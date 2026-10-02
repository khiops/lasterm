import { sshAddress, targetRoute } from "../ssh-route.js";
/**
 * A host's Connect, Reconnect and Disconnect, asked for from its menu (#648),
 * against a mock SSH server: the agent on stdio, or a daemon reached over its
 * socket that keeps its terminals across connections.
 *
 * Every connection the hub opens is counted by the server, so a reconnect the
 * hub was not asked for is seen.
 */

import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { join } from "node:path";
import {
	type AgentSpawnMessage,
	encodeFrame,
	FrameReader,
	generateId,
	type Host,
	type HostVerifyMessage,
	PROTOCOL_VERSION,
	type ProtocolMessage,
} from "@lasterm/shared";
import ssh2, { Server } from "ssh2";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { openTestDatabases } from "../storage/db.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
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
const KEY_DIR = makeTempDir("lasterm-host-connection-");
const CLIENT_KEY_PATH = join(KEY_DIR, "client.pem");
writeFileSync(CLIENT_KEY_PATH, rsaPem(), { mode: 0o600 });

const HOST_FINGERPRINT = (() => {
	const parsed = ssh2.utils.parseKey(HOST_KEY);
	if (parsed instanceof Error) throw parsed;
	const key = Array.isArray(parsed) ? parsed[0] : parsed;
	return `SHA256:${createHash("sha256").update(key.getPublicSSH()).digest("base64")}`;
})();

afterAll(async () => {
	await removeTempDir(KEY_DIR);
});

// ─── The mock host ───────────────────────────────────────────────────────────

type Stream = NodeJS.ReadWriteStream & { exit?: (code: number) => void };

interface MockHost {
	port: number;
	/** SSH connections it accepted. */
	connections: number;
	/** Times its daemon's socket was reached. */
	socketOpens: number;
	/** The terminals its daemon holds, reported alive on every connection. */
	held: string[];
	close: () => Promise<void>;
}

function hello(): Buffer {
	return Buffer.from(
		encodeFrame({
			type: "HELLO",
			version: PROTOCOL_VERSION,
			agentVersion: HUB_VERSION,
			capabilities: ["multiplex", "snapshot", "resize"],
		}),
	);
}

/** An agent: HELLO, then a SPAWN_OK for every SPAWN, under the id asked for or a new one. */
function serveAgent(stream: Stream): void {
	const reader = new FrameReader();
	stream.on("data", (data: Buffer) => {
		for (const msg of reader.push(data)) {
			if (msg.type !== "SPAWN") continue;
			const spawn = msg as AgentSpawnMessage;
			stream.write(
				Buffer.from(
					encodeFrame({
						type: "SPAWN_OK",
						requestId: spawn.requestId,
						channelId: spawn.channelId ?? generateId(),
					}),
				),
			);
		}
	});
	stream.write(hello());
}

/**
 * An SSH server that lets anyone in. Its agent runs on stdio for any command,
 * or, `daemon`, is a daemon already running: its state directory is where the
 * hub looks, and its socket says what it holds.
 */
function mockHost(daemon: boolean): Promise<MockHost> {
	const ends: Array<() => void> = [];
	const result: MockHost = {
		port: 0,
		connections: 0,
		socketOpens: 0,
		held: [],
		close: async () => {},
	};
	const server = new Server({ hostKeys: [HOST_KEY] }, (conn) => {
		result.connections++;
		ends.push(() => conn.end());
		conn.on("error", () => {});
		conn.on("authentication", (ctx) => ctx.accept());
		conn.on("ready", () => {
			conn.on("session", (accept) => {
				accept().on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec() as Stream;
					if (!daemon) {
						serveAgent(stream);
						return;
					}
					if (info.command.includes("XDG_STATE_HOME")) {
						stream.write("/home/pi/.local/state/lasterm");
					}
					stream.exit?.(0);
					stream.end();
				});
			});
			(
				conn as unknown as {
					on: (
						event: "openssh.streamlocal",
						listener: (accept: () => Stream, reject: () => void) => void,
					) => void;
				}
			).on("openssh.streamlocal", (accept, reject) => {
				if (!daemon) {
					reject();
					return;
				}
				result.socketOpens++;
				const stream = accept();
				serveAgent(stream);
				for (const channelId of result.held) {
					stream.write(
						Buffer.from(
							encodeFrame({
								type: "AGENT_CHANNEL_STATE",
								channelId,
								title: "bash",
								pid: 4242,
								alive: true,
							}),
						),
					);
				}
				stream.write(Buffer.from(encodeFrame({ type: "CHANNEL_STATE_END" })));
			});
		});
	});
	server.on("error", () => {});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			result.port = (server.address() as net.AddressInfo).port;
			result.close = () => {
				for (const end of ends) end();
				return new Promise((done) => server.close(() => done()));
			};
			resolve(result);
		});
	});
}

