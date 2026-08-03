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
			moduleUrl: pathToFileURL("/tmp/termora/dist/cli.js").href,
		});

		expect(plan.args).toEqual(["start", "--port", "4321"]);
		expect(plan.args).not.toContain("--daemon");
		expect(plan.args).not.toContain("/tmp/termora/dist/main.js");
		expect(plan.env).toEqual({ TERMORA_PORT: "4321" });
	});

	it("uses the compiled main.js sibling in dev mode and preserves open env", () => {
		const plan = buildDaemonSpawnPlan({
			sea: false,
			port: 4100,
			open: true,
			moduleUrl: pathToFileURL("/tmp/termora/dist/cli.js").href,
		});

		expect(plan.args).toEqual(["/tmp/termora/dist/main.js"]);
		expect(plan.env).toEqual({ TERMORA_PORT: "4100", TERMORA_OPEN: "1" });
	});
});

describe("waitForDaemonReady", () => {
	it("returns ready after pid-matched runtime and health check on the actual port", async () => {
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
				return loadCount >= 2 ? { kind: "present" as const, runtime } : { kind: "absent" as const };
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
		const dir = mkdtempSync(join(tmpdir(), "termora-daemon-log-"));
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
		expect(readDaemonLogTail("/nonexistent/termora/hub-daemon.log")).toBe("");
	});
});

describe("openDaemonLog", () => {
	it("truncates a pre-existing log and clamps it owner-only", () => {
		const dir = mkdtempSync(join(tmpdir(), "termora-daemon-log-"));
		try {
			const logPath = join(dir, "hub-daemon.log");
			writeFileSync(logPath, "stale content from a previous daemon\n", { mode: 0o644 });

			const fd = openDaemonLog(logPath);
			try {
				writeSync(fd, "fresh\n");
			} finally {
				closeSync(fd);
			}

			const stat = statSync(logPath);
			// Truncated: only the fresh write remains, stale content is gone.
			expect(stat.size).toBe("fresh\n".length);
			if (process.platform !== "win32") {
				expect(stat.mode & 0o777).toBe(0o600);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
