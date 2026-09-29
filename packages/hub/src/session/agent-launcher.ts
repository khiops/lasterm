import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENT_SOCKET_POLL_MS,
	AGENT_SOCKET_TIMEOUT,
	type AgentConfig,
	getSocketPath,
} from "@lasterm/shared";
import { lastermDir } from "@lasterm/shared/dist/platform-dirs.js";
import { detectSea } from "@lasterm/shared/dist/sea-addon-loader.js";
import { createOwnerOnlyDirectory } from "../auth.js";
import type { HubLogger } from "../logging/hub-logger.js";
import { resolveAgentBinaryPath } from "../sea-agent-resolver.js";
import { LastermAgent } from "./lasterm-agent.js";
import {
	ensurePrivateSocketDirectory,
	LocalAgentEndpointError,
	type LocalAgentEndpointOptions,
} from "./local-agent-endpoint.js";
import { HubQuittingError } from "./quit-fence.js";

// The agent itself waits ten seconds before reporting its own terminal result.
// Leave delivery slack so the hub does not kill a truthful stopper at its bound.
const AGENT_STOP_TIMEOUT_MS = 12_000;
const AGENT_STOP_OUTPUT_LIMIT = 8_192;

export interface AgentStopResult {
	readonly stopped: boolean;
	readonly diagnostic: string;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Resolve the path to the agent binary.
 *
 * In SEA mode: looks for a co-located lasterm-agent binary next to the hub
 * executable. Falls back to PATH resolution via resolveAgentBinaryPath().
 *
 * In dev mode: returns the Rust agent binary built by cargo at
 *   <project-root>/target/release/lasterm-agent[.exe]
 */
export function resolveAgentPath(): string {
	const sea = detectSea();
	if (sea) {
		const seaPath = resolveAgentBinaryPath();
		if (seaPath) return seaPath;
	}
	// Dev mode fallback: Rust agent binary
	const __dirname = dirname(fileURLToPath(import.meta.url));
	// This file is at packages/hub/src/session/ — go up 4 levels to project root
	const ext = process.platform === "win32" ? ".exe" : "";
	return join(__dirname, "../../../..", `target/release/lasterm-agent${ext}`);
}

/**
 * Returns true if the given agent path is a self-contained executable
 * (i.e. a native binary) rather than a JS module file.
 */
export function isAgentBinary(agentPath: string): boolean {
	return !agentPath.endsWith(".js");
}

/**
 * Ask the identity-validating agent stopper to stop the exact daemon at socketPath.
 * This deliberately never signals an agent PID itself: only the agent can validate
 * its own process record before stopping it.
 */
export function stopLocalAgent(
	socketPathOverride: string | undefined,
	options: {
		agentPath?: string;
		timeoutMs?: number;
		spawn?: typeof spawn;
	} = {},
): Promise<AgentStopResult> {
	const agentPath = options.agentPath ?? resolveAgentPath();
	const socketPath = getSocketPath(socketPathOverride);
	const spawnProcess = options.spawn ?? spawn;
	const timeoutMs = options.timeoutMs ?? AGENT_STOP_TIMEOUT_MS;

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ChildProcess | undefined;
		const append = (current: string, chunk: Buffer | string): string =>
			`${current}${chunk.toString()}`.slice(-AGENT_STOP_OUTPUT_LIMIT);
		const finish = (stopped: boolean, diagnostic: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stopped, diagnostic, stdout, stderr });
		};

		const timer = setTimeout(() => {
			// This only stops our bounded stopper process, never the daemon itself.
			child?.kill();
			finish(false, `Agent stop timed out after ${timeoutMs}ms`);
		}, timeoutMs);

		try {
			child = spawnProcess(agentPath, ["--stop", "--socket", socketPath], {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (err) {
			finish(
				false,
				`Could not run agent stopper: ${err instanceof Error ? err.message : String(err)}`,
			);
			return;
		}

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = append(stderr, chunk);
		});
		child.once("error", (err) => {
			finish(false, `Could not run agent stopper: ${err.message}`);
		});
		child.once("close", (code, signal) => {
			if (code === 0) {
				finish(true, "Local agent stopped");
				return;
			}
			const detail = stderr || stdout;
			finish(
				false,
				`Agent stop was not confirmed (exit ${code ?? "null"}${signal ? `, signal ${signal}` : ""})${detail ? `: ${detail}` : ""}`,
			);
		});
	});
}

