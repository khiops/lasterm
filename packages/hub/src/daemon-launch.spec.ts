import { closeSync, mkdtempSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildDaemonSpawnPlan,
	type ChildExitState,
	DAEMON_LOG_ENV,
	type DaemonRuntimeInfo,
	openDaemonLog,
	readDaemonLogTail,
	tailText,
	waitForDaemonReady,
} from "./daemon-launch.js";

describe("buildDaemonSpawnPlan", () => {
	const logPath = "/tmp/lasterm/state/hub-daemon.log";

	// Mutation: leave the log's path out of the child's environment, and the
	// daemon never takes its log over, so the file grows without bound again.
	it("uses the SEA CLI entry without re-passing --daemon, and names its log", () => {
		const plan = buildDaemonSpawnPlan({
			sea: true,
			port: 4321,
			moduleUrl: pathToFileURL("/tmp/lasterm/dist/cli.js").href,
			logPath,
		});

		expect(plan.args).toEqual(["start", "--port", "4321"]);
		expect(plan.args).not.toContain("--daemon");
		expect(plan.args).not.toContain("/tmp/lasterm/dist/main.js");
		expect(plan.env).toEqual({ LASTERM_PORT: "4321", [DAEMON_LOG_ENV]: logPath });
	});

	it("uses the compiled main.js sibling in dev mode and preserves open env", () => {
		const plan = buildDaemonSpawnPlan({
			sea: false,
			port: 4100,
			open: true,
			moduleUrl: pathToFileURL("/tmp/lasterm/dist/cli.js").href,
			logPath,
		});

		// pathToFileURL resolves the POSIX-looking path against the current drive
		// on Windows, so the expectation goes through the same resolution.
		expect(plan.args).toEqual([resolve("/tmp/lasterm/dist/main.js")]);
		expect(plan.env).toEqual({
			LASTERM_PORT: "4100",
			LASTERM_OPEN: "1",
			[DAEMON_LOG_ENV]: logPath,
		});
	});
});

describe("waitForDaemonReady", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const daemonRuntime: DaemonRuntimeInfo = {
		pid: 123,
		port: 49152,
		started_at: "2026-06-10T00:00:00.000Z",
	};

	/**
	 * The wait reads the monotonic clock itself. This fakes that clock and hands
	 * back a sleep that advances it, so a deadline passes on schedule without the
	 * test waiting for it.
	 */
	function sleepOnFakeMonotonicClock(): (ms: number) => Promise<void> {
		vi.useFakeTimers({ toFake: ["performance"] });
		return async (ms) => {
			vi.advanceTimersByTime(ms);
		};
	}

	it("preserves the native lock contention exit status", async () => {
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => ({ kind: "absent" }),
			fetchHealth: async () => ({}),
			getChildExit: () => ({ exited: true, code: 73, signal: null }),
			readLogTail: () => "LASTERM_HUB_ALREADY_RUNNING: another hub holds hub.lock",
			killChild: () => {},
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
			sleep: async () => {},
		});
		expect(result).toMatchObject({ reason: "already-running", message: "Hub already running" });
	});

	it("returns ready after an unreadable record when the free-lock child publishes its runtime", async () => {
		const sleep = sleepOnFakeMonotonicClock();
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
			sleep,
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
		const sleep = sleepOnFakeMonotonicClock();
		let killCount = 0;
		let reads = 0;
		const result = await waitForDaemonReady({
			childPid: 123,
			loadRuntime: () => {
				reads += 1;
				return { kind: "absent" };
			},
			fetchHealth: async () => ({ status: "ok" }),
			getChildExit: () => ({ exited: false }),
			readLogTail: () => "timeout log",
			killChild: () => {
				killCount += 1;
			},
			sleep,
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
		// Polled at 0, 10 and 20 ms, then once more at the 25 ms deadline.
		expect(reads).toBe(4);
		// A reported failure must not leave the detached child running.
		expect(killCount).toBe(1);
	});

	it("times out even when a health probe never settles", async () => {
		const sleep = sleepOnFakeMonotonicClock();
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
			sleep,
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

	// Mutation: take the deadline from Date.now(), as `start --daemon` did, and a
	// clock set forward while the daemon starts ends the wait at once: a false
	// timeout, and the daemon that was about to answer is killed for it.
	it("is not cut short by a wall clock set forward", async () => {
		const start = Date.now();
		let clockMoved = false;
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => (clockMoved ? start + 60 * 60_000 : start));
		let reads = 0;
		let killCount = 0;
		try {
			const result = await waitForDaemonReady({
				childPid: 123,
				loadRuntime: () => {
					reads += 1;
					clockMoved = true;
					return reads === 1
						? { kind: "absent" as const }
						: { kind: "present" as const, runtime: daemonRuntime };
				},
				fetchHealth: async () => ({ status: "ok" }),
				getChildExit: () => ({ exited: false }),
				readLogTail: () => "",
				killChild: () => {
					killCount += 1;
				},
				sleep: async () => {},
			});
			expect(result).toEqual({ ok: true, pid: 123, port: 49152 });
		} finally {
			clock.mockRestore();
		}
		expect(reads).toBe(2);
		expect(killCount).toBe(0);
	});

	// Mutation: take the deadline from Date.now(), and a clock set back while the
	// daemon starts stretches the wait by as much: an hour of polls before `start
	// --daemon` reports a daemon that never came up.
	it("still ends on time when the wall clock is set back", async () => {
		const start = Date.now();
		let clockMoved = false;
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => (clockMoved ? start - 60 * 60_000 : start));
		let reads = 0;
		let killCount = 0;
		try {
			const result = await waitForDaemonReady({
				childPid: 123,
				loadRuntime: () => {
					reads += 1;
					clockMoved = true;
					// Stands in for the hour the set-back clock would add: a deadline
					// that has already passed must not get this far.
					if (reads > 100) throw new Error("still polling after the deadline passed");
					return { kind: "absent" };
				},
				fetchHealth: async () => ({ status: "ok" }),
				getChildExit: () => ({ exited: false }),
				readLogTail: () => "",
				killChild: () => {
					killCount += 1;
				},
				sleep: async () => {},
				deadlineMs: 0,
			});
			expect(result).toMatchObject({ ok: false, reason: "timeout" });
		} finally {
			clock.mockRestore();
		}
		expect(reads).toBe(1);
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
