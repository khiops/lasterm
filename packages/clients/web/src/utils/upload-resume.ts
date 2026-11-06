/**
 * Resuming an upload after a crash or a restart (#837, part of #721): the files of an upload this
 * device started, read again through the File System Access handles kept in IndexedDB
 * (`upload-handles.ts`).
 *
 * - **Read access is asked on the click.** A handle read back after a restart is in the "prompt"
 *   state: reading it fails with NotAllowedError, and `requestPermission` without a click fails
 *   with SecurityError. So Resume calls `requestPermission({ mode: "read" })` on every kept root
 *   **inside the click's handler**, before anything is awaited, and never decides from
 *   `queryPermission`, which keeps answering "prompt" in WebView2 when a saved grant will let
 *   `requestPermission` through at once. The answer is awaited **with a bound**: a request nobody
 *   answers (a desktop shell that does not handle it) must not hold Resume for ever.
 * - **Each file is checked before any byte moves**: read afresh (`getFile()` through its root's
 *   handle, which follows the path, not the file) and compared with the size and `lastModified`
 *   kept when it was sent. One appended to, or recreated at its path, shows a new size or date;
 *   one deleted fails with NotFoundError. A changed file is never sent silently: its user chooses
 *   to send it again from the start or to leave it out.
 *
 * The browser types are taken structurally, so that a spec gives plain objects.
 */
import type { KeptItem, KeptRoot, KeptUpload } from "./upload-handles.js";
import { bounded } from "./upload-walk.js";

/**
 * How long Resume waits for the answer to its request for read access. A browser asks its own
 * question for a restored handle ("Allow on every visit / Allow this time / Don't allow"), which
 * takes its user a moment; the desktop answers at once (#863).
 */
export const PERMISSION_WAIT_MS = 15_000;

/** How long reading one file again may take. */
export const FILE_WAIT_MS = 5_000;

/** How many files are read again at once. */
const CHECK_CONCURRENCY = 16;

/** What a handle offers for its permission. */
interface PermissionHandle {
	requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<string>;
}

/** A folder's handle, as a resume walks down it. */
interface DirectoryLookup {
	readonly kind: "directory";
	getDirectoryHandle(name: string): Promise<unknown>;
	getFileHandle(name: string): Promise<unknown>;
}

/** A file's handle, as a resume reads it. */
interface FileLookup {
	readonly kind: "file";
	getFile(): Promise<File>;
}

/** What came of asking read access to an upload's files. */
export type AccessOutcome =
	/** Every root may be read. */
	| "granted"
	/** The browser, or its user, refused. */
	| "denied"
	/** No answer came in time. */
	| "timeout"
	/** A root has no handle that can be asked: this browser cannot read it again. */
	| "unsupported";

/**
 * Ask read access to every root of a kept upload. **Call it inside the click's handler**, before
 * anything is awaited: each `requestPermission` is made there, while the click's activation
 * lasts, and only their answers are awaited, each within `waitMs`.
 */
export function askReadAccess(
	roots: readonly Pick<KeptRoot, "handle">[],
	waitMs = PERMISSION_WAIT_MS,
): Promise<AccessOutcome> {
	if (roots.length === 0) return Promise.resolve("unsupported");
	const asked: Promise<string>[] = [];
	for (const root of roots) {
		const handle = root.handle as PermissionHandle | null | undefined;
		if (typeof handle?.requestPermission !== "function") return Promise.resolve("unsupported");
		try {
			asked.push(handle.requestPermission({ mode: "read" }));
		} catch (error) {
			asked.push(Promise.reject(error));
		}
	}
	return Promise.all(asked.map((answer) => bounded(answer, waitMs))).then((answers) => {
		if (answers.some((answer) => !answer.ok && answer.reason === "timeout")) return "timeout";
		return answers.every((answer) => answer.ok && answer.value === "granted")
			? "granted"
			: "denied";
	});
}

