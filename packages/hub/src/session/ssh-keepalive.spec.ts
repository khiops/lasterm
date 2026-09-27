/**
 * A host that stops answering without closing TCP is lost like any other
 * (#607): its connection ends, its host goes disconnected, and the hub reaches
 * for it again, which is what a restart waits for (#605).
 *
 * The keepalive is shrunk here to a fifth of a second, so a silent host is
 * declared lost in 600 ms instead of a minute. The silence comes from a TCP
 * link that stops carrying bytes either way and closes nothing, which is what a
 * host that lost power, or a network cut, looks like from the hub.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
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
import ssh2, { Client, type ConnectConfig, Server, type Server as SshServer } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { type SecurityFields, SecurityLog } from "../logging/security-log.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { AgentConnectionManager } from "./agent-connection-manager.js";
import type { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import { hostReconnecting } from "./host-reachability.js";
import { openJumpRoute } from "./jump-connection.js";
import type { SharedSessionContext } from "./session-context.js";
import { SshAgent } from "./ssh-agent.js";
import { attemptSshTest, SshConnectionManager } from "./ssh-connection-manager.js";
import { SSH_KEEPALIVE } from "./ssh-keepalive.js";
import type { StateBroadcaster } from "./state-broadcaster.js";

vi.mock("./ssh-keepalive.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ssh-keepalive.js")>()),
	SSH_KEEPALIVE: { keepaliveInterval: 200, keepaliveCountMax: 2 },
}));

/** How long a silent host may take to be declared lost here, with room for a loaded machine. */
const LOST_WITHIN_MS =
	SSH_KEEPALIVE.keepaliveInterval * (SSH_KEEPALIVE.keepaliveCountMax + 1) + 2_000;

const HOST_ID = "01K6000000000000000000H607";
const SESSION_ID = "01K6000000000000000000S607";

function rsaPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

const HOST_KEY = rsaPem();
const KEY_DIR = makeTempDir("lasterm-ssh-keepalive-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, rsaPem(), { mode: 0o600 });

/** The fingerprint the hub records for the mock servers' key. */
const HOST_FINGERPRINT = (() => {
	const parsed = ssh2.utils.parseKey(HOST_KEY);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64")}`;
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

// ─── Fixtures ────────────────────────────────────────────────────────────────

type Stream = NodeJS.ReadWriteStream & { exit?: (code: number) => void };

interface MockServerOptions {
	/** An exec'd command: the agent on stdio, or a daemon's setup command. */
	onExec?: (stream: Stream, command: string) => void;
	/** A remote daemon's socket (#79), reached by `direct-streamlocal`. */
	onSocket?: (stream: Stream) => void;
	/** A route through this server, as a jump host opens one. */
	forwardTo?: number;
}

/** An SSH server that lets anyone in, and does what the options say. */
function mockSshServer(options: MockServerOptions): Promise<{ server: SshServer; port: number }> {
	return new Promise((resolve) => {
		const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
			client.on("error", () => {});
			client.on("authentication", (ctx) => ctx.accept());
			client.on("ready", () => {
				client.on("session", (accept) => {
					accept().on("exec", (acceptExec, _reject, info) => {
						options.onExec?.(acceptExec() as Stream, info.command);
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
					if (options.onSocket === undefined) {
						reject();
						return;
					}
					options.onSocket(accept());
				});
			});
		});
		server.on("error", () => {});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as net.AddressInfo).port });
		});
	});
}

/** An agent on stdio: it says HELLO, then stays, reading nothing in particular. */
function stdioAgent(stream: Stream): void {
	stream.write(Buffer.from(encodeFrame(HELLO)));
}

/**
 * A daemon that is already running: its state directory is where the hub
 * looks, and its socket says HELLO.
 */
const runningDaemon: MockServerOptions = {
	onExec: (stream, command) => {
		if (command.includes("XDG_STATE_HOME")) stream.write("/home/pi/.local/state/lasterm");
		stream.exit?.(0);
		stream.end();
	},
	onSocket: stdioAgent,
};

