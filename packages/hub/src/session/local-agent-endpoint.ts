/**
 * The local agent's endpoint, and the checks it passes before the hub writes to it.
 *
 * The first frame the hub sends the local agent carries the token of `auth.json`,
 * and what follows is terminal input and spawn requests, which can carry an
 * elevation password. So nothing is written until the endpoint is known to be
 * this account's own:
 *
 * - **Unix.** The socket's directory must be a real directory, not a symbolic
 *   link, owned by this user, with no permission for group or others. The
 *   socket itself must be a socket owned by this user. Once connected, the
 *   process at the other end must run as this user (`SO_PEERCRED`).
 * - **Windows.** The process serving the named pipe must run as this user: its
 *   token's user SID must be this process's (`GetNamedPipeServerProcessId`).
 *
 * Node has no call for either check, so the hub's native addon makes the
 * connection, and it reaches Node as a descriptor only after the addon has
 * answered. A refusal is a {@link LocalAgentEndpointError}: nothing is sent,
 * and the hub does not start an agent in its place.
 */
import { closeSync, lstatSync, mkdirSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { hubNativeAddon } from "../hub-lock.js";

export const LOCAL_AGENT_ENDPOINT_REFUSED = "LASTERM_LOCAL_AGENT_ENDPOINT_REFUSED";

/** The endpoint, or the directory holding it, is not this account's own. */
export class LocalAgentEndpointError extends Error {
	readonly code = LOCAL_AGENT_ENDPOINT_REFUSED;

	constructor(
		/** The path found wrong: the socket's directory, the socket, or the pipe. */
		readonly path: string,
		/** What is wrong with it. */
		readonly reason: string,
	) {
		super(`${LOCAL_AGENT_ENDPOINT_REFUSED}: refusing the local agent endpoint: ${path} ${reason}`);
		this.name = "LocalAgentEndpointError";
	}
}

/** What these checks read of a path: `fs.Stats`, or a test's stand-in. */
export interface EndpointStats {
	readonly uid: number;
	readonly mode: number;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
	isSocket(): boolean;
}

/** The filesystem calls the Unix checks make, replaceable in a test. */
export interface EndpointFs {
	/** `lstat`: throws an error with code `ENOENT` for a missing path. */
	lstat(path: string): EndpointStats;
	mkdir(path: string, options: { recursive: true; mode: number }): void;
	/** This process's effective user id. */
	uid(): number;
}

/** The native calls: see `crates/lasterm-hub-lock/src/local_agent.rs`. */
export interface LocalAgentNative {
	/** Connect, writing nothing. `fd` on success, `code` and `message` otherwise. */
	connectLocalAgent(path: string): { fd?: number; code?: string; message?: string };
	/** Throws unless the process at the other end runs as this process's user. */
	verifyLocalAgentPeer(fd: number): void;
}

export interface LocalAgentEndpointOptions {
	readonly platform?: NodeJS.Platform;
	readonly fs?: EndpointFs;
	readonly native?: LocalAgentNative;
	/** Closes a descriptor the checks refused. `fs.closeSync` by default. */
	readonly closeFd?: (fd: number) => void;
}

const nodeFs: EndpointFs = {
	lstat: (path) => lstatSync(path),
	mkdir: (path, options) => {
		mkdirSync(path, options);
	},
	uid: () => {
		if (typeof process.getuid !== "function") throw new Error("this platform has no user id");
		return process.getuid();
	},
};

/** How long a Windows pipe whose instances are all taken is tried again. */
const PIPE_BUSY_RETRY_MS = 2_000;
const PIPE_BUSY_POLL_MS = 20;

/**
 * Before connecting to the socket or starting an agent: make sure its directory
 * exists and is this user's own. Unix only; a named pipe has no directory.
 *
 * A missing directory is created 0700 (and any missing parent with it), then
 * looked at again and judged as if it had been found. It is never trusted
 * because this call created it: another process could have made it between the
 * two looks.
 */
export function ensurePrivateSocketDirectory(socketPath: string, fs: EndpointFs = nodeFs): void {
	const directory = dirname(socketPath);
	let stats = lstatIfPresent(fs, directory);
	if (stats === undefined) {
		try {
			fs.mkdir(directory, { recursive: true, mode: 0o700 });
		} catch (error) {
			// Something that is not a directory took the name: judged below.
			if (errorCode(error) !== "EEXIST") throw error;
		}
		stats = lstatIfPresent(fs, directory);
		if (stats === undefined) {
			throw codedError("ENOENT", `${directory} could not be created`);
		}
	}
	assertPrivateDirectory(directory, stats, fs.uid());
}

/**
 * The Unix checks before a connection: the socket's directory as
 * {@link ensurePrivateSocketDirectory} requires it, without creating it, and the
 * socket a socket this user owns. A missing directory or socket is an `ENOENT`
 * error, not a refusal: no agent is there yet.
 */
export function checkLocalAgentSocket(socketPath: string, fs: EndpointFs = nodeFs): void {
	const directory = dirname(socketPath);
	const own = fs.uid();
	const directoryStats = lstatIfPresent(fs, directory);
	if (directoryStats === undefined) {
		throw codedError("ENOENT", `no local agent: ${directory} does not exist`);
	}
	assertPrivateDirectory(directory, directoryStats, own);
	const socketStats = lstatIfPresent(fs, socketPath);
	if (socketStats === undefined) {
		throw codedError("ENOENT", `no local agent: ${socketPath} does not exist`);
	}
	if (socketStats.isSymbolicLink()) {
		throw new LocalAgentEndpointError(socketPath, "is a symbolic link, not a socket");
	}
	if (!socketStats.isSocket()) {
		throw new LocalAgentEndpointError(socketPath, "is not a socket");
	}
	if (socketStats.uid !== own) {
		throw new LocalAgentEndpointError(
			socketPath,
			`is owned by uid ${socketStats.uid}, not by this user (uid ${own})`,
		);
	}
}

/**
 * Connect to the local agent and return the stream, or refuse.
 *
 * Nothing has been written to the stream when it is returned, and nothing is
 * written to a refused one: the native side connects without writing, the
 * checks run on that connection, and a refused descriptor is closed.
 */
export async function openLocalAgentEndpoint(
	socketPath: string,
	options: LocalAgentEndpointOptions = {},
): Promise<net.Socket> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") checkLocalAgentSocket(socketPath, options.fs);
	const native = options.native ?? localAgentNative();
	const fd = await connectNative(native, socketPath, platform);
	const closeFd = options.closeFd ?? closeSync;
	try {
		native.verifyLocalAgentPeer(fd);
	} catch (error) {
		closeFd(fd);
		throw new LocalAgentEndpointError(
			socketPath,
			`failed the peer check: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		return new net.Socket({ fd, readable: true, writable: true });
	} catch (error) {
		closeFd(fd);
		throw error;
	}
}

/**
 * The native connection. A Windows pipe whose instances are all taken is one
 * whose agent is between two accepts: tried again for a moment, as Node's own
 * connect would.
 */
async function connectNative(
	native: LocalAgentNative,
	socketPath: string,
	platform: NodeJS.Platform,
): Promise<number> {
	const deadline = Date.now() + PIPE_BUSY_RETRY_MS;
	for (;;) {
		const result = native.connectLocalAgent(socketPath);
		if (typeof result.fd === "number") return result.fd;
		const code = result.code ?? "UNKNOWN";
		if (platform === "win32" && code === "EBUSY" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, PIPE_BUSY_POLL_MS));
			continue;
		}
		throw codedError(code, result.message ?? `cannot connect to the local agent at ${socketPath}`);
	}
}

function assertPrivateDirectory(directory: string, stats: EndpointStats, own: number): void {
	if (stats.isSymbolicLink()) {
		throw new LocalAgentEndpointError(directory, "is a symbolic link, not a directory");
	}
	if (!stats.isDirectory()) {
		throw new LocalAgentEndpointError(directory, "is not a directory");
	}
	if (stats.uid !== own) {
		throw new LocalAgentEndpointError(
			directory,
			`is owned by uid ${stats.uid}, not by this user (uid ${own})`,
		);
	}
	if ((stats.mode & 0o077) !== 0) {
		throw new LocalAgentEndpointError(
			directory,
			`gives group or others access (mode ${(stats.mode & 0o777).toString(8)}); it must be 700`,
		);
	}
}

function lstatIfPresent(fs: EndpointFs, path: string): EndpointStats | undefined {
	try {
		return fs.lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/** The native calls from the hub's addon. */
export function localAgentNative(): LocalAgentNative {
	const { exports, source } = hubNativeAddon();
	const native = exports as Partial<LocalAgentNative>;
	if (
		typeof native.connectLocalAgent !== "function" ||
		typeof native.verifyLocalAgentPeer !== "function"
	) {
		throw new Error(
			`native addon ${source} does not export connectLocalAgent and verifyLocalAgentPeer`,
		);
	}
	return native as LocalAgentNative;
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}
