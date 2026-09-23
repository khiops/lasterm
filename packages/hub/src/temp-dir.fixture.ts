/**
 * Test-only: a directory a spec makes under the system temp folder, and removes
 * when it is done with it (#524).
 *
 * On Windows an antivirus scanner or the search indexer can hold a file the
 * spec has just written, and deleting it fails until they let go. That is not a
 * defect in the code under test, so removal waits it out for a moment, and a
 * directory still held after that is reported and left in place: it never fails
 * the test that made it.
 *
 * The waiting is done here, around single attempts, rather than by the
 * `maxRetries` of Node's own removal. With Node 24 on Windows, `rmSync` reports
 * a file another process holds as EPERM and gives up at once, whatever
 * `maxRetries` says. `fs.promises.rm` does retry, but it retries each level of
 * the tree inside every retry of the level above: a file held one level down
 * kept it busy for 11 s with `maxRetries: 5`, and each further level multiplies
 * that, past the 30 s a hook is given.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** What a held or briefly busy file makes a removal fail with; the codes Node's own retries cover. */
const TRANSIENT_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);
/** The pause before each new attempt: 1.5 s in all before a directory is given up. */
const RETRY_DELAYS_MS = [100, 200, 300, 400, 500];

export interface RemoveTempDirOptions {
	/** Where a directory that could not be removed is reported. Defaults to `console.warn`. */
	readonly report?: (message: string) => void;
}

/** A new, empty directory under the system temp folder, its name starting with `prefix`. */
export function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Remove `dir` and everything in it. A directory that is already gone is fine.
 * One that cannot be removed is reported, and the promise still resolves.
 */
export async function removeTempDir(
	dir: string,
	{ report = console.warn }: RemoveTempDirOptions = {},
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const delay = RETRY_DELAYS_MS[attempt];
			if (delay === undefined || code === undefined || !TRANSIENT_CODES.has(code)) {
				report(
					`temporary directory ${dir} could not be removed and is left in place: ${code ?? String(error)}`,
				);
				return;
			}
			await sleep(delay);
		}
	}
}
