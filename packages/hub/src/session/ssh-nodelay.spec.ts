/**
 * Every SSH connection the hub opens over TCP has Nagle's algorithm off
 * (#873): ssh2's JavaScript ciphers write each packet in several pieces, and
 * with Nagle on, all but the first waited for the peer's delayed ACK, on each
 * request of an upload and each keystroke.
 *
 * Checked on real connections to a mock server on loopback, by what Node was
 * asked of each socket, rather than by timing: how long a delayed ACK takes
 * depends on the system, and on loopback some take none.
 */

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { encodeFrame, type HelloMessage, type Host, PROTOCOL_VERSION } from "@lasterm/shared";
import ssh2, { Server, type Server as SshServer } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { openJumpRoute } from "./jump-connection.js";
import { SshAgent } from "./ssh-agent.js";
import { attemptSshTest } from "./ssh-connection-manager.js";

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
					accept().write(Buffer.from(encodeFrame(HELLO)));
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
