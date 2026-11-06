import type { FileEntryWithStats, Client as SshClient, Stats } from "ssh2";
import {
	describeError,
	openSftp,
	SftpChannelClosed,
	type SftpSession,
	sftpRequest,
} from "../session/ssh-file-transport.js";
import {
	entryFromMode,
	FileAccessError,
	type FileBackend,
	type FileEntry,
	isHiddenName,
	type LinkKind,
	linkKindOfMode,
	mapLimited,
	REASONS,
} from "./host-files.js";
import {
	baseNameOf,
	joinHostPath,
	normaliseHostPath,
	type PathStyle,
	parentOf,
	WINDOWS_ROOT,
} from "./host-paths.js";

/** How long a host's SFTP session stays open with nothing asked of it (#832). */
export const SFTP_IDLE_MS = 60_000;

/** How many links of a folder are followed at once. */
const LINK_CONCURRENCY = 32;

/** SFTP version 3 status codes (draft-ietf-secsh-filexfer-02). */
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

/** Said when the connection a request went over is gone. */
export function hostNotConnected(cause?: unknown): FileAccessError {
	return new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost", {
		cause,
	});
}

/**
 * The one SFTP session of an SSH connection: opened when first asked for,
 * shared by every request on that connection, and closed once nothing has used
 * it for `idleMs`. Each request is bound to the channel's life (`sftpRequest`):
 * a channel that closes fails the requests it carried, and the next request
 * opens another.
 */
export class SharedSftp {
	private session: SftpSession | null = null;
	private opening: Promise<SftpSession> | null = null;
	private users = 0;
	private idle: ReturnType<typeof setTimeout> | undefined;
	/** Whether the SSH connection ended: nothing can be asked of the host over it. */
	lost = false;

	constructor(
		private readonly client: SshClient,
		private readonly idleMs: number = SFTP_IDLE_MS,
	) {
		const gone = (): void => {
			this.lost = true;
			this.close();
		};
		client.once("end", gone);
		client.once("close", gone);
	}

	/** Run `task` on the session, opening it first if none is open. */
	async use<T>(task: (session: SftpSession) => Promise<T>): Promise<T> {
		this.users++;
		clearTimeout(this.idle);
		try {
			return await task(await this.open());
		} finally {
			this.users--;
			if (this.users === 0 && !this.lost) {
				this.idle = setTimeout(() => this.close(), this.idleMs);
				this.idle.unref?.();
			}
		}
	}

	/** End the session now, if one is open; the next request opens another. */
	close(): void {
		clearTimeout(this.idle);
		const session = this.session;
		this.session = null;
		if (session === null || session.ended) return;
		try {
			session.channel.end();
		} catch {
			// The connection is already gone, and the channel with it.
		}
	}

	private open(): Promise<SftpSession> {
		if (this.lost) return Promise.reject(hostNotConnected());
		if (this.session !== null && !this.session.ended) return Promise.resolve(this.session);
		if (this.opening !== null) return this.opening;
		const opening = openSftp(this.client).then((session) => {
			this.session = session;
			void session.endedSignal.then(() => {
				if (this.session === session) this.session = null;
			});
			return session;
		});
		this.opening = opening;
		const settled = (): void => {
			if (this.opening === opening) this.opening = null;
		};
		opening.then(settled, settled);
		return opening;
	}
}

function statusOf(error: unknown): number | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "number" ? code : undefined;
}

/** Whether the SFTP server said a path does not exist. */
function isMissing(error: unknown): boolean {
	return statusOf(error) === NO_SUCH_FILE;
}

/**
 * `path`, as the service normalised it, the way the host's SFTP server reads
 * it. A drive-absolute path goes as it is (`C:\…`, #716). A UNC path goes with
 * forward slashes (`//server/share/…`): Win32-OpenSSH 9.5 takes
 * `\\server\share` for a folder on drive C: and answers "No such file", which
 * the hub would otherwise take for the share's verdict (#832).
 */
export function sftpPathOf(path: string, style: PathStyle): string {
	return style === "windows" && path.startsWith("\\\\") ? path.replace(/\\/g, "/") : path;
}