/**
 * Connect to an existing agent daemon or spawn a new one.
 *
 * Flow:
 * 1. Verify agent binary exists
 * 2. Unix: the socket's directory must be this user's own, created 0700 if missing
 * 3. Try the authoritative local connection directly
 * 4. If EACCES → throw (different user's socket — do NOT unlink)
 * 5. If the endpoint is refused (LocalAgentEndpointError) → throw, no launch
 * 6. Spawn: child_process.spawn with detached + unref
 * 7. Poll with LastermAgent.connectLocal until the daemon accepts
 */
export async function connectOrLaunch(
	socketPath: string,
	config: AgentConfig,
	agentBinaryPath?: string,
	hubLogger?: HubLogger,
	assertRunning: () => void = () => {},
	endpoint: LocalAgentEndpointOptions = {},
): Promise<LastermAgent> {
	const agentPath = agentBinaryPath ?? resolveAgentPath();

	// Verify agent binary exists
	try {
		await access(agentPath);
	} catch (err) {
		throw new Error(
			`Agent binary not found: ${agentPath} (${err instanceof Error ? err.message : String(err)})`,
		);
	}

	// The socket's directory, before anything is tried in it: a connection
	// would find an agent there, and a launch would put one there. It may not
	// exist yet — on WSL, or under a fresh XDG_RUNTIME_DIR — and the agent's
	// bind needs it. A named pipe (win32) lives in the kernel's pipe namespace
	// and has no directory.
	if ((endpoint.platform ?? process.platform) !== "win32") {
		ensurePrivateSocketDirectory(socketPath, endpoint.fs);
	}

	// Try direct connect first — avoids a throwaway probe connection that
	// confuses the agent's AUTH handshake on Windows named pipes.  Keep
	// invalidation distinct from a failed transport: a fenced operation is not
	// allowed to enter *any* recovery path, particularly endpoint deletion.
	try {
		assertRunning();
		const connected = await LastermAgent.connectLocal(socketPath, hubLogger, endpoint);
		// Do not hand a post-quit connection back to a caller which could adopt it.
		try {
			assertRunning();
		} catch (err) {
			connected.close();
			throw err;
		}
		return connected;
	} catch (err) {
		if (err instanceof HubQuittingError) throw err;
		// Not this account's endpoint: starting an agent would not replace it.
		if (err instanceof LocalAgentEndpointError) throw err;
		if ((err as NodeJS.ErrnoException).code === "EACCES") {
			throw new Error(`Permission denied connecting to socket: ${socketPath}`);
		}
		// A connection failure says nothing about the socket's recorded owner.
		// Do not unlink here: only the agent's identity-validating lifecycle may
		// retire an endpoint.  The daemon bind path owns stale-endpoint recovery.
	}

	// Spawn daemon
	assertRunning();
	const daemonLogPath = launchDaemon(agentPath, socketPath, config);

	// Connect by polling the real agent handshake rather than a throwaway
	// socket probe: the connection that proves the daemon ready is the one this
	// hub keeps. The daemon makes a connection active, displacing the previous
	// one, only once it has authenticated (#127).
	const connected = await connectWhenReady(socketPath, daemonLogPath, hubLogger, endpoint);
	try {
		assertRunning();
	} catch (err) {
		connected.close();
		throw err;
	}
	return connected;
}

/**
 * Spawn the agent as a detached daemon process.
 * The process is unref'd so the hub can exit without waiting for it.
 *
 * SEA mode: the agent path is a self-contained executable — spawn directly.
 * Dev mode: the agent path is a JS file — spawn via node.
 *
 * Returns the path to the daemon log file so the caller can include its tail
 * in error messages when the socket never becomes available.
 */
