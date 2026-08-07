import { closeSync, mkdtempSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	buildDaemonSpawnPlan,
	type ChildExitState,
	type DaemonRuntimeInfo,
	openDaemonLog,
	readDaemonLogTail,
	tailText,
	waitForDaemonReady,
} from "./daemon-launch.js";

describe("buildDaemonSpawnPlan", () => {
	it("uses the SEA CLI entry without re-passing --daemon", () => {
		const plan = buildDaemonSpawnPlan({
			sea: true,
			port: 4321,
			moduleUrl: pathToFileURL("/tmp/lasterm/dist/cli.js").href,
		});

		expect(plan.args).toEqual(["start", "--port", "4321"]);
		expect(plan.args).not.toContain("--daemon");
		expect(plan.args).not.toContain("/tmp/lasterm/dist/main.js");
		expect(plan.env).toEqual({ LASTERM_PORT: "4321" });
	});

	it("uses the compiled main.js sibling in dev mode and preserves open env", () => {
		const plan = buildDaemonSpawnPlan({
			sea: false,
			port: 4100,
			open: true,
			moduleUrl: pathToFileURL("/tmp/lasterm/dist/cli.js").href,
		});

		expect(plan.args).toEqual(["/tmp/lasterm/dist/main.js"]);
		expect(plan.env).toEqual({ LASTERM_PORT: "4100", LASTERM_OPEN: "1" });
	});
});

describe("waitForDaemonReady", () => {
	it("preserves the native lock contention exit status", async () => {
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "absent" }),
			fetchHealth: async () => ({}),
			getChildExit: () => ({ exited: true, code: 73, signal: null }),
			readLogTail: () => "LASTERM_HUB_ALREADY_RUNNING: another hub holds hub.lock",
			killChild: () => {},
			now: () => 0,
			sleep: async () => {},
		});
		expect(result).toMatchObject({ ok: false, reason: "already-running" });
	});

	// Mutation: build the contention message the way a child-exit is built, and the
	// incumbent's own log comes back instead of its identity — which is what happened
	// once the loser started sharing that log in append mode.
	it("names the incumbent on contention and does not print its log", async () => {
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({
				kind: "present",
				runtime: { pid: 456, port: 4100, started_at: "2026-08-03T00:00:00.000Z" },
			}),
			fetchHealth: async () => ({}),
			getChildExit: () => ({ exited: true, code: 73, signal: null }),
			readLogTail: () => "incumbent log line that must not be echoed",
			killChild: () => {},
			now: () => 0,
			sleep: async () => {},
		});
		expect(result).toMatchObject({
			ok: false,
			reason: "already-running",
			message: "Hub already running (pid 456 on port 4100)",
		});
	});

	// Mutation: name the incumbent from the record unconditionally, and a start that
	// lost to a hub which had not yet published claims the loser's own pid.
	it("falls back to an unqualified message when the record cannot name an incumbent", async () => {
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "unreadable", error: new Error("EACCES") }),
			fetchHealth: async () => ({}),
			getChildExit: () => ({ exited: true, code: 73, signal: null }),
			readLogTail: () => "",
			killChild: () => {},
			now: () => 0,
			sleep: async () => {},
		});
		expect(result).toMatchObject({ reason: "already-running", message: "Hub already running" });
	});

	it("returns ready after an unreadable record when the free-lock child publishes its runtime", async () => {
		let now = 0;
		let loadCount = 0;
		let killCount = 0;
		const healthPorts: number[] = [];
		const runtime: DaemonRuntimeInfo = {
			pid: 123,
			port: 49152,
			started_at: "2026-06-10T00:00:00.000Z",
		};

		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => {
				loadCount += 1;
				return loadCount >= 2
					? { kind: "present" as const, runtime }
					: { kind: "unreadable" as const, error: new Error("partial runtime record") };
			},
			fetchHealth: async (port) => {
				healthPorts.push(port);
				return { status: "ok" };
			},
			getChildExit: () => ({ exited: false }),
			readLogTail: () => "",
			killChild: () => {
				killCount += 1;
			},
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			pollMs: 10,
			deadlineMs: 50,
		});

		expect(result).toEqual({ ok: true, pid: 123, port: 49152 });
		expect(healthPorts).toEqual([49152]);
		// Mutation caught: restoring the unreadable-record veto kills this child
		// before it can publish its own runtime record.
		expect(killCount).toBe(0);
	});

	it("fails with child exit details and daemon log tail", async () => {
		let killCount = 0;
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "absent" }),
			fetchHealth: async () => ({ status: "ok" }),
			getChildExit: () => ({ exited: true, code: 42, signal: null }),
			readLogTail: () => "first\nlast",
			killChild: () => {
				killCount += 1;
			},
			now: () => 0,
			sleep: async () => {},
			pollMs: 10,
			deadlineMs: 50,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("child-exited");
			expect(result.message).toContain("code 42");
			expect(result.message).toContain("signal none");
			expect(result.message).toContain("first\nlast");
		}
		expect(killCount).toBe(0);
	});

	it("fails with timeout, terminates the child, and includes the log tail", async () => {
		let now = 0;
		let killCount = 0;
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "absent" }),
			fetchHealth: async () => ({ status: "ok" }),
			getChildExit: () => ({ exited: false }),
			readLogTail: () => "timeout log",
			killChild: () => {
				killCount += 1;
			},
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			pollMs: 10,
			deadlineMs: 25,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("timeout");
			expect(result.message).toContain("25ms");
			expect(result.message).toContain("terminated");
			expect(result.message).toContain("timeout log");
		}
		// A reported failure must not leave the detached child running.
		expect(killCount).toBe(1);
	});

	it("times out even when a health probe never settles", async () => {
		let now = 0;
		let killCount = 0;
		const runtime: DaemonRuntimeInfo = {
			pid: 123,
			port: 49152,
			started_at: "2026-06-10T00:00:00.000Z",
		};

		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "present", runtime }),
			// Accepts the connection but never responds.
			fetchHealth: () => new Promise<never>(() => {}),
			getChildExit: () => ({ exited: false }),
			readLogTail: () => "",
			killChild: () => {
				killCount += 1;
			},
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			pollMs: 10,
			deadlineMs: 25,
			healthTimeoutMs: 5,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("timeout");
		}
		expect(killCount).toBe(1);
	});

	it("keeps failure log tails bounded to the last 20 lines", async () => {
		const lines = Array.from({ length: 25 }, (_, index) => `line-${index + 1}`);
		const childExit: ChildExitState = { exited: true, code: 1, signal: null };

		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "absent" }),
			fetchHealth: async () => ({ status: "ok" }),
			getChildExit: () => childExit,
			readLogTail: () => lines.join("\n"),
			killChild: () => {},
			now: () => 0,
			sleep: async () => {},
			pollMs: 10,
			deadlineMs: 50,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).not.toMatch(/^line-1$/m);
			expect(result.message).not.toMatch(/^line-5$/m);
			expect(result.message).toMatch(/^line-6$/m);
			expect(result.message).toMatch(/^line-25$/m);
		}
	});
});