/**
 * A host's files over SFTP, on the hub's own SSH connection to it.
 *
 * Paths go to the server as the service normalised them (`sftpPathOf`): POSIX,
 * or a Windows drive-absolute path, which Win32-OpenSSH takes as it is (#716),
 * or a UNC path with forward slashes. What it answers in its own form (`/C:/…`,
 * `///server/share/…`) is normalised back. Version 3 has no status for
 * "exists" or "not a folder", and Win32-OpenSSH answers most failures with the
 * generic one, so a failure is explained by a `stat` of the path.
 */
export class SftpFileBackend implements FileBackend {
	constructor(
		private readonly shared: SharedSftp,
		private readonly style: PathStyle,
	) {}

	/** `path` as this host's SFTP server reads it. */
	private wire(path: string): string {
		return sftpPathOf(path, this.style);
	}

	home(): Promise<string> {
		return this.run(async (session) => {
			const real = await sftpRequest<string>(session, (done) => {
				session.channel.realpath(".", done);
			});
			const home = normaliseHostPath(real, this.style);
			if (!home.ok) {
				throw new FileAccessError(
					"FILE_ACCESS_FAILED",
					`The home folder SFTP gave is not usable: ${home.reason}`,
				);
			}
			return home.path;
		}, "The home folder could not be found");
	}

	list(dir: string, hidden: boolean): Promise<FileEntry[]> {
		return this.run(async (session) => {
			let found: FileEntryWithStats[];
			try {
				found = await sftpRequest<FileEntryWithStats[]>(session, (done) => {
					session.channel.readdir(this.wire(dir), done);
				});
			} catch (error) {
				throw await this.explain(session, error, dir, "The folder could not be listed");
			}
			if (this.style === "windows" && dir === WINDOWS_ROOT) return drivesOf(found);
			const shown = found.filter(
				(entry) =>
					entry.filename !== "." &&
					entry.filename !== ".." &&
					(hidden || !isHiddenName(entry.filename)),
			);
			return mapLimited(shown, LINK_CONCURRENCY, (entry) =>
				this.entry(
					session,
					joinHostPath(dir, entry.filename, this.style),
					entry.filename,
					entry.attrs,
				),
			);
		}, "The folder could not be listed");
	}

