import { sshAddress, targetRoute } from "../ssh-route.js";
/**
 * A host reached through a bastion is reached through it every time, and the
 * bastion is let go of when the connection it carried ends.
 *
 * The host's address here is one only the bastion can reach: the bastion
 * routes it to the mock host, while from the hub it leads to a listener that
 * counts each dial and drops it. So a connection that goes around the bastion
 * is seen, and fails, as it would against a host on a private network.
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
	type HostVerifyMessage,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import ssh2, { Server } from "ssh2";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { type SecurityFields, SecurityLog } from "../logging/security-log.js";
import { openTestDatabases } from "../storage/db.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { AgentConnectionManager } from "./agent-connection-manager.js";
import type { ChannelLifecycleManager } from "./channel-lifecycle-manager.js";
import type { ResolvedJump } from "./proxy-jump.js";
import type { SessionState, SharedSessionContext } from "./session-context.js";
import { SessionManager, type WsClient } from "./session-manager.js";
import { SshAgent } from "./ssh-agent.js";
import type { SshConnectionManager } from "./ssh-connection-manager.js";

// The mock host already runs its agent: nothing to upload, nothing to check.
vi.mock("./agent-deployer.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./agent-deployer.js")>()),
	deployAgentIfNeeded: vi.fn().mockResolvedValue({
		deployed: false,
		remoteMatchesHubVersionCache: false,
		remotePath: "lasterm-agent",
		os: null,
		arch: null,
	}),
}));

function rsaPem(): string {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "pkcs1", format: "pem" },
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
	}).privateKey;
}

const HOST_KEY = rsaPem();
const KEY_DIR = makeTempDir("lasterm-jump-reconnect-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, rsaPem(), { mode: 0o600 });

/** The fingerprint of the key both mock servers present. */
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

/** One SSH connection a mock server accepted, as that server sees it. */
interface Accepted {
	/** Whether it has ended. */
	ended: boolean;
	/** The server ends it, as a host that restarts its SSH server does. */
	end: () => void;
}

interface MockServer {
	port: number;
	/** Every connection it accepted, oldest first. */
	accepted: Accepted[];
	/** The destinations it opened a route to, as `host:port`. */
	routes: string[];
	close: () => Promise<void>;
}

/**
 * An SSH server that lets anyone in. It runs an agent on stdio for any
 * command, and routes `route`'s destination to its port.
 */
function mockSshServer(route?: { from: string; toPort: number }): Promise<MockServer> {
	const accepted: Accepted[] = [];
	const routes: string[] = [];
	const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
		const entry: Accepted = { ended: false, end: () => conn.end() };
		accepted.push(entry);
		conn.on("close", () => {
			entry.ended = true;
		});
		conn.on("error", () => {});
		conn.on("authentication", (ctx) => ctx.accept());
		conn.on("ready", () => {
			conn.on("session", (accept) => {
				accept().on("exec", (acceptExec) => {
					acceptExec().write(Buffer.from(encodeFrame(HELLO)));
				});
			});
			conn.on("tcpip", (accept, reject, info) => {
				const destination = `${info.destIP}:${info.destPort}`;
				routes.push(destination);
				if (route === undefined || destination !== route.from) {
					reject();
					return;
				}
				const stream = accept();
				const onward = net.connect(route.toPort, "127.0.0.1");
				onward.on("error", () => stream.destroy());
				stream.on("error", () => onward.destroy());
				stream.pipe(onward).pipe(stream);
			});
		});
	});
	server.on("error", () => {});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				port: (server.address() as net.AddressInfo).port,
				accepted,
				routes,
				close: () => {
					for (const entry of accepted) if (!entry.ended) entry.end();
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}

interface Unreachable {
	port: number;
	/** How many times something dialled it. */
	dials: number;
	forwardTo?: number;
	close: () => Promise<void>;
}

/** What the host's address leads to from the hub: nothing that answers SSH. */
function unreachableFromTheHub(): Promise<Unreachable> {
	const result: Unreachable = { port: 0, dials: 0, close: async () => {} };
	const server = net.createServer((socket) => {
		result.dials++;
		if (result.forwardTo !== undefined) {
			const onward = net.connect(result.forwardTo, "127.0.0.1");
			onward.on("error", () => socket.destroy());
			socket.on("error", () => onward.destroy());
			socket.on("close", () => onward.destroy());
			socket.pipe(onward).pipe(socket);
		} else socket.destroy();
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			result.port = (server.address() as net.AddressInfo).port;
			result.close = () => new Promise((done) => server.close(() => done()));
			resolve(result);
		});
	});
}

