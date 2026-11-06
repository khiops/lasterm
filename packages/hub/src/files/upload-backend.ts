import { randomBytes } from "node:crypto";
import {
	MAX_NAME_BYTES,
	type TransferVerification,
	WINDOWS_MAX_PATH_LENGTH,
} from "@lasterm/shared";
import { FileAccessError, type FileEntry } from "./host-files.js";
import { baseNameOf, joinHostPath, type PathStyle, parentOf } from "./host-paths.js";

/**
 * What an upload needs of a host's files (#833), whichever way the hub reaches
 * them: the hub's own file system, SFTP, or SSH commands. Every backend writes
 * a file to a temporary beside its target, created exclusively, then places it
 * under its name without replacing what is there; only a Replace asked for
 * replaces. What makes each step safe on each backend is said where it is
 * done (`local-upload.ts`, `sftp-upload.ts`, `exec-upload.ts`).
 *
 * Every path is absolute and normalised (`normaliseHostPath`). Nothing here
 * logs: a path or a name is the user's.
 */

/** How the hub reaches a host's files for an upload. */
export type UploadTransport = "local" | "sftp" | "exec";

/** What a folder of an upload came to. */
export type FolderResult =
	| { readonly kind: "created" }
	/** A folder (or a link to one) has that name: the upload goes into it. */
	| { readonly kind: "merged" }
	/** Something that is not a folder has that name. */
	| { readonly kind: "clash"; readonly existing: FileEntry | null }
	| { readonly kind: "failed"; readonly error: FileAccessError };

/** What placing a file under its name came to. */
export type PlaceResult =
	| { readonly kind: "placed" }
	/** Something has that name: nothing was replaced, and the temporary is where it was. */
	| { readonly kind: "exists"; readonly existing: FileEntry | null };

/** Something has the name a file was to be created under exclusively. */
export class TargetExists extends Error {
	constructor(readonly existing: FileEntry | null) {
		super("Something has that name already");
		this.name = "TargetExists";
	}
}

/** What arrived is not what was sent: the file is not placed, and its temporary goes. */
export class VerifyFailed extends Error {
	constructor(
		readonly code: "SIZE_MISMATCH" | "HASH_MISMATCH",
		message: string,
	) {
		super(message);
		this.name = "VerifyFailed";
	}
}

/** The connection a write went over is gone, or its channel closed: the file can resume. */
export class UploadInterrupted extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "UploadInterrupted";
	}
}

/** Whether `error` stopped a file the way a retry resumes, rather than failing it. */
export function isInterruption(error: unknown): boolean {
	return (
		error instanceof UploadInterrupted ||
		(error instanceof FileAccessError && error.code === "HOST_NOT_CONNECTED")
	);
}

/** How a file is opened for its bytes. */
export interface OpenOptions {
	/** 0: create the file, exclusively. More: append to it from there, as it holds that much. */
	readonly resumeAt: number;
	/** Its size once whole. */
	readonly size: number;
	/** Its modification time, in milliseconds since the epoch, kept on the host when given. */
	readonly mtime: number | null;
	/** Over SSH commands: the host hashes it once whole, for the hub to compare. */
	readonly hash: boolean;
}

/** A file being written on a host. */
export interface UploadSink {
	/** Write `data` at `offset`, and resolve once the host acknowledged all of it. */
	write(data: Buffer, offset: number): Promise<void>;
	/**
	 * Every byte is written: flush it, set its time, close it, and check that
	 * the host holds `size` bytes, and over SSH commands that their SHA-256 is
	 * `sha256` when given. Throws `VerifyFailed` when it is not so.
	 */
	finish(sha256: string | null): Promise<TransferVerification>;
	/** Stop writing, keeping what was written. Never rejects. */
	abort(): Promise<void>;
}

