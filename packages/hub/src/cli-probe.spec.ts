import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cmdStop } from "./cli.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFileSync: vi.fn() };
});

// ─── Asking who holds a pid, within a bound ──────────────────────────────────
//
// A runtime record without an owner token is stopped by signal, after checking
// that the pid is a hub. On Windows the check is Windows PowerShell querying
// WMI: 2.5 s idle, 47 s on a loaded CI runner, unbounded if WMI stalls — so
// `stop` could hang, and a test of it timed out.

describe("cmdStop — a probe that does not answer", () => {
	beforeEach(() => {
		vi.mocked(execFileSync).mockReset();
	});

	const legacyRuntime = () => ({
		kind: "present" as const,
		runtime: { pid: 424_242, port: 4100, started_at: "2026-06-18T00:00:00.000Z" },
	});

	it("refuses the signal, as for a command line it could not read", async () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw Object.assign(new Error("spawnSync powershell ETIMEDOUT"), { code: "ETIMEDOUT" });
		});

		await expect(
			cmdStop({ command: "stop" }, { loadRuntime: legacyRuntime, isPidAlive: () => true }),
		).rejects.toThrow("Refusing to signal pid 424242: process command line could not be read");
	});

	it("asks with a bound, and without flashing a console", async () => {
		vi.mocked(execFileSync).mockImplementation(() => {
			throw new Error("not a hub");
		});

		await cmdStop(
			{ command: "stop" },
			{ loadRuntime: legacyRuntime, isPidAlive: () => true },
		).catch(() => undefined);

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
