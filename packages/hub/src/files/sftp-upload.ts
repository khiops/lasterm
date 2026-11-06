import { randomBytes } from "node:crypto";
import type { TransferVerification } from "@lasterm/shared";
import type { Stats } from "ssh2";
import {
	describeError,
	SftpChannelClosed,
	type SftpSession,
	sftpRequest,
} from "../session/ssh-file-transport.js";
import {
	entryFromMode,
	FileAccessError,
	type FileEntry,
	mapLimited,
	REASONS,
} from "./host-files.js";
import { baseNameOf, joinHostPath, type PathStyle, parentOf } from "./host-paths.js";
import {
	hostNotConnected,
	isMissing,
	type SftpFileBackend,
	type SharedSftp,
	sftpPathOf,
	statusOf,
} from "./sftp-files.js";
import {
	type FolderResult,
	isFolderLike,
	type OpenOptions,
	type PlaceResult,
	TargetExists,
	type UploadBackend,
	UploadInterrupted,
	type UploadSink,
	VerifyFailed,
} from "./upload-backend.js";

/**
 * How many bytes one SFTP write carries: under what ssh2 sends in one packet
 * to OpenSSH (34,000 bytes less its overhead), so that none is split.
 */
const PIECE_BYTES = 30 * 1024;

/**
 * How many writes of one file are in flight at once. Few: every byte in
 * flight sits in the SSH connection's send queue ahead of the keystrokes of
 * every terminal on that host, so on a slow link this bounds how far behind
 * file data a keystroke can be (#833). Four of 30 KiB still fill a fast link.
 */
const PIECES_IN_FLIGHT = 4;

/** Whether each connection's server replaces on a plain rename, asked once per connection. */
const renameProbes = new WeakMap<SharedSftp, Promise<boolean>>();

/** SFTP version 3 status codes (draft-ietf-secsh-filexfer-02). */
const PERMISSION_DENIED = 3;

/**
 * Whether the server named `extension` in its VERSION. ssh2 keeps what it
 * named, and refuses a request for one it did not before sending anything.
 */
function offers(session: SftpSession, extension: string): boolean {
	const named = (session.channel as unknown as { _extensions?: Record<string, string> })
		._extensions;
	return named?.[extension] !== undefined;
}

/** Whether ssh2 said the server does not offer an extension, as it does before sending anything. */
function unsupported(error: unknown): boolean {
	return error instanceof Error && /does not support/.test(error.message);
}

class SftpSink implements UploadSink {
	constructor(
		private readonly backend: SftpUploadBackend,
		private readonly session: SftpSession,
		private readonly handle: Buffer,
		private readonly path: string,
		private readonly options: OpenOptions,
	) {}

	async write(data: Buffer, offset: number): Promise<void> {
		const pieces: number[] = [];
		for (let at = 0; at < data.length; at += PIECE_BYTES) pieces.push(at);
		try {
			await mapLimited(pieces, PIECES_IN_FLIGHT, (at) =>
				sftpRequest<void>(this.session, (done) => {
					this.session.channel.write(
						this.handle,
						data,
						at,
						Math.min(PIECE_BYTES, data.length - at),
						offset + at,
						(error) => done(error, undefined),
					);
				}),
			);
		} catch (error) {
			throw this.backend.failure(error, "The file could not be written");
		}
	}

	async finish(): Promise<TransferVerification> {
		const what = "The file could not be written";
		try {
			// Where the server offers it; a server without it writes on close.
			await sftpRequest<void>(this.session, (done) => {
				this.session.channel.ext_openssh_fsync(this.handle, (error) => done(error, undefined));
			}).catch((error: unknown) => {
				if (!unsupported(error)) throw error;
			});
			if (this.options.mtime !== null) {
				const seconds = Math.floor(this.options.mtime / 1000);
				// Kept when the server lets it be; the file is whole either way.
				await sftpRequest<void>(this.session, (done) => {
					this.session.channel.futimes(this.handle, seconds, seconds, (error) =>
						done(error, undefined),
					);
				}).catch((error: unknown) => {
					if (error instanceof SftpChannelClosed || this.backend.lost) throw error;
				});
			}
			await sftpRequest<void>(this.session, (done) => {
				this.session.channel.close(this.handle, (error) => done(error, undefined));
			});
		} catch (error) {
			await this.abort();
			throw this.backend.failure(error, what);
		}
		const attrs = await this.backend.lstat(this.session, this.path);
		if (attrs?.size !== this.options.size) {
			throw new VerifyFailed(
				"SIZE_MISMATCH",
				`${attrs?.size ?? 0} of ${this.options.size} bytes are on the host`,
			);
		}
		return "size";
	}

	async abort(): Promise<void> {
		await sftpRequest<void>(this.session, (done) => {
			this.session.channel.close(this.handle, (error) => done(error, undefined));
		}).catch(() => {});
	}
}