interface Link {
	port: number;
	/** From now on no byte crosses, either way, and nothing is closed. */
	goSilent: () => void;
	close: () => Promise<void>;
}

/** A TCP link to `targetPort` that can go silent, as a host that vanished does. */
function silenceableLink(targetPort: number): Promise<Link> {
	const sockets = new Set<net.Socket>();
	let silent = false;
	const server = net.createServer((inbound) => {
		const outbound = net.connect(targetPort, "127.0.0.1");
		for (const [from, to] of [
			[inbound, outbound],
			[outbound, inbound],
		] as const) {
			sockets.add(from);
			from.on("error", () => {});
			from.on("data", (bytes: Buffer) => {
				if (!silent) to.write(bytes);
			});
			from.on("close", () => {
				sockets.delete(from);
				to.destroy();
			});
		}
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: (server.address() as net.AddressInfo).port,
				goSilent: () => {
					silent = true;
				},
				close: () => {
					for (const socket of sockets) socket.destroy();
					return new Promise((done) => server.close(() => done()));
				},
			});
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
		historyRetentionDays: 30,
		os: "linux",
		arch: "arm64",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

/** Resolves when `agent` closes, and fails saying so if it is still up after `withinMs`. */
async function closes(agent: SshAgent, withinMs: number): Promise<number> {
	const startedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			once(agent, "close"),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`the connection was still up after ${withinMs} ms`)),
					withinMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	return Date.now() - startedAt;
}

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

/** A server, and a link in front of it that can go silent. */
async function reachableThroughLink(
	options: MockServerOptions,
): Promise<{ link: Link; serverPort: number }> {
	const { server, port } = await mockSshServer(options);
	cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
	const link = await silenceableLink(port);
	// The link goes first: the server waits for its connections to end.
	cleanups.push(() => link.close());
	return { link, serverPort: port };
}

/** An agent connected through `port`, closed at the end of the test. */
async function connectedAgent(
	port: number,
	remoteDaemon = false,
	jump?: Parameters<SshAgent["start"]>[3],
): Promise<SshAgent> {
	const agent = new SshAgent(makeHost(port), undefined, undefined, undefined, remoteDaemon);
	cleanups.push(() => agent.close());
	await agent.start(HOST_FINGERPRINT, null, undefined, jump);
	expect(agent.connected).toBe(true);
	return agent;
}

// ─── A host that stops answering ─────────────────────────────────────────────