/** One way to a host's files, for an upload. */
export interface UploadBackend {
	readonly transport: UploadTransport;
	readonly style: PathStyle;
	/** Whether the connection this backend goes over is gone. */
	readonly lost: boolean;
	/** The entries of `dir`, hidden ones included, links not followed. */
	list(dir: string): Promise<FileEntry[]>;
	/** What `path` is, as `lstat` says; `NOT_FOUND` when nothing is there. */
	stat(path: string): Promise<FileEntry>;
	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }>;
	/** Create each folder, in order, each in a folder that exists; say what each came to. */
	mkdirs(paths: readonly string[]): Promise<FolderResult[]>;
	/** Open `path` for a file's bytes. Throws `TargetExists` when a new one finds the name taken. */
	open(path: string, options: OpenOptions): Promise<UploadSink>;
	/**
	 * Put the whole file `temp` under the name `target`: without replacing
	 * anything, unless `replace`. A folder is never replaced.
	 */
	place(temp: string, target: string, replace: boolean): Promise<PlaceResult>;
	/** Remove a file, if it is there. Never rejects. */
	remove(path: string): Promise<void>;
	/**
	 * Cut the file `path` to its first `size` bytes: a temporary that resumes
	 * after a hub restart keeps only what its host acknowledged (#860), since
	 * with several writes in flight a later one can land before an earlier,
	 * and its size proves nothing. `NOT_FOUND` when it is not there.
	 */
	truncate(path: string, size: number): Promise<void>;
	/**
	 * How a new file reaches its name in `dir`: through a temporary, or, where
	 * the host's rename replaces what it lands on and nothing else places
	 * without replacing, written under its own name directly, created
	 * exclusively (SFTP only).
	 */
	placement(dir: string): Promise<"temp" | "direct">;
	/** Let go of what the backend holds open for the upload, such as an SFTP session. */
	release(): void;
}

const encoder = new TextEncoder();

/** `name` cut to at most `bytes` UTF-8 bytes, at a character boundary, keeping at least one. */
function cutToBytes(name: string, bytes: number): string {
	let kept = "";
	for (const character of name) {
		if (encoder.encode(kept + character).length > bytes) break;
		kept += character;
	}
	return kept === "" ? ([...name][0] ?? "x") : kept;
}

/** The part of a temporary's name after the target's: `.<16 hex>.partial`. */
const TEMP_TAIL_LENGTH = ".0123456789abcdef.partial".length;

/**
 * The hidden temporary a file is written to beside its target, `.name.<16
 * hex>.partial` as the agent deployment names its own (#555): same folder,
 * so placing it stays on one file system, and unique. The target's name is
 * cut short when the temporary's would be over a name's 255 bytes, or, on a
 * Windows host, its path over MAX_PATH.
 */
export function tempPathFor(
	target: string,
	style: PathStyle,
	random: string = randomBytes(8).toString("hex"),
): string {
	const parent = parentOf(target, style);
	if (parent === null) throw new FileAccessError("UNSUPPORTED_PATH", "A root has no temporary");
	let name = cutToBytes(baseNameOf(target, style), MAX_NAME_BYTES - 1 - TEMP_TAIL_LENGTH);
	let temp = joinHostPath(parent, `.${name}.${random}.partial`, style);
	if (style === "windows" && temp.length > WINDOWS_MAX_PATH_LENGTH) {
		const over = temp.length - WINDOWS_MAX_PATH_LENGTH;
		name = [...name].slice(0, Math.max(1, [...name].length - over)).join("");
		temp = joinHostPath(parent, `.${name}.${random}.partial`, style);
	}
	return temp;
}

/**
 * The name Keep both gives the `n`th copy: `report (1).pdf`, `archive.tar (1).gz`,
 * `.bashrc (1)`, a folder `photos (1)`.
 */
export function keepBothName(name: string, n: number, kind: "file" | "dir"): string {
	const dot = kind === "file" ? name.lastIndexOf(".") : -1;
	if (dot <= 0) return `${name} (${n})`;
	return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** Whether an entry is a folder, or a link to one: what an incoming folder merges into. */
export function isFolderLike(entry: FileEntry): boolean {
	return entry.kind === "directory" || (entry.kind === "symlink" && entry.linkKind === "directory");
}