/**
 * A remote host's files for an upload, over SFTP on the hub's own connection
 * to it. The session is held open for as long as the upload runs, since its
 * open files belong to it (`SharedSftp.hold`).
 *
 * SFTP version 3 has no "already exists": an exclusive open, a hard link or
 * a rename onto a name that exists fails with status 4 (`SSH_FX_FAILURE`),
 * like any other failure. After such a failure the name is looked at
 * (`lstat`): something there is a conflict, nothing an error.
 *
 * - The temporary is opened `wx` (CREAT | EXCL | WRITE), synced with
 *   `fsync@openssh.com` where offered, its time set with `futimes`.
 * - It is placed with `hardlink@openssh.com`, which refuses a name that
 *   exists, then removed. Without it, with the plain rename, which refuses
 *   one on OpenSSH (it links, or checks then renames) and on Win32-OpenSSH
 *   9.5 alike; a server whose rename replaces is found by a probe once per
 *   connection, and a new file is then written under its own name, `wx`.
 * - Replace is `posix-rename@openssh.com`, which replaces (Win32-OpenSSH's
 *   too); without it, the name is removed, then the temporary renamed onto it.
 */
export class SftpUploadBackend implements UploadBackend {
	readonly transport = "sftp";
	private readonly letGo: () => void;

	constructor(
		private readonly shared: SharedSftp,
		readonly style: PathStyle,
		private readonly browse: SftpFileBackend,
	) {
		this.letGo = shared.hold();
	}

	get lost(): boolean {
		return this.shared.lost;
	}

	list(dir: string): Promise<FileEntry[]> {
		return this.browse.list(dir, true);
	}