describe("tailText", () => {
	it("returns the last requested lines", () => {
		const text = Array.from({ length: 5 }, (_, index) => `line-${index + 1}`).join("\n");
		expect(tailText(text, 2)).toBe("line-4\nline-5");
	});
});

describe("readDaemonLogTail", () => {
	it("reads only the end of an oversized log file", () => {
		const dir = mkdtempSync(join(tmpdir(), "lasterm-daemon-log-"));
		try {
			const logPath = join(dir, "hub-daemon.log");
			// 200_000 numbered lines (~2.5 MB) — far beyond the 64 KiB read cap.
			const lines = Array.from({ length: 200_000 }, (_, index) => `entry-${index + 1}`);
			writeFileSync(logPath, `${lines.join("\n")}\n`);

			const tail = readDaemonLogTail(logPath);

			expect(tail).toMatch(/^entry-200000$/m);
			expect(tail).not.toMatch(/^entry-1$/m);
			// The cap bounds memory: the tail is a small suffix, not the whole file.
			expect(tail.length).toBeLessThanOrEqual(8192);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns empty string for a missing file", () => {
		expect(readDaemonLogTail("/nonexistent/lasterm/hub-daemon.log")).toBe("");
	});
});

describe("openDaemonLog", () => {
	it("preserves a pre-existing log for a losing daemon launch and clamps it owner-only", () => {
		const dir = mkdtempSync(join(tmpdir(), "lasterm-daemon-log-"));
		try {
			const logPath = join(dir, "hub-daemon.log");
			writeFileSync(logPath, "incumbent daemon log\n", { mode: 0o644 });

			const fd = openDaemonLog(logPath);
			try {
				writeSync(fd, "fresh\n");
			} finally {
				closeSync(fd);
			}

			const stat = statSync(logPath);
			// Mutation caught: changing the open mode back to "w" erases the
			// incumbent before the child has proved it owns the lock.
			expect(stat.size).toBe("incumbent daemon log\nfresh\n".length);
			if (process.platform !== "win32") {
				expect(stat.mode & 0o777).toBe(0o600);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