describe("a host that stops answering, without closing, is lost (#607)", {
	timeout: 20_000,
}, () => {
	it("ends the connection to an agent on stdio, and says why", async () => {
		const logged = vi.spyOn(console, "error");
		const { link } = await reachableThroughLink({ onExec: stdioAgent });
		const agent = await connectedAgent(link.port);

		link.goSilent();
		await closes(agent, LOST_WITHIN_MS);

		expect(agent.connected).toBe(false);
		expect(agent.closedByHub).toBe(false);
		const lines = logged.mock.calls.map((call) => String(call[0]));
		expect(lines).toContain(
			`[lasterm-ssh] lost the connection to 127.0.0.1:${link.port}: the host stopped answering its keepalives`,
		);
	});

	it("ends the connection a remote daemon is reached over (#79)", async () => {
		const { link } = await reachableThroughLink(runningDaemon);
		const agent = await connectedAgent(link.port, true);
		expect(agent.usedRemoteDaemon).toBe(true);

		link.goSilent();
		await closes(agent, LOST_WITHIN_MS);

		expect(agent.connected).toBe(false);
	});

	it("ends the connection to a host behind a jump host that still answers", async () => {
		// The target goes silent behind the bastion, which stays up: only the
		// target's own keepalive, carried inside the bastion's channel, can tell.
		const { link } = await reachableThroughLink({ onExec: stdioAgent });
		const { server: bastion, port: bastionPort } = await mockSshServer({ forwardTo: link.port });
		cleanups.unshift(() => new Promise<void>((done) => bastion.close(() => done())));
		const agent = await connectedAgent(link.port, false, {
			jump: { host: "127.0.0.1", port: bastionPort, username: "jump" },
			auth: { method: "key", keyPath: CLIENT_KEY_PATH },
			promptHostId: HOST_ID,
			pinnedFingerprint: HOST_FINGERPRINT,
			trustKnownHosts: false,
			pinTo: { kind: "spec", hostId: HOST_ID },
		});

		link.goSilent();
		await closes(agent, LOST_WITHIN_MS);

		expect(agent.connected).toBe(false);
	});

	it("and the hub marks its host disconnected and reaches for it again, so a restart waits (#605)", async () => {
		const { link } = await reachableThroughLink({ onExec: stdioAgent });
		const agent = await connectedAgent(link.port);
		const host = makeHost(link.port);
		const records: SecurityFields[] = [];
		const ctx = {
			agents: new Map([[HOST_ID, agent]]),
			sessions: new Map([[HOST_ID, { id: SESSION_ID, hostId: HOST_ID, status: "active" }]]),
			agentCapabilities: new Map(),
			pendingRequests: new Map(),
			reconnectTimers: new Map(),
			reconnectAbortControllers: new Map(),
			stoppingAgents: new Set(),
			quitState: "RUNNING",
			quitEpoch: 0,
			metaDal: { getHost: () => host, updateSessionStatus: vi.fn() },
			security: new SecurityLog((_message, fields) => records.push(fields)),
			hubLogger: null,
			configResolver: null,
		} as unknown as SharedSessionContext;
		cleanups.push(() => {
			for (const timer of ctx.reconnectTimers.values()) clearTimeout(timer);
		});
		const broadcaster = {
			broadcastToAllClients: vi.fn(),
			updateSessionStatus: vi.fn((hostId: string, sessionId: string, status: string) => {
				const session = ctx.sessions.get(hostId);
				if (session?.id === sessionId) session.status = status as typeof session.status;
			}),
		} as unknown as StateBroadcaster;
		const lifecycle = { closeSession: vi.fn() } as unknown as ChannelLifecycleManager;
		const manager = new AgentConnectionManager(ctx, broadcaster, lifecycle);
		manager.sshMgr = new SshConnectionManager(ctx, broadcaster, lifecycle, manager);
		manager.wireAgentEvents(HOST_ID, SESSION_ID, agent);
		expect(hostReconnecting(ctx, HOST_ID)).toBeNull();

		link.goSilent();
		await closes(agent, LOST_WITHIN_MS);

		expect(ctx.agents.has(HOST_ID)).toBe(false);
		expect(ctx.sessions.get(HOST_ID)?.status).toBe("disconnected");
		expect(ctx.reconnectTimers.has(HOST_ID)).toBe(true);
		// What a SPAWN or a restart is now refused with: HOST_UNREACHABLE, and
		// the pane waits for the host to come back.
		expect(hostReconnecting(ctx, HOST_ID)).toBe("disconnected");
		expect(records.at(-1)).toEqual({
			event: "ssh.disconnect",
			hostId: HOST_ID,
			reason: "connection_lost",
		});
	});
});

// ─── A host that answers ─────────────────────────────────────────────────────

describe("a host that answers keeps its connection", { timeout: 20_000 }, () => {
	/** Long enough for the keepalive to have gone unanswered several times over. */
	const WATCH_MS = SSH_KEEPALIVE.keepaliveInterval * (SSH_KEEPALIVE.keepaliveCountMax + 1) * 4;

	it("while the link is quiet", async () => {
		const { link } = await reachableThroughLink({ onExec: stdioAgent });
		const agent = await connectedAgent(link.port);

		await expect(closes(agent, WATCH_MS)).rejects.toThrow("still up");

		expect(agent.connected).toBe(true);
	});

	it("while its output fills the link", async () => {
		let seq = 0;
		const { link } = await reachableThroughLink({
			onExec: (stream) => {
				stdioAgent(stream);
				const chunk = new Uint8Array(16 * 1024).fill(0x61);
				const flood = setInterval(() => {
					const output: ProtocolMessage = {
						type: "OUTPUT",
						channelId: "01K6000000000000000000C607",
						seq: seq++,
						ts: new Date().toISOString(),
						data: chunk,
					};
					stream.write(Buffer.from(encodeFrame(output)));
				}, 5);
				stream.on("close", () => clearInterval(flood));
				cleanups.push(() => clearInterval(flood));
			},
		});
		const agent = await connectedAgent(link.port);
		let received = 0;
		agent.on("message", (message: ProtocolMessage) => {
			if (message.type === "OUTPUT") received++;
		});

		await expect(closes(agent, WATCH_MS)).rejects.toThrow("still up");

		expect(agent.connected).toBe(true);
		// Busy for real: output kept arriving the whole time.
		expect(received).toBeGreaterThan(100);
	});
});