/** Waits for `condition`, and fails saying what was awaited if it does not come. */
async function until(what: string, condition: () => boolean, withinMs = 8_000): Promise<void> {
	const deadline = Date.now() + withinMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`still waiting after ${withinMs} ms: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// ─── The hub ─────────────────────────────────────────────────────────────────

interface Harness {
	sm: SessionManager;
	ctx: SharedSessionContext;
	sshMgr: SshConnectionManager;
	host: Host;
	remote: MockHost;
	/** A window, and everything the hub sent it. */
	window: WsClient;
	heard: ProtocolMessage[];
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function hubWith(
	options: { daemon: boolean; pinned?: boolean; windowId?: string } = { daemon: false },
): Promise<Harness> {
	const remote = await mockHost(options.daemon);
	const dbManager = openTestDatabases();
	const sm = new SessionManager(dbManager);
	const internals = sm as unknown as { ctx: SharedSessionContext; sshMgr: SshConnectionManager };
	const { ctx } = internals;
	const host = ctx.metaDal.createHost({
		type: "ssh",
		label: options.daemon ? "pi" : "box",
		sshHost: "127.0.0.1",
		sshPort: remote.port,
		sshAuth: "key",
		sshKeyPath: CLIENT_KEY_PATH,
		sshRemoteDaemon: options.daemon,
	});
	if (options.pinned !== false)
		ctx.metaDal.updateHostFingerprint(
			host.id,
			HOST_FINGERPRINT,
			targetRoute(host, (id) => sshAddress(ctx.metaDal.getHost(id))),
		);

	const heard: ProtocolMessage[] = [];
	const window: WsClient = {
		id: options.windowId ?? "c-window",
		send: (msg) => heard.push(msg),
		attachedChannels: new Set(),
	};
	sm.addClient(window);

	// Every connection a test starts is seen to end before the hub goes.
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
		await remote.close();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.all(closed),
			new Promise((resolve) => {
				timer = setTimeout(resolve, 5_000);
			}),
		]);
		clearTimeout(timer);
		sm.beginQuit();
		await sm.shutdown();
		dbManager.close();
		tracking.mockRestore();
	});
	return { sm, ctx, sshMgr: internals.sshMgr, host, remote, window, heard };
}

/** Its agent, when connected. */
function agentOf(h: Harness): SshAgent | undefined {
	const agent = h.ctx.agents.get(h.host.id);
	return agent instanceof SshAgent && agent.connected ? agent : undefined;
}

/** Connect the host as its menu's Connect does, and wait for it. */
async function connected(h: Harness): Promise<SshAgent> {
	const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
	if (outcome.kind !== "connecting") throw new Error(`not connecting: ${outcome.kind}`);
	await expect(outcome.done).resolves.toBe(true);
	const agent = agentOf(h);
	if (agent === undefined) throw new Error("no agent after connecting");
	return agent;
}

/** Terminals of the host's session, running there, which its daemon (if any) holds. */
function terminalsOn(h: Harness, count: number): string[] {
	const session = h.ctx.sessions.get(h.host.id);
	if (session === undefined) throw new Error("no session");
	const ids = Array.from({ length: count }, () => generateId());
	for (const id of ids) {
		h.ctx.metaDal.createChannel({ id, sessionId: session.id, status: "live", shell: "bash" });
		h.ctx.channels.set(id, {
			sessionId: session.id,
			hostId: h.host.id,
			status: "live",
			clients: new Set(),
			shell: "bash",
			cols: 80,
			rows: 24,
			dynamicTitle: null,
			processTitle: null,
			displayTitle: "bash",
		});
	}
	h.remote.held = ids;
	return ids;
}

function sessionStates(h: Harness): Array<{ status: string; disconnectedByUser?: boolean }> {
	return h.heard
		.filter((m) => m.type === "SESSION_STATE" && m.hostId === h.host.id)
		.map((m) => m as { status: string; disconnectedByUser?: boolean });
}

function endsOf(h: Harness, channelId: string): ProtocolMessage[] {
	return h.heard.filter(
		(m) => m.type === "CHANNEL_STATE" && m.channelId === channelId && m.status === "dead",
	);
}

function sessionOf(h: Harness): SessionState | undefined {
	return h.ctx.sessions.get(h.host.id);
}

// ─── Connect ─────────────────────────────────────────────────────────────────

describe("Connect (#648)", { timeout: 20_000 }, () => {
	it("refuses a pinned revoked key without prompting or changing the pin", async () => {
		const h = await hubWith({ daemon: false });
		const home = makeTempDir("lasterm-revoked-session-");
		cleanups.push(() => {
			vi.unstubAllEnvs();
			removeTempDir(home);
		});
		mkdirSync(join(home, ".ssh"));
		const key = ssh2.utils.parseKey(HOST_KEY);
		if (key instanceof Error || Array.isArray(key)) throw new Error("invalid mock key");
		const file = join(home, ".ssh", "known_hosts");
		writeFileSync(
			file,
			`@revoked [127.0.0.1]:${h.remote.port} ${key.type} ${key.getPublicSSH().toString("base64")}\n`,
		);
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		expect(outcome.kind).toBe("connecting");
		if (outcome.kind !== "connecting") throw new Error("expected connecting");
		await expect(outcome.done).resolves.toBe(false);
		expect(h.heard).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "SSH_HOST_KEY_REVOKED",
				message: `This host's key is marked @revoked in ${file}:1. Refusing to connect.`,
			}),
		);
		expect(h.heard.some((m) => m.type === "HOST_VERIFY")).toBe(false);
		expect(h.ctx.metaDal.getHost(h.host.id)?.sshFingerprint).toBe(HOST_FINGERPRINT);
	});

	it("reaches the host and readies its agent, and starts no terminal", async () => {
		const h = await hubWith({ daemon: false });

		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });

		expect(outcome.kind).toBe("connecting");
		if (outcome.kind !== "connecting") return;
		await expect(outcome.done).resolves.toBe(true);
		expect(agentOf(h)).toBeDefined();
		expect(sessionOf(h)?.status).toBe("active");
		expect([...h.ctx.channels.values()].filter((c) => c.hostId === h.host.id)).toEqual([]);
		expect(h.heard.some((m) => m.type === "SPAWN_OK" || m.type === "CHANNEL_CREATED")).toBe(false);
		// The rail shows it being reached, then reached.
		expect(sessionStates(h).map((s) => s.status)).toEqual(["starting", "active"]);
		expect(h.remote.connections).toBe(1);
	});

	it("says it is connected already, and opens nothing more", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);

		expect(h.sm.connectHost(h.host.id).kind).toBe("connected");
		expect(h.remote.connections).toBe(1);
	});

	it("asks its questions of the window that asked, as a terminal's first connection does", async () => {
		// "c-b" sorts after "c-a": the one named, not the first there is, is asked.
		const h = await hubWith({ daemon: false, pinned: false, windowId: "c-b" });
		const other: ProtocolMessage[] = [];
		h.sm.addClient({ id: "c-a", send: (m) => other.push(m), attachedChannels: new Set() });
		const asked = new Promise<HostVerifyMessage>((resolve) => {
			h.window.send = (msg) => {
				h.heard.push(msg);
				if (msg.type === "HOST_VERIFY") resolve(msg as HostVerifyMessage);
			};
		});

		const outcome = h.sm.connectHost(h.host.id, { clientId: "c-b" });
		const question = await asked;
		expect(question.firstConnect).toBe(true);
		h.sm.handleHostVerifyResponse(question.promptId, "trust_once", "c-b");

		if (outcome.kind !== "connecting") throw new Error(outcome.kind);
		await expect(outcome.done).resolves.toBe(true);
		expect(other.some((m) => m.type === "HOST_VERIFY")).toBe(false);
	});

	it("says why it failed, to the window that asked, and leaves no session behind", async () => {
		const h = await hubWith({ daemon: false, pinned: false });
		h.window.send = (msg) => {
			h.heard.push(msg);
			if (msg.type === "HOST_VERIFY") {
				const { promptId } = msg as HostVerifyMessage;
				queueMicrotask(() => h.sm.handleHostVerifyResponse(promptId, "reject", h.window.id));
			}
		};

		const outcome = h.sm.connectHost(h.host.id, { clientId: h.window.id });
		if (outcome.kind !== "connecting") throw new Error(outcome.kind);

		await expect(outcome.done).resolves.toBe(false);
		expect(h.heard).toContainEqual(
			expect.objectContaining({ type: "ERROR", code: "SSH_HOST_KEY_REJECTED" }),
		);
		expect(sessionOf(h)).toBeUndefined();
		expect(sessionStates(h).at(-1)?.status).toBe("closed");
	});

	it("has nothing to do on the local host", async () => {
		const h = await hubWith({ daemon: false });
		const local = h.ctx.metaDal.createHost({ type: "local", label: "local" });

		expect(h.sm.connectHost(local.id).kind).toBe("not-ssh");
		expect(h.sm.reconnectHost(local.id).kind).toBe("not-ssh");
		expect(h.sm.disconnectHost(local.id).kind).toBe("not-ssh");
	});
});

