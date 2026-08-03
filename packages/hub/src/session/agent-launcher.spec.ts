import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
	type AgentConfig,
	DEFAULT_AGENT_CONFIG,
	encodeFrame,
	PROTOCOL_VERSION,
} from "@termora/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubQuittingError } from "./quit-fence.js";
import type { TermoraAgent } from "./termora-agent.js";
import { getTestSocketPath } from "./test-socket-path.js";

/**
 * Mock child_process.spawn so connectOrLaunch never creates real processes.
 * The mock's behavior is configured per-test via mockSpawnImpl.
 */
let mockSpawnImpl: (...args: unknown[]) => unknown = () => ({
	unref: vi.fn(),
	pid: 99999,
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawnImpl(...args),
	};
});

// Import AFTER vi.mock so the mock is in place
const { connectOrLaunch, readBoundedLogTail, stopLocalAgent } = await import("./agent-launcher.js");

const TEST_TIMEOUT = 15_000;

/**
 * Create a mock agent daemon that speaks the termora protocol.
 * On each connection it sends HELLO + CHANNEL_STATE_END immediately.
 */
function createMockDaemon(socketPath: string): Promise<{
	server: net.Server;
	connections: net.Socket[];
}> {
	return new Promise((resolve) => {
		const connections: net.Socket[] = [];

		const server = net.createServer((socket) => {
			connections.push(socket);
			socket.on("error", () => {}); // suppress ECONNRESET during cleanup

			const hello = encodeFrame({
				type: "HELLO",
				version: PROTOCOL_VERSION,
				agentVersion: "0.1.0",
				capabilities: ["multiplex", "resize", "snapshot"],
			});
			socket.write(Buffer.from(hello));

			const end = encodeFrame({ type: "CHANNEL_STATE_END" });
			socket.write(Buffer.from(end));
		});

		server.listen(socketPath, () => resolve({ server, connections }));
	});
}

/** Close a net.Server and wait for the "close" event. */
function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