	stat(path: string): Promise<FileEntry> {
		if (this.style === "windows" && path === WINDOWS_ROOT) {
			return Promise.resolve({ name: WINDOWS_ROOT, kind: "directory", size: null, mtime: null });
		}
		return this.run(async (session) => {
			let attrs: Stats;
			try {
				attrs = await sftpRequest<Stats>(session, (done) => {
					session.channel.lstat(this.wire(path), done);
				});
			} catch (error) {
				throw this.failure(error, "The path could not be read");
			}
			return this.entry(session, path, baseNameOf(path, this.style), attrs);
		}, "The path could not be read");
	}

	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		return this.run(async (session) => {
			let space: { f_frsize: unknown; f_blocks: unknown; f_bavail: unknown };
			try {
				space = await sftpRequest(session, (done) => {
					session.channel.ext_openssh_statvfs(this.wire(dir), done);
				});
			} catch (error) {
				if (error instanceof Error && /does not support/.test(error.message)) {
					throw new FileAccessError(
						"FILE_ACCESS_FAILED",
						"The SFTP server does not report free space (no statvfs@openssh.com)",
						{ cause: error },
					);
				}
				throw await this.explain(session, error, dir, "The free space could not be read");
			}
			const unit = Number(space.f_frsize);
			return { available: Number(space.f_bavail) * unit, total: Number(space.f_blocks) * unit };
		}, "The free space could not be read");
	}

	mkdir(path: string): Promise<void> {
		return this.run(async (session) => {
			const what = "The folder could not be created";
			try {
				await sftpRequest<void>(session, (done) => {
					session.channel.mkdir(this.wire(path), (error) => done(error, undefined));
				});
			} catch (error) {
				// Version 3 has no "exists": OpenSSH and Win32-OpenSSH both say FAILURE,
				// so what is there now is what says it.
				if ((await this.lstatOrNull(session, path)) !== null) {
					throw new FileAccessError("ALREADY_EXISTS", `${what}: ${REASONS.ALREADY_EXISTS}`, {
						cause: error,
					});
				}
				throw await this.explain(session, error, parentOf(path, this.style), what, true);
			}
		}, "The folder could not be created");
	}

	/**
	 * SFTP has no request that reads the environment: a host reached over SFTP
	 * is asked over SSH commands instead (`RemoteFiles`). Said without a
	 * verdict, so that another way is tried.
	 */
	async env(): Promise<ReadonlyMap<string, string>> {
		throw new FileAccessError(
			"FILE_ACCESS_FAILED",
			"The environment could not be read: SFTP has no request for it",
		);
	}

	/** Run `task` on the shared session, and name a lost connection or an SFTP that would not open. */
	private async run<T>(task: (session: SftpSession) => Promise<T>, what: string): Promise<T> {
		try {
			return await this.shared.use(task);
		} catch (error) {
			if (this.shared.lost) throw hostNotConnected(error);
			if (error instanceof FileAccessError) throw error;
			throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${describeError(error)}`, {
				cause: error,
			});
		}
	}

	private failure(error: unknown, what: string, parent = false): Error {
		if (this.shared.lost) return hostNotConnected(error);
		if (error instanceof SftpChannelClosed) return error;
		if (isMissing(error)) {
			const reason = parent ? REASONS.PARENT_NOT_FOUND : REASONS.NOT_FOUND;
			return new FileAccessError("NOT_FOUND", `${what}: ${reason}`, { cause: error });
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

	/**
	 * Why a request on the folder `dir` failed: it is missing or not a folder, as
	 * a `stat` says, or what SFTP said. `parent`: `dir` is the folder a new path
	 * would be in.
	 */
	private async explain(
		session: SftpSession,
		error: unknown,
		dir: string | null,
		what: string,
		parent = false,
	): Promise<Error> {
		if (this.shared.lost || error instanceof SftpChannelClosed || dir === null) {
			return this.failure(error, what, parent);
		}
		let attrs: Stats;
		try {
			attrs = await sftpRequest<Stats>(session, (done) => {
				session.channel.stat(this.wire(dir), done);
			});
		} catch (statError) {
			if (isMissing(statError)) {
				const reason = parent ? REASONS.PARENT_NOT_FOUND : REASONS.NOT_FOUND;
				return new FileAccessError("NOT_FOUND", `${what}: ${reason}`, { cause: error });
			}
			return this.failure(error, what, parent);
		}
		if (!attrs.isDirectory()) {
			const reason = parent ? REASONS.PARENT_NOT_A_DIRECTORY : REASONS.NOT_A_DIRECTORY;
			return new FileAccessError("NOT_A_DIRECTORY", `${what}: ${reason}`, { cause: error });
		}
		return this.failure(error, what, parent);
	}

	private async lstatOrNull(session: SftpSession, path: string): Promise<Stats | null> {
		try {
			return await sftpRequest<Stats>(session, (done) => {
				session.channel.lstat(this.wire(path), done);
			});
		} catch (error) {
			if (isMissing(error)) return null;
			throw this.failure(error, "The path could not be read", false);
		}
	}

	private async entry(
		session: SftpSession,
		path: string,
		name: string,
		attrs: Stats,
	): Promise<FileEntry> {
		const entry = entryFromMode(name, attrs.mode, attrs.size, attrs.mtime);
		if (entry.kind !== "symlink") return entry;
		const [target, linkKind] = await Promise.all([
			sftpRequest<string>(session, (done) => {
				session.channel.readlink(this.wire(path), done);
			}).catch(() => undefined),
			sftpRequest<Stats>(session, (done) => {
				session.channel.stat(this.wire(path), done);
			}).then(
				(followed): LinkKind => linkKindOfMode(followed.mode),
				(): LinkKind => "missing",
			),
		]);
		return { ...entry, ...(target !== undefined ? { linkTarget: target } : {}), linkKind };
	}
}

/** What Win32-OpenSSH lists at its root: a drive per entry, named `C:` (#832). */
function drivesOf(found: readonly FileEntryWithStats[]): FileEntry[] {
	const drives = new Set<string>();
	for (const { filename } of found) {
		const letter = /^([A-Za-z]):?[\\/]?$/.exec(filename)?.[1];
		if (letter !== undefined) drives.add(`${letter.toUpperCase()}:`);
	}
	return [...drives].map((name) => ({ name, kind: "directory", size: null, mtime: null }));
}