// ─── Reconnect ───────────────────────────────────────────────────────────────

describe("Reconnect (#648)", { timeout: 20_000 }, () => {
	it("with a daemon: a new connection, and the terminals it holds are taken up, alive", async () => {
		const h = await hubWith({ daemon: true });
		const first = await connected(h);
		const [a, b] = terminalsOn(h, 2);
		const sessionId = sessionOf(h)?.id;

		const outcome = h.sm.reconnectHost(h.host.id, { clientId: h.window.id });

		expect(outcome).toMatchObject({ kind: "connecting", ended: 0 });
		if (outcome.kind !== "connecting") return;
		await expect(outcome.done).resolves.toBe(true);
		const second = agentOf(h);
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(first.connected).toBe(false);
		expect(first.closedByHub).toBe(true);
		expect(h.remote.socketOpens).toBe(2);
		for (const id of [a, b] as string[]) {
			expect(h.ctx.channels.get(id)?.status).toBe("live");
			expect(endsOf(h, id)).toEqual([]);
		}
		expect(sessionOf(h)).toMatchObject({ id: sessionId, status: "active" });
	});

	it("without one: says how many terminals would end, and does nothing until told", async () => {
		const h = await hubWith({ daemon: false });
		const first = await connected(h);
		const ids = terminalsOn(h, 2);

		expect(h.sm.reconnectHost(h.host.id)).toEqual({ kind: "terminals-would-end", terminals: 2 });
		expect(agentOf(h)).toBe(first);
		for (const id of ids) expect(h.ctx.channels.get(id)?.status).toBe("live");
		expect(h.remote.connections).toBe(1);
	});

	it("without one, told: the terminals end with the old connection, and a new one opens", async () => {
		const h = await hubWith({ daemon: false });
		const first = await connected(h);
		const ids = terminalsOn(h, 2);

		const outcome = h.sm.reconnectHost(h.host.id, { clientId: h.window.id, force: true });

		expect(outcome).toMatchObject({ kind: "connecting", ended: 2 });
		if (outcome.kind !== "connecting") return;
		await expect(outcome.done).resolves.toBe(true);
		expect(agentOf(h)).not.toBe(first);
		expect(first.closedByHub).toBe(true);
		expect(h.remote.connections).toBe(2);
		for (const id of ids) {
			expect(h.ctx.channels.has(id)).toBe(false);
			expect(endsOf(h, id)).toEqual([expect.objectContaining({ endReason: "stopped" })]);
		}
		expect(sessionOf(h)?.status).toBe("active");
	});
});

