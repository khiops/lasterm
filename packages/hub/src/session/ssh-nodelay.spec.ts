/**
 * Every SSH connection the hub opens over TCP has Nagle's algorithm off
 * (#873): ssh2's JavaScript ciphers write each packet in several pieces, and
 * with Nagle on, all but the first waited for the peer's delayed ACK, on each
 * request of an upload and each keystroke.
 *
 * Checked on real connections to a mock server on loopback, by what Node was
 * asked of each socket, rather than by timing: how long a delayed ACK takes
 * depends on the system, and on loopback some take none.
 *
 * With Nagle off, each of those pieces could leave as a segment of its own, so
 * the same sockets gather each turn's writes into one (#896). Checked by the
 * writes each socket hands the system per packet, and on a bare TCP pair for
 * what could leave a socket corked.
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
	encodeFrame,
	type HelloMessage,
	type Host,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import ssh2, { type Client, type ClientChannel, Server, type Server as SshServer } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { openJumpRoute } from "./jump-connection.js";
import { SshAgent } from "./ssh-agent.js";
import { attemptSshTest } from "./ssh-connection-manager.js";
import { coalesceWritesPerTick } from "./ssh-nodelay.js";

const HOST_ID = "01K6000000000000000000H873";

function rsaPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

const HOST_KEY = rsaPem();
const KEY_DIR = makeTempDir("lasterm-ssh-nodelay-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, rsaPem(), { mode: 0o600 });

const HOST_FINGERPRINT = (() => {
	const parsed = ssh2.utils.parseKey(HOST_KEY);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return fingerprintOf(key.getPublicSSH());
})();

const HELLO: HelloMessage = {
	type: "HELLO",
	version: PROTOCOL_VERSION,
	agentVersion: HUB_VERSION,
	capabilities: ["multiplex", "snapshot", "resize"],
};

afterAll(async () => {
	await removeTempDir(KEY_DIR);
});

type Stream = NodeJS.ReadWriteStream & { exit?: (code: number) => void };

interface MockServerOptions {
	/** A remote daemon runs there: its socket says HELLO, and every command ends at once. */
	daemon?: boolean;
	/** Routes to this port, as a jump host does. */
	forwardTo?: number;
	/** Told of each piece the hub sends in a channel: to its agent, its daemon or a route. */
	onData?: () => void;
}

/** An SSH server that lets anyone in; an agent exec'd on it says HELLO. */
function mockSshServer(options: MockServerOptions): Promise<{ server: SshServer; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (ctx) => ctx.accept());
			client.on("ready", () => {
				client.on("session", (accept) => {
					accept().on("exec", (acceptExec, _reject, info) => {
						const stream = acceptExec() as Stream;
						if (!options.daemon) {
							stream.on("data", () => options.onData?.());
							stream.write(Buffer.from(encodeFrame(HELLO)));
							return;
						}
						// Where the hub looks for the daemon's socket.
						if (info.command.includes("XDG_STATE_HOME"))
							stream.write("/home/pi/.local/state/lasterm");
						stream.exit?.(0);
						stream.end();
					});
				});
				client.on("tcpip", (accept, reject) => {
					if (options.forwardTo === undefined) {
						reject();
						return;
					}
					const stream = accept();
					stream.on("data", () => options.onData?.());
					const onward = net.connect(options.forwardTo, "127.0.0.1");
					onward.on("error", () => stream.destroy());
					stream.on("error", () => onward.destroy());
					stream.pipe(onward).pipe(stream);
				});
				(
					client as unknown as {
						on: (
							event: "openssh.streamlocal",
							listener: (accept: () => Stream, reject: () => void) => void,
						) => void;
					}
				).on("openssh.streamlocal", (accept, reject) => {
					if (!options.daemon) {
						reject();
						return;
					}
					const stream = accept();
					stream.on("data", () => options.onData?.());
					stream.write(Buffer.from(encodeFrame(HELLO)));
				});
			});
		});
		server.on("error", () => {});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as net.AddressInfo).port });
		});
	});
}

