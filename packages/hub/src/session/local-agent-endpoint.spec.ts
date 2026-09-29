import { closeSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { encodeFrame, PROTOCOL_VERSION } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LastermAgent } from "./lasterm-agent.js";
import {
	checkLocalAgentSocket,
	type EndpointFs,
	type EndpointStats,
	ensurePrivateSocketDirectory,
	LOCAL_AGENT_ENDPOINT_REFUSED,
	LocalAgentEndpointError,
	type LocalAgentNative,
	localAgentNative,
	openLocalAgentEndpoint,
} from "./local-agent-endpoint.js";
import { getTestSocketPath } from "./test-socket-path.js";

const OWN_UID = 1000;
const SOCKET = "/run/user/1000/lasterm/agent.sock";
const DIRECTORY = dirname(SOCKET);

type Kind = "directory" | "socket" | "file" | "symlink";

function stats(kind: Kind, { uid = OWN_UID, mode = 0o700 } = {}): EndpointStats {
	return {
		uid,
		mode,
		isDirectory: () => kind === "directory",
		isSocket: () => kind === "socket",
		isSymbolicLink: () => kind === "symlink",
	};
}

function enoent(path: string): Error {
	return Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), {
		code: "ENOENT",
	});
}

/**
 * A filesystem of fixed answers. A path answers with the next entry of its
 * list, then keeps the last one, so a test can say what a second look sees.
 */
function fakeFs(entries: Record<string, Array<EndpointStats | "missing">>, uid = OWN_UID) {
	const looks = new Map<string, number>();
	const mkdir = vi.fn<EndpointFs["mkdir"]>();
	const lstat = vi.fn((path: string): EndpointStats => {
		const answers = entries[path] ?? ["missing"];
		const index = looks.get(path) ?? 0;
		looks.set(path, index + 1);
		const answer = answers[Math.min(index, answers.length - 1)];
		if (answer === undefined || answer === "missing") throw enoent(path);
		return answer;
	});
	const fs: EndpointFs = { lstat, mkdir, uid: () => uid };
	return { fs, lstat, mkdir };
}

function refusal(run: () => unknown): LocalAgentEndpointError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(LocalAgentEndpointError);
		return error as LocalAgentEndpointError;
	}
	throw new Error("expected a refusal");
}

describe("ensurePrivateSocketDirectory", () => {
	it("accepts a directory this user owns, open to nobody else, and creates nothing", () => {
		const { fs, mkdir } = fakeFs({ [DIRECTORY]: [stats("directory")] });
		ensurePrivateSocketDirectory(SOCKET, fs);
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("creates a missing directory 0700, then looks again", () => {
		const { fs, mkdir, lstat } = fakeFs({ [DIRECTORY]: ["missing", stats("directory")] });
		ensurePrivateSocketDirectory(SOCKET, fs);
		expect(mkdir).toHaveBeenCalledWith(DIRECTORY, { recursive: true, mode: 0o700 });
		expect(lstat).toHaveBeenCalledTimes(2);
	});

	it("judges a directory that appeared between the two looks as found, not as created", () => {
		// Missing at the first look; at the second, another account's.
		const { fs } = fakeFs({ [DIRECTORY]: ["missing", stats("directory", { uid: 0 })] });
		const error = refusal(() => ensurePrivateSocketDirectory(SOCKET, fs));
		expect(error.path).toBe(DIRECTORY);
		expect(error.reason).toBe("is owned by uid 0, not by this user (uid 1000)");
	});

	it("judges what took the name when creating it fails with EEXIST", () => {
		const { fs, mkdir } = fakeFs({ [DIRECTORY]: ["missing", stats("file")] });
		mkdir.mockImplementation(() => {
			throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
		});
		expect(refusal(() => ensurePrivateSocketDirectory(SOCKET, fs)).reason).toBe(
			"is not a directory",
		);
	});

	it("refuses a directory another account owns", () => {
		const { fs, mkdir } = fakeFs({ [DIRECTORY]: [stats("directory", { uid: 1001 })] });
		const error = refusal(() => ensurePrivateSocketDirectory(SOCKET, fs));
		expect(error.code).toBe(LOCAL_AGENT_ENDPOINT_REFUSED);
		expect(error.message).toBe(
			`${LOCAL_AGENT_ENDPOINT_REFUSED}: refusing the local agent endpoint: ${DIRECTORY} is owned by uid 1001, not by this user (uid 1000)`,
		);
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("refuses a symbolic link, wherever it points", () => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("symlink")] });
		expect(refusal(() => ensurePrivateSocketDirectory(SOCKET, fs)).reason).toBe(
			"is a symbolic link, not a directory",
		);
	});

	it.each([
		[0o755, "755"],
		[0o770, "770"],
		[0o701, "701"],
		[0o1777, "777"],
	])("refuses a directory whose mode is %o", (mode, shown) => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("directory", { mode: 0o40000 | mode })] });
		expect(refusal(() => ensurePrivateSocketDirectory(SOCKET, fs)).reason).toBe(
			`gives group or others access (mode ${shown}); it must be 700`,
		);
	});

	it("refuses a file where the directory should be", () => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("file")] });
		expect(refusal(() => ensurePrivateSocketDirectory(SOCKET, fs)).reason).toBe(
			"is not a directory",
		);
	});

	it("passes on an error that is not a missing path", () => {
		const { fs, lstat } = fakeFs({});
		lstat.mockImplementation(() => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		});
		expect(() => ensurePrivateSocketDirectory(SOCKET, fs)).toThrow(
			expect.objectContaining({ code: "EACCES" }),
		);
	});
});