function launchDaemon(agentPath: string, socketPath: string, config: AgentConfig): string {
	// `--log-files-kept` unasked: the local agent ships with this hub, beside it
	// or in the same build. A remote one may be older, and is asked first
	// (`remoteDaemonLaunchCommand`).
	const daemonArgs = [
		"--daemon",
		"--socket",
		socketPath,
		"--log-level",
		config.logLevel,
		"--format",
		config.logFormat,
		"--log-files-kept",
		String(config.logFilesKept),
	];

	const isBin = isAgentBinary(agentPath);
	const [cmd, args] = isBin
		? [agentPath, daemonArgs]
		: [process.execPath, [agentPath, ...daemonArgs]];

	// The same directory, created the same way, as the hub's own state dir: this
	// can be its first creation, and the TLS key it holds refuses a parent that
	// the umask left group-writable (#237).
	const stateDir = lastermDir("state");
	createOwnerOnlyDirectory(stateDir);

	// The socket's directory exists, and is this user's own: connectOrLaunch
	// made sure of it before the first connection attempt.
	const logPath = join(stateDir, "agent-daemon.log");
	const logFd = openSync(logPath, "a");

	const child = spawn(cmd, args, {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		windowsHide: true,
	});

	child.on?.("error", (err) => {
		process.stderr.write(
			`[agent-launcher] daemon process error (pid=${child.pid}): ${err instanceof Error ? err.stack : String(err)}\n`,
		);
	});

	child.unref();
	try {
		closeSync(logFd);
	} catch {
		/* ignore */
	}

	return logPath;
}

/**
 * Read the last at-most `windowBytes` bytes of a log file and return the
 * last `maxLines` non-empty lines joined with newlines, capped at `maxChars`
 * characters.  Returns an empty string on ENOENT, empty file, or any error.
 *
 * Uses openSync/fstatSync/readSync/closeSync so the syscall sequence is
 * synchronous-bounded: only the suffix bytes are transferred, preventing
 * OOM or event-loop stall on large / hung daemon logs.
 *
 * @internal exported for unit testing
 */
export function readBoundedLogTail(
	logPath: string,
	windowBytes = 8192,
	maxLines = 20,
	maxChars = 4096,
): string {
	let fd = -1;
	try {
		fd = openSync(logPath, "r");
		const { size } = fstatSync(fd);
		if (size <= 0) return "";
		const readOffset = Math.max(0, size - windowBytes);
		const readLen = size - readOffset;
		const buf = Buffer.allocUnsafe(readLen);
		const bytesRead = readSync(fd, buf, 0, readLen, readOffset);
		const raw = buf.toString("utf8", 0, bytesRead);
		const lines = raw.split("\n").filter((l) => l.length > 0);
		const tail = lines.slice(-maxLines).join("\n");
		return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
	} catch {
		// ENOENT or unreadable — not fatal
		return "";
	} finally {
		if (fd !== -1) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

/**
 * Poll until the daemon accepts the authoritative hub connection.
 *
 * This intentionally uses LastermAgent.connectLocal instead of probeSocket:
 * the connection that proves the daemon ready is the one this hub keeps, and
 * it becomes the daemon's active hub connection once it has authenticated.
 *
 * Retries every AGENT_SOCKET_POLL_MS (100ms), gives up after AGENT_SOCKET_TIMEOUT (5s).
 *
 * On timeout, appends the last ~20 lines of the daemon log (if non-empty) to
 * the error message so startup crashes are not silent.
 */
async function connectWhenReady(
	socketPath: string,
	daemonLogPath?: string,
	hubLogger?: HubLogger,
	endpoint: LocalAgentEndpointOptions = {},
): Promise<LastermAgent> {
	const deadline = Date.now() + AGENT_SOCKET_TIMEOUT;
	let lastErr: unknown;

	while (Date.now() < deadline) {
		try {
			return await LastermAgent.connectLocal(socketPath, hubLogger, endpoint);
		} catch (err) {
			lastErr = err;
			if (err instanceof LocalAgentEndpointError) throw err;
			if ((err as NodeJS.ErrnoException).code === "EACCES") {
				throw new Error(`Permission denied connecting to socket: ${socketPath}`);
			}
		}

		await sleep(AGENT_SOCKET_POLL_MS);
	}

	// Build a diagnostic suffix from the daemon log tail (bounded to last 20 lines / 4 KB).
	let logTail = "";
	if (daemonLogPath) {
		const tail = readBoundedLogTail(daemonLogPath);
		if (tail.length > 0) {
			logTail = `\n\nAgent daemon log (last 20 lines from ${daemonLogPath}):\n${tail}`;
		}
	}

	const lastErrText =
		lastErr instanceof Error && lastErr.message.length > 0
			? `; last error: ${lastErr.message}`
			: "";
	throw new Error(
		`Agent socket did not become available within ${AGENT_SOCKET_TIMEOUT}ms: ${socketPath}${lastErrText}${logTail}`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