describe("connectOrLaunch", () => {
	let tmpDir: string;
	let socketPath: string;
	let daemon: { server: net.Server; connections: net.Socket[] } | null = null;
	let agent: TermoraAgent | null = null;
	let oldXdgStateHome: string | undefined;

	const config: AgentConfig = { ...DEFAULT_AGENT_CONFIG };

	beforeEach(async () => {
		oldXdgStateHome = process.env.XDG_STATE_HOME;
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "termora-launcher-test-"));
		process.env.XDG_STATE_HOME = tmpDir;
		socketPath = getTestSocketPath();

		// Reset spawn mock to default (no-op)
		mockSpawnImpl = () => ({ unref: vi.fn(), pid: 99999 });
	});

	afterEach(async () => {
		agent?.close();
		agent = null;
		if (daemon) {
			for (const conn of daemon.connections) {
				conn.destroy();
			}
			await closeServer(daemon.server);
			daemon = null;
		}
		await rm(tmpDir, { recursive: true, force: true });
		if (oldXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = oldXdgStateHome;
		}
	});

	describe("Given agent daemon already running", () => {
		it(
			"connects to existing agent without spawning",
			async () => {
				daemon = await createMockDaemon(socketPath);

				// Binary must exist to pass access() check, but won't be spawned
				const dummyBinary = path.join(tmpDir, "fake-agent.js");
				await writeFile(dummyBinary, "// placeholder");

				let spawnCalled = false;
				mockSpawnImpl = () => {
					spawnCalled = true;
					return { unref: vi.fn(), pid: 99999 };
				};

				agent = await connectOrLaunch(socketPath, config, dummyBinary);

				expect(agent).toBeDefined();
				expect(agent.connected).toBe(true);
				expect(spawnCalled).toBe(false);
			},
			TEST_TIMEOUT,
		);
	});

	describe.skipIf(process.platform === "win32")("Given stale socket file", () => {
		it(
			"connects to a newly started daemon after the previous endpoint closes",
			async () => {
				// Node closes and unlinks its Unix endpoint before the replacement binds.
				const staleServer = net.createServer();
				await new Promise<void>((resolve) => {
					staleServer.listen(socketPath, () => resolve());
				});
				await closeServer(staleServer);

				// connectOrLaunch calls spawn, then polls with the authoritative
				// TermoraAgent connection.
				// Our mock spawn starts the mock daemon instead of a real process.
				mockSpawnImpl = () => {
					setImmediate(async () => {
						daemon = await createMockDaemon(socketPath);
					});
					return { unref: vi.fn(), pid: 12345 };
				};

				const dummyBinary = path.join(tmpDir, "fake-agent.js");
				await writeFile(dummyBinary, "// placeholder");

				agent = await connectOrLaunch(socketPath, config, dummyBinary);

				expect(agent).toBeDefined();
				expect(agent.connected).toBe(true);
				expect(daemon?.connections).toHaveLength(1);
			},
			TEST_TIMEOUT,
		);
	});

	it("leaves the endpoint intact when its operation is invalidated before connect", async () => {
		await writeFile(socketPath, "not a socket");
		const dummyBinary = path.join(tmpDir, "fake-agent.js");
		await writeFile(dummyBinary, "// placeholder");

		await expect(
			connectOrLaunch(socketPath, config, dummyBinary, undefined, () => {
				throw new HubQuittingError();
			}),
		).rejects.toThrow("Hub is quitting");
		expect(existsSync(socketPath)).toBe(true);
	});

	describe("Given no agent running (ENOENT)", () => {
		it(
			"spawns daemon and connects after socket becomes available",
			async () => {
				let capturedArgs: unknown[] = [];

				// Mock spawn: start mock daemon after a delay (simulates startup time)
				mockSpawnImpl = (...args: unknown[]) => {
					capturedArgs = args;
					setTimeout(async () => {
						daemon = await createMockDaemon(socketPath);
					}, 150);
					return { unref: vi.fn(), pid: 12345 };
				};

				const dummyBinary = path.join(tmpDir, "fake-agent.js");
				await writeFile(dummyBinary, "// placeholder");

				agent = await connectOrLaunch(socketPath, config, dummyBinary);

				expect(agent).toBeDefined();
				expect(agent.connected).toBe(true);
				expect(daemon?.connections).toHaveLength(1);

				// Verify spawn was called with correct arguments
				expect(capturedArgs[0]).toBe(process.execPath);
				const cliArgs = capturedArgs[1] as string[];
				expect(cliArgs).toContain("--daemon");
				expect(cliArgs).toContain("--socket");
				expect(cliArgs).toContain(socketPath);
				expect(cliArgs).toContain("--buffer-per-channel");
				expect(cliArgs).toContain(String(config.bufferPerChannel));
				expect(cliArgs).toContain("--buffer-global");
				expect(cliArgs).toContain(String(config.bufferGlobal));
				expect(cliArgs).toContain("--log-level");
				expect(cliArgs).toContain(config.logLevel);
				expect(cliArgs).toContain("--format");
				expect(cliArgs).toContain(config.logFormat);

				// Verify detached + stdio: stdin=ignore, stdout+stderr=log fd
				const opts = capturedArgs[2] as Record<string, unknown>;
				expect(opts.detached).toBe(true);
				const stdio = opts.stdio as unknown[];
				expect(Array.isArray(stdio)).toBe(true);
				expect(stdio[0]).toBe("ignore");
				expect(typeof stdio[1]).toBe("number"); // log fd
				expect(stdio[1]).toBe(stdio[2]); // stdout and stderr share the same fd
			},
			TEST_TIMEOUT,
		);
	});

	describe("Given agent spawned but socket never becomes available", () => {
		it(
			"rejects with timeout error after AGENT_SOCKET_TIMEOUT",
			async () => {
				const dummyBinary = path.join(tmpDir, "fake-agent.js");
				await writeFile(dummyBinary, "// placeholder");

				// Spawn succeeds but never creates a real daemon — socket stays unavailable
				mockSpawnImpl = () => ({ unref: vi.fn(), pid: 77777 });

				await expect(connectOrLaunch(socketPath, config, dummyBinary)).rejects.toThrow(
					/Agent socket did not become available/,
				);
			},
			TEST_TIMEOUT,
		);
	});

	describe("Given agent binary does not exist", () => {
		it(
			"throws with descriptive error",
			async () => {
				const nonexistentPath = path.join(tmpDir, "nonexistent", "agent.js");

				await expect(connectOrLaunch(socketPath, config, nonexistentPath)).rejects.toThrow(
					/Agent binary not found/,
				);
			},
			TEST_TIMEOUT,
		);
	});

	describe("Given SEA binary path (no .js extension)", () => {
		it(
			"spawns the binary directly as the executable (not via node)",
			async () => {
				let capturedArgs: unknown[] = [];

				mockSpawnImpl = (...args: unknown[]) => {
					capturedArgs = args;
					setTimeout(async () => {
						daemon = await createMockDaemon(socketPath);
					}, 150);
					return { unref: vi.fn(), pid: 12345 };
				};

				// Create a fake SEA binary (no .js extension)
				const seaBinary = path.join(tmpDir, "termora-agent");
				await writeFile(seaBinary, "#!/bin/sh\n");

				agent = await connectOrLaunch(socketPath, config, seaBinary);

				expect(agent).toBeDefined();
				expect(agent.connected).toBe(true);

				// SEA binary must be the executable, not wrapped in node
				expect(capturedArgs[0]).toBe(seaBinary);
				const cliArgs = capturedArgs[1] as string[];
				// The binary path must NOT appear in the args list — it is the command
				expect(cliArgs).not.toContain(seaBinary);
				expect(cliArgs).toContain("--daemon");
				expect(cliArgs).toContain("--socket");
				expect(cliArgs).toContain(socketPath);
				expect(cliArgs).toContain("--log-level");
				expect(cliArgs).toContain(config.logLevel);
				expect(cliArgs).toContain("--format");
				expect(cliArgs).toContain(config.logFormat);
			},
			TEST_TIMEOUT,
		);
	});

	/**
	 * Mutation caught: removing the `mkdirSync(dirname(socketPath), ...)` call
	 * in launchDaemon causes the agent's UnixListener::bind to fail with ENOENT
	 * on WSL / XDG_RUNTIME_DIR environments where the socket parent dir does not
	 * pre-exist. This test verifies the directory is created before spawn is called.
	 */
	it.skipIf(process.platform === "win32")(
		"[socket parent dir] creates missing parent directory before spawning the agent",
		async () => {
			// Use a separate temp base so cleanup is independent of the outer tmpDir.
			const isolatedBase = mkdtempSync(path.join(os.tmpdir(), "termora-sockdir-test-"));
			try {
				// Point the socket at a two-level-deep path that does not exist yet.
				// Neither `isolatedBase/missing/` nor `isolatedBase/missing/nested/` exists.
				const missingParent = path.join(isolatedBase, "missing", "nested");
				const deepSocketPath = path.join(missingParent, "agent.sock");

				// Verify the directory genuinely does not exist before the call.
				expect(existsSync(missingParent)).toBe(false);

				let dirCreatedBeforeSpawn = false;
				mockSpawnImpl = (..._args: unknown[]) => {
					// At this point launchDaemon has already run mkdirSync — check it.
					dirCreatedBeforeSpawn = existsSync(missingParent);
					// Start the mock daemon so waitForSocket succeeds.
					setTimeout(async () => {
						daemon = await createMockDaemon(deepSocketPath);
					}, 150);
					return { unref: vi.fn(), pid: 55555 };
				};

				const dummyBinary = path.join(tmpDir, "fake-agent.js");
				await writeFile(dummyBinary, "// placeholder");

				agent = await connectOrLaunch(deepSocketPath, config, dummyBinary);

				// The socket parent directory must have been created before spawn.
				expect(dirCreatedBeforeSpawn).toBe(true);
				// Belt-and-suspenders: directory still exists after connect.
				expect(existsSync(missingParent)).toBe(true);
				expect(agent.connected).toBe(true);
			} finally {
				rmSync(isolatedBase, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);

	/**
	 * Mutation caught: reverting mode 0o700 → no mode (default 0o777 & umask)
	 * would leave the socket parent dir group/world-accessible, allowing other
	 * local users to reach the agent socket.
	 * This test verifies the created directory has mode 0o700.
	 */
	it.skipIf(process.platform === "win32")(
		"[socket parent dir] creates parent directory with owner-only mode 0o700",
		async () => {
			const isolatedBase = mkdtempSync(path.join(os.tmpdir(), "termora-sockmode-test-"));
			try {
				const socketParent = path.join(isolatedBase, "sockdir");
				const testSocketPath = path.join(socketParent, "agent.sock");

				expect(existsSync(socketParent)).toBe(false);

				mockSpawnImpl = (..._args: unknown[]) => {
					setTimeout(async () => {
						daemon = await createMockDaemon(testSocketPath);
					}, 150);
					return { unref: vi.fn(), pid: 55556 };
				};

				const dummyBinary = path.join(tmpDir, "fake-agent.js");
				await writeFile(dummyBinary, "// placeholder");

				agent = await connectOrLaunch(testSocketPath, config, dummyBinary);

				// Directory must exist and have mode 0o700 (owner rwx, no group/other).
				expect(existsSync(socketParent)).toBe(true);
				const st = statSync(socketParent);
				// st.mode & 0o777 masks off the file-type bits — only rwxrwxrwx remain.
				expect(st.mode & 0o777).toBe(0o700);
			} finally {
				rmSync(isolatedBase, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT,
	);
});

describe("stopLocalAgent", () => {
	it("runs the resolved executable with explicit stop arguments and no shell", async () => {
		const child = new (
			await import("node:events")
		).EventEmitter() as import("node:child_process").ChildProcess;
		Object.assign(child, {
			stdout: new (await import("node:events")).EventEmitter(),
			stderr: new (await import("node:events")).EventEmitter(),
			kill: vi.fn(),
		});
		const run = vi.fn(() => {
			setImmediate(() => child.emit("close", 0, null));
			return child;
		});

		const result = await stopLocalAgent("/tmp/termora-agent.sock", {
			agentPath: "/opt/termora-agent",
			spawn: run as unknown as typeof import("node:child_process").spawn,
		});

		expect(result).toMatchObject({ stopped: true, diagnostic: "Local agent stopped" });
		expect(run).toHaveBeenCalledWith(
			"/opt/termora-agent",
			["--stop", "--socket", "/tmp/termora-agent.sock"],
			expect.objectContaining({ shell: false }),
		);
	});
});

/**
 * Unit tests for readBoundedLogTail — the bounded-suffix log reader extracted
 * from waitForSocket.  These tests exercise the helper directly with a real
 * temp file so there is no need to wire up the full 5-second timeout path.
 *
 * Mutations caught:
 *   (a) reverting to readFileSync(whole) — the "large file" test asserts the
 *       returned string length is bounded (≤ ~4 KB + ellipsis overhead) even
 *       when the log is 50 KB, so the whole-file version would pass content
 *       but produce an oversized result that the assertion rejects.
 *   (b) dropping the lines.slice(-20) limit — the last-lines test asserts only
 *       the final line is present and early lines are absent.
 *   (c) making the helper always return "" — the content assertion fails.
 *   (d) ENOENT not handled gracefully — the missing-file test would throw.
 */
describe("readBoundedLogTail", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "termora-logtail-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	it("returns empty string for a missing log file (ENOENT)", () => {
		const result = readBoundedLogTail(path.join(tmpDir, "nonexistent.log"));
		expect(result).toBe("");
	});

	it("returns empty string for an empty log file", () => {
		const logPath = path.join(tmpDir, "empty.log");
		writeFileSync(logPath, "");
		expect(readBoundedLogTail(logPath)).toBe("");
	});

	it("returns the log content for a small log file", () => {
		const logPath = path.join(tmpDir, "small.log");
		writeFileSync(logPath, "line1\nline2\nline3\n");
		const result = readBoundedLogTail(logPath);
		expect(result).toContain("line1");
		expect(result).toContain("line2");
		expect(result).toContain("line3");
	});

	it("returns only the last N lines when the log has many lines", () => {
		const logPath = path.join(tmpDir, "manylines.log");
		// Write 100 numbered lines
		const allLines = Array.from({ length: 100 }, (_, i) => `log-line-${i + 1}`);
		writeFileSync(logPath, `${allLines.join("\n")}\n`);

		// Default maxLines=20: should have the last 20 lines, not the first ones
		const result = readBoundedLogTail(logPath);
		expect(result).toContain("log-line-100");
		expect(result).toContain("log-line-81");
		expect(result).not.toContain("log-line-1\n");
		expect(result).not.toContain("log-line-80");
	});

	it("returns bounded output for a large log file (>8 KB window)", () => {
		const logPath = path.join(tmpDir, "large.log");

		// Write ~50 KB of log content: 1000 lines × ~50 bytes each
		const earlyLine = "early-line-that-should-not-appear-in-tail";
		const lateLine = "late-line-that-must-appear-in-tail";
		const lines: string[] = [];
		// 950 "early" padding lines
		for (let i = 0; i < 950; i++) {
			lines.push(`${earlyLine}-${i}-${"x".repeat(30)}`);
		}
		// 50 "late" lines that must appear in the tail
		for (let i = 0; i < 50; i++) {
			lines.push(`${lateLine}-${i}`);
		}
		writeFileSync(logPath, `${lines.join("\n")}\n`);

		const result = readBoundedLogTail(logPath);

		// Result must be bounded — total length well under 50 KB
		// maxChars cap is 4096; add overhead for "…" prefix = ~4097 chars max
		expect(result.length).toBeLessThanOrEqual(4097);

		// Must contain the final late line
		expect(result).toContain(`${lateLine}-49`);

		// Must NOT contain the very early padding lines (they're outside the window)
		expect(result).not.toContain(`${earlyLine}-0-`);
	});

	it("uses the provided windowBytes parameter to limit disk reads", () => {
		const logPath = path.join(tmpDir, "windowed.log");

		// Write 30 lines, each exactly 20 chars + newline = 21 bytes
		// Total ~630 bytes.  windowBytes=100 → only the last ~4-5 lines fit.
		const allLines = Array.from(
			{ length: 30 },
			(_, i) => `line${String(i + 1).padStart(2, "0")}-${"a".repeat(14)}`,
		);
		writeFileSync(logPath, `${allLines.join("\n")}\n`);

		// windowBytes=100 should exclude the early lines
		const result = readBoundedLogTail(logPath, 100, 20, 4096);
		expect(result).toContain("line30");
		// line01 is ~21*29 bytes before the end — outside the 100-byte window
		expect(result).not.toContain("line01");
	});

	it("decodes only the bytes actually read (truncation safety)", () => {
		// Mutation caught: using buf.toString("utf8") instead of
		// buf.toString("utf8", 0, bytesRead) would include uninitialized memory
		// from Buffer.allocUnsafe when readSync returns fewer bytes than requested.
		//
		// We can't easily force readSync to return a short count on a real file,
		// so we verify the contract from the other side: the returned string must
		// consist entirely of printable ASCII (the known file content), with no
		// stray non-printable bytes that would indicate uninitialized buffer regions
		// were included.
		const logPath = path.join(tmpDir, "truncation-safety.log");
		const content = "alpha\nbeta\ngamma\ndelta\n";
		writeFileSync(logPath, content);

		const result = readBoundedLogTail(logPath);

		// Every character in the result must be a printable ASCII character or newline.
		// Uninitialized memory from allocUnsafe would contain arbitrary bytes,
		// including control chars/NULs that would fail this assertion.
		expect(result).toMatch(/^[\x20-\x7E\n]*$/);

		// Content is still present — not a trivially-empty result.
		expect(result).toContain("alpha");
		expect(result).toContain("gamma");
	});
});
