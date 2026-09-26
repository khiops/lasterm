/**
 * replace-file.ts
 *
 * The last step of every "write a temporary file, then rename it over the
 * target" in the hub and in the shared code: the rename, made to survive
 * another process reading the target on Windows (#588).
 *
 * There, libuv renames with MoveFileExW, which is not the POSIX-semantics
 * rename: it fails with EPERM while any other process has the target open,
 * even for a plain readFileSync. Measured on Windows 11, with one process
 * renaming over runtime.json in a loop for 3.5 s: 754 renames and no EPERM
 * alone; 566 renames and 154 EPERM while a second process read the file in a
 * loop. The readers are ordinary ones — a client looking for its hub's port,
 * `lasterm status`, an antivirus or the search indexer — and each holds the
 * file for microseconds. So on Windows a rename refused with EPERM, EACCES or
 * EBUSY is tried again after a short pause, a few times, well under a second
 * in all, before its error is let through.
 *
 * Elsewhere rename(2) replaces the target whoever has it open, and a failure
 * is final: the rename is made once, as before.
 *
 * The pauses are synchronous, because every caller is. A target that stays
 * held — a running executable, a loaded library — therefore costs its caller
 * the whole bound before the same error it used to get at once.
 *
 * The temporary file is the caller's: it is left where it is until the rename
 * succeeds or its error is thrown, and removing it then is up to the caller.
 *
 * The loop has the shape of removeTempDir in the hub's temp-dir fixture, which
 * waits out the same holders for the tests' removals, asynchronously.
 */

import { renameSync } from "node:fs";

/** What Windows answers while another process has the source or the target open. */
const HELD_FILE_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * The pause before each new attempt on Windows: twelve attempts, 425 ms of
 * waiting in all before the last error is thrown.
 *
 * The count is what beats a reader that keeps coming back; the pauses, what
 * outlasts one that holds on for a while. Against another process reading the
 * target in a tight loop, each attempt failed about one time in four,
 * independently of how long it had waited: of 7,000 publishes, 24% needed a
 * second attempt, 0.1% a sixth, and none more. Twelve attempts leave room for
 * a busier reader than that; the pauses stop growing at 50 ms so that they fit.
 */
export const REPLACE_FILE_RETRY_DELAYS_MS: readonly number[] = [
	5, 10, 20, 40, 50, 50, 50, 50, 50, 50, 50,
];

/** Substitutes for the environment, for tests. */
export interface ReplaceFileOptions {
	/** The platform whose rename semantics apply. Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
	/** The rename itself. Defaults to `fs.renameSync`. */
	readonly rename?: (from: string, to: string) => void;
	/** Blocks for the given number of milliseconds. Defaults to {@link sleepSync}. */
	readonly sleep?: (ms: number) => void;
}

/**
 * Rename `from` over `to`, replacing it. On Windows, a rename refused because
 * another process holds one of the files is tried again for a bounded time;
 * the error of the last attempt is thrown when that runs out. Any other error,
 * and any error on another platform, is thrown at once.
 */
export function replaceFileSync(from: string, to: string, options: ReplaceFileOptions = {}): void {
	const { platform = process.platform, rename = renameSync, sleep = sleepSync } = options;
	for (let attempt = 0; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (error) {
			const delay = REPLACE_FILE_RETRY_DELAYS_MS[attempt];
			if (platform !== "win32" || delay === undefined || !isHeldFileError(error)) throw error;
			sleep(delay);
		}
	}
}

function isHeldFileError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code !== undefined && HELD_FILE_CODES.has(code);
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms` milliseconds. Nothing ever notifies the cell, so the wait always runs out. */
export function sleepSync(ms: number): void {
	Atomics.wait(sleepCell, 0, 0, ms);
}