/** Waits for `condition`, and fails saying what was awaited if it does not come. */
async function until(
	what: string | (() => string),
	condition: () => boolean,
	withinMs = 8_000,
): Promise<void> {
	const deadline = Date.now() + withinMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(
				`still waiting after ${withinMs} ms: ${typeof what === "string" ? what : what()}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

interface Harness {
	sm: SessionManager;
	ctx: SharedSessionContext;
	agentMgr: AgentConnectionManager;
	sshMgr: SshConnectionManager;
	lifecycle: ChannelLifecycleManager;
	/** The bastion, as a host of this hub. */
	bastionHost: Host;
	/** The host reached through it. */
	host: Host;
	bastion: MockServer;
	target: MockServer;
	/** The host's own address, as the hub would dial it. */
	direct: Unreachable;
	/** What the security log recorded. */
	records: SecurityFields[];
}

const SESSION_ID = "01K6000000000000000000SJMP";

let harness: Harness | null = null;

beforeEach(async () => {
	const target = await mockSshServer();
	const direct = await unreachableFromTheHub();
	// The bastion reaches the host's address; the hub reaches only the bastion.
	const bastion = await mockSshServer({
		from: `127.0.0.1:${direct.port}`,
		toPort: target.port,
	});

	const records: SecurityFields[] = [];
	const dbManager = openTestDatabases();
	const sm = new SessionManager(
		dbManager,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		new SecurityLog((_message, fields) => records.push(fields)),
	);
	const internals = sm as unknown as {
		ctx: SharedSessionContext;
		agentMgr: AgentConnectionManager;
		sshMgr: SshConnectionManager;
		lifecycle: ChannelLifecycleManager;
	};
	const { ctx } = internals;

	const bastionHost = ctx.metaDal.createHost({
		type: "ssh",
		label: "bastion",
		sshHost: "127.0.0.1",
		sshPort: bastion.port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
	});
	ctx.metaDal.updateHostFingerprint(
		bastionHost.id,
		HOST_FINGERPRINT,
		targetRoute(bastionHost, (id) => sshAddress(ctx.metaDal.getHost(id))),
	);
	const host = ctx.metaDal.createHost({
		type: "ssh",
		label: "behind-the-bastion",
		sshHost: "127.0.0.1",
		sshPort: direct.port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		sshProxyHostId: bastionHost.id,
	});

	harness = {
		sm,
		...internals,
		bastionHost,
		host,
		bastion,
		target,
		direct,
		records,
	};
	// Every connection a test starts is seen to end before the hub goes: its
	// close is recorded in the database, which must still be there.
	const closed: Array<Promise<unknown>> = [];
	const start = SshAgent.prototype.start;
	const tracking = vi.spyOn(SshAgent.prototype, "start").mockImplementation(function (
		this: SshAgent,
		...args: Parameters<SshAgent["start"]>
	) {
		closed.push(once(this, "close"));
		return start.apply(this, args);
	});
	cleanups.push(async () => {
		await bastion.close();
		await target.close();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all(closed),
			new Promise((resolve) => {
				timer = setTimeout(resolve, 5_000);
			}),
		]);
		clearTimeout(timer);
		await sm.shutdown();
		dbManager.close();
		await direct.close();
		tracking.mockRestore();
	});
});

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	harness = null;
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function the(): Harness {
	if (harness === null) throw new Error("no harness");
	return harness;
}

/** The session a connected (or once connected) host has. */
function seedSession(status: SessionState["status"]): void {
	const { ctx, host } = the();
	(ctx.sessions as Map<string, SessionState>).set(host.id, {
		id: SESSION_ID,
		hostId: host.id,
		status,
	});
}

/** The route the first connection took, as the first connect resolves it. */
function jumpThroughBastion(): ResolvedJump {
	const { bastion, bastionHost } = the();
	return {
		jump: { host: "127.0.0.1", port: bastion.port, username: "jump" },
		auth: { method: "key", keyPath: CLIENT_KEY_PATH },
		promptHostId: bastionHost.id,
		pinnedFingerprint: HOST_FINGERPRINT,
		trustKnownHosts: false,
		pinTo: {
			kind: "host",
			hostId: bastionHost.id,
			expectedRoute: targetRoute(bastionHost, () => undefined),
		},
	};
}

/** A connection through the bastion, serving the host's session like the first connect's. */
async function connectedThroughBastion(): Promise<SshAgent> {
	const { ctx, host, agentMgr } = the();
	const agent = new SshAgent(host);
	await agent.start(HOST_FINGERPRINT, null, undefined, jumpThroughBastion());
	expect(agent.connected).toBe(true);
	seedSession("active");
	(ctx.agents as Map<string, SshAgent>).set(host.id, agent);
	agentMgr.wireAgentEvents(host.id, SESSION_ID, agent);
	return agent;
}

function currentAgent(): SshAgent | undefined {
	const { ctx, host } = the();
	const agent = ctx.agents.get(host.id);
	return agent instanceof SshAgent ? agent : undefined;
}

// ─── Reconnecting ────────────────────────────────────────────────────────────

describe("a host reached through a bastion is reconnected through it", { timeout: 20_000 }, () => {
	it("after its connection was lost", async () => {
		const { ctx, host, target, bastion, direct } = the();
		const first = await connectedThroughBastion();
		ctx.metaDal.updateHostFingerprint(
			host.id,
			HOST_FINGERPRINT,
			targetRoute(host, (id) => sshAddress(ctx.metaDal.getHost(id))),
		);

		// The host ends the connection: the hub did not ask for it, so it reconnects.
		for (const connection of target.accepted) connection.end();

		await until(
			() => `a new connection, the host's own address dialled ${direct.dials} time(s)`,
			() => {
				const agent = currentAgent();
				return agent !== undefined && agent !== first && agent.connected;
			},
		);
		expect(direct.dials).toBe(0);
		expect(bastion.routes).toEqual([`127.0.0.1:${direct.port}`, `127.0.0.1:${direct.port}`]);
		expect(ctx.sessions.get(host.id)?.status).toBe("active");
	});

	it("when a pane asks for it again", async () => {
		const { sm, ctx, host, lifecycle, bastion, direct } = the();
		ctx.metaDal.updateHostFingerprint(
			host.id,
			HOST_FINGERPRINT,
			targetRoute(host, (id) => sshAddress(ctx.metaDal.getHost(id))),
		);
		seedSession("disconnected");
		const client: WsClient = { id: "c-jump", send: () => {}, attachedChannels: new Set() };
		sm.addClient(client);

		const reconnect = lifecycle.onReconnectAgent;
		expect(reconnect).toBeDefined();
		await expect(reconnect?.(host.id)).resolves.toBe(true);

		expect(currentAgent()?.connected).toBe(true);
		expect(direct.dials).toBe(0);
		expect(bastion.routes).toEqual([`127.0.0.1:${direct.port}`]);
	});

	it("once its key is confirmed, on a first connection", async () => {
		const { sm, ctx, lifecycle, host, bastion, direct, target } = the();
		let questions = 0;
		seedSession("starting");
		// Whoever is asked trusts the key, for this session only.
		const client: WsClient = {
			id: "c-jump",
			send: (message: ProtocolMessage) => {
				if (message.type !== "HOST_VERIFY") return;
				questions++;
				const { promptId } = message as HostVerifyMessage;
				queueMicrotask(() => sm.handleHostVerifyResponse(promptId, "trust_once", "c-jump"));
			},
			attachedChannels: new Set(),
		};
		sm.addClient(client);

		const connect = (
			sm as unknown as {
				_connectSshAgent: (
					hostId: string,
					host: Host,
					client: WsClient,
					sessionId: string,
				) => Promise<SshAgent>;
			}
		)._connectSshAgent.bind(sm);
		const agent = await connect(host.id, host, client, SESSION_ID);

		expect(agent.connected).toBe(true);
		expect(direct.dials).toBe(0);
		expect(bastion.routes).toEqual([`127.0.0.1:${direct.port}`, `127.0.0.1:${direct.port}`]);
		expect(questions).toBe(1);
		agent.close();
		seedSession("disconnected");
		await expect(lifecycle.onReconnectAgent?.(host.id)).resolves.toBe(true);
		expect(questions).toBe(1);
		const separate = ctx.metaDal.createHost({
			type: "ssh",
			label: "direct-target",
			sshHost: host.sshHost!,
			sshPort: host.sshPort!,
			sshAuth: "key",
			sshKeyPath: CLIENT_KEY_PATH,
		});
		(ctx.sessions as Map<string, SessionState>).set(separate.id, {
			id: "direct-session",
			hostId: separate.id,
			status: "starting",
		});
		direct.forwardTo = target.port;
		const directAgent = await connect(separate.id, separate, client, "direct-session");
		expect(directAgent.connected).toBe(true);
		expect(questions).toBe(2);
		directAgent.close();
	});
	it("does not pin or retry a stale route after the key question", async () => {
		const { sm, ctx, host, bastion } = the();
		seedSession("starting");
		const pin = vi.spyOn(ctx.metaDal, "updateHostFingerprint");
		const messages: ProtocolMessage[] = [];
		const client: WsClient = {
			id: "c-edit",
			attachedChannels: new Set(),
			send: (message) => {
				messages.push(message);
				if (message.type === "HOST_VERIFY") {
					ctx.metaDal.updateHost(host.id, { sshHost: "edited" });
					queueMicrotask(() =>
						sm.handleHostVerifyResponse(message.promptId, "trust_permanent", "c-edit"),
					);
				}
			},
		};
		sm.addClient(client);
		const connect = sm as unknown as {
			_connectSshAgent(
				id: string,
				host: Host,
				client: WsClient,
				sessionId: string,
			): Promise<SshAgent>;
		};
		await expect(connect._connectSshAgent(host.id, host, client, SESSION_ID)).rejects.toThrow(
			"The host changed while connecting. Connect again.",
		);
		expect(pin).toHaveBeenCalledWith(
			host.id,
			HOST_FINGERPRINT,
			targetRoute(host, (id) => sshAddress(ctx.metaDal.getHost(id))),
		);
		expect(pin.mock.results.at(-1)?.value).toBe(false);
		expect(ctx.metaDal.getHost(host.id)?.sshFingerprint).toBeNull();
		expect(bastion.routes).toHaveLength(1);
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				message: "The host changed while connecting. Connect again.",
			}),
		);
		pin.mockRestore();
	});
});

