import { promises as fs } from "node:fs";
import type { Readable } from "node:stream";
import { FileAccessError, REASONS } from "./host-files.js";
import { localFailure } from "./local-files.js";

/**
 * What a download needs of a host's files (#840): one regular file, read as a
 * stream, whichever way the hub reaches it. Every backend looks at the file it
 * opened twice, before the first byte and after the last, so that a file that
 * changes while it is read is never delivered whole (spec H3, H3b).
 *
 * Every path is absolute and normalised (`normaliseHostPath`). Nothing here
 * logs: a path or a name is the user's.
 */

/** The unit of a file's modification time, as its backend reads it: kept in the ETag. */
export type MtimeUnit = "ms" | "s" | "t";

/** What one look at a file says. */
export interface FileLook {
	readonly size: number;
	/** The modification time, in `unit`. */
	readonly mtime: number;
	readonly unit: MtimeUnit;
}

/** A file opened for a download. */
export interface OpenedFile {
	/** The first look, taken on the opened file; the response's headers come from it. */
	readonly look: FileLook;
	/**
	 * The bytes from `start`, `length` of them. Resolves once the bytes can
	 * flow: an SSH command's own look, which comes first, has agreed with
	 * `look` (`FILE_CHANGED` otherwise). Called once.
	 */
	read(start: number, length: number): Promise<Readable>;
	/** A second look, once the stream has ended. */
	recheck(): Promise<FileLook>;
	/** Let go of the file and of what holds it open. Never rejects; called once. */
	close(): Promise<void>;
}

/** One way to read a host's files, for a download. */
export interface ReadBackend {
	/**
	 * Open the regular file `path`: `NOT_FOUND`, `LINK_NOT_FOLLOWED` for a link
	 * the backend can tell, `NOT_A_FILE` for a folder or anything else that is
	 * not a regular file, `FILE_CHANGED` when the opened file is not the one the
	 * path named a moment before.
	 */
	open(path: string): Promise<OpenedFile>;
}

/** Whether two looks agree: the same size and modification time. */
export function sameLook(a: FileLook, b: FileLook): boolean {
	return a.size === b.size && a.mtime === b.mtime && a.unit === b.unit;
}

export function notAFile(what: string): FileAccessError {
	return new FileAccessError("NOT_A_FILE", `${what}: ${REASONS.NOT_A_FILE}`);
}

export function linkNotFollowed(what: string): FileAccessError {
	return new FileAccessError("LINK_NOT_FOLLOWED", `${what}: ${REASONS.LINK_NOT_FOLLOWED}`);
}

export function fileChanged(what: string): FileAccessError {
	return new FileAccessError("FILE_CHANGED", `${what}: ${REASONS.FILE_CHANGED}`);
}

const WHAT = "The file could not be read";

/** How much a local read reads ahead of the response. */
export const LOCAL_READ_HIGH_WATER = 64 * 1024;

/**
 * The hub's own file system, as the hub's OS user. A link is what `lstat` says
 * is a symbolic link (on Windows, what libuv reports as one: a symlink or a
 * junction); the opened file must be the one the `lstat` saw, by inode,
 * device, size and modification time.
 */
export class LocalReadBackend implements ReadBackend {
	constructor(
		private readonly hooks: {
			/** Called between the `lstat` and the open, for tests that change the file there. */
			readonly betweenLookAndOpen?: (path: string) => Promise<void>;
			/** Told the bytes each read took from the file, for tests that bound the read-ahead. */
			readonly onRead?: (bytes: number) => void;
			/** Called before the second look, for tests that change the file there. */
			readonly beforeRecheck?: (path: string) => Promise<void>;
		} = {},
	) {}

	async open(path: string): Promise<OpenedFile> {
		let before: import("node:fs").Stats;
		try {
			before = await fs.lstat(path);
		} catch (error) {
			throw localFailure(error, WHAT);
		}
		if (before.isSymbolicLink()) throw linkNotFollowed(WHAT);
		if (!before.isFile()) throw notAFile(WHAT);
		await this.hooks.betweenLookAndOpen?.(path);
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(path, "r");
		} catch (error) {
			throw localFailure(error, WHAT);
		}
		try {
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.ino !== before.ino ||
				opened.dev !== before.dev ||
				opened.size !== before.size ||
				Math.trunc(opened.mtimeMs) !== Math.trunc(before.mtimeMs)
			) {
				throw fileChanged(WHAT);
			}
			return new LocalOpenedFile(handle, lookOf(opened), this.hooks.onRead, async () =>
				this.hooks.beforeRecheck?.(path),
			);
		} catch (error) {
			await handle.close().catch(() => {});
			if (error instanceof FileAccessError) throw error;
			throw localFailure(error, WHAT);
		}
	}
}

function lookOf(stats: import("node:fs").Stats): FileLook {
	return { size: stats.size, mtime: Math.trunc(stats.mtimeMs), unit: "ms" };
}

class LocalOpenedFile implements OpenedFile {
	private closed = false;

	constructor(
		private readonly handle: fs.FileHandle,
		readonly look: FileLook,
		private readonly onRead?: (bytes: number) => void,
		private readonly beforeRecheck?: () => Promise<void>,
	) {}

	async read(start: number, length: number): Promise<Readable> {
		const stream = this.handle.createReadStream({
			start,
			end: start + length - 1,
			autoClose: false,
			highWaterMark: LOCAL_READ_HIGH_WATER,
		});
		const onRead = this.onRead;
		if (onRead !== undefined) {
			// `data` listeners see what the pipe takes, and leave its pacing alone.
			stream.on("data", (chunk: Buffer | string) => onRead(chunk.length));
		}
		return stream;
	}

	async recheck(): Promise<FileLook> {
		await this.beforeRecheck?.();
		try {
			return lookOf(await this.handle.stat());
		} catch (error) {
			throw localFailure(error, WHAT);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.handle.close().catch(() => {});
	}
}
