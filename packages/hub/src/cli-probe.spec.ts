import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { identifyRecordedProcess } from "./cli.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: vi.fn() };
});

// ─── Asking who holds a pid, within a bound ──────────────────────────────────
//
// `status` asks who holds the pid of a hub whose port refuses. On Windows that
// is Windows PowerShell querying WMI: 2.5 s idle, 47 s on a loaded CI runner,
// unbounded if WMI stalls.

describe("identifyRecordedProcess — a probe that does not answer", () => {
	const PID = 424_242;

	beforeEach(() => {
		vi.mocked(execFileSync).mockReset();
	});

	it("does not know who holds the pid, as for a command line it could not read", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw Object.assign(new Error("spawnSync powershell ETIMEDOUT"), { code: "ETIMEDOUT" });
		});

		expect(identifyRecordedProcess(PID)).toBe("unknown");
	});

	it("asks with a bound, and without flashing a console", () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("no such process");
		});

		identifyRecordedProcess(PID);

		const probe = vi
			.mocked(execFileSync)
			.mock.calls.find(([file]) => file === "powershell" || file === "ps");
		expect(probe, JSON.stringify(vi.mocked(execFileSync).mock.calls)).toBeDefined();
		const options = probe?.[2] as { timeout?: number; windowsHide?: boolean } | undefined;
		expect(options?.timeout).toBeGreaterThan(0);
		expect(options?.timeout).toBeLessThanOrEqual(10_000);
		expect(options?.windowsHide).toBe(true);
	});
});