// ─── Every connection the hub opens ──────────────────────────────────────────

describe("every SSH connection the hub opens carries the keepalive", () => {
	const keepalive = {
		keepaliveInterval: SSH_KEEPALIVE.keepaliveInterval,
		keepaliveCountMax: SSH_KEEPALIVE.keepaliveCountMax,
	};

	/** The configuration each new ssh2 connection is given; each one fails at once. */
	function captureConnects(): Array<Record<string, unknown>> {
		const configs: Array<Record<string, unknown>> = [];
		vi.spyOn(Client.prototype, "connect").mockImplementation(function (
			this: Client,
			config: ConnectConfig,
		) {
			configs.push(config as unknown as Record<string, unknown>);
			queueMicrotask(() => this.emit("error", new Error("not connecting in this test")));
			return this;
		});
		return configs;
	}

	it("a host's own, which its agent on stdio and its remote daemon are both reached over", async () => {
		const configs = captureConnects();

		for (const remoteDaemon of [false, true]) {
			const agent = new SshAgent(makeHost(22), undefined, undefined, undefined, remoteDaemon);
			await expect(agent.start(HOST_FINGERPRINT)).rejects.toThrow("not connecting");
		}

		expect(configs).toHaveLength(2);
		for (const config of configs) expect(config).toMatchObject(keepalive);
	});

	it("a jump host's", async () => {
		const configs = captureConnects();

		await expect(
			openJumpRoute({
				jump: { host: "127.0.0.1", port: 22, username: "jump" },
				auth: {},
				pinnedFingerprint: HOST_FINGERPRINT,
				trustKnownHosts: false,
				destination: { host: "10.0.0.2", port: 22 },
			}),
		).rejects.toThrow("not connecting");

		expect(configs).toEqual([expect.objectContaining(keepalive)]);
	});

	it("a connection test's", async () => {
		const configs: Array<Record<string, unknown>> = [];
		const client = Object.assign(new Client(), {
			connect(this: Client, config: ConnectConfig) {
				configs.push(config as unknown as Record<string, unknown>);
				queueMicrotask(() => this.emit("error", new Error("not connecting in this test")));
				return this;
			},
		});

		await attemptSshTest(
			{ host: "127.0.0.1", port: 22, username: "tester" },
			new Set(),
			undefined,
			() => client,
		);

		expect(configs).toEqual([expect.objectContaining(keepalive)]);
	});
});

// ─── The values ──────────────────────────────────────────────────────────────

describe("the keepalive the hub ships", () => {
	it("declares a silent host lost within a minute, and gives a busy link 45 s to answer", async () => {
		const { SSH_KEEPALIVE: shipped } =
			await vi.importActual<typeof import("./ssh-keepalive.js")>("./ssh-keepalive.js");
		const { keepaliveInterval, keepaliveCountMax } = shipped;

		// ssh2 gives up at the request after the last one allowed to go
		// unanswered, and only an answer resets the count.
		expect(keepaliveInterval * (keepaliveCountMax + 1)).toBeLessThanOrEqual(60_000);
		expect(keepaliveInterval * keepaliveCountMax).toBeGreaterThanOrEqual(45_000);
	});
});
