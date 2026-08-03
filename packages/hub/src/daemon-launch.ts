import { closeSync, fchmodSync, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DaemonSpawnPlan {
	args: string[];
	env: Record<string, string>;
}

export interface BuildDaemonSpawnPlanOptions {
	sea: boolean;
	port: number;
	open?: boolean;
	moduleUrl: string;
}

export function buildDaemonSpawnPlan(options: BuildDaemonSpawnPlanOptions): DaemonSpawnPlan {
	const env: Record<string, string> = {
		TERMORA_PORT: String(options.port),
		...(options.open ? { TERMORA_OPEN: "1" } : {}),
	};

	if (options.sea) {
		return {
			args: ["start", "--port", String(options.port)],
			env,
		};
	}

	return {
		args: [fileURLToPath(new URL("./main.js", options.moduleUrl))],
		env,
	};
}

export interface DaemonRuntimeInfo {
	pid: number;
	port: number;
	started_at: string;
}

export type DaemonRuntimeLoadResult =
	| { kind: "absent" }
	| { kind: "present"; runtime: DaemonRuntimeInfo }
	| { kind: "unreadable"; error: unknown };

export type ChildExitState =
	| { exited: false }
	| {
			exited: true;
			code: number | null;
			signal: string | null;
			errorMessage?: string;
	  };

export type DaemonReadyResult =
	| {
			ok: true;
			pid: number;
			port: number;
	  }
	| {
			ok: false;
			reason: "child-exited" | "runtime-unreadable" | "timeout";
			message: string;
	  };

export interface WaitForDaemonReadyDeps {
	childPid: number;
	loadRuntime: () => DaemonRuntimeLoadResult;
	fetchHealth: (port: number) => Promise<unknown>;
	getChildExit: () => ChildExitState;
	readLogTail: () => string;
	// Invoked on the timeout path so a slow child cannot survive a reported
	// failure: exit 1 must mean "no daemon is running".
	killChild: () => void;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	pollMs?: number;
	deadlineMs?: number;
	// Upper bound on a single health probe — a socket that accepts but never
	// responds must not park the loop past the readiness deadline.
	healthTimeoutMs?: number;
}

const DEFAULT_POLL_MS = 100;
const DEFAULT_DEADLINE_MS = 5000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_TAIL_LINES = 20;
const DEFAULT_TAIL_CHARS = 8192;
// The daemon log is append-only and never rotated; cap how much of it the
// failure path reads so a long-lived log cannot exhaust memory.
const MAX_TAIL_READ_BYTES = 64 * 1024;

export function tailText(
	text: string,
	maxLines = DEFAULT_TAIL_LINES,
	maxChars = DEFAULT_TAIL_CHARS,
): string {
	const trimmedTrailingNewline = text.replace(/\r?\n$/, "");
	if (!trimmedTrailingNewline) return "";

	const lineTail = trimmedTrailingNewline.split(/\r?\n/).slice(-maxLines).join("\n");
	if (lineTail.length <= maxChars) return lineTail;
	return lineTail.slice(-maxChars);
}

// Truncate on every daemon start (the log documents the current daemon only,
// so repeated starts cannot accumulate unbounded disk usage) and keep it
// owner-only: daemon stdout/stderr can leak sensitive startup details.
export function openDaemonLog(logPath: string): number {
	const fd = openSync(logPath, "w", 0o600);
	// The creation mode only applies to new files — clamp pre-existing ones too.
	fchmodSync(fd, 0o600);
	return fd;
}

export function readDaemonLogTail(logPath: string, maxLines = DEFAULT_TAIL_LINES): string {
	try {
		const fd = openSync(logPath, "r");
		try {
			const size = fstatSync(fd).size;
			const readBytes = Math.min(size, MAX_TAIL_READ_BYTES);
			if (readBytes === 0) return "";
			const buffer = Buffer.alloc(readBytes);
			const bytesRead = readSync(fd, buffer, 0, readBytes, size - readBytes);
			return tailText(buffer.toString("utf-8", 0, bytesRead), maxLines);
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

export async function waitForDaemonReady(deps: WaitForDaemonReadyDeps): Promise<DaemonReadyResult> {
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const deadlineAt = deps.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);

	while (true) {
		const childExit = deps.getChildExit();
		if (childExit.exited) {
			return {
				ok: false,
				reason: "child-exited",
				message: formatFailureMessage(describeChildExit(childExit), deps.readLogTail()),
			};
		}

		const runtime = deps.loadRuntime();
		if (runtime.kind === "unreadable") {
			deps.killChild();
			return {
				ok: false,
				reason: "runtime-unreadable",
				message: formatFailureMessage(
					`Daemon runtime record could not be read: ${describeRuntimeReadFailure(runtime.error)}; the daemon process was terminated`,
					deps.readLogTail(),
				),
			};
		}
		if (runtime.kind === "present" && runtime.runtime.pid === deps.childPid) {
			try {
				await fetchHealthBounded(deps, runtime.runtime.port);
				return { ok: true, pid: runtime.runtime.pid, port: runtime.runtime.port };
			} catch {
				// The runtime file can appear before Fastify is accepting requests.
			}
		}

		if (deps.now() >= deadlineAt) {
			deps.killChild();
			return {
				ok: false,
				reason: "timeout",
				message: formatFailureMessage(
					`Daemon did not become ready within ${deps.deadlineMs ?? DEFAULT_DEADLINE_MS}ms; the daemon process was terminated`,
					deps.readLogTail(),
				),
			};
		}

		await deps.sleep(Math.min(pollMs, Math.max(0, deadlineAt - deps.now())));
	}
}

function describeRuntimeReadFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchHealthBounded(deps: WaitForDaemonReadyDeps, port: number): Promise<unknown> {
	const timeoutMs = deps.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			deps.fetchHealth(port),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Health probe timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function describeChildExit(exit: Extract<ChildExitState, { exited: true }>): string {
	const code = exit.code === null ? "null" : String(exit.code);
	const signal = exit.signal === null ? "none" : exit.signal;
	const error = exit.errorMessage ? ` (${exit.errorMessage})` : "";
	return `Daemon process exited before readiness (code ${code}, signal ${signal})${error}`;
}

function formatFailureMessage(summary: string, rawLogTail: string): string {
	const logTail = tailText(rawLogTail);
	return [summary, "Daemon log tail:", logTail ? logTail : "<empty>"].join("\n");
}