	stat(path: string): Promise<FileEntry> {
		return this.browse.stat(path);
	}

	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		return this.browse.freeSpace(dir);
	}

	async mkdirs(paths: readonly string[]): Promise<FolderResult[]> {
		const results: FolderResult[] = [];
		for (const path of paths) {
			try {
				await this.browse.mkdir(path);
				results.push({ kind: "created" });
			} catch (error) {
				if (!(error instanceof FileAccessError))
					throw this.failure(error, "The folder could not be created");
				if (error.code === "HOST_NOT_CONNECTED") throw error;
				if (error.code !== "ALREADY_EXISTS") {
					results.push({ kind: "failed", error });
					continue;
				}
				const there = await this.browse.stat(path).catch(() => null);
				results.push(
					there !== null && isFolderLike(there)
						? { kind: "merged" }
						: { kind: "clash", existing: there },
				);
			}
		}
		return results;
	}

	async open(path: string, options: OpenOptions): Promise<UploadSink> {
		const what = "The file could not be created";
		const session = await this.session(what);
		let handle: Buffer;
		try {
			handle = await sftpRequest<Buffer>(session, (done) => {
				session.channel.open(this.wire(path), options.resumeAt === 0 ? "wx" : "r+", done);
			});
		} catch (error) {
			if (options.resumeAt === 0 && !this.lost && !(error instanceof SftpChannelClosed)) {
				const there = await this.lstat(session, path);
				if (there !== null) throw new TargetExists(this.entry(path, there));
				if (isMissing(error)) {
					throw new FileAccessError("NOT_FOUND", `${what}: ${REASONS.PARENT_NOT_FOUND}`, {
						cause: error,
					});
				}
			}
			throw this.failure(error, what);
		}
		return new SftpSink(this, session, handle, path, options);
	}

	async place(temp: string, target: string, replace: boolean): Promise<PlaceResult> {
		const what = "The file could not be put in place";
		const session = await this.session(what);
		if (replace) {
			const there = await this.lstat(session, target);
			if (there?.isDirectory()) {
				throw new FileAccessError("ALREADY_EXISTS", `${what}: a folder has that name`);
			}
			try {
				await sftpRequest<void>(session, (done) => {
					session.channel.ext_openssh_rename(this.wire(temp), this.wire(target), (error) =>
						done(error, undefined),
					);
				});
				return { kind: "placed" };
			} catch (error) {
				if (!unsupported(error)) throw this.failure(error, what);
			}
			// No POSIX rename: the name is freed, then taken.
			if (there !== null) await this.removeOn(session, target);
			await this.rename(session, temp, target, what);
			return { kind: "placed" };
		}

		let linked: boolean;
		try {
			await sftpRequest<void>(session, (done) => {
				session.channel.ext_openssh_hardlink(this.wire(temp), this.wire(target), (error) =>
					done(error, undefined),
				);
			});
			linked = true;
		} catch (error) {
			if (!unsupported(error)) return this.placementFailed(session, error, target, what);
			linked = false;
		}
		if (linked) {
			await this.removeOn(session, temp);
			return { kind: "placed" };
		}
		try {
			await sftpRequest<void>(session, (done) => {
				session.channel.rename(this.wire(temp), this.wire(target), (error) =>
					done(error, undefined),
				);
			});
			return { kind: "placed" };
		} catch (error) {
			return this.placementFailed(session, error, target, what);
		}
	}

	async remove(path: string): Promise<void> {
		try {
			await this.removeOn(await this.shared.current(), path);
		} catch {
			// Left behind: nothing else can be done about it here.
		}
	}

	async placement(dir: string): Promise<"temp" | "direct"> {
		const session = await this.session("The folder could not be written in");
		// A hard link places without replacing, wherever it is offered.
		if (offers(session, "hardlink@openssh.com")) return "temp";
		let probe = renameProbes.get(this.shared);
		if (probe === undefined) {
			probe = this.probeRename(session, dir);
			renameProbes.set(this.shared, probe);
		}
		return (await probe) ? "direct" : "temp";
	}

	release(): void {
		this.letGo();
	}

	/**
	 * Whether this server's plain rename replaces what it lands on: two empty
	 * temporaries, created exclusively in `dir`, one renamed onto the other.
	 * Unknown counts as replacing, so that nothing is ever placed by a rename
	 * that might.
	 */
	private async probeRename(session: SftpSession, dir: string): Promise<boolean> {
		const random = randomBytes(8).toString("hex");
		const a = joinHostPath(dir, `.lasterm-probe.${random}.a.partial`, this.style);
		const b = joinHostPath(dir, `.lasterm-probe.${random}.b.partial`, this.style);
		try {
			for (const path of [a, b]) {
				const handle = await sftpRequest<Buffer>(session, (done) => {
					session.channel.open(this.wire(path), "wx", done);
				});
				await sftpRequest<void>(session, (done) => {
					session.channel.close(handle, (error) => done(error, undefined));
				});
			}
			const replaced = await sftpRequest<void>(session, (done) => {
				session.channel.rename(this.wire(a), this.wire(b), (error) => done(error, undefined));
			}).then(
				() => true,
				() => false,
			);
			return replaced || (await this.lstat(session, a)) === null;
		} catch {
			return true;
		} finally {
			await this.removeOn(session, a).catch(() => {});
			await this.removeOn(session, b).catch(() => {});
		}
	}

	/** Why an SFTP request of an upload failed, as the upload reads it. */
	failure(error: unknown, what: string): Error {
		if (this.lost) return hostNotConnected(error);
		if (error instanceof FileAccessError || error instanceof VerifyFailed) return error;
		if (error instanceof SftpChannelClosed) {
			return new UploadInterrupted("The SFTP channel to the host closed", { cause: error });
		}
		if (isMissing(error)) {
			return new FileAccessError("NOT_FOUND", `${what}: ${REASONS.NOT_FOUND}`, { cause: error });
		}
		if (statusOf(error) === PERMISSION_DENIED) {
			return new FileAccessError("PERMISSION_DENIED", `${what}: ${REASONS.PERMISSION_DENIED}`, {
				cause: error,
			});
		}
		return new FileAccessError("FILE_ACCESS_FAILED", `${what}: SFTP said ${describeError(error)}`, {
			cause: error,
		});
	}

	async lstat(session: SftpSession, path: string): Promise<Stats | null> {
		try {
			return await sftpRequest<Stats>(session, (done) => {
				session.channel.lstat(this.wire(path), done);
			});
		} catch (error) {
			if (isMissing(error)) return null;
			throw this.failure(error, "The path could not be read");
		}
	}

	private async placementFailed(
		session: SftpSession,
		error: unknown,
		target: string,
		what: string,
	): Promise<PlaceResult> {
		if (this.lost || error instanceof SftpChannelClosed) throw this.failure(error, what);
		const there = await this.lstat(session, target);
		if (there !== null) return { kind: "exists", existing: this.entry(target, there) };
		const parent = parentOf(target, this.style);
		if (parent !== null && (await this.lstat(session, parent)) === null) {
			throw new FileAccessError("NOT_FOUND", `${what}: ${REASONS.PARENT_NOT_FOUND}`, {
				cause: error,
			});
		}
		throw this.failure(error, what);
	}

	private async rename(
		session: SftpSession,
		from: string,
		to: string,
		what: string,
	): Promise<void> {
		try {
			await sftpRequest<void>(session, (done) => {
				session.channel.rename(this.wire(from), this.wire(to), (error) => done(error, undefined));
			});
		} catch (error) {
			throw this.failure(error, what);
		}
	}

	private removeOn(session: SftpSession, path: string): Promise<void> {
		return sftpRequest<void>(session, (done) => {
			session.channel.unlink(this.wire(path), (error) => done(error, undefined));
		}).catch((error: unknown) => {
			if (!isMissing(error)) throw error;
		});
	}

	private async session(what: string): Promise<SftpSession> {
		try {
			return await this.shared.current();
		} catch (error) {
			throw this.failure(error, what);
		}
	}

	private entry(path: string, attrs: Stats): FileEntry {
		return entryFromMode(baseNameOf(path, this.style), attrs.mode, attrs.size, attrs.mtime);
	}

	private wire(path: string): string {
		return sftpPathOf(path, this.style);
	}
}