// ─── Letting go of the bastion ───────────────────────────────────────────────

describe("the bastion is let go of with the connection it carried", { timeout: 20_000 }, () => {
	it("when that connection is lost, which stays a loss and not the hub's doing", async () => {
		const { ctx, host, target, bastion, records } = the();
		const first = await connectedThroughBastion();
		expect(bastion.accepted).toHaveLength(1);

		for (const connection of target.accepted) connection.end();
		await until("the connection to end", () => !first.connected);
		// Nothing more is under test once the loss is seen: no reconnect.
		const timer = ctx.reconnectTimers.get(host.id);
		expect(timer, "the loss scheduled a reconnect").toBeDefined();
		clearTimeout(timer);
		ctx.reconnectTimers.delete(host.id);

		await until(
			"the bastion's connection to end",
			() => bastion.accepted[0]?.ended === true,
			3_000,
		);
		expect(first.closedByHub).toBe(false);
		expect(records.at(-1)).toEqual({
			event: "ssh.disconnect",
			hostId: host.id,
			reason: "connection_lost",
		});
	});

	it("when that connection is refused at the host's key, and asked about", async () => {
		const { sm, host, bastion } = the();
		seedSession("starting");
		const client: WsClient = {
			id: "c-jump",
			send: (message: ProtocolMessage) => {
				if (message.type !== "HOST_VERIFY") return;
				const { promptId } = message as HostVerifyMessage;
				queueMicrotask(() => sm.handleHostVerifyResponse(promptId, "reject", "c-jump"));
			},
			attachedChannels: new Set(),
		};
		sm.addClient(client);

		const connect = (
			sm as unknown as {
				_connectSshAgent: (
					hostId: string,
					host: Host,
					client: WsClient,
					sessionId: string,
				) => Promise<SshAgent>;
			}
		)._connectSshAgent.bind(sm);
		await expect(connect(host.id, host, client, SESSION_ID)).rejects.toThrow("rejected");

		expect(bastion.accepted).toHaveLength(1);
		await until(
			"the bastion's connection to end",
			() => bastion.accepted[0]?.ended === true,
			3_000,
		);
	});
});