/** A file of an upload as it is now, read again through its root. */
export interface ReadAgain {
	readonly itemId: number;
	readonly file: File;
}

/** A file that changed since its first bytes were sent: what was sent, and what it is now. */
export interface ChangedFile {
	readonly itemId: number;
	readonly relPath: string;
	readonly was: { readonly size: number; readonly lastModified: number };
	readonly file: File;
}

/** What a resume found of an upload's files. */
export interface FilesFound {
	/** As they were sent: they go on from what their host holds. */
	readonly same: readonly ReadAgain[];
	readonly changed: readonly ChangedFile[];
	/** No longer where they were. */
	readonly gone: readonly number[];
	/** There, but not readable now. */
	readonly unreadable: readonly number[];
	/** Files of the upload nothing was kept for: only a drop can give them again. */
	readonly unknown: readonly number[];
}

/** Whether an error says the file, or a folder on its way, is not there. */
function isGone(error: unknown): boolean {
	const name = (error as { name?: unknown } | null)?.name;
	return name === "NotFoundError" || name === "TypeMismatchError";
}

/** The file a kept item names, read afresh under its root. Throws as the API does. */
async function readUnder(root: unknown, pathInRoot: string, waitMs: number): Promise<File> {
	const step = async <T>(promise: Promise<T>): Promise<T> => {
		const got = await bounded(promise, waitMs);
		if (got.ok) return got.value;
		throw got.reason === "timeout" ? new Error("timed out") : got.error;
	};
	let at = root as DirectoryLookup | FileLookup;
	const names = pathInRoot === "" ? [] : pathInRoot.split("/");
	for (const [index, name] of names.entries()) {
		if (at.kind !== "directory")
			throw Object.assign(new Error(name), { name: "TypeMismatchError" });
		const last = index === names.length - 1;
		at = (await step(last ? at.getFileHandle(name) : at.getDirectoryHandle(name))) as
			| DirectoryLookup
			| FileLookup;
	}
	if (at.kind !== "file") throw Object.assign(new Error(pathInRoot), { name: "TypeMismatchError" });
	return step(at.getFile());
}

/**
 * Read again each of `itemIds` (the files of the upload not yet placed) through the kept handles,
 * and compare it with what was sent: its size and its `lastModified`.
 */
export async function findKeptFiles(
	kept: { readonly upload: KeptUpload; readonly items: readonly KeptItem[] },
	itemIds: readonly number[],
	waitMs = FILE_WAIT_MS,
): Promise<FilesFound> {
	const byId = new Map(kept.items.map((item) => [item.itemId, item]));
	const same: ReadAgain[] = [];
	const changed: ChangedFile[] = [];
	const gone: number[] = [];
	const unreadable: number[] = [];
	const unknown: number[] = [];
	const look = async (itemId: number): Promise<void> => {
		const item = byId.get(itemId);
		const root = item === undefined ? undefined : kept.upload.roots[item.root];
		if (item === undefined || root === undefined) {
			unknown.push(itemId);
			return;
		}
		let file: File;
		try {
			file = await readUnder(root.handle, item.pathInRoot, waitMs);
		} catch (error) {
			(isGone(error) ? gone : unreadable).push(itemId);
			return;
		}
		if (file.size === item.size && file.lastModified === item.lastModified) {
			same.push({ itemId, file });
		} else {
			changed.push({
				itemId,
				relPath: item.relPath,
				was: { size: item.size, lastModified: item.lastModified },
				file,
			});
		}
	};
	const queue = [...itemIds];
	const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, queue.length) }, async () => {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) await look(next);
	});
	await Promise.all(workers);
	const byItem = (a: number, b: number) => a - b;
	return {
		same: same.sort((a, b) => a.itemId - b.itemId),
		changed: changed.sort((a, b) => a.itemId - b.itemId),
		gone: gone.sort(byItem),
		unreadable: unreadable.sort(byItem),
		unknown: unknown.sort(byItem),
	};
}
