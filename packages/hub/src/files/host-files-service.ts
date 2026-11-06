import type { HostOs } from "@lasterm/shared";
import type { Client as SshClient } from "ssh2";
import { readRemoteSystem, type SftpSupport } from "../session/agent-deployer.js";
import { ExecFileBackend } from "./exec-files.js";
import { expandVariables, lookupIn, referencedVariables } from "./expand-vars.js";
import {
	FileAccessError,
	type FileBackend,
	type FileEntry,
	type FileErrorCode,
	type FileListing,
	type FileStat,
	type FreeSpace,
	finishListing,
	isDefinitive,
	REASONS,
} from "./host-files.js";
import { normaliseHostPath, type PathStyle, parentOf, pathStyleOf } from "./host-paths.js";
import { LocalFileBackend, localHostOs } from "./local-files.js";
import { SFTP_IDLE_MS, SftpFileBackend, SharedSftp } from "./sftp-files.js";

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
	/**
	 * What decides the folder a panel opens at for a terminal (#836): its
	 * host's `transferFallbackDir` as the cascade resolves it for that
	 * terminal, and the variables its scopes and launch profile set, which the
	 * agent reads first when it expands a `cwd`. Absent: the home.
	 */
	startFolder?(channelId: string): StartFolderSettings;
	/** The local host's files; the hub's own file system unless a spec says otherwise. */
	local?: { backend: FileBackend; os: HostOs };
	/** How long a host's SFTP session stays open unused; `SFTP_IDLE_MS` by default. */
	sftpIdleMs?: number;
}

/** What the settings say of the folder a panel opens at, for one terminal. */
export interface StartFolderSettings {
	/** The folder for a terminal whose directory is unknown, as written: "" for the home. */
	readonly fallbackDir: string;
	/** The variables the terminal's SPAWN would carry, read before the host's own environment. */
	readonly env: Readonly<Record<string, string>>;
}

/** The errors that say the fallback folder cannot be opened, rather than that the host cannot be reached. */
const FALLBACK_REFUSALS: ReadonlySet<FileErrorCode> = new Set<FileErrorCode>([
	"NOT_FOUND",
	"NOT_A_DIRECTORY",
	"PERMISSION_DENIED",
	"UNSUPPORTED_PATH",
]);

/** Why the fallback folder `shown` is not the one listed, as the client shows it. */
function fallbackProblem(shown: string, reason: string): string {
	return `The fallback folder ${shown} cannot be opened: ${reason}`;
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
		client: SshClient,
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
	 * Over SSH commands only: SFTP has no request for the environment. An exec
	 * channel gets the environment a remote agent started over SSH gets.
	 */
	env(names: readonly string[]): Promise<ReadonlyMap<string, string>> {
		return this.exec.env(names);
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
	private readonly local: { backend: FileBackend; os: HostOs };
	private readonly sftpIdleMs: number;
	private readonly remotes = new WeakMap<SshClient, RemoteFiles>();
	private readonly detected = new WeakMap<SshClient, Promise<HostOs | null>>();

	constructor(private readonly deps: HostFilesDeps) {
		this.local = deps.local ?? { backend: new LocalFileBackend(), os: localHostOs() };
		this.sftpIdleMs = deps.sftpIdleMs ?? SFTP_IDLE_MS;
	}

	/**
	 * The entries of the folder `path`, or of the folder a panel opens at
	 * without one (#836): the fallback folder the settings name for a terminal
	 * whose directory is unknown, its variables expanded on the host, else the
	 * account's home. A fallback folder that cannot be opened gives the home,
	 * and says why; a host that cannot be reached is said as it is. The
	 * terminal's live directory (#834) is the client's to ask for by its path.
	 */
	async list(channelId: string, path: string | undefined, hidden: boolean): Promise<FileListing> {
		const { backend, style } = await this.reach(channelId);
		if (path !== undefined) {
			const dir = normalised(path, style);
			return finishListing(dir, await backend.list(dir, hidden), hidden);
		}
		const fallback = await this.fallbackListing(channelId, backend, style, hidden);
		if ("listing" in fallback) return fallback.listing;
		const home = await backend.home();
		return {
			...finishListing(home, await backend.list(home, hidden), hidden),
			start: "home",
			...(fallback.problem !== undefined ? { fallbackProblem: fallback.problem } : {}),
		};
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

	/**
	 * The fallback folder's listing, or why there is none: no fallback set
	 * (no problem), or one that cannot be opened (its problem). Its variables
	 * are expanded as the agent expands a terminal's `cwd`: from the
	 * terminal's own variables, then from the host's environment, without
	 * regard to case on Windows.
	 */
	private async fallbackListing(
		channelId: string,
		backend: FileBackend,
		style: PathStyle,
		hidden: boolean,
	): Promise<{ listing: FileListing } | { problem?: string }> {
		const settings = this.deps.startFolder?.(channelId);
		const written = settings?.fallbackDir.trim() ?? "";
		if (settings === undefined || written === "") return {};
		const ignoreCase = style === "windows";
		const ownVariables = lookupIn(settings.env, ignoreCase);
		const fromHost = referencedVariables(written).filter(
			(name) => ownVariables(name) === undefined,
		);
		let hostVariables: (name: string) => string | undefined = () => undefined;
		if (fromHost.length > 0) {
			try {
				hostVariables = lookupIn(await backend.env(fromHost), ignoreCase);
			} catch (error) {
				// A connection lost is said as it is; anything else leaves the
				// variables unread, and the folder they name unknown.
				if (error instanceof FileAccessError && error.code === "HOST_NOT_CONNECTED") throw error;
				const said = error instanceof Error ? error.message : String(error);
				return {
					problem: fallbackProblem(
						written,
						`its variables could not be read on the host (${said})`,
					),
				};
			}
		}
		const expanded = expandVariables(written, (name) => ownVariables(name) ?? hostVariables(name));
		const dir = normaliseHostPath(expanded, style);
		if (!dir.ok) return { problem: fallbackProblem(expanded, dir.reason) };
		try {
			const listing = finishListing(dir.path, await backend.list(dir.path, hidden), hidden);
			return { listing: { ...listing, start: "fallback" } };
		} catch (error) {
			if (error instanceof FileAccessError && FALLBACK_REFUSALS.has(error.code)) {
				const reason =
					error.code === "UNSUPPORTED_PATH"
						? error.message
						: REASONS[error.code as keyof typeof REASONS];
				return { problem: fallbackProblem(dir.path, reason) };
			}
			throw error;
		}
	}

	private async reach(channelId: string): Promise<{ backend: FileBackend; style: PathStyle }> {
		const channel = this.deps.channelHost(channelId);
		if (channel === null) throw new ChannelNotFound();
		if (channel.hostType === "local") {
			return { backend: this.local.backend, style: pathStyleOf(this.local.os) };
		}
		const host = this.deps.sshHost(channel.hostId);
		const client = host?.sshConnection ?? null;
		if (host === null || client === null) {
			throw new FileAccessError(
				"HOST_NOT_CONNECTED",
				"This terminal's host is not connected to the hub: connect it first",
			);
		}
		let remote = this.remotes.get(client);
		if (remote === undefined) {
			const os = this.deps.hostOs(channel.hostId) ?? (await this.detectOs(client));
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
		return { backend: remote, style: remote.style };
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
