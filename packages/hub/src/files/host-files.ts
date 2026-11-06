/**
 * What browsing a host's files answers (#832), whichever way the hub reaches
 * them: the hub's own file system for the local host, SFTP or SSH commands for
 * a remote one. Every backend implements `FileBackend`; the file service picks
 * one per host.
 */

/** What an entry is, as `lstat` says: a link is a link, whatever it points to. */
export type FileKind = "file" | "directory" | "symlink" | "other";

/** What a link points to, followed: `missing` when it leads nowhere the host can reach. */
export type LinkKind = "file" | "directory" | "other" | "missing";

export interface FileEntry {
	readonly name: string;
	readonly kind: FileKind;
	/** Bytes, for a file or a link; null for a folder, or when the host does not say. */
	readonly size: number | null;
	/** Last modified, ISO 8601; null when the host does not say. */
	readonly mtime: string | null;
	/** What a link holds, as the host reads it; absent when it does not say. */
	readonly linkTarget?: string;
	/** What a link leads to, followed. Only on a link. */
	readonly linkKind?: LinkKind;
}

export interface FileListing {
	/** The folder listed, as `normaliseHostPath` spells it. */
	readonly path: string;
	/** Folders first, then by name; at most `LISTING_CAP`. */
	readonly entries: FileEntry[];
	/** How many more entries the folder holds past `LISTING_CAP`: 0 for a whole listing. */
	readonly truncated: number;
}

export interface FileStat extends FileEntry {
	readonly path: string;
}

/** The space the host's user may still write in a folder's file system, and its size, in bytes. */
export interface FreeSpace {
	readonly path: string;
	/** Null when the host does not say (a share whose space Windows does not report, for one). */
	readonly available: number | null;
	readonly total: number | null;
}

/** The most entries a listing returns; the count of the rest is in `truncated`. */
export const LISTING_CAP = 5_000;

export type FileErrorCode =
	| "HOST_NOT_CONNECTED"
	| "NOT_FOUND"
	| "NOT_A_DIRECTORY"
	| "ALREADY_EXISTS"
	| "PERMISSION_DENIED"
	| "UNSUPPORTED_PATH"
	| "FILE_ACCESS_FAILED";

/**
 * Why a request on a host's files did not succeed. Its message is the client's:
 * it may name the path, so it is never logged.
 */
export class FileAccessError extends Error {
	constructor(
		readonly code: FileErrorCode,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "FileAccessError";
	}
}

/** What each code says of a path, and of the folder a new one would be in. */
export const REASONS = {
	NOT_FOUND: "it does not exist",
	NOT_A_DIRECTORY: "it is not a folder",
	ALREADY_EXISTS: "it exists already",
	PERMISSION_DENIED: "permission denied",
	PARENT_NOT_FOUND: "the folder it would be in does not exist",
	PARENT_NOT_A_DIRECTORY: "what it would be in is not a folder",
} as const;

/**
 * An answer that settles a request whichever backend gave it: trying another
 * would only say the same. A `FILE_ACCESS_FAILED` does not: another way to the
 * host may succeed.
 */
export function isDefinitive(error: unknown): error is FileAccessError {
	return error instanceof FileAccessError && error.code !== "FILE_ACCESS_FAILED";
}

/**
 * One way to a host's files. Every path it is handed is absolute and already
 * normalised for the host's style (`normaliseHostPath`); it throws
 * `FileAccessError`, or anything else for a failure it cannot name.
 */
export interface FileBackend {
	/** The account's home folder, normalised. */
	home(): Promise<string>;
	/**
	 * The entries of `dir`, in any order. Hidden ones (a name starting with
	 * `.`) may be left out when `hidden` is false; the service drops any left in.
	 */
	list(dir: string, hidden: boolean): Promise<FileEntry[]>;
	stat(path: string): Promise<FileEntry>;
	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }>;
	/** Create the folder `path`, whose parent exists; refuse one that exists. */
	mkdir(path: string): Promise<void>;
}

/** Whether a name is hidden: it starts with a dot, on every host, whatever its attributes. */
export function isHiddenName(name: string): boolean {
	return name.startsWith(".");
}

function isFolderLike(entry: FileEntry): boolean {
	return entry.kind === "directory" || (entry.kind === "symlink" && entry.linkKind === "directory");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders (and links to them) first, then by name as a person reads it, ties by code point. */
export function compareEntries(a: FileEntry, b: FileEntry): number {
	const folders = Number(isFolderLike(b)) - Number(isFolderLike(a));
	if (folders !== 0) return folders;
	const named = collator.compare(a.name, b.name);
	if (named !== 0) return named;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** A backend's entries as a listing answers them: hidden ones dropped unless asked for, sorted, capped. */
export function finishListing(
	path: string,
	entries: readonly FileEntry[],
	hidden: boolean,
): FileListing {
	const shown = hidden ? [...entries] : entries.filter((entry) => !isHiddenName(entry.name));
	shown.sort(compareEntries);
	return {
		path,
		entries: shown.slice(0, LISTING_CAP),
		truncated: Math.max(0, shown.length - LISTING_CAP),
	};
}

/** Seconds since the epoch, as hosts report a time, in ISO 8601; null for anything else. */
export function isoFromSeconds(seconds: number | null | undefined): string | null {
	if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
	const date = new Date(seconds * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** POSIX `st_mode` type bits. */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

/** What a POSIX mode says an entry is. */
export function kindOfMode(mode: number): FileKind {
	switch (mode & S_IFMT) {
		case S_IFDIR:
			return "directory";
		case S_IFREG:
			return "file";
		case S_IFLNK:
			return "symlink";
		default:
			return "other";
	}
}

/** What a POSIX mode says a link leads to, once followed. */
export function linkKindOfMode(mode: number): LinkKind {
	const kind = kindOfMode(mode);
	return kind === "symlink" ? "other" : kind;
}

/** An entry from what a POSIX `stat` or SFTP says: its size only for what is not a folder. */
export function entryFromMode(
	name: string,
	mode: number,
	size: number | null,
	mtimeSeconds: number | null,
): FileEntry {
	const kind = kindOfMode(mode);
	return {
		name,
		kind,
		size: kind === "directory" ? null : size,
		mtime: isoFromSeconds(mtimeSeconds),
	};
}

/** Run `task` on every item, at most `limit` at a time, in order. */
export async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index] as T, index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
