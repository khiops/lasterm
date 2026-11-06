import type { HostOs } from "@lasterm/shared";
import type { Client as SshClient } from "ssh2";
import { readRemoteSystem, type SftpSupport } from "../session/agent-deployer.js";
import { ExecFileBackend } from "./exec-files.js";
import { ExecUploadBackend } from "./exec-upload.js";
import {
	FileAccessError,
	type FileBackend,
	type FileEntry,
	type FileListing,
	type FileStat,
	type FreeSpace,
	finishListing,
	isDefinitive,
} from "./host-files.js";
import { normaliseHostPath, type PathStyle, parentOf, pathStyleOf } from "./host-paths.js";
import { LocalFileBackend, localHostOs } from "./local-files.js";
import { LocalUploadBackend } from "./local-upload.js";
import { SFTP_IDLE_MS, SftpFileBackend, SharedSftp } from "./sftp-files.js";
import { SftpUploadBackend } from "./sftp-upload.js";
import type { UploadBackend } from "./upload-backend.js";

/** What the service reads of a host's SSH connection: an `SshAgent`, connected. */
export interface SshFileHost {
	/** The ssh2 connection while it is up; null once it is lost or closed. */
	readonly sshConnection: SshClient | null;
	/** Whether the server offers SFTP, as the connection's probe found (#722); null until it has. */
	readonly sftpSupport: SftpSupport | null;
}

export interface HostFilesDeps {
	/** The host a terminal runs on, and its type; null for an unknown terminal. */
	channelHost(channelId: string): { hostId: string; hostType: string } | null;
	/** The OS recorded for a host, null when no connection has detected it yet. */
	hostOs(hostId: string): HostOs | null;
	/** The connected SSH agent of a remote host, or null when none is connected to this hub. */
	sshHost(hostId: string): SshFileHost | null;
	/** The local host's files; the hub's own file system unless a spec says otherwise. */
	local?: { backend: FileBackend; os: HostOs; upload?: UploadBackend };
	/** How long a host's SFTP session stays open unused; `SFTP_IDLE_MS` by default. */
	sftpIdleMs?: number;
}

/** The terminal a request names is not one this hub knows. */
export class ChannelNotFound extends Error {
	constructor() {
		super("Channel not found");
		this.name = "ChannelNotFound";
	}
}

/**
 * A remote host's files: over SFTP where the server offers it, and over SSH
 * commands where it does not or where SFTP failed without a verdict. An answer
 * that settles the request (`isDefinitive`) is not asked again another way;
 * when both ways failed, the error says what each said, as the agent
 * deployment does (#722).
 */
class RemoteFiles implements FileBackend {
	private readonly shared: SharedSftp;
	private readonly sftp: SftpFileBackend;
	private readonly exec: ExecFileBackend;

	constructor(
		private readonly client: SshClient,
		readonly style: PathStyle,
		private readonly support: () => SftpSupport | null,
		idleMs: number,
	) {
		this.shared = new SharedSftp(client, idleMs);
		this.sftp = new SftpFileBackend(this.shared, style);
		this.exec = new ExecFileBackend(client, style, () => this.shared.lost);
	}

	home(): Promise<string> {
		return this.either((backend) => backend.home());
	}

	list(dir: string, hidden: boolean): Promise<FileEntry[]> {
		return this.either((backend) => backend.list(dir, hidden));
	}

	stat(path: string): Promise<FileEntry> {
		return this.either((backend) => backend.stat(path));
	}

	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		return this.either((backend) => backend.freeSpace(dir));
	}

	mkdir(path: string): Promise<void> {
		return this.either((backend) => backend.mkdir(path));
	}

	/**
	 * The way an upload writes on this host (#833): SFTP where the server
	 * offers it and its session opens, SSH commands otherwise. One way for a
	 * whole upload, unlike a listing: a file half written one way is not
	 * finished the other. Each upload holds its own, and lets go of it.
	 */
	async upload(): Promise<UploadBackend> {
		if (this.support()?.offered !== false) {
			try {
				await this.shared.current();
				return new SftpUploadBackend(this.shared, this.style, this.sftp);
			} catch {
				if (this.shared.lost) {
					throw new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost");
				}
			}
		}
		return new ExecUploadBackend(this.client, this.style, () => this.shared.lost, this.exec);
	}

	private async either<T>(request: (backend: FileBackend) => Promise<T>): Promise<T> {
		const support = this.support();
		let sftpSaid: string;
		if (support?.offered === false) {
			sftpSaid = `the server does not offer SFTP (${support.reason})`;
		} else {
			try {
				return await request(this.sftp);
			} catch (error) {
				if (isDefinitive(error)) throw error;
				sftpSaid = error instanceof Error ? error.message : String(error);
			}
		}
		try {
			return await request(this.exec);
		} catch (error) {
			if (isDefinitive(error)) throw error;
			const execSaid = error instanceof Error ? error.message : String(error);
			throw new FileAccessError(
				"FILE_ACCESS_FAILED",
				`Over SFTP: ${sftpSaid}. Over SSH commands: ${execSaid}`,
				{ cause: error },
			);
		}
	}
}

