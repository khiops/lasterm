import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPLACE_FILE_RETRY_DELAYS_MS, replaceFileSync, sleepSync } from "./replace-file.js";

function errno(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: rename refused`), { code });
}

/** A rename that throws each of `errors` in turn, then succeeds; with a record of its calls. */
function scriptedRename(errors: readonly NodeJS.ErrnoException[]) {
	const calls: Array<[string, string]> = [];
	const rename = (from: string, to: string): void => {
		calls.push([from, to]);
		const error = errors[calls.length - 1];
		if (error !== undefined) throw error;
	};
	return { rename, calls };
}

function recordedSleep() {
	const pauses: number[] = [];
	return { sleep: (ms: number) => void pauses.push(ms), pauses };
}

describe("replaceFileSync on Windows", () => {
	it.each(["EPERM", "EACCES", "EBUSY"])(
		"renames once another process lets go, after %s twice",
		(code) => {
			const { rename, calls } = scriptedRename([errno(code), errno(code)]);
			const { sleep, pauses } = recordedSleep();
			replaceFileSync("from.tmp", "to", { platform: "win32", rename, sleep });
			expect(calls).toEqual([
				["from.tmp", "to"],
				["from.tmp", "to"],
				["from.tmp", "to"],
			]);
			expect(pauses).toEqual([5, 10]);
		},
	);

	it("throws the last error once the bound runs out, well under a second", () => {
		const errors = Array.from({ length: 20 }, () => errno("EPERM"));
		const { rename, calls } = scriptedRename(errors);
		const { sleep, pauses } = recordedSleep();
		let thrown: unknown;
		try {
			replaceFileSync("from.tmp", "to", { platform: "win32", rename, sleep });
		} catch (error) {
			thrown = error;
		}
		expect(calls).toHaveLength(REPLACE_FILE_RETRY_DELAYS_MS.length + 1);
		expect(thrown).toBe(errors[calls.length - 1]);
		expect(pauses).toEqual(REPLACE_FILE_RETRY_DELAYS_MS);
		expect(pauses.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(1000);
	});

	it("throws any other error at once", () => {
		const missing = errno("ENOENT");
		const { rename, calls } = scriptedRename([missing]);
		const { sleep, pauses } = recordedSleep();
		expect(() => replaceFileSync("from.tmp", "to", { platform: "win32", rename, sleep })).toThrow(
			missing,
		);
		expect(calls).toHaveLength(1);
		expect(pauses).toEqual([]);
	});

	it("throws an error without a code at once", () => {
		const odd = new Error("not an errno");
		const { rename, calls } = scriptedRename([odd as NodeJS.ErrnoException]);
		const { sleep, pauses } = recordedSleep();
		expect(() => replaceFileSync("from.tmp", "to", { platform: "win32", rename, sleep })).toThrow(
			odd,
		);
		expect(calls).toHaveLength(1);
		expect(pauses).toEqual([]);
	});
});

describe("replaceFileSync elsewhere", () => {
	// rename(2) replaces a target whoever has it open: a refusal there is final.
	it.each(["linux", "darwin"] as const)("renames once on %s, even after EPERM", (platform) => {
		const refused = errno("EPERM");
		const { rename, calls } = scriptedRename([refused]);
		const { sleep, pauses } = recordedSleep();
		expect(() => replaceFileSync("from.tmp", "to", { platform, rename, sleep })).toThrow(refused);
		expect(calls).toHaveLength(1);
		expect(pauses).toEqual([]);
	});
});

describe("replaceFileSync on this machine", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("replaces the target with the file and leaves nothing behind", () => {
		const dir = mkdtempSync(join(tmpdir(), "lasterm-replace-file-"));
		dirs.push(dir);
		const target = join(dir, "record.json");
		const temporary = join(dir, "record.json.tmp");
		writeFileSync(target, "old");
		writeFileSync(temporary, "new");
		replaceFileSync(temporary, target);
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(readdirSync(dir)).toEqual(["record.json"]);
	});

	it("sleeps for at least as long as it is asked", () => {
		const start = performance.now();
		sleepSync(30);
		expect(performance.now() - start).toBeGreaterThanOrEqual(25);
	});
});
