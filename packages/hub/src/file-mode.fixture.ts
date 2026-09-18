import { statSync } from "node:fs";
import { expect } from "vitest";

/**
 * Assert a file's permission bits where the platform has them. On Windows,
 * chmod only toggles the read-only attribute and stat reports 0o666 for any
 * writable file, so a POSIX mode cannot hold there and the check is skipped;
 * the rest of the calling test still runs.
 */
export function expectPosixMode(path: string, mode: number): void {
	if (process.platform === "win32") return;
	expect(statSync(path).mode & 0o777).toBe(mode);
}