describe("checkLocalAgentSocket", () => {
	it("accepts a socket this user owns in a private directory", () => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("directory")], [SOCKET]: [stats("socket")] });
		expect(() => checkLocalAgentSocket(SOCKET, fs)).not.toThrow();
	});

	it("says ENOENT, not a refusal, when there is no socket yet", () => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("directory")] });
		let thrown: unknown;
		try {
			checkLocalAgentSocket(SOCKET, fs);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).not.toBeInstanceOf(LocalAgentEndpointError);
		expect(thrown).toMatchObject({ code: "ENOENT" });
	});

	it("says ENOENT when there is no directory yet, and creates none", () => {
		const { fs, mkdir } = fakeFs({});
		expect(() => checkLocalAgentSocket(SOCKET, fs)).toThrow(
			expect.objectContaining({ code: "ENOENT" }),
		);
		expect(mkdir).not.toHaveBeenCalled();
	});

	it("refuses a socket in a directory open to others before looking at the socket", () => {
		const { fs, lstat } = fakeFs({
			[DIRECTORY]: [stats("directory", { mode: 0o755 })],
			[SOCKET]: [stats("socket")],
		});
		expect(refusal(() => checkLocalAgentSocket(SOCKET, fs)).path).toBe(DIRECTORY);
		expect(lstat).not.toHaveBeenCalledWith(SOCKET);
	});

	it("refuses a socket another account owns", () => {
		const { fs } = fakeFs({
			[DIRECTORY]: [stats("directory")],
			[SOCKET]: [stats("socket", { uid: 1001 })],
		});
		const error = refusal(() => checkLocalAgentSocket(SOCKET, fs));
		expect(error.path).toBe(SOCKET);
		expect(error.reason).toBe("is owned by uid 1001, not by this user (uid 1000)");
	});

	it.each<[Kind, string]>([
		["file", "is not a socket"],
		["directory", "is not a socket"],
		["symlink", "is a symbolic link, not a socket"],
	])("refuses a %s where the socket should be", (kind, reason) => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("directory")], [SOCKET]: [stats(kind)] });
		expect(refusal(() => checkLocalAgentSocket(SOCKET, fs)).reason).toBe(reason);
	});
});

describe("openLocalAgentEndpoint", () => {
	it("refuses a Unix endpoint on the filesystem checks without connecting", async () => {
		const { fs } = fakeFs({ [DIRECTORY]: [stats("directory", { uid: 1001 })] });
		const native: LocalAgentNative = {
			connectLocalAgent: vi.fn(() => ({ fd: 42 })),
			verifyLocalAgentPeer: vi.fn(),
		};
		await expect(
			openLocalAgentEndpoint(SOCKET, { platform: "linux", fs, native }),
		).rejects.toBeInstanceOf(LocalAgentEndpointError);
		expect(native.connectLocalAgent).not.toHaveBeenCalled();
	});

	it("passes a failed connection on with the code Node would give", async () => {
		const native: LocalAgentNative = {
			connectLocalAgent: () => ({ code: "ECONNREFUSED", message: "nobody listens" }),
			verifyLocalAgentPeer: vi.fn(),
		};
		const failure = openLocalAgentEndpoint(String.raw`\\.\pipe\x`, {
			platform: "win32",
			native,
		});
		await expect(failure).rejects.toMatchObject({
			code: "ECONNREFUSED",
			message: "nobody listens",
		});
		await expect(failure).rejects.not.toBeInstanceOf(LocalAgentEndpointError);
		expect(native.verifyLocalAgentPeer).not.toHaveBeenCalled();
	});
});