// ─── Disconnect ──────────────────────────────────────────────────────────────

describe("Disconnect (#648)", { timeout: 20_000 }, () => {
	it("with a daemon: its terminals keep running, and its session waits, marked", async () => {
		const h = await hubWith({ daemon: true });
		const agent = await connected(h);
		const [id] = terminalsOn(h, 1) as [string];

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "disconnected", ended: 0 });

		expect(agentOf(h)).toBeUndefined();
		expect(agent.closedByHub).toBe(true);
		expect(sessionOf(h)?.status).toBe("disconnected");
		expect(h.ctx.channels.get(id)?.status).toBe("live");
		expect(endsOf(h, id)).toEqual([]);
		expect(sessionStates(h).at(-1)).toMatchObject({
			status: "disconnected",
			disconnectedByUser: true,
		});
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toEqual([h.host.id]);
	});

	it("without one: says how many would end, then ends them once told", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);
		const ids = terminalsOn(h, 3);

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "terminals-would-end", terminals: 3 });
		expect(agentOf(h)).toBeDefined();

		expect(h.sm.disconnectHost(h.host.id, { force: true })).toEqual({
			kind: "disconnected",
			ended: 3,
		});
		expect(agentOf(h)).toBeUndefined();
		expect(sessionOf(h)).toBeUndefined();
		for (const id of ids) {
			expect(endsOf(h, id)).toEqual([expect.objectContaining({ endReason: "stopped" })]);
		}
		expect(sessionStates(h).at(-1)).toMatchObject({ status: "closed", disconnectedByUser: true });
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toEqual([h.host.id]);
	});

	it("is not undone by the hub: no reconnect for a lost link, an attach, or a start nobody asked for", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const [id] = terminalsOn(h, 1) as [string];
		h.sm.disconnectHost(h.host.id);
		const sessionId = sessionOf(h)?.id ?? "";

		// What a lost link does, once its close is heard.
		h.sshMgr.scheduleReconnect(h.host.id, sessionId, 0, Date.now());
		expect(h.ctx.reconnectTimers.has(h.host.id)).toBe(false);

		// A window opening over its terminal: answered from what the hub remembers.
		await expect(h.sm.handleAttach(h.window.id, id)).resolves.toBe(true);
		expect(h.heard).toContainEqual(
			expect.objectContaining({ type: "ATTACH_OK", channelId: id, cached: true }),
		);

		// A pane following "When a terminal ends": it waits for the host.
		await expect(
			h.sm.handleSpawn(h.window.id, {
				type: "SPAWN",
				hostId: h.host.id,
				automatic: true,
			}),
		).resolves.toBeNull();
		expect(h.heard).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "HOST_UNREACHABLE",
				hostId: h.host.id,
				hostStatus: "disconnected",
			}),
		);

		// A second longer than the first backoff: nothing dialled meanwhile.
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(h.remote.connections).toBe(1);
		expect(agentOf(h)).toBeUndefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toEqual([h.host.id]);
	});

	it("is undone by Connect, which takes up what the daemon kept", async () => {
		const h = await hubWith({ daemon: true });
		await connected(h);
		const [id] = terminalsOn(h, 1) as [string];
		h.sm.disconnectHost(h.host.id);

		await connected(h);

		expect(h.remote.socketOpens).toBe(2);
		expect(h.ctx.channels.get(id)?.status).toBe("live");
		expect(sessionStates(h).at(-1)).toEqual(expect.objectContaining({ status: "active" }));
		expect(sessionStates(h).at(-1)?.disconnectedByUser).toBeUndefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});

	it("is undone by a terminal opened there, which brings it back; a restart nobody asked for waits", async () => {
		const h = await hubWith({ daemon: false });
		await connected(h);
		const [ended] = terminalsOn(h, 1) as [string];
		h.sm.disconnectHost(h.host.id, { force: true });

		// Its terminal, ended with the connection, brought back by the setting: refused.
		await expect(
			h.sm.handleSpawn(h.window.id, {
				type: "SPAWN",
				hostId: h.host.id,
				reuseChannelId: ended,
				automatic: true,
			}),
		).resolves.toBeNull();
		expect(h.heard).toContainEqual(
			expect.objectContaining({
				type: "ERROR",
				code: "HOST_UNREACHABLE",
				channelId: ended,
				hostStatus: "closed",
			}),
		);
		expect(h.remote.connections).toBe(1);

		// Someone opens a terminal there.
		const opened = await h.sm.handleSpawn(h.window.id, { type: "SPAWN", hostId: h.host.id });

		expect(opened).not.toBeNull();
		expect(h.remote.connections).toBe(2);
		expect(agentOf(h)).toBeDefined();
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});

	it("has nothing to close on a host never connected, and marks nothing", async () => {
		const h = await hubWith({ daemon: false });

		expect(h.sm.disconnectHost(h.host.id)).toEqual({ kind: "disconnected", ended: 0 });
		expect(h.sm.getStateSnapshot().userDisconnectedHosts).toBeUndefined();
	});
});

// ─── A host that comes back on its own ───────────────────────────────────────

describe("a host its user did not disconnect", { timeout: 20_000 }, () => {
	it("is still reconnected after a lost link", async () => {
		const h = await hubWith({ daemon: true });
		const first = await connected(h);

		// The host ends the connection: the hub did not ask for it.
		await h.remote.close();
		await until("the connection to end", () => !first.connected);

		const timer = h.ctx.reconnectTimers.get(h.host.id);
		expect(timer, "the loss scheduled a reconnect").toBeDefined();
		expect(sessionOf(h)?.status).toBe("disconnected");
		expect(sessionStates(h).at(-1)?.disconnectedByUser).toBeUndefined();
		// Nothing more is under test once the reconnect is seen waiting.
		clearTimeout(timer);
		h.ctx.reconnectTimers.delete(h.host.id);
	});
});