function makeHost(port: number): Host {
	return {
		id: HOST_ID,
		type: "ssh",
		label: "raspberrypi",
		sshHost: "127.0.0.1",
		sshPort: port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		iconType: "auto",
		trustRemoteHints: "ignore",
		sortOrder: 0,
		os: "linux",
		arch: "arm64",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(options: MockServerOptions = {}): Promise<number> {
	const { server, port } = await mockSshServer(options);
	cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
	return port;
}

/** A TCP socket some code asked Node to set Nagle's algorithm for. */
interface Asked {
	/** Where it connected to, read once it did. */
	port: number | undefined;
	/** Whether the last ask was for Nagle off. */
	noDelay: boolean;
}

/**
 * Every TCP socket asked to set Nagle's algorithm from now on. What Node is
 * asked before a socket connects, it applies once it is connected.
 */
function watchNoDelay(): Map<net.Socket, Asked> {
	const asked = new Map<net.Socket, Asked>();
	const setNoDelay = net.Socket.prototype.setNoDelay;
	vi.spyOn(net.Socket.prototype, "setNoDelay").mockImplementation(function (
		this: net.Socket,
		noDelay?: boolean,
	) {
		let entry = asked.get(this);
		if (entry === undefined) {
			const fresh: Asked = { port: undefined, noDelay: false };
			if (this.connecting) this.once("connect", () => (fresh.port = this.remotePort));
			else fresh.port = this.remotePort;
			asked.set(this, fresh);
			entry = fresh;
		}
		entry.noDelay = noDelay !== false;
		return setNoDelay.call(this, noDelay);
	});
	return asked;
}

/** Whether each socket to `port` that was asked has Nagle off. */
function socketsTo(asked: Map<net.Socket, Asked>, port: number): boolean[] {
	return [...asked.values()].filter((entry) => entry.port === port).map((entry) => entry.noDelay);
}

describe("every SSH connection the hub opens sends each packet at once (#873)", {
	timeout: 20_000,
}, () => {
	it("a host's own, which its agent on stdio is reached over", async () => {
		const port = await startServer();
		const asked = watchNoDelay();
		const agent = new SshAgent(makeHost(port));
		cleanups.push(() => agent.close());
		await agent.start(HOST_FINGERPRINT);
		expect(agent.connected).toBe(true);

		expect(socketsTo(asked, port)).toEqual([true]);
	});

	it("a host's own, which its remote daemon's socket is reached over (#79)", async () => {
		const port = await startServer({ daemon: true });
		const asked = watchNoDelay();
		const agent = new SshAgent(makeHost(port), undefined, undefined, undefined, true);
		cleanups.push(() => agent.close());
		await agent.start(HOST_FINGERPRINT);
		expect(agent.usedRemoteDaemon).toBe(true);

		// The daemon's socket is a channel of the host's connection: no socket of its own.
		expect(socketsTo(asked, port)).toEqual([true]);
	});

	it("a jump host's, which carries the connection of the host behind it", async () => {
		const targetPort = await startServer();
		const bastionPort = await startServer({ forwardTo: targetPort });
		const asked = watchNoDelay();
		const agent = new SshAgent(makeHost(targetPort));
		cleanups.push(() => agent.close());
		await agent.start(HOST_FINGERPRINT, null, undefined, {
			jump: { host: "127.0.0.1", port: bastionPort, username: "jump" },
			knownHostsNames: ["127.0.0.1"],
			auth: { method: "key", keyPath: CLIENT_KEY_PATH },
			promptHostId: HOST_ID,
			pinnedFingerprint: HOST_FINGERPRINT,
			trustKnownHosts: false,
			pinTo: { kind: "spec", hostId: HOST_ID },
		});
		expect(agent.connected).toBe(true);

		// The target's connection rides a channel of the bastion's: the hub's only
		// TCP socket is the one to the bastion, and the onward socket the mock
		// bastion's own.
		expect(socketsTo(asked, bastionPort)).toEqual([true]);
		expect(socketsTo(asked, targetPort)).toEqual([]);
	});

	it("a jump route a connection test opens", async () => {
		const targetPort = await startServer();
		const bastionPort = await startServer({ forwardTo: targetPort });
		const asked = watchNoDelay();
		const route = await openJumpRoute({
			jump: { host: "127.0.0.1", port: bastionPort, username: "jump" },
			knownHostsNames: ["127.0.0.1"],
			auth: {},
			pinnedFingerprint: HOST_FINGERPRINT,
			trustKnownHosts: false,
			destination: { host: "127.0.0.1", port: targetPort },
		});
		cleanups.push(() => route.close());

		expect(socketsTo(asked, bastionPort)).toEqual([true]);
	});

	it("a connection test's", async () => {
		const port = await startServer();
		const asked = watchNoDelay();

		const outcome = await attemptSshTest(
			{ host: "127.0.0.1", port, username: "tester" },
			new Set([HOST_FINGERPRINT]),
		);

		expect(outcome.result).toEqual({ ok: true });
		expect(socketsTo(asked, port)).toEqual([true]);
	});
});

/**
 * How many writes each TCP socket hands the system from now on. A call of
 * `_write` or `_writev` is one write, however many chunks it gathers.
 */
function watchWrites(): Map<net.Socket, number> {
	const counts = new Map<net.Socket, number>();
	const proto = net.Socket.prototype as unknown as Record<
		"_write" | "_writev",
		(...args: unknown[]) => void
	>;
	for (const method of ["_write", "_writev"] as const) {
		const original = proto[method];
		vi.spyOn(proto, method).mockImplementation(function (this: net.Socket, ...args: unknown[]) {
			counts.set(this, (counts.get(this) ?? 0) + 1);
			return Reflect.apply(original, this, args);
		});
	}
	return counts;
}

/** The writes of the sockets that reached `port`: the hub's, never the server's own. */
function writesTo(counts: Map<net.Socket, number>, port: number): number {
	let total = 0;
	for (const [socket, count] of counts) if (socket.remotePort === port) total += count;
	return total;
}

/** What the mock server is told of, one piece at a time. */
function arrivals(): { onData: () => void; next: () => Promise<void> } {
	let waiting: (() => void) | undefined;
	return {
		onData: () => {
			const resolve = waiting;
			waiting = undefined;
			resolve?.();
		},
		next: () => new Promise<void>((resolve) => (waiting = resolve)),
	};
}

const ROUNDS = 5;
const ONE_EACH = Array.from({ length: ROUNDS }, () => 1);
const KEYSTROKE: ProtocolMessage = {
	type: "INPUT",
	channelId: "01K6000000000000000000C896",
	data: new Uint8Array([0x61]),
};

/** Until `count` has stood still for 50 ms: whatever the connection still had to say is said. */
async function idle(count: () => number): Promise<void> {
	let last = count();
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		const now = count();
		if (now === last) return;
		last = now;
	}
}

/**
 * The writes the hub's sockets to `port` make for each of a few small packets
 * `send` sends, each counted once the server has it.
 */
async function writesPerPacket(
	counts: Map<net.Socket, number>,
	port: number,
	arrived: () => Promise<void>,
	send: () => void,
): Promise<number[]> {
	const rounds: number[] = [];
	for (let round = 0; round < ROUNDS; round++) {
		await idle(() => writesTo(counts, port));
		const before = writesTo(counts, port);
		const received = arrived();
		send();
		await received;
		rounds.push(writesTo(counts, port) - before);
	}
	return rounds;
}

function execOn(client: Client): Promise<ClientChannel> {
	return new Promise((resolve, reject) =>
		client.exec("cat", (error, stream) => (error ? reject(error) : resolve(stream))),
	);
}

// ssh2's AES-GCM, which it picks first, writes a packet's length, body and tag
// apart: three writes each, without the gathering.
describe("every SSH connection the hub opens sends each packet in one write (#896)", {
	timeout: 20_000,
}, () => {
	it("a host's own, a keystroke to its agent on stdio", async () => {
		const seen = arrivals();
		const port = await startServer({ onData: seen.onData });
		const counts = watchWrites();
		const agent = new SshAgent(makeHost(port));
		cleanups.push(() => agent.close());
		await agent.start(HOST_FINGERPRINT);

		const rounds = await writesPerPacket(counts, port, seen.next, () => agent.send(KEYSTROKE));
		expect(rounds).toEqual(ONE_EACH);
	});

	it("a host's own, a keystroke to its remote daemon's socket (#79)", async () => {
		const seen = arrivals();
		const port = await startServer({ daemon: true, onData: seen.onData });
		const counts = watchWrites();
		const agent = new SshAgent(makeHost(port), undefined, undefined, undefined, true);
		cleanups.push(() => agent.close());
		await agent.start(HOST_FINGERPRINT);
		expect(agent.usedRemoteDaemon).toBe(true);

		const rounds = await writesPerPacket(counts, port, seen.next, () => agent.send(KEYSTROKE));
		expect(rounds).toEqual(ONE_EACH);
	});

	it("a jump host's, a keystroke to the host behind it", async () => {
		const seen = arrivals();
		const targetPort = await startServer({ onData: seen.onData });
		const bastionPort = await startServer({ forwardTo: targetPort });
		const counts = watchWrites();
		const agent = new SshAgent(makeHost(targetPort));
		cleanups.push(() => agent.close());
		await agent.start(HOST_FINGERPRINT, null, undefined, {
			jump: { host: "127.0.0.1", port: bastionPort, username: "jump" },
			knownHostsNames: ["127.0.0.1"],
			auth: { method: "key", keyPath: CLIENT_KEY_PATH },
			promptHostId: HOST_ID,
			pinnedFingerprint: HOST_FINGERPRINT,
			trustKnownHosts: false,
			pinTo: { kind: "spec", hostId: HOST_ID },
		});

		// The target's packet, written in three pieces into the bastion's channel,
		// makes three of the bastion's packets: nine writes without.
		const rounds = await writesPerPacket(counts, bastionPort, seen.next, () =>
			agent.send(KEYSTROKE),
		);
		expect(rounds).toEqual(ONE_EACH);
	});

	it("a jump route a connection test opens, a packet down the route", async () => {
		const targetPort = await startServer();
		const seen = arrivals();
		const bastionPort = await startServer({ forwardTo: targetPort, onData: seen.onData });
		const counts = watchWrites();
		const route = await openJumpRoute({
			jump: { host: "127.0.0.1", port: bastionPort, username: "jump" },
			knownHostsNames: ["127.0.0.1"],
			auth: {},
			pinnedFingerprint: HOST_FINGERPRINT,
			trustKnownHosts: false,
			destination: { host: "127.0.0.1", port: targetPort },
		});
		cleanups.push(() => route.close());

		const rounds = await writesPerPacket(counts, bastionPort, seen.next, () =>
			route.stream.write("a"),
		);
		expect(rounds).toEqual(ONE_EACH);
	});

	it("a connection test's, a packet its probe sends", async () => {
		const seen = arrivals();
		const port = await startServer({ onData: seen.onData });
		const counts = watchWrites();
		let rounds: number[] = [];

		const outcome = await attemptSshTest(
			{ host: "127.0.0.1", port, username: "tester" },
			new Set([HOST_FINGERPRINT]),
			async (client) => {
				const stream = await execOn(client);
				rounds = await writesPerPacket(counts, port, seen.next, () => stream.write("a"));
				return undefined;
			},
		);

		expect(outcome.result).toEqual({ ok: true });
		expect(rounds).toEqual(ONE_EACH);
	});
});

/** A loopback TCP pair whose writer gathers each turn's writes. */
async function gatheringPair(): Promise<{
	writer: net.Socket;
	/** What the reader has read so far. */
	read: () => string;
	/** The reader saw the writer's FIN. */
	ended: Promise<void>;
	/** The writes the writer handed the system. */
	writes: () => number;
}> {
	let accept: (socket: net.Socket) => void = () => {};
	const accepted = new Promise<net.Socket>((resolve) => (accept = resolve));
	const server = net.createServer((socket) => accept(socket));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
	const counts = watchWrites();
	const writer = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
	writer.on("error", () => {});
	cleanups.push(() => writer.destroy());
	await new Promise<void>((resolve) => writer.once("connect", () => resolve()));
	writer.setNoDelay(true);
	coalesceWritesPerTick(writer);
	const reader = await accepted;
	cleanups.push(() => reader.destroy());
	let read = "";
	reader.setEncoding("latin1");
	reader.on("data", (data: string) => (read += data));
	reader.on("error", () => {});
	const ended = new Promise<void>((resolve) => reader.once("end", () => resolve()));
	return { writer, read: () => read, ended, writes: () => counts.get(writer) ?? 0 };
}

/** The turn after this one: every tick and promise queued so far has run. */
function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("a socket that gathers each turn's writes leaves nothing corked (#896)", {
	timeout: 10_000,
}, () => {
	it("sends one turn's writes in one write, and answers each", async () => {
		const pair = await gatheringPair();
		const answered: string[] = [];
		pair.writer.write("len", () => answered.push("len"));
		pair.writer.write("body", () => answered.push("body"));
		pair.writer.write("tag", () => answered.push("tag"));

		await vi.waitFor(() => expect(pair.read()).toBe("lenbodytag"));
		await vi.waitFor(() => expect(answered).toEqual(["len", "body", "tag"]));
		expect(pair.writes()).toBe(1);
		expect(pair.writer.writableCorked).toBe(0);
	});

	it("releases the writes of a timer, and of an immediate, at the end of their turn", async () => {
		const pair = await gatheringPair();
		setTimeout(() => {
			pair.writer.write("t1");
			pair.writer.write("t2");
		}, 1);
		await vi.waitFor(() => expect(pair.read()).toBe("t1t2"));
		setImmediate(() => {
			pair.writer.write("i1");
			pair.writer.write("i2");
		});
		await vi.waitFor(() => expect(pair.read()).toBe("t1t2i1i2"));

		expect(pair.writes()).toBe(2);
		expect(pair.writer.writableCorked).toBe(0);
	});

	it("joins a write of a tick queued before the release, and releases one queued after it", async () => {
		const pair = await gatheringPair();
		// Queued before the first write, so before the release it queues.
		process.nextTick(() => pair.writer.write("b"));
		pair.writer.write("a");
		// Queued after the release: it corks anew, and is released in the same queue.
		process.nextTick(() => {
			pair.writer.write("c");
			pair.writer.write("d");
		});

		await nextTurn();
		expect(pair.writer.writableCorked).toBe(0);
		await vi.waitFor(() => expect(pair.read()).toBe("abcd"));
		expect(pair.writes()).toBe(2);
	});

	it("sends what was written before end(), then its FIN", async () => {
		const pair = await gatheringPair();
		pair.writer.write("a");
		pair.writer.write("b");
		pair.writer.end();

		await pair.ended;
		expect(pair.read()).toBe("ab");
		expect(pair.writes()).toBe(1);
		await nextTurn();
		expect(pair.writer.writableCorked).toBe(0);
	});

	it("hands what was written before destroy() to the system first", async () => {
		const pair = await gatheringPair();
		pair.writer.write("a");
		pair.writer.write("b");
		pair.writer.destroy();

		await vi.waitFor(() => expect(pair.read()).toBe("ab"));
		expect(pair.writes()).toBe(1);
	});

	it("does the same before destroy(error), whose error is still the one told", async () => {
		const pair = await gatheringPair();
		const told = new Promise<Error>((resolve) => pair.writer.once("error", resolve));
		pair.writer.write("a");
		pair.writer.write("b");
		pair.writer.destroy(new Error("boom"));

		expect((await told).message).toBe("boom");
		await vi.waitFor(() => expect(pair.read()).toBe("ab"));
		expect(pair.writes()).toBe(1);
		expect(pair.writer.writableCorked).toBe(0);
	});

	it("releases a write that throws, and gathers the next turn's writes all the same", async () => {
		const pair = await gatheringPair();
		expect(() => pair.writer.write(42 as unknown as string)).toThrow();
		await nextTurn();
		expect(pair.writer.writableCorked).toBe(0);

		pair.writer.write("a");
		pair.writer.write("b");
		await vi.waitFor(() => expect(pair.read()).toBe("ab"));
		expect(pair.writes()).toBe(1);
	});
});