/** A daemon that says HELLO and records every byte it is sent. */
function recordingDaemon(socketPath: string) {
	const received: Buffer[] = [];
	const sockets: net.Socket[] = [];
	let ended = 0;
	const server = net.createServer((socket) => {
		sockets.push(socket);
		socket.on("error", () => {});
		socket.on("data", (data: Buffer) => received.push(data));
		socket.on("close", () => {
			ended += 1;
		});
		socket.write(
			Buffer.from(
				encodeFrame({
					type: "HELLO",
					version: PROTOCOL_VERSION,
					agentVersion: "0.1.0",
					capabilities: ["multiplex", "resize", "snapshot"],
				}),
			),
		);
	});
	const listening = new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		listening,
		received,
		get accepted() {
			return sockets.length;
		},
		get ended() {
			return ended;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
}

async function until(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// These go through the real native addon, on this platform's real endpoint: a
// Unix socket, or a named pipe on Windows.
describe("LastermAgent.connectLocal through the native checks", () => {
	let daemon: ReturnType<typeof recordingDaemon> | undefined;
	let agent: LastermAgent | undefined;

	afterEach(async () => {
		await agent?.close();
		agent = undefined;
		await daemon?.close();
		daemon = undefined;
	});

	it("accepts a daemon this process serves, and what the hub sends reaches it", async () => {
		const socketPath = getTestSocketPath();
		daemon = recordingDaemon(socketPath);
		await daemon.listening;

		agent = await LastermAgent.connectLocal(socketPath);
		agent.send({ type: "HEARTBEAT", ts: "2026-01-01T00:00:00.000Z" });

		await until(() => (daemon?.received.length ?? 0) > 0, "the frame");
	});

	it("refuses when the peer check fails, and nothing reaches the daemon", async () => {
		const socketPath = getTestSocketPath();
		daemon = recordingDaemon(socketPath);
		await daemon.listening;
		const real = localAgentNative();
		const closeFd = vi.fn((fd: number) => {
			closeSync(fd);
		});

		const attempt = LastermAgent.connectLocal(socketPath, undefined, {
			native: {
				connectLocalAgent: (path) => real.connectLocalAgent(path),
				verifyLocalAgentPeer: () => {
					throw new Error("the local agent runs as uid 0, not as this user (uid 1000)");
				},
			},
			closeFd,
		});

		const error = await attempt.then(
			() => {
				throw new Error("expected a refusal");
			},
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(LocalAgentEndpointError);
		expect(error).toMatchObject({
			code: LOCAL_AGENT_ENDPOINT_REFUSED,
			path: socketPath,
			reason: "failed the peer check: the local agent runs as uid 0, not as this user (uid 1000)",
		});
		expect((error as Error).message).toBe(
			`${LOCAL_AGENT_ENDPOINT_REFUSED}: refusing the local agent endpoint: ${socketPath} failed the peer check: the local agent runs as uid 0, not as this user (uid 1000)`,
		);
		expect(closeFd).toHaveBeenCalledTimes(1);
		// The daemon saw a connection open and close with nothing on it.
		await until(() => daemon?.ended === 1, "the refused connection to close");
		expect(daemon.accepted).toBe(1);
		expect(daemon.received).toEqual([]);
	});

	it("tries a busy Windows pipe again rather than giving up", async () => {
		const socketPath = getTestSocketPath();
		daemon = recordingDaemon(socketPath);
		await daemon.listening;
		const real = localAgentNative();
		let busy = 2;
		const connectLocalAgent = vi.fn((path: string) =>
			busy-- > 0 ? { code: "EBUSY", message: "all instances busy" } : real.connectLocalAgent(path),
		);

		agent = await LastermAgent.connectLocal(socketPath, undefined, {
			platform: "win32",
			native: { connectLocalAgent, verifyLocalAgentPeer: (fd) => real.verifyLocalAgentPeer(fd) },
		});
		expect(connectLocalAgent).toHaveBeenCalledTimes(3);
	});
});