/**
 * Browsing the files of the host a terminal runs on (#832): its folders, what a
 * path is, the free space, and a new folder. One interface, three ways to the
 * files: the hub's own file system for the local host, and for a remote one
 * SFTP or SSH commands over the hub's own connection to it.
 *
 * Nothing here logs: a path or a name is the user's, at any level, and a
 * listing is a routine request.
 */
export class HostFilesService {
	private readonly local: { backend: FileBackend; os: HostOs; upload: UploadBackend };
	private readonly sftpIdleMs: number;
	private readonly remotes = new WeakMap<SshClient, RemoteFiles>();
	private readonly detected = new WeakMap<SshClient, Promise<HostOs | null>>();

	constructor(private readonly deps: HostFilesDeps) {
		const local = deps.local ?? { backend: new LocalFileBackend(), os: localHostOs() };
		this.local = { ...local, upload: local.upload ?? new LocalUploadBackend(local.os) };
		this.sftpIdleMs = deps.sftpIdleMs ?? SFTP_IDLE_MS;
	}

	/**
	 * The entries of the folder `path`, or of the folder a panel opens at
	 * without one: the account's home (the terminal's own folder, #834, and the
	 * configured one, #835, will come first).
	 */
	async list(channelId: string, path: string | undefined, hidden: boolean): Promise<FileListing> {
		const { backend, style } = await this.reach(channelId);
		const dir = path === undefined ? await backend.home() : normalised(path, style);
		return finishListing(dir, await backend.list(dir, hidden), hidden);
	}

	async stat(channelId: string, path: string): Promise<FileStat> {
		const { backend, style } = await this.reach(channelId);
		const target = normalised(path, style);
		return { ...(await backend.stat(target)), path: target };
	}

	async freeSpace(channelId: string, path: string | undefined): Promise<FreeSpace> {
		const { backend, style } = await this.reach(channelId);
		const dir = path === undefined ? await backend.home() : normalised(path, style);
		return { path: dir, ...(await backend.freeSpace(dir)) };
	}

	/** Create the folder `path`; its parent must exist, and it must not. */
	async mkdir(channelId: string, path: string): Promise<{ path: string }> {
		const { backend, style } = await this.reach(channelId);
		const target = normalised(path, style);
		if (parentOf(target, style) === null) {
			throw new FileAccessError("UNSUPPORTED_PATH", "A root cannot be created");
		}
		await backend.mkdir(target);
		return { path: target };
	}

	/** The host a terminal runs on, and its type; ChannelNotFound for one this hub does not know. */
	channelHost(channelId: string): { hostId: string; hostType: string } {
		const channel = this.deps.channelHost(channelId);
		if (channel === null) throw new ChannelNotFound();
		return channel;
	}

	/**
	 * The way an upload writes on a host, for one upload, which lets go of it
	 * when it is done with it (`UploadBackend.release`). The host must be
	 * connected: `HOST_NOT_CONNECTED` otherwise.
	 */
	async uploadBackend(hostId: string, hostType: string): Promise<UploadBackend> {
		if (hostType === "local") return this.local.upload;
		return (await this.remote(hostId)).upload();
	}

	private async reach(channelId: string): Promise<{ backend: FileBackend; style: PathStyle }> {
		const channel = this.channelHost(channelId);
		if (channel.hostType === "local") {
			return { backend: this.local.backend, style: pathStyleOf(this.local.os) };
		}
		const remote = await this.remote(channel.hostId);
		return { backend: remote, style: remote.style };
	}

	private async remote(hostId: string): Promise<RemoteFiles> {
		const host = this.deps.sshHost(hostId);
		const client = host?.sshConnection ?? null;
		if (host === null || client === null) {
			throw new FileAccessError(
				"HOST_NOT_CONNECTED",
				"This terminal's host is not connected to the hub: connect it first",
			);
		}
		let remote = this.remotes.get(client);
		if (remote === undefined) {
			const os = this.deps.hostOs(hostId) ?? (await this.detectOs(client));
			if (os === null) {
				throw new FileAccessError(
					"FILE_ACCESS_FAILED",
					"The host's system could not be detected, so its paths cannot be read",
				);
			}
			// Another request may have set it up while this one asked the host.
			remote =
				this.remotes.get(client) ??
				new RemoteFiles(client, pathStyleOf(os), () => host.sftpSupport, this.sftpIdleMs);
			this.remotes.set(client, remote);
		}
		return remote;
	}

	/** The OS of a host none of whose connections has recorded it, asked once per connection. */
	private detectOs(client: SshClient): Promise<HostOs | null> {
		let detected = this.detected.get(client);
		if (detected === undefined) {
			detected = readRemoteSystem(client).then(
				(system) => system?.parsed?.os ?? null,
				() => null,
			);
			this.detected.set(client, detected);
		}
		return detected;
	}
}

function normalised(path: string, style: PathStyle): string {
	const result = normaliseHostPath(path, style);
	if (!result.ok) throw new FileAccessError("UNSUPPORTED_PATH", result.reason);
	return result.path;
}
