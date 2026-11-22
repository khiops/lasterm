import type { AgentChannelStateMessage, HelloMessage, ProtocolMessage } from "@lasterm/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { ConfigResolver } from "../config.js";
import type { ChannelLifecycleManager } from "../session/channel-lifecycle-manager.js";
import { reconnectContextId } from "../session/prompt-context.js";
import { captureQuitFence } from "../session/quit-fence.js";
import {
	REMOTE_STATE_DIR_COMMAND,
	remoteDaemonPaths,
	remoteDaemonStopCommand,
} from "../session/remote-daemon.js";
import type { SessionState, SharedSessionContext } from "../session/session-context.js";
import { SessionManager } from "../session/session-manager.js";
import { SshAgent } from "../session/ssh-agent.js";
import { SshConnectionManager } from "../session/ssh-connection-manager.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { registerChannelRoutes } from "./channels.js";
import { registerHostConnectionRoutes } from "./host-connection.js";
import { registerHostRoutes } from "./hosts.js";
import { readReplaceAgentBody, registerSessionRoutes } from "./sessions.js";

const agentHooks = vi.hoisted(() => ({
	start: undefined as (() => Promise<void>) | undefined,
	channelState: undefined as (() => Promise<AgentChannelStateMessage[]>) | undefined,
}));

const constructedAgents = vi.hoisted(() => [] as object[]);

// The connection to a remote daemon, as replaceAgent sees it: connected, a
// daemon, and answering a STOP the way the agent of #127 does.
vi.mock("../session/ssh-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../session/ssh-agent.js")>();
	const { EventEmitter } = await import("node:events");
	class FakeSshAgent extends EventEmitter {
		constructor() {
			super();
			constructedAgents.push(this);
		}
		closedByHub = false;
		start = vi.fn(async () => {
			await agentHooks.start?.();
		});
		lastKeyVerification = { capturedFingerprint: null, mismatch: false, tofu: false };
		waitForChannelState = vi.fn(
			async (): Promise<AgentChannelStateMessage[]> =>
				agentHooks.channelState
					? agentHooks.channelState()
					: [
							{
								type: "AGENT_CHANNEL_STATE",
								channelId: "01K580CHAN0000000000000001",
								title: "bash",
								pid: 1,
								alive: true,
							},
						],
		);
		connected = true;
		usedRemoteDaemon = true;
		remoteAgentPath = "/home/pi/.local/bin/lasterm-agent";
		helloMessage: HelloMessage | undefined;
		otherOwnerChannels: number | undefined;
		/** How many terminals other hubs hold on this daemon. */
		othersHold = 0;
		/** The terminals whose end it reports as it stops, before its connection ends. */
		exitsOnStop: string[] = [];
		readonly sent: ProtocolMessage[] = [];
		/** What this agent answers ENV_QUERY with, by mode; nothing when unset. */
		environments: Record<string, Record<string, string>> | undefined;
		send = vi.fn((msg: ProtocolMessage) => {
			this.sent.push(msg);
			if (msg.type === "ATTACH") {
				queueMicrotask(() =>
					this.emit("message", {
						type: "ATTACH_OK",
						channelId: msg.channelId,
						snapshot: new Uint8Array(),
						lastSeq: 0,
					}),
				);
				return;
			}
			if (msg.type === "ENV_QUERY") {
				const env = this.environments?.[msg.mode];
				if (env === undefined) return;
				setImmediate(() =>
					this.emit("message", { type: "ENV", requestId: msg.requestId, env, os: "linux" }),
				);
				return;
			}
			if (msg.type !== "STOP") return;
			if (!msg.force && this.othersHold > 0) {
				setImmediate(() =>
					this.emit("message", {
						type: "ERROR",
						code: "OTHER_HUBS_HOLD_CHANNELS",
						message: `${this.othersHold} terminals opened by other hubs are running here; nothing was stopped`,
						otherOwnerChannels: this.othersHold,
					}),
				);
				return;
			}
			// A daemon that stops says nothing: its terminals end, then its connection.
			setImmediate(() => {
				for (const channelId of this.exitsOnStop) {
					this.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
				}
				this.connected = false;
				this.emit("close");
			});
		});
		execOnHost = vi.fn(async (command: string) =>
			command === REMOTE_STATE_DIR_COMMAND
				? { stdout: "/home/pi/.local/state/lasterm", exitCode: 0 }
				: { stdout: "", exitCode: 0 },
		);
		close = vi.fn(async () => {
			this.closedByHub = true;
			this.connected = false;
			queueMicrotask(() => this.emit("close"));
		});
	}
	return { ...actual, SshAgent: FakeSshAgent };
});

type FakeSshAgent = SshAgent & {
	connected: boolean;
	othersHold: number;
	exitsOnStop: string[];
	environments: Record<string, Record<string, string>> | undefined;
	sent: ProtocolMessage[];
	send: ReturnType<typeof vi.fn>;
	execOnHost: ReturnType<typeof vi.fn>;
};

/** What a daemon at this hub's version says it can do. */
const DAEMON_HELLO: HelloMessage = {
	type: "HELLO",
	version: 1,
	agentVersion: HUB_VERSION,
	capabilities: ["multiplex", "resize", "snapshot", "launch-profiles", "env-modes", "hub-identity"],
};

/** A daemon older than this hub, which the hub stops once it holds nothing there (#805). */
const OUTDATED_DAEMON_HELLO: HelloMessage = { ...DAEMON_HELLO, agentVersion: "0.1.0" };

let dbs: DatabaseManager;
let sm: SessionManager;
let server: FastifyInstance;
let hostId: string;

beforeEach(async () => {
	constructedAgents.length = 0;
	agentHooks.start = undefined;
	agentHooks.channelState = undefined;
	dbs = openTestDatabases();
	const metaDal = new MetaDAL(dbs.meta);
	hostId = metaDal.createHost({ type: "ssh", label: "pi", sshHost: "pi@pi.local" }).id;
	sm = new SessionManager(dbs);
	server = Fastify({ logger: false });
	registerSessionRoutes(server, metaDal, sm);
	registerHostConnectionRoutes(server, metaDal, sm);
	registerHostRoutes(server, metaDal, sm);
	registerChannelRoutes(server, metaDal, sm);
	await server.ready();
});

afterEach(async () => {
	await server.close();
	vi.restoreAllMocks();
	sm.beginQuit();
	await sm.shutdown();
	// A fake agent ends its connection after a STOP in a setImmediate, and
	// nothing above leaves the microtask queue. Without this turn, the end of a
	// STOP no test waited for, an idle agent's retirement (#805), reached this
	// manager during the next test, with its meta.db closed (#925).
	await new Promise<void>((resolve) => setImmediate(resolve));
	dbs.close();
});

/** The agent this hub reaches the host through, already connected. */
function connectedAgent(othersHold = 0): FakeSshAgent {
	const agent = new SshAgent({ id: hostId } as never) as FakeSshAgent;
	agent.helloMessage = DAEMON_HELLO;
	agent.othersHold = othersHold;
	// Its list came, as an adoption leaves it: nothing held yet (#701).
	agent.daemonInventory = { listed: new Set(), destroyed: new Set() };
	(sm.agents as unknown as Map<string, unknown>).set(hostId, agent);
	return agent;
}

function replace(payload?: unknown) {
	return server.inject({
		method: "POST",
		url: `/api/hosts/${hostId}/agent/replace`,
		...(payload !== undefined && { payload: payload as object }),
	});
}

/**
 * A terminal running on `agent`, which the manager hears as it hears a
 * connection it opened, and a window that holds it in its state.
 */
function liveTerminalOn(agent: FakeSshAgent): {
	channelId: string;
	heard: ProtocolMessage[];
	ctx: SharedSessionContext;
} {
	const { channelIds, heard, ctx } = liveTerminalsOn(agent, 1);
	return { channelId: channelIds[0] ?? "", heard, ctx };
}

const SESSION_ID = "01K580SESSION0000000000000";

/** As liveTerminalOn, with `count` terminals on that agent. */
function liveTerminalsOn(
	agent: FakeSshAgent,
	count: number,
): { channelIds: string[]; heard: ProtocolMessage[]; ctx: SharedSessionContext } {
	const sessionId = SESSION_ID;
	const channelIds = Array.from({ length: count }, (_, i) => `01K580CHAN000000000000000${i + 1}`);
	const metaDal = new MetaDAL(dbs.meta);
	metaDal.createSession({ id: sessionId, hostId, status: "active" });
	const internals = sm as unknown as {
		ctx: SharedSessionContext;
		agentMgr: { wireAgentEvents(hostId: string, sessionId: string, agent: unknown): void };
	};
	(internals.ctx.sessions as unknown as Map<string, SessionState>).set(hostId, {
		id: sessionId,
		hostId,
		status: "active",
	});
	for (const channelId of channelIds) {
		metaDal.createChannel({ id: channelId, sessionId, status: "live", shell: "bash" });
		internals.ctx.channels.set(channelId, {
			sessionId,
			hostId,
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
	// Held by its daemon, which said so (#701).
	for (const channelId of channelIds) agent.daemonInventory?.listed.add(channelId);
	internals.agentMgr.wireAgentEvents(hostId, sessionId, agent);
	const heard: ProtocolMessage[] = [];
	sm.addClient({ id: "c-window", send: (msg) => heard.push(msg), attachedChannels: new Set() });
	return { channelIds, heard, ctx: internals.ctx };
}

function endsOf(heard: ProtocolMessage[], channelId: string): ProtocolMessage[] {
	return heard.filter(
		(m) => m.type === "CHANNEL_STATE" && m.channelId === channelId && m.status === "dead",
	);
}

describe("DELETE /api/hosts/:id ends its terminals after consent (#910)", () => {
	function remove(force = "") {
		return server.inject({ method: "DELETE", url: `/api/hosts/${hostId}${force}` });
	}

	it("R1 refuses with the live count without sending or deleting anything", async () => {
		const agent = connectedAgent();
		const { channelId, ctx } = liveTerminalOn(agent);
		const response = await remove();
		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual({
			error: {
				code: "TERMINALS_WOULD_END",
				terminals: 1,
				message:
					"1 terminal on this host has not ended. Send force=true to ask its agent to end it and delete the host.",
			},
		});
		expect(agent.sent).toEqual([]);
		expect(ctx.channels.has(channelId)).toBe(true);
		expect((await server.inject(`/api/hosts/${hostId}`)).statusCode).toBe(200);
	});

	// An outdated daemon too: the delete holds the stop marker (D3 step 1), so
	// the end of its last terminal begins no retirement and sends no STOP (#923).
	it.each([
		["at this hub's version", DAEMON_HELLO],
		["older than this hub", OUTDATED_DAEMON_HELLO],
	])(
		"V1 sends every DESTROY before close, reports each own session, and drops rows and secrets, daemon %s",
		async (_, hello) => {
			const agent = connectedAgent();
			agent.helloMessage = hello;
			const { channelIds, heard, ctx } = liveTerminalsOn(agent, 2);
			const dal = new MetaDAL(dbs.meta);
			const olderSession = "01K580SESSION0000000000001";
			dal.createSession({ id: olderSession, hostId, status: "active" });
			const second = channelIds[1]!;
			dbs.meta.prepare("UPDATE channels SET session_id = ? WHERE id = ?").run(olderSession, second);
			ctx.channels.get(second)!.sessionId = olderSession;
			const anotherWindow: ProtocolMessage[] = [];
			sm.addClient({
				id: "other-window",
				send: (msg) => anotherWindow.push(msg),
				attachedChannels: new Set(),
			});
			const order: string[] = [];
			agent.send.mockImplementation((msg: ProtocolMessage) =>
				order.push(msg.type === "DESTROY" ? msg.channelId : msg.type),
			);
			vi.spyOn(agent, "close").mockImplementation(async () => {
				order.push("close");
				agent.connected = false;
			});
			const log = vi.fn();
			ctx.hubLogger = { log } as never;
			ctx.passphraseCache.set(hostId, { secret: "secret", expiresAt: Infinity });
			ctx.passphraseCache.set("other", { secret: "other", expiresAt: Infinity });
			ctx.elevationCache.set(`${hostId}:window`, { secret: "secret", expiresAt: Infinity });
			ctx.elevationCache.set("other:window", { secret: "other", expiresAt: Infinity });
			ctx.trustedAgentSha256.set(hostId, "hash");
			ctx.trustedAgentSha256.set("other", "other-hash");
			expect((await remove("?force=true")).statusCode).toBe(204);
			// One DESTROY for each terminal, naming it, then the close.
			expect(order).toEqual([...channelIds, "close"]);
			for (const messages of [heard, anotherWindow]) {
				for (const [index, id] of channelIds.entries()) {
					expect(endsOf(messages, id)).toEqual([
						{
							type: "CHANNEL_STATE",
							channelId: id,
							sessionId: index === 0 ? SESSION_ID : olderSession,
							status: "dead",
							endReason: "killed",
							// Each end has an id of its own (#932).
							endId: expect.any(String),
						},
					]);
				}
			}
			expect((await server.inject(`/api/hosts/${hostId}`)).statusCode).toBe(404);
			for (const id of channelIds) {
				expect(ctx.channels.has(id)).toBe(false);
				expect(dal.getChannel(id)).toBeUndefined();
			}
			expect(ctx.sessions.has(hostId)).toBe(false);
			expect(ctx.agents.has(hostId)).toBe(false);
			expect(ctx.stoppingAgents.has(hostId)).toBe(false);
			expect(ctx.passphraseCache.has(hostId)).toBe(false);
			expect(ctx.passphraseCache.has("other")).toBe(true);
			expect(ctx.elevationCache.has(`${hostId}:window`)).toBe(false);
			expect(ctx.elevationCache.has("other:window")).toBe(true);
			expect(ctx.trustedAgentSha256.has(hostId)).toBe(false);
			expect(ctx.trustedAgentSha256.get("other")).toBe("other-hash");
			expect(
				log.mock.calls.filter(([, message]) => message === "session-manager: host deleted"),
			).toEqual([["info", "session-manager: host deleted", { hostId, ended: 2, unreachable: 0 }]]);
		},
	);

	it("R2 validates force before changing the host", async () => {
		const response = await remove("?force=yes");
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toEqual({
			code: "VALIDATION_ERROR",
			message: "force must be true or false.",
		});
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
	});

	it.each(
		["stop", "acquisition", "start", "attach"].flatMap((kind) =>
			["", "?force=false", "?force=true"].map((force) => ({ kind, force })),
		),
	)("R3 refuses $kind with $force", async ({ kind, force }) => {
		const agent = connectedAgent();
		const { ctx } = liveTerminalOn(agent);
		const internals = sm as unknown as {
			retirement: { startOn(id: string): () => void };
			agentMgr: { daemonAttachPromises: Map<string, Promise<unknown>> };
		};
		const has = vi.spyOn(ctx.acquisitions, "has").mockReturnValue(kind === "acquisition");
		if (kind === "stop") ctx.stoppingAgents.add(hostId);
		const end = kind === "start" ? internals.retirement.startOn(hostId) : () => {};
		if (kind === "attach")
			internals.agentMgr.daemonAttachPromises.set(hostId, new Promise(() => {}));
		const response = await remove(force);
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({
			code: "HOST_BUSY",
			message:
				kind === "stop"
					? "This host's agent is being stopped."
					: "A terminal or a connection is starting on this host. Wait for it, or answer or cancel its question, then delete the host.",
		});
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
		expect(agent.sent).toEqual([]);
		has.mockRestore();
		ctx.stoppingAgents.delete(hostId);
		end();
		internals.agentMgr.daemonAttachPromises.delete(hostId);
	});

	it.each(["", "?force=true"])("R4 refuses during quit with %s", async (force) => {
		sm.beginQuit();
		const response = await remove(force);
		expect(response.statusCode).toBe(409);
		expect(response.json().error.code).toBe("HUB_QUITTING");
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
	});

	it.each([
		[
			"",
			2,
			"2 uploads to this host are running. Wait for them to end or cancel them, then delete the host.",
		],
		[
			"?force=true",
			2,
			"2 uploads to this host are running. Wait for them to end or cancel them, then delete the host.",
		],
		[
			"",
			1,
			"1 upload to this host is running. Wait for them to end or cancel them, then delete the host.",
		],
	] as const)(
		"R5 never overrides running uploads with %s, transfers=%i",
		async (force, transfers, message) => {
			sm.setTransfers({ activeOn: () => transfers, interruptOn: vi.fn() });
			const response = await remove(force);
			expect(response.statusCode).toBe(409);
			expect(response.json().error).toEqual({ code: "TRANSFERS_RUNNING", transfers, message });
			expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
		},
	);

	it("R6 counts unreachable terminals without promising a send", async () => {
		const agent = connectedAgent();
		const { ctx, channelId } = liveTerminalOn(agent);
		ctx.agents.delete(hostId);
		ctx.channels.get(channelId)!.status = "orphan";
		const response = await remove();
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toEqual({
			code: "TERMINALS_WOULD_END",
			terminals: 1,
			unreachable: 1,
			message:
				"1 terminal on this host has not ended, and this hub is not connected to its agent: nothing can be sent to it, and it may keep running. Connecting the host first may reach it; or send force=true to delete it anyway.",
		});
		expect((await remove("?force=true")).statusCode).toBe(204);
		expect(agent.sent).toEqual([]);
		const dal = new MetaDAL(dbs.meta);
		expect(dal.getHost(hostId)).toBeUndefined();
		expect(dal.getChannel(channelId)).toBeUndefined();
		expect(ctx.channels.has(channelId)).toBe(false);
		expect(ctx.sessions.has(hostId)).toBe(false);
	});

	// D2's other forms: several terminals, and a local host, which has nothing
	// to connect first.
	it.each([
		[
			"ssh",
			2,
			false,
			"2 terminals on this host have not ended. Send force=true to ask their agent to end them and delete the host.",
		],
		[
			"ssh",
			2,
			true,
			"2 terminals on this host have not ended, and this hub is not connected to their agent: nothing can be sent to them, and they may keep running. Connecting the host first may reach them; or send force=true to delete it anyway.",
		],
		[
			"local",
			1,
			true,
			"1 terminal on this host has not ended, and this hub is not connected to its agent: nothing can be sent to it, and it may keep running. Send force=true to delete it anyway.",
		],
		[
			"local",
			2,
			true,
			"2 terminals on this host have not ended, and this hub is not connected to their agent: nothing can be sent to them, and they may keep running. Send force=true to delete it anyway.",
		],
	] as const)(
		"D2 tells a %s host's terminals=%i, unreachable=%s, in their own form",
		async (type, terminals, unreachable, message) => {
			if (type === "local")
				hostId = new MetaDAL(dbs.meta).createHost({ type: "local", label: "this machine" }).id;
			const agent = connectedAgent();
			const { ctx } = liveTerminalsOn(agent, terminals);
			if (unreachable) ctx.agents.delete(hostId);
			const response = await remove();
			expect(response.statusCode).toBe(409);
			expect(response.json().error).toEqual({
				code: "TERMINALS_WOULD_END",
				terminals,
				...(unreachable && { unreachable: terminals }),
				message,
			});
			expect(agent.sent).toEqual([]);
			expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
		},
	);

	it.each(["deleteCascadeForHost", "deleteHost"] as const)(
		"R12 releases the marker when %s throws",
		async (method) => {
			const agent = connectedAgent();
			const { ctx } = liveTerminalOn(agent);
			const ids = [...ctx.channels.keys()];
			const fail = vi.spyOn(MetaDAL.prototype, method).mockImplementationOnce(() => {
				throw new Error("disk full");
			});
			expect((await remove("?force=true")).statusCode).toBe(500);
			expect(ctx.stoppingAgents.has(hostId)).toBe(false);
			expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
			for (const id of ids) expect(new MetaDAL(dbs.meta).getChannel(id)).toBeDefined();
			fail.mockRestore();
			expect((await remove("?force=true")).statusCode).toBe(204);
		},
	);

	// A current daemon's connection is closed (#805), and so is an outdated
	// one's while its list still names the terminals being destroyed: it is
	// retired at the next connection's adoption, or ends at its idle timeout
	// (#701). The DESTROYs go first either way (#923).
	it.each([
		["at this hub's version", DAEMON_HELLO, "close"],
		["older than this hub", OUTDATED_DAEMON_HELLO, "close"],
	])("V3 session deletion sends DESTROY before ending a daemon %s", async (_, hello, end) => {
		const agent = connectedAgent();
		agent.helloMessage = hello;
		const { channelIds } = liveTerminalsOn(agent, 2);
		const order: string[] = [];
		agent.send.mockImplementation((msg: ProtocolMessage) =>
			order.push(msg.type === "DESTROY" ? msg.channelId : msg.type),
		);
		vi.spyOn(agent, "close").mockImplementation(async () => {
			order.push("close");
			agent.connected = false;
		});
		expect(
			(await server.inject({ method: "DELETE", url: `/api/sessions/${SESSION_ID}` })).statusCode,
		).toBe(204);
		expect(order).toEqual([...channelIds, end]);
	});
});

// What #910 decided about this route and no test held (#957): each case below
// names the wrong implementation it turns red.
describe("DELETE /api/hosts/:id, the decisions no test held (#957)", () => {
	const internals = () =>
		sm as unknown as {
			ctx: SharedSessionContext;
			retirement: { startOn(id: string): () => void };
		};

	function remove(query = "", id = hostId) {
		return server.inject({ method: "DELETE", url: `/api/hosts/${id}${query}` });
	}

	const uploads = (count: number) =>
		sm.setTransfers({ activeOn: (id) => (id === hostId ? count : 0), interruptOn: vi.fn() });

	/** A channel the hub tracks for `on`, as liveTerminalsOn builds one. */
	function trackChannel(channelId: string, on: string, status: "live" | "dead" | "orphan") {
		internals().ctx.channels.set(channelId, {
			sessionId: SESSION_ID,
			hostId: on,
			status,
			clients: new Set(),
			shell: "bash",
			cols: 80,
			rows: 24,
			dynamicTitle: null,
			processTitle: null,
			displayTitle: "bash",
		});
	}

	function logsOf(ctx: SharedSessionContext) {
		const log = vi.fn();
		ctx.hubLogger = { log } as never;
		return () =>
			log.mock.calls.filter(([, message]) => message === "session-manager: host deleted");
	}

	it("D1 answers an unknown id with its own code and message", async () => {
		const response = await remove("", "01K580NOSUCHHOST000000000");
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Host not found" } });
	});

	// Wrong implementations: two steps swapped. Each case holds two refusing
	// conditions at once and says which one answers.
	it.each([
		{
			name: "404 before 400",
			query: "?force=yes",
			id: "01K580NOSUCHHOST000000000",
			setup: () => {},
			status: 404,
			code: "NOT_FOUND",
		},
		{
			name: "400 before quitting",
			query: "?force=yes",
			setup: () => sm.beginQuit(),
			status: 400,
			code: "VALIDATION_ERROR",
		},
		{
			name: "quitting before busy",
			query: "",
			setup: () => {
				sm.beginQuit();
				internals().ctx.stoppingAgents.add(hostId);
			},
			status: 409,
			code: "HUB_QUITTING",
		},
		{
			name: "busy before uploads",
			query: "",
			setup: () => {
				internals().ctx.stoppingAgents.add(hostId);
				uploads(2);
			},
			status: 409,
			code: "HOST_BUSY",
		},
		{
			name: "uploads before terminals",
			query: "",
			setup: () => {
				uploads(1);
				liveTerminalOn(connectedAgent());
			},
			status: 409,
			code: "TRANSFERS_RUNNING",
		},
	])("D1 order: $name", async ({ query, id, setup, status, code }) => {
		setup();
		const response = await remove(query, id);
		expect(response.statusCode).toBe(status);
		expect(response.json().error.code).toBe(code);
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
	});

	it("D1 tells the marker before the starting hold when both are there", async () => {
		internals().ctx.stoppingAgents.add(hostId);
		const end = internals().retirement.startOn(hostId);
		const response = await remove();
		end();
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toEqual({
			code: "HOST_BUSY",
			message: "This host's agent is being stopped.",
		});
	});

	it("D1 lets running uploads win over force, and sends nothing to the terminals", async () => {
		const agent = connectedAgent();
		const { channelId, ctx } = liveTerminalOn(agent);
		uploads(1);
		const response = await remove("?force=true");
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toEqual({
			code: "TRANSFERS_RUNNING",
			transfers: 1,
			message:
				"1 upload to this host is running. Wait for them to end or cancel them, then delete the host.",
		});
		expect(agent.sent).toEqual([]);
		expect(ctx.channels.has(channelId)).toBe(true);
		expect(new MetaDAL(dbs.meta).getChannel(channelId)).toBeDefined();
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
	});

	it("D1 counts the uploads to a local host too", async () => {
		hostId = new MetaDAL(dbs.meta).createHost({ type: "local", label: "this machine" }).id;
		uploads(1);
		const response = await remove();
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({ code: "TRANSFERS_RUNNING", transfers: 1 });
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
	});

	it.each(["", "?force=true"])(
		"R4 says the hub is quitting in these words with %s",
		async (query) => {
			sm.beginQuit();
			expect((await remove(query)).json().error).toEqual({
				code: "HUB_QUITTING",
				message: "The hub is quitting.",
			});
		},
	);

	it("D1 treats force=false as no force: a live terminal is asked about, and nothing is sent", async () => {
		const agent = connectedAgent();
		const { channelId, ctx } = liveTerminalOn(agent);
		const response = await remove("?force=false");
		expect(response.statusCode).toBe(409);
		expect(response.json().error).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 1 });
		expect(agent.sent).toEqual([]);
		expect(ctx.channels.has(channelId)).toBe(true);
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeDefined();
	});

	describe("the answer", () => {
		let announced: string[];
		let other: FastifyInstance;

		beforeEach(async () => {
			announced = [];
			other = Fastify({ logger: false });
			// What the client is told, and when the answer is sent, in one list.
			other.addHook("onSend", async (_request, _reply, payload) => {
				announced.push("answer");
				return payload;
			});
			registerHostRoutes(other, new MetaDAL(dbs.meta), sm, (scope) =>
				announced.push(`announce:${scope}`),
			);
			await other.ready();
		});

		afterEach(async () => {
			await other.close();
		});

		it("D1 announces the hosts before it answers, and answers with an empty 204", async () => {
			const response = await other.inject({ method: "DELETE", url: `/api/hosts/${hostId}` });
			expect(response.statusCode).toBe(204);
			expect(response.body).toBe("");
			expect(announced).toEqual(["announce:hosts", "answer"]);
		});

		it("D1 announces nothing for a refusal", async () => {
			liveTerminalOn(connectedAgent());
			const response = await other.inject({ method: "DELETE", url: `/api/hosts/${hostId}` });
			expect(response.statusCode).toBe(409);
			expect(announced).toEqual(["answer"]);
		});
	});

	it("D1 returns its outcome at once: deleteHost is not a Promise, and the row is gone when it returns", () => {
		const outcome = sm.deleteHost(hostId, { force: true });
		expect(outcome).not.toBeInstanceOf(Promise);
		expect(new MetaDAL(dbs.meta).getHost(hostId)).toBeUndefined();
	});

	// R3, as the hub holds a host busy (#957): each refusal leaves every row, on
	// an SSH host and on a local one, whose daemon attach is under way.
	describe.each([
		["an ssh host", "ssh"],
		["a local host", "local"],
	] as const)("R3 on %s", (_, type) => {
		it.each(["stop", "acquisition", "start", "attach"])(
			"refuses while %s is held, with every row kept",
			async (kind) => {
				if (type === "local")
					hostId = new MetaDAL(dbs.meta).createHost({ type: "local", label: "this machine" }).id;
				const agent = connectedAgent();
				const { channelId, ctx } = liveTerminalOn(agent);
				const attach = (
					sm as unknown as { agentMgr: { daemonAttachPromises: Map<string, unknown> } }
				).agentMgr.daemonAttachPromises;
				const end = kind === "start" ? internals().retirement.startOn(hostId) : () => {};
				try {
					if (kind === "stop") ctx.stoppingAgents.add(hostId);
					if (kind === "acquisition") {
						ctx.acquisitions.set(hostId, {
							id: "held-acquisition",
							hostId,
							state: "CONNECTING",
							controller: new AbortController(),
							connectPromise: new Promise(() => {}),
							_resolve: vi.fn(),
							_reject: vi.fn(),
							leases: new Set(),
						});
					}
					if (kind === "attach") attach.set(hostId, new Promise(() => {}));
					for (const query of ["", "?force=false", "?force=true"]) {
						const response = await remove(query);
						expect(response.statusCode).toBe(409);
						expect(response.json().error.code).toBe("HOST_BUSY");
					}
					const dal = new MetaDAL(dbs.meta);
					expect(dal.getHost(hostId)).toBeDefined();
					expect(dal.getSession(SESSION_ID)).toBeDefined();
					expect(dal.getChannel(channelId)).toBeDefined();
					expect(agent.sent).toEqual([]);
				} finally {
					ctx.acquisitions.delete(hostId);
					ctx.stoppingAgents.delete(hostId);
					end();
					attach.delete(hostId);
				}
			},
		);
	});

	describe("D2, what it counts", () => {
		it("counts neither a dead terminal nor another host's, and ends only the live ones of this host", async () => {
			const agent = connectedAgent();
			const { channelId, heard, ctx } = liveTerminalOn(agent);
			const otherHost = new MetaDAL(dbs.meta).createHost({
				type: "ssh",
				label: "elsewhere",
				sshHost: "x@elsewhere.test",
			}).id;
			trackChannel("01K580CHANDEAD0000000000001", hostId, "dead");
			trackChannel("01K580CHANELSE0000000000001", otherHost, "live");
			const refusal = await remove();
			expect(refusal.statusCode).toBe(409);
			expect(refusal.json().error).toMatchObject({ code: "TERMINALS_WOULD_END", terminals: 1 });
			const logged = logsOf(ctx);
			expect((await remove("?force=true")).statusCode).toBe(204);
			// D3: a DESTROY for the live terminal only, and no report for the dead one.
			expect(agent.sent).toEqual([{ type: "DESTROY", channelId }]);
			expect(
				heard
					.filter((m) => m.type === "CHANNEL_STATE")
					.map((m) => (m as { channelId: string }).channelId),
			).toEqual([channelId]);
			expect(ctx.channels.has("01K580CHANDEAD0000000000001")).toBe(false);
			expect(ctx.channels.has("01K580CHANELSE0000000000001")).toBe(true);
			expect(logged()).toEqual([
				["info", "session-manager: host deleted", { hostId, ended: 1, unreachable: 0 }],
			]);
		});

		it("calls a terminal unreachable when its agent is there but not connected", async () => {
			const agent = connectedAgent();
			liveTerminalOn(agent);
			agent.connected = false;
			const response = await remove();
			expect(response.statusCode).toBe(409);
			expect(response.json().error).toEqual({
				code: "TERMINALS_WOULD_END",
				terminals: 1,
				unreachable: 1,
				message:
					"1 terminal on this host has not ended, and this hub is not connected to its agent: nothing can be sent to it, and it may keep running. Connecting the host first may reach it; or send force=true to delete it anyway.",
			});
		});
	});

	describe("D3, ending and deleting", () => {
		it("R1 keeps the host's rows, its session and its terminal's row, when it refuses", async () => {
			const { channelId } = liveTerminalOn(connectedAgent());
			expect((await remove()).statusCode).toBe(409);
			const dal = new MetaDAL(dbs.meta);
			expect(dal.getChannel(channelId)).toMatchObject({ status: "live" });
			expect(dal.getSession(SESSION_ID)).toBeDefined();
		});

		it("reports each unreachable terminal killed, once, and logs them as unreachable", async () => {
			const agent = connectedAgent();
			const { channelIds, heard, ctx } = liveTerminalsOn(agent, 2);
			ctx.agents.delete(hostId);
			const logged = logsOf(ctx);
			expect((await remove("?force=true")).statusCode).toBe(204);
			expect(agent.sent).toEqual([]);
			for (const id of channelIds) {
				expect(endsOf(heard, id)).toEqual([
					expect.objectContaining({ status: "dead", endReason: "killed", sessionId: SESSION_ID }),
				]);
			}
			expect(logged()).toEqual([
				["info", "session-manager: host deleted", { hostId, ended: 0, unreachable: 2 }],
			]);
		});

		it("takes each destroyed terminal out of the snapshot scheduler and the chunker", async () => {
			const { channelIds, ctx } = liveTerminalsOn(connectedAgent(), 2);
			const scheduler = vi.spyOn(ctx.scheduler, "untrackChannel");
			const chunker = vi.spyOn(ctx.chunker, "untrackChannel");
			expect((await remove("?force=true")).statusCode).toBe(204);
			for (const id of channelIds) {
				expect(scheduler).toHaveBeenCalledWith(id);
				expect(chunker).toHaveBeenCalledWith(id);
			}
		});

		// With a session entry, closing it calls the reconnect off as well; a host
		// the hub reconnects to without one depends on deleteHost doing it.
		it.each([
			["with its session entry", true],
			["with no session entry", false],
		])("calls off a reconnect that was waiting, and one under way, %s", async (_, withSession) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { ctx } = liveTerminalOn(connectedAgent());
				if (!withSession) ctx.sessions.delete(hostId);
				const fire = vi.fn();
				ctx.reconnectTimers.set(hostId, setTimeout(fire, 5_000) as unknown as NodeJS.Timeout);
				const underway = new AbortController();
				ctx.reconnectAbortControllers.set(hostId, underway);
				expect((await remove("?force=true")).statusCode).toBe(204);
				expect(ctx.reconnectTimers.has(hostId)).toBe(false);
				expect(ctx.reconnectAbortControllers.has(hostId)).toBe(false);
				expect(underway.signal.aborted).toBe(true);
				await vi.advanceTimersByTimeAsync(10_000);
				expect(fire).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("reports the session closed, and closes its prompt contexts", async () => {
			const { heard, ctx } = liveTerminalOn(connectedAgent());
			const contextId = reconnectContextId(SESSION_ID);
			ctx.promptContexts.set(contextId, {
				id: contextId,
				kind: "session",
				hostId,
				routeClientId: "c-window",
				state: "OPEN",
				prompts: new Set(),
			});
			heard.length = 0;
			expect((await remove("?force=true")).statusCode).toBe(204);
			const states = heard.filter((m) => m.type === "SESSION_STATE");
			expect(states.at(-1)).toMatchObject({ sessionId: SESSION_ID, hostId, status: "closed" });
			expect(states.filter((m) => (m as { status: string }).status === "closed")).toHaveLength(1);
			expect(ctx.promptContexts.get(contextId)?.state ?? "CLOSED").toBe("CLOSED");
		});

		it("forgets, without a word, the terminals it finds when the host has no session entry", async () => {
			const { heard, ctx } = liveTerminalOn(connectedAgent());
			ctx.channels.clear();
			ctx.sessions.delete(hostId);
			trackChannel("01K580CHANDEAD0000000000002", hostId, "dead");
			heard.length = 0;
			expect((await remove("?force=true")).statusCode).toBe(204);
			expect(ctx.channels.has("01K580CHANDEAD0000000000002")).toBe(false);
			expect(heard).toEqual([]);
		});

		it("deletes its rows only after the connection is closed", async () => {
			const agent = connectedAgent();
			const { channelId } = liveTerminalOn(agent);
			const dal = new MetaDAL(dbs.meta);
			const atClose: { host: boolean; channel: boolean }[] = [];
			vi.spyOn(agent, "close").mockImplementation(async () => {
				atClose.push({
					host: dal.getHost(hostId) !== undefined,
					channel: dal.getChannel(channelId) !== undefined,
				});
				agent.connected = false;
			});
			expect((await remove("?force=true")).statusCode).toBe(204);
			expect(atClose).toEqual([{ host: true, channel: true }]);
			expect(dal.getHost(hostId)).toBeUndefined();
		});

		it("V2 logs a delete with nothing to end, and drops the host's secrets", async () => {
			const ctx = internals().ctx;
			const logged = logsOf(ctx);
			ctx.passphraseCache.set(hostId, { secret: "secret", expiresAt: Infinity });
			ctx.passphraseCache.set("other", { secret: "other", expiresAt: Infinity });
			ctx.elevationCache.set(`${hostId}:window`, { secret: "secret", expiresAt: Infinity });
			ctx.elevationCache.set("other:window", { secret: "other", expiresAt: Infinity });
			ctx.trustedAgentSha256.set(hostId, "hash");
			ctx.trustedAgentSha256.set("other", "other-hash");
			expect((await remove()).statusCode).toBe(204);
			expect(logged()).toEqual([
				["info", "session-manager: host deleted", { hostId, ended: 0, unreachable: 0 }],
			]);
			expect([...ctx.passphraseCache.keys()]).toEqual(["other"]);
			expect([...ctx.elevationCache.keys()]).toEqual(["other:window"]);
			expect([...ctx.trustedAgentSha256.keys()]).toEqual(["other"]);
		});
	});
});

describe("terminal work arriving after deletion or a lost connection (#910)", () => {
	function fixture() {
		const agent = connectedAgent();
		const f = liveTerminalOn(agent);
		const lifecycle = (sm as unknown as { lifecycle: ChannelLifecycleManager }).lifecycle;
		return { ...f, agent, lifecycle, dal: new MetaDAL(dbs.meta) };
	}

	it("V6 cancels an open waiting on the reconnect after retirement", async () => {
		const { ctx, agent, heard } = fixture();
		let resume!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			resume = resolve;
		});
		agentHooks.start = async () => {
			entered();
			await held;
		};
		const retirement = (
			sm as unknown as { retirement: { retireIfIdle: (id: string) => Promise<unknown> | null } }
		).retirement;
		vi.spyOn(retirement, "retireIfIdle").mockImplementationOnce(() => {
			ctx.agents.delete(hostId);
			return Promise.resolve();
		});
		const opening = sm.handleSpawn("c-window", { type: "SPAWN", hostId });
		await started;
		expect(ctx.reconnectAbortControllers.has(hostId)).toBe(true);
		expect(
			(await server.inject({ method: "DELETE", url: `/api/hosts/${hostId}?force=true` }))
				.statusCode,
		).toBe(204);
		resume();
		expect(await opening).toBeNull();
		const reconnect = constructedAgents.at(-1) as FakeSshAgent;
		expect(reconnect).not.toBe(agent);
		expect(reconnect.closedByHub).toBe(true);
		expect(reconnect.sent.some((msg) => msg.type === "SPAWN")).toBe(false);
		expect(ctx.agents.has(hostId)).toBe(false);
		expect(heard).toContainEqual(expect.objectContaining({ type: "ERROR", hostId }));
	});

	it.each(["open", "restart", "reconnect"])(
		"R7 refuses a prepared %s SPAWN after its host row goes",
		async (kind) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { agent, ctx, lifecycle, dal, heard, channelId } = fixture();
				dal.deleteCascadeForHost(hostId);
				dal.deleteHost(hostId);
				const spawnMsg = {
					type: "SPAWN" as const,
					requestId: "deleted-request",
					cols: 80,
					rows: 24,
					envMode: "inherit" as const,
				};
				let result: unknown;
				if (kind === "open") {
					const pending = lifecycle
						.sendSpawnAndWait({
							agent,
							spawnMsg,
							hostId,
							session: { id: SESSION_ID },
							client: ctx.clients.get("c-window")!,
							clientId: "c-window",
							resolvedShell: undefined,
							resolvedArgs: [],
							resolvedCwd: undefined,
							resolvedDirectProcess: false,
							resolvedLaunchProfileId: undefined,
							cols: 80,
							rows: 24,
							reuseChannelId: channelId,
						})
						.catch((error: Error) => ({ error: error.message }));
					await vi.advanceTimersByTimeAsync(10_001);
					result = await pending;
					expect(result).toEqual({ channelId: null, errCode: "HOST_NOT_FOUND" });
					expect(heard).toContainEqual({
						type: "ERROR",
						code: "HOST_NOT_FOUND",
						hostId,
						channelId,
						message: "That host is no longer in this hub's list.",
					});
				} else if (kind === "restart") {
					const pending = (
						lifecycle as unknown as {
							sendRestartSpawn(agent: unknown, msg: unknown, hostId: string): Promise<unknown>;
						}
					).sendRestartSpawn(agent, spawnMsg, hostId);
					await vi.advanceTimersByTimeAsync(10_001);
					result = await pending;
					expect(result).toEqual({ ok: false, channelId: null, errCode: "HOST_NOT_FOUND" });
				} else {
					const pending = lifecycle.spawnChannelsForHost(hostId, agent, vi.fn(), vi.fn());
					expect(vi.getTimerCount()).toBe(0);
					await vi.advanceTimersByTimeAsync(10_001);
					await pending;
					expect(heard.filter((m) => m.type === "CHANNEL_STATE")).toEqual([]);
				}
				expect(agent.sent).toEqual([]);
				expect(ctx.pendingRequests.size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("R11 delivers a bastion answer but does not cache it after the bastion is deleted", async () => {
		const { ctx, dal } = fixture();
		const target = dal.createHost({
			type: "ssh",
			label: "target",
			sshHost: "target.test",
			sshProxyHostId: hostId,
		});
		ctx.acquisitions.set(target.id, {
			id: "target-acquisition",
			hostId: target.id,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: new Promise(() => {}),
			_resolve: vi.fn(),
			_reject: vi.fn(),
			leases: new Set(),
		});
		const mgr = (sm as unknown as { sshMgr: SshConnectionManager }).sshMgr;
		const client = ctx.clients.get("c-window")!;
		const auth = mgr.buildPromptAuth(client, undefined, "target-acquisition");
		const targetAnswer = auth(target.id, "password", "Target password");
		const [targetPromptId, targetPending] = [...ctx.pendingPrompts.entries()][0]!;
		mgr.handleAuthPromptResponse(client.id, {
			hostId: target.id,
			secret: "target answer",
			promptId: targetPromptId,
			deliveryEpoch: targetPending.deliveryEpoch!,
		});
		await targetAnswer;
		const answer = auth(hostId, "passphrase", "Enter bastion passphrase");
		const [promptId, pending] = [...ctx.pendingPrompts.entries()][0]!;
		expect(ctx.promptContexts.get(pending.contextId!)?.hostId).toBe(target.id);
		// The owning connection can keep asking about its jump after deletion.
		expect(target.sshProxyHostId).toBe(hostId);
		expect(
			(await server.inject({ method: "DELETE", url: `/api/hosts/${hostId}?force=true` }))
				.statusCode,
		).toBe(204);
		mgr.handleAuthPromptResponse(client.id, {
			hostId,
			secret: "answer",
			rememberSession: true,
			promptId,
			deliveryEpoch: pending.deliveryEpoch!,
		});
		await expect(answer).resolves.toBe("answer");
		expect(ctx.passphraseCache.has(hostId)).toBe(false);
	});

	it.each([false, true])("R8 ignores a forgotten snapshot with row present=%s", (rowPresent) => {
		const { lifecycle, dal, channelId, ctx } = fixture();
		lifecycle.destroyChannel(channelId);
		if (!rowPresent) dal.deleteCascadeForHost(hostId);
		const write = vi.spyOn(ctx.spoolDal, "insertSnapshot");
		expect(() => lifecycle.storeSnapshot(channelId, { rows: [] })).not.toThrow();
		expect(write).not.toHaveBeenCalled();
		expect(
			dbs.meta.prepare("SELECT * FROM cache_index WHERE channel_id = ?").all(channelId),
		).toEqual([]);
	});

	it.each(["timeout", "answer"])(
		"R10 ignores a forgotten reconnect terminal's %s",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { agent, ctx, lifecycle, channelId, heard } = fixture();
				ctx.channels.get(channelId)!.clients.add("c-window");
				lifecycle.reAttachChannels(hostId, SESSION_ID, agent);
				const request = agent.sent.find((m) => m.type === "SPAWN")!;
				if (request.type !== "SPAWN") throw new Error("expected SPAWN");
				lifecycle.destroyChannel(channelId);
				heard.length = 0;
				const track = vi.spyOn(ctx.scheduler, "trackChannel");
				const chunk = vi.spyOn(ctx.chunker, "trackChannel");
				if (mode === "answer")
					agent.emit("message", {
						type: "SPAWN_OK",
						requestId: request.requestId,
						channelId,
						pid: 1,
					});
				else await vi.advanceTimersByTimeAsync(10_001);
				expect(heard.filter((m) => m.type === "CHANNEL_STATE")).toEqual([]);
				expect(ctx.channels.has(channelId)).toBe(false);
				expect(track).not.toHaveBeenCalled();
				expect(chunk).not.toHaveBeenCalled();
				expect(ctx.pendingRequests.size).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	// D4b: a handler that says nothing still frees what it held (#957).
	it("R10 frees the timer of a reconnect answer it ignores, and settles the batch", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { agent, ctx, lifecycle, channelId } = fixture();
			const timersBefore = vi.getTimerCount();
			const batch = lifecycle.spawnChannelsForHost(hostId, agent, vi.fn(), vi.fn());
			const request = agent.sent.find((m) => m.type === "SPAWN")!;
			if (request.type !== "SPAWN") throw new Error("expected SPAWN");
			expect(vi.getTimerCount()).toBe(timersBefore + 1);
			lifecycle.destroyChannel(channelId);
			let settled = false;
			void batch.then(() => {
				settled = true;
			});
			agent.emit("message", { type: "SPAWN_OK", requestId: request.requestId, channelId, pid: 1 });
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(true);
			expect(vi.getTimerCount()).toBe(timersBefore);
			expect(ctx.pendingRequests.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// D4b: whichever way a reconnect's SPAWN stops speaking for its terminal,
	// the batch it belongs to still settles (#957).
	it.each(["forgotten terminal", "replaced connection"])(
		"R10 settles the batch when the timeout of a %s fires",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { agent, ctx, lifecycle, channelId } = fixture();
				const batch = lifecycle.spawnChannelsForHost(hostId, agent, vi.fn(), vi.fn());
				let settled = false;
				void batch.then(() => {
					settled = true;
				});
				if (mode === "forgotten terminal") lifecycle.destroyChannel(channelId);
				else ctx.agents.delete(hostId);
				await vi.advanceTimersByTimeAsync(10_001);
				expect(settled).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	// D4b: an old SPAWN speaks for the state object it was sent for, not for
	// whatever is tracked under the same id by the time it answers.
	it.each(["timeout", "answer"])(
		"R10 ignores the %s of a SPAWN once another state is tracked under its id",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { agent, ctx, lifecycle, channelId, heard } = fixture();
				const old = ctx.channels.get(channelId)!;
				lifecycle.reAttachChannels(hostId, SESSION_ID, agent);
				const request = agent.sent.find((m) => m.type === "SPAWN")!;
				if (request.type !== "SPAWN") throw new Error("expected SPAWN");
				const replacement = { ...old, clients: new Set<string>() };
				ctx.channels.set(channelId, replacement);
				heard.length = 0;
				const track = vi.spyOn(ctx.scheduler, "trackChannel");
				if (mode === "answer")
					agent.emit("message", {
						type: "SPAWN_OK",
						requestId: request.requestId,
						channelId,
						pid: 1,
					});
				else await vi.advanceTimersByTimeAsync(10_001);
				expect(heard.filter((m) => m.type === "CHANNEL_STATE")).toEqual([]);
				expect(track).not.toHaveBeenCalled();
				expect(ctx.channels.get(channelId)).toBe(replacement);
				expect(replacement.status).toBe("live");
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("R7 answers an open for a host the hub does not know with its one message", async () => {
		const { heard } = fixture();
		const unknown = "01K580NOSUCHHOST000000000";
		await sm.handleSpawn("c-window", { type: "SPAWN", hostId: unknown });
		expect(heard).toContainEqual({
			type: "ERROR",
			code: "HOST_NOT_FOUND",
			message: "That host is no longer in this hub's list.",
			hostId: unknown,
		});
	});

	it.each(["new-spawn", "new-spawn, old answer early", "lost", "adopted"])(
		"R10 keeps the terminal after the old connection is %s",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const { agent, ctx, lifecycle, channelId, heard } = fixture();
				const state = ctx.channels.get(channelId)!;
				state.clients.add("c-window");
				lifecycle.reAttachChannels(hostId, SESSION_ID, agent);
				const old = agent.sent.find((m) => m.type === "SPAWN")!;
				if (old.type !== "SPAWN") throw new Error("expected SPAWN");
				ctx.agents.delete(hostId);
				if (mode !== "lost") {
					const next = connectedAgent();
					if (mode === "adopted") await lifecycle.adoptWhatTheDaemonHolds(hostId, next);
					else {
						lifecycle.reAttachChannels(hostId, SESSION_ID, next);
						const request = next.sent.find((m) => m.type === "SPAWN")!;
						if (request.type !== "SPAWN") throw new Error("expected SPAWN");
						if (!request.requestId) throw new Error("expected request id");
						if (!ctx.pendingRequests.has(request.requestId))
							throw new Error("expected the second SPAWN to wait for its answer");
						// As a reconnect does, the hub hears the new connection before its answer.
						(
							sm as unknown as {
								agentMgr: { wireAgentEvents(h: string, s: string, a: unknown): void };
							}
						).agentMgr.wireAgentEvents(hostId, SESSION_ID, next);
						heard.length = 0;
						next.emit("message", {
							type: "SPAWN_OK",
							requestId: request.requestId,
							channelId,
							pid: 1,
						});
						// R10 (c): the connection the host now has speaks for the terminal.
						expect(heard.filter((m) => m.type === "CHANNEL_STATE")).toEqual([
							{ type: "CHANNEL_STATE", channelId, sessionId: SESSION_ID, status: "live" },
						]);
					}
				}
				heard.length = 0;
				if (mode === "new-spawn, old answer early") {
					// D4b: the replaced connection's answer, before its own timeout,
					// speaks of a terminal the new connection holds now.
					const track = vi.spyOn(ctx.scheduler, "trackChannel");
					const chunk = vi.spyOn(ctx.chunker, "trackChannel");
					agent.emit("message", { type: "SPAWN_OK", requestId: old.requestId, channelId, pid: 1 });
					expect(heard.filter((m) => m.type === "CHANNEL_STATE")).toEqual([]);
					expect(track).not.toHaveBeenCalled();
					expect(chunk).not.toHaveBeenCalled();
					expect(ctx.pendingRequests.has(old.requestId!)).toBe(false);
				}
				await vi.advanceTimersByTimeAsync(10_001);
				agent.emit("message", { type: "SPAWN_OK", requestId: old.requestId, channelId, pid: 1 });
				expect(heard.filter((m) => m.type === "CHANNEL_STATE")).toEqual([]);
				expect(ctx.channels.get(channelId)).toBe(state);
				// Not dead, and not some other status the old timeout chose without a word (#957).
				expect(state.status).toBe("live");
				// Whichever the old connection's end, the next connection starts it again.
				const next = connectedAgent();
				const batch = lifecycle.spawnChannelsForHost(hostId, next, vi.fn(), vi.fn());
				expect(next.sent.some((m) => m.type === "SPAWN")).toBe(true);
				await vi.advanceTimersByTimeAsync(10_001);
				await batch;
			} finally {
				vi.useRealTimers();
			}
		},
	);

	// D5 (#957): a snapshot for a channel the hub no longer tracks is dropped
	// at the one place that writes it, whoever brings it, and the scheduler's
	// slot is freed all the same.
	it.each([false, true])(
		"D5 frees the scheduler's slot for a forgotten channel's SNAPSHOT_RES, and stores nothing, row present=%s",
		(rowPresent) => {
			const { agent, ctx, lifecycle, channelId, dal } = fixture();
			lifecycle.destroyChannel(channelId);
			if (!rowPresent) dal.deleteCascadeForHost(hostId);
			const slot = vi.spyOn(ctx.scheduler, "onSnapshotResponse");
			const write = vi.spyOn(ctx.spoolDal, "insertSnapshot");
			agent.emit("message", { type: "SNAPSHOT_RES", channelId, snapshot: { rows: [] } });
			expect(slot).toHaveBeenCalledWith(channelId);
			expect(write).not.toHaveBeenCalled();
		},
	);

	it("D5 stores nothing for an ATTACH answer that comes after its channel is forgotten", async () => {
		const { ctx, lifecycle, channelId } = fixture();
		const write = vi.spyOn(ctx.spoolDal, "insertSnapshot");
		const attaching = sm.handleAttach("c-window", channelId);
		// The fake agent answers on the next microtask: the channel goes first.
		lifecycle.destroyChannel(channelId);
		await attaching;
		expect(write).not.toHaveBeenCalled();
		expect(
			dbs.meta.prepare("SELECT * FROM cache_index WHERE channel_id = ?").all(channelId),
		).toEqual([]);
	});

	it("R8 leaves an existing cache index alone when a forgotten channel's snapshot comes", () => {
		const { agent, ctx, lifecycle, channelId } = fixture();
		expect(lifecycle.storeSnapshot(channelId, { rows: ["kept"] })).toBeDefined();
		const index = () =>
			dbs.meta.prepare("SELECT * FROM cache_index WHERE channel_id = ?").all(channelId);
		const kept = index();
		expect(kept).toHaveLength(1);
		const chunks = () => ctx.spoolDal.getMaxSeq(channelId);
		const seq = chunks();
		lifecycle.destroyChannel(channelId);
		agent.emit("message", { type: "SNAPSHOT_RES", channelId, snapshot: { rows: ["late"] } });
		expect(index()).toEqual(kept);
		expect(chunks()).toBe(seq);
	});

	// R7 (#957): the open path itself, as a client's SPAWN takes it, with the
	// row deleted after the checks and before the SPAWN is sent.
	it("R7 answers a client's open with HOST_NOT_FOUND, and sends no SPAWN, when the row goes mid-open", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { agent, ctx, lifecycle, heard, dal } = fixture();
			const send = lifecycle.sendSpawnAndWait.bind(lifecycle);
			vi.spyOn(lifecycle, "sendSpawnAndWait").mockImplementationOnce((...args) => {
				dal.deleteCascadeForHost(hostId);
				dal.deleteHost(hostId);
				return send(...args);
			});
			const opening = sm.handleSpawn("c-window", { type: "SPAWN", hostId });
			await vi.advanceTimersByTimeAsync(10_001);
			await opening;
			expect(agent.sent.filter((m) => m.type === "SPAWN")).toEqual([]);
			expect(heard).toContainEqual({
				type: "ERROR",
				code: "HOST_NOT_FOUND",
				hostId,
				message: "That host is no longer in this hub's list.",
			});
			expect(ctx.pendingRequests.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	// R11 (#957): the answer reaches the target's connection by the route the
	// client's PROMPT_RESPONSE takes, and caches nothing under the deleted bastion.
	it("R11 delivers the bastion's answer through the client's PROMPT_RESPONSE, and does not cache it", async () => {
		const { ctx, dal } = fixture();
		const target = dal.createHost({
			type: "ssh",
			label: "target",
			sshHost: "target.test",
			sshProxyHostId: hostId,
		});
		ctx.acquisitions.set(target.id, {
			id: "target-acquisition",
			hostId: target.id,
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: new Promise(() => {}),
			_resolve: vi.fn(),
			_reject: vi.fn(),
			leases: new Set(),
		});
		const mgr = (sm as unknown as { sshMgr: SshConnectionManager }).sshMgr;
		const auth = mgr.buildPromptAuth(ctx.clients.get("c-window")!, undefined, "target-acquisition");
		const answer = auth(hostId, "passphrase", "Enter bastion passphrase");
		const [promptId, pending] = [...ctx.pendingPrompts.entries()][0]!;
		expect(
			(await server.inject({ method: "DELETE", url: `/api/hosts/${hostId}?force=true` }))
				.statusCode,
		).toBe(204);
		sm.handleAuthPromptResponse("c-window", {
			hostId,
			secret: "answer",
			rememberSession: true,
			promptId,
			deliveryEpoch: pending.deliveryEpoch!,
		});
		await expect(answer).resolves.toBe("answer");
		expect(ctx.passphraseCache.has(hostId)).toBe(false);
	});
});

// What DELETE /api/sessions/:id sends, and in what order (#957).
describe("DELETE /api/sessions/:id, the DESTROYs it sends (#910)", () => {
	function end() {
		return server.inject({ method: "DELETE", url: `/api/sessions/${SESSION_ID}` });
	}

	it("D6 sends each DESTROY before it reports any terminal killed", async () => {
		const agent = connectedAgent();
		const { channelIds } = liveTerminalsOn(agent, 2);
		const order: string[] = [];
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			if (msg.type === "DESTROY") order.push(`destroy ${msg.channelId}`);
		});
		sm.addClient({
			id: "c-order",
			send: (msg) => {
				if (msg.type === "CHANNEL_STATE") order.push(`${msg.status} ${msg.channelId}`);
			},
			attachedChannels: new Set(),
		});
		expect((await end()).statusCode).toBe(204);
		expect(order).toEqual([
			`destroy ${channelIds[0]}`,
			`destroy ${channelIds[1]}`,
			`dead ${channelIds[0]}`,
			`dead ${channelIds[1]}`,
		]);
	});

	// An agent older than this hub, on the local host, is stopped once the
	// session's terminals are gone: its STOP comes after their DESTROYs.
	it("V3 sends every DESTROY before the STOP that retires an outdated local daemon", async () => {
		hostId = new MetaDAL(dbs.meta).createHost({ type: "local", label: "this machine" }).id;
		const agent = connectedAgent();
		agent.helloMessage = OUTDATED_DAEMON_HELLO;
		const { channelIds } = liveTerminalsOn(agent, 2);
		const order: string[] = [];
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			order.push(msg.type === "DESTROY" ? `DESTROY ${msg.channelId}` : msg.type);
		});
		expect((await end()).statusCode).toBe(204);
		await new Promise((resolve) => setImmediate(resolve));
		expect(order).toEqual([`DESTROY ${channelIds[0]}`, `DESTROY ${channelIds[1]}`, "STOP"]);
	});

	it("D6 sends nothing to an agent that is not connected, and still reports the terminals", async () => {
		const agent = connectedAgent();
		const { channelId, heard } = liveTerminalOn(agent);
		agent.connected = false;
		expect((await end()).statusCode).toBe(204);
		expect(agent.sent).toEqual([]);
		expect(endsOf(heard, channelId)).toHaveLength(1);
	});

	it("D6 sends no DESTROY for a terminal that has ended", async () => {
		const agent = connectedAgent();
		const { channelIds, ctx } = liveTerminalsOn(agent, 2);
		ctx.channels.get(channelIds[1]!)!.status = "dead";
		expect((await end()).statusCode).toBe(204);
		expect(agent.sent).toEqual([{ type: "DESTROY", channelId: channelIds[0] }]);
	});
});

// Replacing the agent ends its terminals, and on purpose: a pane set to
// restart them must not bring them back on the new one (#580).
describe("POST /api/hosts/:id/agent/replace, and the terminals that end with it (#580)", () => {
	it("says of each terminal that ends as the agent stops that the hub ended it", async () => {
		const agent = connectedAgent();
		const { channelId, heard } = liveTerminalOn(agent);
		agent.exitsOnStop = [channelId];

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(endsOf(heard, channelId)).toEqual([
			expect.objectContaining({ exitCode: 0, endReason: "stopped" }),
		]);
		// Stopped, not killed: nobody aimed at that terminal. Stored with the
		// end, a pane that finds it ended later follows its setting (#592).
		expect(new MetaDAL(dbs.meta).getChannel(channelId)).toMatchObject({
			status: "dead",
			endReason: "stopped",
		});
	});

	it("says nothing of the kind of a terminal that ends after a refused replace", async () => {
		const agent = connectedAgent(2);
		const { channelId, heard } = liveTerminalOn(agent);

		expect((await replace()).statusCode).toBe(409);
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });

		const ends = endsOf(heard, channelId);
		expect(ends).toHaveLength(1);
		expect(ends[0]).not.toHaveProperty("endReason");
		expect(new MetaDAL(dbs.meta).getChannel(channelId)).not.toHaveProperty("endReason");
	});
});

// What the real app does: the daemon tears its terminals down and its
// connection goes before any of their exit reports reaches the hub. They were
// left live, until a reconnect after the next launch found them unknown and
// ended them with no reason at all (#599).
describe("POST /api/hosts/:id/agent/replace, when no end is reported (#599)", () => {
	function expectEveryOneStopped(channelIds: string[], heard: ProtocolMessage[]): void {
		const metaDal = new MetaDAL(dbs.meta);
		for (const channelId of channelIds) {
			// Told to every window as it happens: a pane over it shows that it
			// was stopped from elsewhere, and does not start it again (#580).
			expect(endsOf(heard, channelId)).toEqual([
				{
					type: "CHANNEL_STATE",
					channelId,
					sessionId: SESSION_ID,
					status: "dead",
					endReason: "stopped",
					endId: expect.any(String),
				},
			]);
			// Kept with the end: found at the next launch, it follows its setting (#592).
			expect(metaDal.getChannel(channelId)).toMatchObject({
				status: "dead",
				endReason: "stopped",
			});
			// And no longer held as running, by a hub that has no agent there.
			expect(sm.channels.has(channelId)).toBe(false);
		}
	}

	it("ends every terminal the agent held, stopped, once the STOP is confirmed", async () => {
		const agent = connectedAgent();
		const { channelIds, heard } = liveTerminalsOn(agent, 2);

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expectEveryOneStopped(channelIds, heard);
	});

	it("does the same when a STOP it cannot send leaves the agent to its own --stop", async () => {
		const agent = connectedAgent();
		const { channelIds, heard } = liveTerminalsOn(agent, 2);
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			if (msg.type === "STOP") throw new Error("SSH agent not connected");
		});

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.execOnHost).toHaveBeenCalledTimes(2);
		expectEveryOneStopped(channelIds, heard);
	});

	// The daemon's stop closes its channel, and that ends the SSH client the
	// `--stop` exec runs on, before the exec has an exit status (#1111).
	it.each([
		["a non-zero exit", async () => ({ stdout: "", exitCode: 255 })],
		[
			"a rejection",
			async () => {
				throw new Error("SSH agent not connected");
			},
		],
	])(
		"counts the connection closing during its own --stop as the stop, with %s",
		async (_name, answer) => {
			const agent = connectedAgent();
			const { channelIds, heard } = liveTerminalsOn(agent, 2);
			agent.send.mockImplementation((msg: ProtocolMessage) => {
				if (msg.type === "STOP") throw new Error("SSH agent not connected");
			});
			agent.execOnHost.mockImplementation(async (command: string) => {
				if (command === REMOTE_STATE_DIR_COMMAND) {
					return { stdout: "/home/pi/.local/state/lasterm", exitCode: 0 };
				}
				agent.connected = false;
				agent.emit("close");
				return answer();
			});

			const res = await replace();

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({ replaced: true });
			expectEveryOneStopped(channelIds, heard);
			expect(sm.agents.has(hostId)).toBe(false);
		},
	);

	// An unsent STOP means the agent channel is closed, so the agent is no
	// longer `connected` while its SSH client may still run the `--stop`.
	it("runs its own --stop when the STOP cannot be sent because the agent channel is closed", async () => {
		const agent = connectedAgent();
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			if (msg.type === "STOP") {
				agent.connected = false;
				throw new Error("SSH agent not connected");
			}
		});

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ replaced: true });
		expect(agent.execOnHost).toHaveBeenCalledTimes(2);
	});

	it("says nothing was changed only when it is known, not after a --stop whose connection stayed up and failed", async () => {
		const agent = connectedAgent();
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			if (msg.type === "STOP") throw new Error("SSH agent not connected");
		});
		agent.execOnHost.mockImplementation(async (command: string) =>
			command === REMOTE_STATE_DIR_COMMAND
				? { stdout: "/home/pi/.local/state/lasterm", exitCode: 0 }
				: { stdout: "", exitCode: 1 },
		);

		const res = await replace();

		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({
			error: { code: "AGENT_NOT_REPLACED", message: "The agent would not stop (exit 1)." },
		});
		expect(sm.agents.get(hostId)).toBe(agent);
	});

	// On stdio the agent is not stopped, and nothing it runs ends.
	it("ends nothing when the agent is not stopped", async () => {
		const agent = connectedAgent();
		agent.usedRemoteDaemon = false;
		const { channelIds, heard } = liveTerminalsOn(agent, 1);

		expect((await replace()).statusCode).toBe(409);

		const channelId = channelIds[0] ?? "";
		expect(endsOf(heard, channelId)).toEqual([]);
		expect(sm.channels.get(channelId)?.status).toBe("live");
		expect(new MetaDAL(dbs.meta).getChannel(channelId)?.status).toBe("live");
	});
});

describe("POST /api/hosts/:id/agent/replace, refused by its daemon's own list (#701)", () => {
	it.each(["AGENT_INVENTORY_UNKNOWN", "OTHER_HOST_TERMINALS", "TERMINALS_SHOWN_ENDED"])(
		"answers %s with its own code, and sends no STOP",
		async (code) => {
			const agent = connectedAgent();
			const { channelIds } = liveTerminalsOn(agent, 1);
			const tracked = sm.channels.get(channelIds[0] ?? "");
			if (tracked === undefined) throw new Error("no terminal");
			if (code === "AGENT_INVENTORY_UNKNOWN") agent.daemonInventory = undefined;
			if (code === "OTHER_HOST_TERMINALS") {
				const other = new MetaDAL(dbs.meta).createHost({
					type: "ssh",
					label: "pi-again",
					sshHost: "pi@pi.local",
				});
				sm.channels.set("01K701ELSEWHERE00000000000", { ...tracked, hostId: other.id });
				agent.daemonInventory?.listed.add("01K701ELSEWHERE00000000000");
			}
			if (code === "TERMINALS_SHOWN_ENDED") {
				sm.channels.set("01K701SHOWNENDED0000000000", { ...tracked, status: "dead" });
				agent.daemonInventory?.listed.add("01K701SHOWNENDED0000000000");
			}
			const refused = await replace({ force: true });
			expect(refused.statusCode).toBe(409);
			expect(refused.json()).toMatchObject({ error: { code } });
			expect(agent.sent.filter((msg) => msg.type === "STOP")).toEqual([]);
		},
	);
});

describe("POST /api/hosts/:id/agent/replace, on an agent other hubs use (#127)", () => {
	it("answers 409 with the count, and a forced retry sends STOP { force: true }", async () => {
		const agent = connectedAgent(2);

		const refused = await replace();

		expect(refused.statusCode).toBe(409);
		expect(refused.json()).toEqual({
			error: {
				code: "OTHER_HUBS_HOLD_CHANNELS",
				message: "2 terminals opened by other hubs are running here; nothing was stopped",
				other_owner_channels: 2,
			},
		});
		expect(agent.sent).toEqual([{ type: "STOP", force: false }]);
		// Nothing stopped, so nothing was let go of.
		expect(sm.agents.get(hostId)).toBe(agent);

		// The close is heard by the manager's own handling too; by then this hub
		// must already have let go, or it reads a dropped link and dials again.
		let heldWhenClosed: boolean | undefined;
		agent.on("close", () => {
			heldWhenClosed = sm.agents.get(hostId) === agent;
		});
		const forced = await replace({ force: true });

		expect(forced.statusCode).toBe(200);
		expect(forced.json()).toMatchObject({ replaced: true });
		expect(agent.sent.at(-1)).toEqual({ type: "STOP", force: true });
		expect(heldWhenClosed).toBe(false);
		expect(sm.agents.has(hostId)).toBe(false);
		// Asked for, so the security log's disconnect is this hub's, not a lost link.
		expect(agent.closedByHub).toBe(true);
		// The protocol answered for itself: the out-of-band stop was not needed.
		expect(agent.execOnHost).not.toHaveBeenCalled();
	});

	it("stops at once when no other hub holds anything there", async () => {
		const agent = connectedAgent();

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.sent).toEqual([{ type: "STOP", force: false }]);
	});

	it("falls back to the agent's --stop when the STOP cannot be written", async () => {
		const agent = connectedAgent(2);
		agent.send.mockImplementation(() => {
			throw new Error("SSH agent not connected");
		});

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.execOnHost.mock.calls).toEqual([
			[REMOTE_STATE_DIR_COMMAND],
			[
				remoteDaemonStopCommand(
					"/home/pi/.local/bin/lasterm-agent",
					remoteDaemonPaths("/home/pi/.local/state/lasterm"),
				),
			],
		]);
		expect(sm.agents.has(hostId)).toBe(false);
	});

	it("refuses a force that is not a boolean, and asks the agent nothing", async () => {
		const agent = connectedAgent(2);

		const res = await replace({ force: "yes" });

		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
		expect(agent.sent).toEqual([]);
	});
});

describe("GET /api/hosts/:id/agent-environment (#576)", () => {
	function environment(mode?: string) {
		return server.inject({
			method: "GET",
			url: `/api/hosts/${hostId}/agent-environment${mode === undefined ? "" : `?mode=${mode}`}`,
		});
	}

	it("asks the agent, for the mode requested, and answers with what it says", async () => {
		const agent = connectedAgent();
		agent.environments = {
			inherit: { HOME: "/home/pi", EDITOR: "vi", TERM: "xterm-256color" },
			minimal: { HOME: "/home/pi", TERM: "xterm-256color" },
		};

		const res = await environment("minimal");

		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			mode: "minimal",
			os: "linux",
			env: { HOME: "/home/pi", TERM: "xterm-256color" },
		});
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(agent.sent).toEqual([
			expect.objectContaining({
				type: "ENV_QUERY",
				mode: "minimal",
				requestId: expect.any(String),
			}),
		]);
	});

	it("answers 409 HOST_NOT_CONNECTED when no agent of this host is connected", async () => {
		const res = await environment("inherit");

		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({ error: { code: "HOST_NOT_CONNECTED" } });
	});

	it("refuses a mode it does not know, and asks the agent nothing", async () => {
		const agent = connectedAgent();

		const res = await environment("clean");

		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
		expect(agent.sent).toEqual([]);
	});

	it("answers 404 for a host it does not know", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/hosts/01HZZZZZZZZZZZZZZZZZZZZZZZ/agent-environment?mode=inherit",
		});

		expect(res.statusCode).toBe(404);
	});
});

describe("SessionManager.queryAgentEnvironment", () => {
	it("gives up on an agent that does not answer", async () => {
		connectedAgent();

		expect(await sm.queryAgentEnvironment(hostId, "inherit", 20)).toEqual({ kind: "timeout" });
	});

	it("says not connected when the connection ends before the answer", async () => {
		const agent = connectedAgent();
		const asked = sm.queryAgentEnvironment(hostId, "inherit", 5_000);

		agent.emit("close");

		expect(await asked).toEqual({ kind: "not-connected" });
	});

	// Another request's answer is not this one's.
	it("reads only the answer to its own request", async () => {
		const agent = connectedAgent();
		const asked = sm.queryAgentEnvironment(hostId, "inherit", 5_000);
		const query = agent.sent.find((msg) => msg.type === "ENV_QUERY");
		if (query?.type !== "ENV_QUERY") throw new Error("expected an ENV_QUERY");

		agent.emit("message", { type: "ENV", requestId: "someone-else", env: { A: "1" }, os: "linux" });
		agent.emit("message", {
			type: "ENV",
			requestId: query.requestId,
			env: { B: "2", N: 3 },
			os: "linux",
		});

		expect(await asked).toEqual({ kind: "ok", env: { B: "2" }, os: "linux" });
	});
});

describe("readReplaceAgentBody", () => {
	it("reads no body, or no force, as not forcing", () => {
		const none = { force: false, stopTransfers: false };
		expect(readReplaceAgentBody(undefined)).toEqual(none);
		expect(readReplaceAgentBody(null)).toEqual(none);
		expect(readReplaceAgentBody({})).toEqual(none);
	});

	it("takes force as the boolean it is", () => {
		expect(readReplaceAgentBody({ force: true })).toEqual({ force: true, stopTransfers: false });
		expect(readReplaceAgentBody({ force: false })).toEqual({ force: false, stopTransfers: false });
	});

	it("takes stop_transfers apart from force: the uploads to the host stop, other hubs' terminals do not (#833)", () => {
		expect(readReplaceAgentBody({ stop_transfers: true })).toEqual({
			force: false,
			stopTransfers: true,
		});
	});

	it("refuses anything else, rather than guess that it means yes", () => {
		for (const body of [
			{ force: "true" },
			{ force: 1 },
			{ force: null },
			{ stop_transfers: "yes" },
			[],
			"force",
			1,
		]) {
			expect(readReplaceAgentBody(body)).toHaveProperty("error");
		}
	});
});

describe("#674 reconnect timer after ATTACH", () => {
	it("does not construct or adopt a second agent after ATTACH reconnects a dropped host", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		try {
			const meta = new MetaDAL(dbs.meta);
			meta.updateHost(hostId, { sshRemoteDaemon: true });
			const old = connectedAgent();
			const { channelId, ctx } = liveTerminalOn(old);
			old.connected = false;
			old.emit("close");
			expect(ctx.reconnectTimers.has(hostId)).toBe(true);
			expect(await sm.handleAttach("c-window", channelId)).toBe(true);
			const adopted = sm.agents.get(hostId);
			expect(adopted).toBeInstanceOf(SshAgent);
			expect(adopted).not.toBe(old);
			const count = constructedAgents.length;
			await vi.advanceTimersByTimeAsync(1_100);
			await Promise.resolve();
			expect(ctx.reconnectTimers.has(hostId)).toBe(false);
			expect(constructedAgents).toHaveLength(count);
			expect(sm.agents.get(hostId)).toBe(adopted);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("#674 in-flight stop fences", () => {
	it("refuses an in-flight SPAWN after Replace marks the host", async () => {
		const old = connectedAgent();
		const { ctx, heard } = liveTerminalOn(old);
		ctx.agents.delete(hostId);
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		agentHooks.channelState = async () => {
			entered();
			await gate;
			return [];
		};
		const spawn = sm.handleSpawn("c-window", { type: "SPAWN", hostId });
		await waiting;
		const agent = sm.agents.get(hostId) as FakeSshAgent;
		// What a Replace needs before it stops anything (#701), as the end of
		// an earlier list would have left it; this one's is held back.
		agent.daemonInventory = { listed: new Set(), destroyed: new Set() };
		let stopped!: () => void;
		const stopSent = new Promise<void>((resolve) => {
			stopped = resolve;
		});
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			agent.sent.push(msg);
			if (msg.type === "STOP") stopped();
		});
		const pending = replace().then((response) => response);
		await stopSent;
		expect(ctx.stoppingAgents.has(hostId)).toBe(true);
		release();
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			agent.sent.push(msg);
			if (msg.type === "SPAWN") throw new Error("unexpected SPAWN");
		});
		try {
			expect(await spawn).toBeNull();
			expect(agent.sent.some((msg) => msg.type === "SPAWN")).toBe(false);
			expect(heard).toContainEqual({
				type: "ERROR",
				code: "HOST_BUSY",
				message: "This host's agent is being stopped.",
				hostId,
			});
		} finally {
			refuseStop(agent);
			await pending;
		}
	});

	it.each([
		{ kind: "restart", superseded: false },
		{ kind: "timer", superseded: false },
		{ kind: "restart", superseded: true },
		{ kind: "timer", superseded: true },
	])(
		"settles a stop-marked $kind reconnect without stale controllers (superseded: $superseded)",
		async ({ kind, superseded }) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			try {
				const old = connectedAgent();
				const { ctx } = liveTerminalOn(old);
				old.connected = false;
				ctx.agents.delete(hostId);
				let release!: () => void;
				let entered!: () => void;
				const waiting = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				agentHooks.start = async () => {
					entered();
					await gate;
				};
				let attempt: Promise<boolean> | undefined;
				if (kind === "restart") {
					const lifecycle = (
						sm as unknown as { lifecycle: { onReconnectAgent: (id: string) => Promise<boolean> } }
					).lifecycle;
					attempt = lifecycle.onReconnectAgent(hostId);
				} else {
					const sshMgr = (sm as unknown as { sshMgr: SshConnectionManager }).sshMgr;
					sshMgr.scheduleReconnect(hostId, SESSION_ID, 0, Date.now());
					await vi.advanceTimersByTimeAsync(1_100);
				}
				await waiting;
				expect(ctx.reconnectAbortControllers.has(hostId)).toBe(true);
				ctx.stoppingAgents.add(hostId);
				const newer = new AbortController();
				if (superseded) ctx.reconnectAbortControllers.set(hostId, newer);
				release();
				if (attempt) expect(await attempt).toBe(false);
				await vi.advanceTimersByTimeAsync(0);
				expect(ctx.reconnectAbortControllers.get(hostId)).toBe(superseded ? newer : undefined);
				expect(sm.agents.has(hostId)).toBe(false);
				ctx.stoppingAgents.delete(hostId);
			} finally {
				vi.useRealTimers();
			}
		},
	);
});

async function heldReplace() {
	const agent = connectedAgent();
	const terminal = liveTerminalOn(agent);
	let sent!: () => void;
	const stopSent = new Promise<void>((resolve) => {
		sent = resolve;
	});
	agent.send.mockImplementation((msg: ProtocolMessage) => {
		agent.sent.push(msg);
		if (msg.type === "STOP") sent();
	});
	const pending = replace().then((response) => response);
	await stopSent;
	return { agent, ...terminal, pending };
}

function refuseStop(agent: FakeSshAgent): void {
	agent.emit("message", {
		type: "ERROR",
		code: "OTHER_HUBS_HOLD_CHANNELS",
		message: "1 terminal held",
	});
}

describe("#674 exclusive Replace", () => {
	it("refuses a second Replace while the first STOP waits", async () => {
		const { agent, pending } = await heldReplace();
		const second = replace().then((response) => response);
		await new Promise<void>((resolve) => setImmediate(resolve));
		refuseStop(agent);
		const response = await second;
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: { code: "HOST_BUSY" } });
		expect(agent.sent.filter((msg) => msg.type === "STOP")).toHaveLength(1);
		await pending;
	});

	it.each(["displaced", "hub-close", "quitting"] as const)(
		"does not replace after %s",
		async (cause) => {
			const { agent, pending, heard, channelId } = await heldReplace();
			if (cause === "displaced")
				agent.emit("message", { type: "ERROR", code: "DISPLACED", message: "another hub" });
			else if (cause === "hub-close") await agent.close();
			else {
				sm.beginQuit();
				agent.connected = false;
				agent.emit("close");
			}
			const response = await pending;
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ error: { code: "AGENT_NOT_REPLACED" } });
			expect(
				endsOf(heard, channelId).filter(
					(msg) => msg.type === "CHANNEL_STATE" && msg.endReason === "stopped",
				),
			).toEqual([]);
		},
	);

	it("answers a displaced Replace before the displaced connection finishes closing", async () => {
		const { agent, pending } = await heldReplace();
		vi.spyOn(agent, "close").mockImplementation(async () => {
			agent.closedByHub = true;
			agent.connected = false;
		});
		agent.emit("message", { type: "ERROR", code: "DISPLACED", message: "another hub" });
		const response = await Promise.race([
			pending,
			new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
		]);
		agent.emit("close");
		await pending;
		expect(response?.statusCode).toBe(409);
		expect(response?.json()).toMatchObject({ error: { code: "AGENT_NOT_REPLACED" } });
	});

	const refused = [
		{ name: "connect", method: "POST", path: () => `/api/hosts/${hostId}/connect` },
		{ name: "reconnect", method: "POST", path: () => `/api/hosts/${hostId}/reconnect` },
		{ name: "disconnect", method: "POST", path: () => `/api/hosts/${hostId}/disconnect` },
		{
			name: "restart",
			method: "POST",
			path: () => `/api/channels/01K580CHAN0000000000000001/restart`,
		},
		{ name: "session-delete", method: "DELETE", path: () => `/api/sessions/${SESSION_ID}` },
		{ name: "host-delete", method: "DELETE", path: () => `/api/hosts/${hostId}` },
		{
			name: "daemon-policy",
			method: "PUT",
			path: () => `/api/hosts/${hostId}`,
			payload: { ssh_remote_daemon: false },
		},
		{
			name: "os-policy",
			method: "PUT",
			path: () => `/api/hosts/${hostId}`,
			payload: { os: "linux" },
		},
	] as const;
	for (const entry of refused) {
		it(`refuses ${entry.name} at the route while STOP waits`, async () => {
			const { agent, pending, ctx } = await heldReplace();
			ctx.userDisconnectedHosts.add(hostId);
			const count = constructedAgents.length;
			const response = await server.inject({
				method: entry.method,
				url: entry.path(),
				...("payload" in entry ? { payload: entry.payload } : {}),
			});
			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ error: { code: "HOST_BUSY" } });
			expect(constructedAgents).toHaveLength(count);
			expect(ctx.userDisconnectedHosts.has(hostId)).toBe(true);
			refuseStop(agent);
			await pending;
		});
	}

	it("refuses WS SPAWN before clearing a user's disconnect", async () => {
		const { agent, pending, heard, ctx } = await heldReplace();
		ctx.userDisconnectedHosts.add(hostId);
		const count = constructedAgents.length;
		agent.send.mockImplementation((msg: ProtocolMessage) => {
			agent.sent.push(msg);
			if (msg.type === "SPAWN" && "requestId" in msg) {
				queueMicrotask(() =>
					agent.emit("message", {
						type: "SPAWN_OK",
						requestId: msg.requestId,
						channelId: "01K580CHAN0000000000000002",
					}),
				);
			}
		});
		const spawned = await sm.handleSpawn("c-window", {
			type: "SPAWN",
			hostId,
			cols: 80,
			rows: 24,
		});
		refuseStop(agent);
		await pending;
		expect(heard).toContainEqual({
			type: "ERROR",
			code: "HOST_BUSY",
			message: "This host's agent is being stopped.",
			hostId,
		});
		expect(spawned).toBeNull();
		expect(constructedAgents).toHaveLength(count);
		expect(ctx.userDisconnectedHosts.has(hostId)).toBe(true);
	});

	it("allows a label-only PUT while STOP waits", async () => {
		const { agent, pending } = await heldReplace();
		const response = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}`,
			payload: { label: "renamed" },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ label: "renamed" });
		refuseStop(agent);
		await pending;
	});

	it("the held agent's close does not ask the reconnect manager to schedule", async () => {
		const { agent, pending } = await heldReplace();
		const schedule = vi.spyOn(SshConnectionManager.prototype, "scheduleReconnect");
		let callsWhileHeld = -1;
		agent.once("close", () => {
			callsWhileHeld = schedule.mock.calls.length;
		});
		await agent.close();
		expect(callsWhileHeld).toBe(0);
		expect((await pending).statusCode).toBe(409);
	});

	it("does not replay a reconnect when Replace finds an already disconnected host without an agent", async () => {
		const ctx = (sm as unknown as { ctx: SharedSessionContext }).ctx;
		new MetaDAL(dbs.meta).createSession({ id: SESSION_ID, hostId, status: "disconnected" });
		(ctx.sessions as unknown as Map<string, SessionState>).set(hostId, {
			id: SESSION_ID,
			hostId,
			status: "disconnected",
		});
		const schedule = vi.spyOn(SshConnectionManager.prototype, "scheduleReconnect");
		expect(ctx.agents.has(hostId)).toBe(false);
		expect(ctx.reconnectTimers.has(hostId)).toBe(false);
		expect(ctx.reconnectAbortControllers.has(hostId)).toBe(false);
		expect(ctx.acquisitions.has(hostId)).toBe(false);
		expect(ctx.userDisconnectedHosts.has(hostId)).toBe(false);

		const response = await replace();

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: { code: "AGENT_NOT_REPLACED" } });
		expect(schedule).not.toHaveBeenCalled();
		expect(ctx.reconnectTimers.has(hostId)).toBe(false);
		expect(ctx.stoppingAgents.has(hostId)).toBe(false);
	});

	it("replays exactly one suppressed reconnect after an unconfirmed Replace releases the host", async () => {
		const { agent, pending, ctx } = await heldReplace();
		const schedule = vi.spyOn(SshConnectionManager.prototype, "scheduleReconnect");
		await agent.close();
		expect((await pending).statusCode).toBe(409);
		expect(schedule).toHaveBeenCalledExactlyOnceWith(hostId, SESSION_ID, 0, expect.any(Number));
		expect(ctx.reconnectTimers.has(hostId)).toBe(true);
		expect(ctx.stoppingAgents.has(hostId)).toBe(false);
		expect(ctx.agents.has(hostId)).toBe(false);
	});

	it("does not replay a reconnect after an unconfirmed Replace while a reconnect controller exists", async () => {
		const { agent, pending, ctx } = await heldReplace();
		const schedule = vi.spyOn(SshConnectionManager.prototype, "scheduleReconnect");
		const controller = new AbortController();
		ctx.reconnectAbortControllers.set(hostId, controller);
		expect(ctx.reconnectTimers.has(hostId)).toBe(false);
		await agent.close();
		expect((await pending).statusCode).toBe(409);
		expect(ctx.stoppingAgents.has(hostId)).toBe(false);
		expect(ctx.agents.has(hostId)).toBe(false);
		expect(ctx.sessions.get(hostId)?.status).toBe("disconnected");
		expect(schedule).not.toHaveBeenCalled();
		expect(ctx.reconnectTimers.has(hostId)).toBe(false);
		expect(ctx.reconnectAbortControllers.get(hostId)).toBe(controller);
		expect(controller.signal.aborted).toBe(false);
	});

	it("does not replay a reconnect after an unconfirmed Replace while an acquisition exists", async () => {
		const { agent, pending, ctx } = await heldReplace();
		const schedule = vi.spyOn(SshConnectionManager.prototype, "scheduleReconnect");
		let resolveConnect!: (session: SessionState) => void;
		let rejectConnect!: (error: Error) => void;
		const connectPromise = new Promise<SessionState>((resolve, reject) => {
			resolveConnect = resolve;
			rejectConnect = reject;
		});
		const acquisition = {
			id: "pending-acquisition",
			hostId,
			state: "CONNECTING" as const,
			controller: new AbortController(),
			connectPromise,
			_resolve: resolveConnect,
			_reject: rejectConnect,
			leases: new Set<never>(),
		};
		ctx.acquisitions.set(hostId, acquisition);
		try {
			expect(ctx.reconnectTimers.has(hostId)).toBe(false);
			expect(ctx.reconnectAbortControllers.has(hostId)).toBe(false);
			await agent.close();
			expect((await pending).statusCode).toBe(409);
			expect(ctx.stoppingAgents.has(hostId)).toBe(false);
			expect(ctx.agents.has(hostId)).toBe(false);
			expect(ctx.sessions.get(hostId)?.status).toBe("disconnected");
			expect(schedule).not.toHaveBeenCalled();
			expect(ctx.reconnectTimers.has(hostId)).toBe(false);
			expect(ctx.acquisitions.get(hostId)).toBe(acquisition);
		} finally {
			ctx.acquisitions.delete(hostId);
		}
	});
});

describe("POST stop-keeping", () => {
	function stop(payload: object = {}, id = hostId) {
		return server.inject({ method: "POST", url: `/api/hosts/${id}/agent/stop-keeping`, payload });
	}

	function fixture() {
		const agent = connectedAgent();
		const live = liveTerminalsOn(agent, 2);
		const dal = new MetaDAL(dbs.meta);
		dal.updateHost(hostId, { sshRemoteDaemon: true });
		return { agent, dal, ...live };
	}

	function unchanged(f: ReturnType<typeof fixture>) {
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(true);
		expect(f.ctx.sessions.get(hostId)?.status).toBe("active");
		expect(sm.agents.get(hostId)).toBe(f.agent);
		expect(f.agent.connected).toBe(true);
		expect(f.agent.close).not.toHaveBeenCalled();
		for (const id of f.channelIds) {
			expect(f.ctx.channels.get(id)?.status).toBe("live");
			expect(f.dal.getChannel(id)?.endReason).toBeUndefined();
		}
		expect(f.ctx.stoppingAgents.has(hostId)).toBe(false);
	}

	async function disabled(f: ReturnType<typeof fixture>, payload: object) {
		const response = await stop(payload);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			outcome: "disabled_not_stopped",
			message: expect.any(String),
			host: { ssh_remote_daemon: false },
		});
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(false);
		expect(f.ctx.userDisconnectedHosts.has(hostId)).toBe(true);
		expect(f.ctx.sessions.get(hostId)?.status).toBe("disconnected");
		expect(sm.agents.has(hostId)).toBe(false);
		expect(f.agent.close).toHaveBeenCalled();
		for (const id of f.channelIds) {
			expect(f.dal.getChannel(id)?.endReason).toBeUndefined();
			expect(endsOf(f.heard, id)).toEqual([]);
		}
		expect(f.heard).toContainEqual(
			expect.objectContaining({
				type: "SESSION_STATE",
				status: "disconnected",
				disconnectedByUser: true,
			}),
		);
		const before = constructedAgents.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(constructedAgents).toHaveLength(before);
		expect(f.ctx.reconnectTimers.has(hostId)).toBe(false);
	}

	it("requires consent for this hub's terminals, then stops and saves No", async () => {
		const f = fixture();
		const refusal = await stop();
		expect(refusal.statusCode).toBe(409);
		expect(refusal.json()).toMatchObject({ error: { code: "TERMINALS_WOULD_END", terminals: 2 } });
		unchanged(f);
		expect(f.agent.send).not.toHaveBeenCalled();
		const response = await stop({ end_terminals: true });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			outcome: "stopped",
			ended: 2,
			host: { ssh_remote_daemon: false },
		});
		expect(f.agent.sent).toContainEqual({ type: "STOP", force: false });
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(false);
		for (const id of f.channelIds) {
			expect(f.dal.getChannel(id)).toMatchObject({ status: "dead", endReason: "stopped" });
		}
		expect(f.heard).toContainEqual(
			expect.objectContaining({ type: "SESSION_STATE", status: "closed" }),
		);
		expect(f.ctx.sessions.has(hostId)).toBe(false);
	});

	it("requires consent for the uploads to the host, apart from force, and interrupts them once given (#833)", async () => {
		const f = fixture();
		const interrupted: string[] = [];
		sm.setTransfers({
			activeOn: (id) => (id === hostId && interrupted.length === 0 ? 1 : 0),
			interruptOn: (id) => interrupted.push(id),
		});
		const refusal = await stop({ end_terminals: true, force: true });
		expect(refusal.statusCode).toBe(409);
		expect(refusal.json()).toMatchObject({ error: { code: "TRANSFERS_WOULD_STOP", transfers: 1 } });
		unchanged(f);
		const replace = await server.inject({
			method: "POST",
			url: `/api/hosts/${hostId}/agent/replace`,
			payload: { force: true },
		});
		expect(replace.statusCode).toBe(409);
		expect(replace.json()).toMatchObject({ error: { code: "TRANSFERS_WOULD_STOP", transfers: 1 } });
		unchanged(f);
		const kill = await server.inject({
			method: "DELETE",
			url: `/api/sessions/${f.ctx.sessions.get(hostId)?.id}`,
		});
		expect(kill.statusCode).toBe(409);
		expect(kill.json()).toMatchObject({ error: { code: "TRANSFERS_WOULD_STOP", transfers: 1 } });
		const badForce = await server.inject({
			method: "DELETE",
			url: `/api/sessions/${f.ctx.sessions.get(hostId)?.id}?force=yes`,
		});
		expect(badForce.statusCode).toBe(400);
		unchanged(f);
		expect(interrupted).toEqual([]);

		const response = await stop({ end_terminals: true, stop_transfers: true });
		expect(response.statusCode).toBe(200);
		expect(interrupted).toEqual([hostId]);
	});

	it("preserves everything on an other-hub refusal and forwards forced retry", async () => {
		const f = fixture();
		f.agent.othersHold = 3;
		const response = await stop({ end_terminals: true });
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({
			error: { code: "OTHER_HUBS_HOLD_CHANNELS", other_owner_channels: 3 },
		});
		unchanged(f);
		expect(f.agent.execOnHost).not.toHaveBeenCalled();
		const retry = await stop({ end_terminals: true, force: true });
		expect(retry.json()).toMatchObject({ outcome: "stopped", ended: 2 });
		expect(f.agent.sent).toContainEqual({ type: "STOP", force: true });
	});

	it("leaves the uploads running when the daemon refuses a stop consented for them, and interrupts them once it stops (#1102)", async () => {
		const f = fixture();
		f.agent.othersHold = 3;
		const uploads = recordUploads(f);
		const declined = await stop({ end_terminals: true, stop_transfers: true });
		expect(declined.statusCode).toBe(409);
		expect(declined.json()).toMatchObject({
			error: { code: "OTHER_HUBS_HOLD_CHANNELS", other_owner_channels: 3 },
		});
		const replace = await server.inject({
			method: "POST",
			url: `/api/hosts/${hostId}/agent/replace`,
			payload: { stop_transfers: true },
		});
		expect(replace.statusCode).toBe(409);
		expect(replace.json()).toMatchObject({
			error: { code: "OTHER_HUBS_HOLD_CHANNELS", other_owner_channels: 3 },
		});
		expect(uploads.interrupted).toEqual([]);
		unchanged(f);

		const forced = await stop({ end_terminals: true, stop_transfers: true, force: true });
		expect(forced.json()).toMatchObject({ outcome: "stopped", ended: 2 });
		expect(uploads.interrupted).toEqual([hostId]);
		expect(uploads.held).toEqual([true]);
	});

	// A STOP with no connection to say it on: only a forced request goes on to
	// the agent's own --stop, over SSH.
	function stopCannotBeSent(f: ReturnType<typeof fixture>): void {
		f.agent.send.mockImplementation(() => {
			throw new Error("transport unavailable");
		});
	}

	// What the uploads saw: interrupted for which host, and whether the hub
	// still held the connection they run over when they were. `counted` uploads
	// run to the host until they are interrupted.
	function recordUploads(f: ReturnType<typeof fixture>, counted = 1) {
		const seen = { interrupted: [] as string[], held: [] as boolean[] };
		sm.setTransfers({
			activeOn: (id) => (id === hostId && seen.interrupted.length === 0 ? counted : 0),
			interruptOn: (id) => {
				seen.held.push(sm.agents.get(hostId) === f.agent);
				seen.interrupted.push(id);
			},
		});
		return seen;
	}

	it("Replace interrupts the uploads it was told about once the daemon stops, before letting go of the connection (#1102)", async () => {
		const f = fixture();
		const uploads = recordUploads(f);
		const replace = await server.inject({
			method: "POST",
			url: `/api/hosts/${hostId}/agent/replace`,
			payload: { stop_transfers: true },
		});
		expect(replace.statusCode).toBe(200);
		expect(replace.json()).toMatchObject({ replaced: true });
		expect(uploads.interrupted).toEqual([hostId]);
		expect(uploads.held).toEqual([true]);
	});

	it("Stop keeping with no upload counted interrupts none once the daemon stops (#1102)", async () => {
		const f = fixture();
		const uploads = recordUploads(f, 0);
		const response = await stop({ end_terminals: true });
		expect(response.json()).toMatchObject({ outcome: "stopped", ended: 2 });
		expect(uploads.interrupted).toEqual([]);
	});

	it("Replace with no upload counted interrupts none once the daemon stops (#1102)", async () => {
		const f = fixture();
		const uploads = recordUploads(f, 0);
		const response = await replace({});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ replaced: true });
		expect(uploads.interrupted).toEqual([]);
	});

	it("Stop keeping whose STOP cannot be sent still interrupts the uploads before the connection is let go (#1102)", async () => {
		const f = fixture();
		stopCannotBeSent(f);
		const uploads = recordUploads(f);
		const response = await stop({ end_terminals: true, stop_transfers: true });
		expect(response.json()).toMatchObject({ outcome: "disabled_not_stopped" });
		expect(uploads.interrupted).toEqual([hostId]);
		expect(uploads.held).toEqual([true]);
	});

	it("Replace whose STOP is answered with an error leaves the uploads running (#1102)", async () => {
		const f = fixture();
		f.agent.send.mockImplementation((msg: ProtocolMessage) => {
			if (msg.type !== "STOP") return;
			setImmediate(() =>
				f.agent.emit("message", { type: "ERROR", code: "INTERNAL_ERROR", message: "no" }),
			);
		});
		const uploads = recordUploads(f);
		const replace = await server.inject({
			method: "POST",
			url: `/api/hosts/${hostId}/agent/replace`,
			payload: { stop_transfers: true },
		});
		expect(replace.statusCode).toBe(409);
		expect(replace.json()).toMatchObject({
			error: { message: expect.stringContaining("Nothing was changed") },
		});
		expect(uploads.interrupted).toEqual([]);
	});

	it.each([
		[
			"timeout",
			"The agent did not say it had stopped. Its terminals may be ending; look again before asking twice.",
		],
		["unconfirmed", "The connection ended without confirming the agent stopped."],
		["closed_by_hub", "The connection ended without confirming the agent stopped."],
		["displaced", "The connection ended without confirming the agent stopped."],
	] as const)(
		"Replace whose STOP ends %s: the uploads are interrupted, the agent may be ending or its connection ended (#1102)",
		async (mode, message) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const f = fixture();
				if (mode === "unconfirmed") {
					f.agent.helloMessage = {
						...DAEMON_HELLO,
						capabilities: [...(DAEMON_HELLO.capabilities ?? []), "stop-accepted"],
					};
				}
				f.agent.send.mockImplementation((msg: ProtocolMessage) => {
					if (msg.type !== "STOP" || mode === "timeout") return;
					queueMicrotask(() => {
						if (mode === "closed_by_hub") void f.agent.close();
						else if (mode === "unconfirmed") {
							f.agent.connected = false;
							f.agent.emit("close");
						} else {
							f.agent.emit("message", {
								type: "ERROR",
								code: "DISPLACED",
								message: "displaced",
							});
						}
					});
				});
				const uploads = recordUploads(f);
				const replace = server.inject({
					method: "POST",
					url: `/api/hosts/${hostId}/agent/replace`,
					payload: { stop_transfers: true },
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
				await new Promise<void>((resolve) => setImmediate(resolve));
				await vi.advanceTimersByTimeAsync(15_001);
				const response = await replace;
				expect(response.statusCode).toBe(409);
				expect(response.json()).toEqual({ error: { code: "AGENT_NOT_REPLACED", message } });
				expect(uploads.interrupted).toEqual([hostId]);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("Replace whose STOP cannot be sent interrupts the uploads before its own --stop lets go (#1102)", async () => {
		const f = fixture();
		stopCannotBeSent(f);
		const uploads = recordUploads(f);
		const replace = await server.inject({
			method: "POST",
			url: `/api/hosts/${hostId}/agent/replace`,
			payload: { stop_transfers: true },
		});
		expect(replace.json()).toMatchObject({ replaced: true });
		expect(f.agent.execOnHost).toHaveBeenCalledTimes(2);
		expect(uploads.interrupted).toEqual([hostId]);
		expect(uploads.held).toEqual([true]);
	});

	it.each([
		["missing-path", "This hub does not know where that agent is installed."],
		["state-exit", "The host could not say where its agent's socket is."],
		["state-reject", "The host could not say where its agent's socket is."],
		["state-relative", "The host could not say where its agent's socket is."],
		["nonzero", "The agent would not stop (exit 1)."],
		["exec-reject", "The connection ended without confirming the agent stopped."],
		["hub-close", "The connection ended without confirming the agent stopped."],
	] as const)(
		"Replace whose STOP cannot be sent and whose --stop fails on %s still interrupts the uploads, their link being gone (#1102)",
		async (mode, message) => {
			const f = fixture();
			stopCannotBeSent(f);
			if (mode === "missing-path") f.agent.remoteAgentPath = null;
			f.agent.execOnHost.mockImplementation(async (command: string) => {
				if (command === REMOTE_STATE_DIR_COMMAND) {
					if (mode === "state-reject") throw new Error("state command failed");
					return {
						stdout: mode === "state-relative" ? "relative" : "/state",
						exitCode: mode === "state-exit" ? 1 : 0,
					};
				}
				if (mode === "exec-reject") throw new Error("exec failed");
				if (mode === "hub-close") await f.agent.close();
				return { stdout: "", exitCode: 1 };
			});
			const uploads = recordUploads(f);
			const response = await replace({ stop_transfers: true });
			expect(response.statusCode).toBe(409);
			expect(response.json()).toEqual({ error: { code: "AGENT_NOT_REPLACED", message } });
			expect(uploads.interrupted).toEqual([hostId]);
		},
	);

	it.each(["exit-zero", "daemon-close"])(
		"--stop after an unsent STOP confirms on %s, the uploads interrupted before it runs (#1102)",
		async (mode) => {
			const f = fixture();
			stopCannotBeSent(f);
			if (mode === "daemon-close") {
				f.agent.execOnHost.mockImplementation(async (command: string) => {
					if (command === REMOTE_STATE_DIR_COMMAND) return { stdout: "/state", exitCode: 0 };
					f.agent.connected = false;
					f.agent.emit("close");
					return { stdout: "", exitCode: 1 };
				});
			}
			const uploads = recordUploads(f);
			const response = await stop({ end_terminals: true, force: true, stop_transfers: true });
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ outcome: "stopped", ended: 2 });
			expect(f.agent.execOnHost).toHaveBeenCalledTimes(2);
			expect(f.agent.sent).toEqual([]);
			for (const id of f.channelIds) expect(f.dal.getChannel(id)?.endReason).toBe("stopped");
			expect(uploads.interrupted).toEqual([hostId]);
			expect(uploads.held).toEqual([true]);
		},
	);

	// `held`: the uploads are interrupted before the hub lets go of a
	// connection still up at the answer; null where it had already ended.
	it.each([
		["timeout", [true]],
		["error", [true]],
		["displaced", null],
		["closed_by_hub", null],
		["unconfirmed", null],
		["unsent", [true]],
	] as const)("unconfirmed STOP %s disables and disconnects", async (mode, held) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const f = fixture();
			if (mode === "unconfirmed") {
				f.agent.helloMessage = {
					...DAEMON_HELLO,
					capabilities: [...(DAEMON_HELLO.capabilities ?? []), "stop-accepted"],
				};
			}
			f.agent.send.mockImplementation(() => {
				if (mode === "unsent") throw new Error("transport unavailable");
				if (mode === "timeout") return;
				queueMicrotask(() => {
					if (mode === "closed_by_hub") void f.agent.close();
					else if (mode === "unconfirmed") {
						f.agent.connected = false;
						f.agent.emit("close");
					} else
						f.agent.emit("message", {
							type: "ERROR",
							code: mode === "displaced" ? "DISPLACED" : "STOP_FAILED",
							message: "unconfirmed",
						});
				});
			});
			const uploads = recordUploads(f);
			const result = disabled(f, { end_terminals: true, stop_transfers: true });
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(15_001);
			await result;
			expect(f.agent.execOnHost).not.toHaveBeenCalled();
			// The connection is dropped whatever the answer: the uploads stop (#1102).
			expect(uploads.interrupted).toEqual([hostId]);
			if (held !== null) expect(uploads.held).toEqual(held);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		"missing-path",
		"state-exit",
		"state-relative",
		"state-reject",
		"state-close",
		"exec-reject",
		"exec-timeout",
		"nonzero",
		"hub-close",
	])(
		"--stop after an unsent STOP: %s is unconfirmed, the uploads interrupted before it runs (#1102)",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const f = fixture();
				stopCannotBeSent(f);
				if (mode === "missing-path") f.agent.remoteAgentPath = null;
				f.agent.execOnHost.mockImplementation(async (command: string) => {
					if (command === REMOTE_STATE_DIR_COMMAND) {
						if (mode === "state-reject") throw new Error("state command failed");
						if (mode === "state-close") {
							f.agent.connected = false;
							f.agent.emit("close");
							return { stdout: "", exitCode: 1 };
						}
						return {
							stdout: mode === "state-relative" ? "relative" : "/state",
							exitCode: mode === "state-exit" ? 1 : 0,
						};
					}
					if (mode === "exec-reject" || mode === "exec-timeout") throw new Error(mode);
					if (mode === "hub-close") await f.agent.close();
					return { stdout: "", exitCode: mode.startsWith("state-") ? 0 : 1 };
				});
				const uploads = recordUploads(f);
				await disabled(f, { end_terminals: true, force: true, stop_transfers: true });
				if (mode === "missing-path") expect(f.agent.execOnHost).not.toHaveBeenCalled();
				expect(uploads.interrupted).toEqual([hostId]);
				expect(uploads.held).toEqual([true]);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("allows only a forced unsent STOP to fall back to --stop", async () => {
		const f = fixture();
		f.agent.send.mockImplementation(() => {
			throw new Error("unsent");
		});
		const response = await stop({ end_terminals: true, force: true });
		expect(response.json()).toMatchObject({ outcome: "stopped" });
		expect(f.agent.execOnHost).toHaveBeenCalledTimes(2);
	});

	it.each([
		"unknown",
		"local",
		"quitting",
		"stopping",
		"acquiring",
		"absent",
		"disconnected",
		"stdio",
	])("admission: %s", async (mode) => {
		const f = fixture();
		let id = hostId;
		if (mode === "unknown") id = "unknown";
		if (mode === "local") id = f.dal.createHost({ type: "local", label: "local-stop" }).id;
		if (mode === "quitting") sm.beginQuit();
		if (mode === "stopping") f.ctx.stoppingAgents.add(hostId);
		if (mode === "acquiring") {
			const acquisition = { id: "pending", state: "CONNECTING" };
			Object.defineProperty(f.ctx.acquisitions, "has", {
				value: (key: string) => key === hostId && acquisition.state === "CONNECTING",
				configurable: true,
			});
		}
		if (mode === "absent") f.ctx.agents.delete(hostId);
		if (mode === "stdio") f.agent.usedRemoteDaemon = false;
		if (mode === "disconnected") f.agent.connected = false;
		const before = {
			row: f.dal.getHost(hostId),
			session: f.ctx.sessions.get(hostId)?.status,
			channels: f.channelIds.map((id) => f.dal.getChannel(id)),
			agent: f.ctx.agents.get(hostId),
			connected: f.agent.connected,
		};
		const response = await stop({ end_terminals: true, force: true }, id);
		const codes: Record<string, string> = {
			unknown: "NOT_FOUND",
			local: "NOT_SSH_HOST",
			quitting: "HUB_QUITTING",
			stopping: "HOST_BUSY",
			acquiring: "HOST_BUSY",
			absent: "HOST_NOT_CONNECTED",
			disconnected: "HOST_NOT_CONNECTED",
			stdio: "NO_DAEMON_CONNECTION",
		};
		expect(response.statusCode).toBe(mode === "unknown" ? 404 : mode === "local" ? 400 : 409);
		expect(response.json()).toMatchObject({ error: { code: codes[mode] } });
		expect({
			row: f.dal.getHost(hostId),
			session: f.ctx.sessions.get(hostId)?.status,
			channels: f.channelIds.map((id) => f.dal.getChannel(id)),
			agent: f.ctx.agents.get(hostId),
			connected: f.agent.connected,
		}).toEqual(before);
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(true);
		expect(f.agent.send).not.toHaveBeenCalled();
		expect(f.agent.execOnHost).not.toHaveBeenCalled();
		if (mode !== "stopping") expect(f.ctx.stoppingAgents.has(hostId)).toBe(false);
		f.ctx.stoppingAgents.delete(hostId);
	});

	it("holds the admission marker synchronously until STOP settles", async () => {
		const f = fixture();
		let markerAtSend = false;
		f.agent.send.mockImplementation(() => {
			markerAtSend = f.ctx.stoppingAgents.has(hostId);
		});
		const pending = sm.stopKeepingAgent(hostId, { endTerminals: true, force: false });
		expect(markerAtSend).toBe(true);
		expect(f.ctx.stoppingAgents.has(hostId)).toBe(true);
		const second = await stop({ end_terminals: true });
		expect(second.json()).toMatchObject({ error: { code: "HOST_BUSY" } });
		f.agent.emit("message", { type: "ERROR", code: "STOP_FAILED", message: "failed" });
		await pending;
		expect(f.ctx.stoppingAgents.has(hostId)).toBe(false);
	});

	it("quitting during STOP writes and publishes nothing after quit", async () => {
		const f = fixture();
		f.agent.send.mockImplementation(() => {});
		const pending = sm.stopKeepingAgent(hostId, { endTerminals: true, force: false });
		sm.beginQuit();
		const heardAtQuit = f.heard.length;
		await f.agent.close();
		const result = await pending;
		expect(result).toMatchObject({ kind: "error", code: "HUB_QUITTING" });
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(true);
		expect(f.heard).toHaveLength(heardAtQuit);
	});

	it.each([true, false])("write failure after confirmed=%s", async (confirmed) => {
		const f = fixture();
		if (!confirmed)
			f.agent.send.mockImplementation(() =>
				queueMicrotask(() =>
					f.agent.emit("message", { type: "ERROR", code: "FAILED", message: "no" }),
				),
			);
		vi.spyOn(f.ctx.metaDal, "updateHost").mockImplementation(() => {
			throw new Error("disk full");
		});
		const response = await stop({ end_terminals: true });
		expect(response.statusCode).toBe(500);
		expect(response.json().error.message).toBe(
			confirmed
				? "The agent was stopped, but the setting could not be saved."
				: "The setting could not be saved; the agent was not confirmed stopped.",
		);
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(true);
		if (confirmed) {
			expect(f.ctx.sessions.has(hostId)).toBe(false);
			expect(f.ctx.userDisconnectedHosts.has(hostId)).toBe(true);
			for (const id of f.channelIds) expect(f.dal.getChannel(id)?.endReason).toBe("stopped");
		} else unchanged(f);
	});

	it("replays a suppressed reconnect when an unconfirmed stop cannot save No", async () => {
		const f = fixture();
		const reconnect = vi
			.spyOn(SshConnectionManager.prototype, "scheduleReconnect")
			.mockImplementation(() => {});
		vi.spyOn(f.ctx.metaDal, "updateHost").mockImplementation(() => {
			throw new Error("disk full");
		});
		f.agent.send.mockImplementation(() =>
			queueMicrotask(() => {
				f.agent.emit("message", { type: "ERROR", code: "STOP_FAILED", message: "not stopped" });
				f.agent.connected = false;
				f.agent.emit("close");
			}),
		);
		const response = await stop({ end_terminals: true });
		expect(response.statusCode).toBe(500);
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(true);
		expect(f.ctx.userDisconnectedHosts.has(hostId)).toBe(false);
		expect(reconnect).toHaveBeenCalledTimes(1);
		expect(reconnect).toHaveBeenCalledWith(hostId, SESSION_ID, 0, expect.any(Number));
	});

	it("observes admission precedence before connected-agent checks", async () => {
		const f = fixture();
		const local = f.dal.createHost({ type: "local", label: "precedence" });
		f.ctx.stoppingAgents.add(hostId);
		f.ctx.agents.delete(hostId);
		sm.beginQuit();
		expect((await stop({}, local.id)).json().error.code).toBe("NOT_SSH_HOST");
		expect((await stop()).json().error.code).toBe("HUB_QUITTING");
		f.ctx.stoppingAgents.delete(hostId);
	});

	it.each(["end_terminals", "force"])("validates %s consent", async (key) => {
		const f = fixture();
		for (const value of [1, "true", null, [], {}]) {
			const response = await stop({ [key]: value });
			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
			unchanged(f);
		}
	});

	it("publishes the daemon fact and clears it on release", async () => {
		const f = fixture();
		expect(sm.getStateSnapshot().sessions).toContainEqual(
			expect.objectContaining({ hostId, connectedThroughRemoteDaemon: true }),
		);
		await stop({ end_terminals: true });
		const released = f.heard.filter((m) => m.type === "SESSION_STATE");
		expect(released).toContainEqual(
			expect.objectContaining({ type: "SESSION_STATE", status: "active" }),
		);
		for (const message of released)
			expect(message).not.toHaveProperty("connectedThroughRemoteDaemon");
	});

	it("announces the daemon fact immediately at the shared adoption commit", () => {
		const f = fixture();
		f.ctx.agents.delete(hostId);
		f.heard.length = 0;
		f.ctx.commits.adoptAgent(captureQuitFence(f.ctx), hostId, f.agent);
		expect(f.heard[0]).toMatchObject({ type: "SESSION_STATE", connectedThroughRemoteDaemon: true });
	});

	it.each(["disconnected", "stdio", "starting"])("does not re-announce on %s adoption", (mode) => {
		const f = fixture();
		if (mode === "disconnected") f.agent.connected = false;
		if (mode === "stdio") f.agent.usedRemoteDaemon = false;
		if (mode === "starting") {
			const session = f.ctx.sessions.get(hostId);
			if (!session) throw new Error("expected the host session");
			session.status = "starting";
		}
		f.ctx.agents.delete(hostId);
		f.heard.length = 0;
		f.ctx.commits.adoptAgent(captureQuitFence(f.ctx), hostId, f.agent);
		expect(f.heard.filter((m) => m.type === "SESSION_STATE")).toEqual([]);
	});

	it.each(["disconnected", "stdio"])("omits the session daemon fact for %s agents", (mode) => {
		const f = fixture();
		if (mode === "disconnected") f.agent.connected = false;
		else f.agent.usedRemoteDaemon = false;
		expect(sm.getStateSnapshot().sessions[0]).not.toHaveProperty("connectedThroughRemoteDaemon");
	});

	it("clears the daemon fact on displacement", async () => {
		const f = fixture();
		f.agent.emit("message", { type: "ERROR", code: "DISPLACED", message: "new connection" });
		expect(sm.getStateSnapshot().sessions[0]).not.toHaveProperty("connectedThroughRemoteDaemon");
		expect(f.heard).toContainEqual(expect.objectContaining({ type: "SESSION_STATE", hostId }));
		for (const message of f.heard.filter((m) => m.type === "SESSION_STATE"))
			expect(message).not.toHaveProperty("connectedThroughRemoteDaemon");
	});

	it.each([false, "false", 0, {}, []])(
		"PUT validates or refuses daemon revocation: %j",
		async (value) => {
			const f = fixture();
			const response = await server.inject({
				method: "PUT",
				url: `/api/hosts/${hostId}`,
				payload: { ssh_remote_daemon: value, label: "changed" },
			});
			expect(response.statusCode).toBe(typeof value === "boolean" ? 409 : 400);
			expect(response.json().error.code).toBe(
				typeof value === "boolean" ? "DAEMON_CONNECTED" : "VALIDATION_ERROR",
			);
			unchanged(f);
			expect(f.dal.getHost(hostId)?.label).toBe("pi");
		},
	);

	it("PUT refuses OS policy revocation but allows unrelated edits and unchanged policy", async () => {
		const f = fixture();
		const os = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}`,
			payload: { os: "windows" },
		});
		expect(os.statusCode).toBe(409);
		expect(os.json().error.code).toBe("DAEMON_CONNECTED");
		unchanged(f);
		for (const payload of [{ label: "renamed" }, { ssh_remote_daemon: true }, { os: "linux" }]) {
			const response = await server.inject({ method: "PUT", url: `/api/hosts/${hostId}`, payload });
			expect(response.statusCode).toBe(200);
		}
	});
	it.each([true, false])(
		"PUT resolves a null policy against global default %s",
		async (globalDefault) => {
			const f = fixture();
			f.dal.updateHost(hostId, { sshRemoteDaemon: null });
			const resolver = new ConfigResolver(f.dal);
			vi.spyOn(resolver, "sshConfig", "get").mockReturnValue({
				...resolver.sshConfig,
				remoteDaemon: globalDefault,
			});
			Object.defineProperty(f.ctx, "configResolver", { value: resolver, configurable: true });
			const response = await server.inject({
				method: "PUT",
				url: `/api/hosts/${hostId}`,
				payload: { ssh_remote_daemon: false },
			});
			expect(response.statusCode).toBe(globalDefault ? 409 : 200);
			expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBe(globalDefault ? undefined : false);
		},
	);

	it("PUT accepts null when no daemon is connected", async () => {
		const f = fixture();
		f.agent.usedRemoteDaemon = false;
		const response = await server.inject({
			method: "PUT",
			url: `/api/hosts/${hostId}`,
			payload: { ssh_remote_daemon: null },
		});
		expect(response.statusCode).toBe(200);
		expect(f.dal.getHost(hostId)?.sshRemoteDaemon).toBeUndefined();
	});
});

// ─── Closed sessions (#911) ───────────────────────────────────────────────────

const LONG_AGO = "2026-01-01T00:00:00.000Z";

/** A session row as a run left it, created at `createdAt` and last changed long ago. */
function seedSession(id: string, host: string, status: SessionState["status"], createdAt: string) {
	new MetaDAL(dbs.meta).createSession({ id, hostId: host, status });
	dbs.meta
		.prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
		.run(createdAt, LONG_AGO, id);
}

function seedChannel(id: string, sessionId: string, status: "live" | "orphan" | "dead") {
	new MetaDAL(dbs.meta).createChannel({ id, sessionId, status, shell: "bash" });
}

/** The session rows, oldest first: id, status and updated_at. */
function sessionRows(): Array<[string, string, string]> {
	return new MetaDAL(dbs.meta).listSessions().map((s) => [s.id, s.status, s.updatedAt]);
}

/** An SSH host whose daemon is kept: a hub start leaves its terminals orphan and reaches nothing. */
function daemonHost(label: string): string {
	return new MetaDAL(dbs.meta).createHost({
		type: "ssh",
		label,
		sshHost: `pi@${label}.local`,
		os: "linux",
		sshRemoteDaemon: true,
	}).id;
}

async function listedSessions(
	query = "",
	on: FastifyInstance = server,
): Promise<Array<{ id: string; status: string; host: string }>> {
	const res = await on.inject({ method: "GET", url: `/api/sessions${query}` });
	expect(res.statusCode).toBe(200);
	return res.json<Array<{ id: string; host_id: string; status: string }>>().map((s) => ({
		id: s.id,
		status: s.status,
		host: s.host_id,
	}));
}

describe("GET /api/sessions, closed sessions (#911)", () => {
	const S1 = "01K911SESSION0000000000S01";
	const S2 = "01K911SESSION0000000000S02";
	const S3 = "01K911SESSION0000000000S03";
	const S4 = "01K911SESSION0000000000S04";
	const S8 = "01K911SESSION0000000000S08";
	const S9 = "01K911SESSION0000000000S09";
	const S5 = "01K911SESSION0000000000S05";
	let otherHost: string;

	beforeEach(() => {
		otherHost = new MetaDAL(dbs.meta).createHost({
			type: "ssh",
			label: "nas",
			sshHost: "pi@nas.local",
		}).id;
		seedSession(S1, hostId, "closed", "2026-11-13T10:00:01.000Z");
		seedSession(S2, hostId, "closed", "2026-11-13T10:00:02.000Z");
		seedChannel("01K911CHANNEL00000000000C2", S2, "dead");
		seedSession(S3, hostId, "active", "2026-11-13T10:00:03.000Z");
		seedSession(S4, hostId, "disconnected", "2026-11-13T10:00:04.000Z");
		seedSession(S8, hostId, "starting", "2026-11-13T10:00:05.000Z");
		seedSession(S9, hostId, "detached", "2026-11-13T10:00:06.000Z");
		seedSession(S5, otherHost, "active", "2026-11-13T10:00:07.000Z");
	});

	// Mutations: list every row (S1, S2 listed); keep only active and
	// disconnected (S8, S9 missing).
	it("GET /api/sessions lists the sessions that are not closed (#911)", async () => {
		expect(await listedSessions()).toEqual([
			{ id: S3, status: "active", host: hostId },
			{ id: S4, status: "disconnected", host: hostId },
			{ id: S8, status: "starting", host: hostId },
			{ id: S9, status: "detached", host: hostId },
			{ id: S5, status: "active", host: otherHost },
		]);
		expect((await listedSessions(`?host_id=${hostId}`)).map((s) => s.id)).toEqual([S3, S4, S8, S9]);
	});

	// Mutations: ignore `all` (S1, S2 missing); drop the host filter with it (S5
	// in H's list); read `all=false` as true (S1, S2 listed).
	it("GET /api/sessions?all=true lists every session the hub keeps (#911)", async () => {
		expect((await listedSessions("?all=true")).map((s) => s.id)).toEqual([
			S1,
			S2,
			S3,
			S4,
			S8,
			S9,
			S5,
		]);
		expect((await listedSessions(`?host_id=${hostId}&all=true`)).map((s) => s.id)).toEqual([
			S1,
			S2,
			S3,
			S4,
			S8,
			S9,
		]);
		expect((await listedSessions("?all=false")).map((s) => s.id)).toEqual([S3, S4, S8, S9, S5]);
	});

	// Mutation: read any value other than `true` as false (200).
	it("GET /api/sessions refuses an all that is not true or false (#911)", async () => {
		for (const value of ["yes", "1", ""]) {
			const res = await server.inject({ method: "GET", url: `/api/sessions?all=${value}` });
			expect(res.statusCode).toBe(400);
			expect(res.json()).toEqual({
				error: { code: "VALIDATION_ERROR", message: "all must be true or false." },
			});
		}
	});
});

describe("a hub start and the sessions a previous run left (#911)", () => {
	const S1 = "01K911SESSION0000000000S01";
	const S2 = "01K911SESSION0000000000S02";
	const S3 = "01K911SESSION0000000000S03";
	const S4 = "01K911SESSION0000000000S04";
	const S5 = "01K911SESSION0000000000S05";
	const S6 = "01K911SESSION0000000000S06";
	const S7 = "01K911SESSION0000000000S07";

	// Mutations: no sweep (S1, S3 remain); delete closed rows a channel names
	// (FK error, or S2 and S4 gone); close the held S5; close without updated_at
	// (S4's stays LONG_AGO); rewrite rows already closed (S2's changes).
	it("a hub start drops the sessions it neither holds nor lists a terminal under (#911)", async () => {
		const C2 = "01K911CHANNEL00000000000C2";
		const C4 = "01K911CHANNEL00000000000C4";
		const C5 = "01K911CHANNEL00000000000C5";
		const keptHost = daemonHost("k");
		seedSession(S1, hostId, "closed", "2026-11-13T10:00:01.000Z");
		seedSession(S2, hostId, "closed", "2026-11-13T10:00:02.000Z");
		seedChannel(C2, S2, "dead");
		seedSession(S3, hostId, "disconnected", "2026-11-13T10:00:03.000Z");
		seedSession(S4, hostId, "active", "2026-11-13T10:00:04.000Z");
		seedChannel(C4, S4, "dead");
		seedSession(S5, keptHost, "disconnected", "2026-11-13T10:00:05.000Z");
		seedChannel(C5, S5, "orphan");
		const dal = new MetaDAL(dbs.meta);
		for (const channel of [C2, C4, C5]) dal.updateCacheIndex(channel, `chunk-${channel}`, 7);

		await sm.startup();

		const rows = sessionRows();
		expect(rows.map(([id, status]) => [id, status])).toEqual([
			[S2, "closed"],
			[S4, "closed"],
			[S5, "disconnected"],
		]);
		expect(rows.find(([id]) => id === S2)?.[2]).toBe(LONG_AGO);
		expect((rows.find(([id]) => id === S4)?.[2] ?? "") > LONG_AGO).toBe(true);
		expect([C2, C4, C5].map((id) => dal.getChannel(id)?.sessionId)).toEqual([S2, S4, S5]);
		expect(
			dbs.meta.prepare("SELECT channel_id FROM cache_index ORDER BY channel_id").all(),
		).toEqual([{ channel_id: C2 }, { channel_id: C4 }, { channel_id: C5 }]);
		expect((await listedSessions()).map((s) => s.id)).toEqual([S5]);
	});

	// Mutation: today's adoption of the earliest row (S6 adopted and listed, S7
	// closed).
	it("a hub start keeps the session its live terminals were opened under (#911)", async () => {
		const C7 = "01K911CHANNEL00000000000C7";
		const host = daemonHost("m");
		seedSession(S6, host, "disconnected", "2026-11-13T10:00:06.000Z");
		seedSession(S7, host, "active", "2026-11-13T10:00:07.000Z");
		seedChannel(C7, S7, "orphan");

		await sm.startup();

		expect(sessionRows().map(([id, status]) => [id, status])).toEqual([[S7, "disconnected"]]);
		expect(new MetaDAL(dbs.meta).getChannel(C7)?.sessionId).toBe(S7);
		expect((await listedSessions(`?host_id=${host}`)).map((s) => s.id)).toEqual([S7]);
	});

	// Mutation: spare from the close every row an alive channel names (S6 left
	// disconnected and listed).
	it("a hub start closes an older session its live terminals still name, and keeps it (#911)", async () => {
		const C6 = "01K911CHANNEL00000000000C6";
		const C7 = "01K911CHANNEL00000000000C7";
		const host = daemonHost("m");
		seedSession(S6, host, "disconnected", "2026-11-13T10:00:06.000Z");
		seedChannel(C6, S6, "orphan");
		seedSession(S7, host, "active", "2026-11-13T10:00:07.000Z");
		seedChannel(C7, S7, "orphan");

		await sm.startup();

		expect(sessionRows().map(([id, status]) => [id, status])).toEqual([
			[S6, "closed"],
			[S7, "disconnected"],
		]);
		expect(new MetaDAL(dbs.meta).getChannel(C6)?.sessionId).toBe(S6);
		expect((await listedSessions(`?host_id=${host}`)).map((s) => s.id)).toEqual([S7]);
	});

	// Mutation: sweep only after the restore found something alive (it returns
	// early when nothing is).
	it("a hub start with no live terminal still drops its stale sessions (#911)", async () => {
		seedSession(S1, hostId, "closed", "2026-11-13T10:00:01.000Z");
		seedSession(S3, hostId, "active", "2026-11-13T10:00:03.000Z");

		await sm.startup();

		expect(sessionRows()).toEqual([]);
	});
});

describe("connect and disconnect, then a hub start (#911)", () => {
	// Red on today's code: five rows (three closed, one disconnected, one active).
	it("connect and disconnect cycles leave one session after a hub start (#911)", async () => {
		// An agent on stdio: its sessions close with its connection.
		agentHooks.start = async () => {
			const agent = constructedAgents.at(-1) as FakeSshAgent;
			agent.helloMessage = DAEMON_HELLO;
			agent.usedRemoteDaemon = false;
			agent.connected = true;
		};
		agentHooks.channelState = async () => [];
		const connect = async (on: FastifyInstance) => {
			const res = await on.inject({
				method: "POST",
				url: `/api/hosts/${hostId}/connect`,
				payload: {},
			});
			expect([200, 202]).toContain(res.statusCode);
			await vi.waitFor(async () => {
				const statuses = (await listedSessions("", on)).map((s) => s.status);
				expect(statuses).toContain("active");
			});
		};
		for (let cycle = 0; cycle < 3; cycle++) {
			await connect(server);
			const res = await server.inject({
				method: "POST",
				url: `/api/hosts/${hostId}/disconnect`,
				payload: { force: true },
			});
			expect(res.statusCode).toBe(200);
		}
		await connect(server);

		// The hub restarts while the host is connected.
		sm.beginQuit();
		await sm.shutdown();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const metaDal = new MetaDAL(dbs.meta);
		const restarted = new SessionManager(dbs);
		const restartedServer = Fastify({ logger: false });
		registerSessionRoutes(restartedServer, metaDal, restarted);
		registerHostConnectionRoutes(restartedServer, metaDal, restarted);
		await restartedServer.ready();
		try {
			await restarted.startup();
			await connect(restartedServer);

			expect((await listedSessions("", restartedServer)).map((s) => s.status)).toEqual(["active"]);
			expect(sessionRows()).toHaveLength(1);
		} finally {
			await restartedServer.close();
			restarted.beginQuit();
			await restarted.shutdown();
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	});
});

describe("GET /api/sessions/:id (#932)", () => {
	it("lists the session's ended terminals without their end id", async () => {
		const metaDal = new MetaDAL(dbs.meta);
		const sessionId = "01K932SESSAPI0000000000000";
		const channelId = "01K932CHANAPI0000000000000";
		metaDal.createSession({ id: sessionId, hostId, status: "active" });
		metaDal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });
		metaDal.updateChannelStatus(channelId, "dead", 2);
		expect(metaDal.getChannel(channelId)?.endId).toBeDefined();

		const res = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}` });

		const body = res.json() as { channels: Array<Record<string, unknown>> };
		expect(body.channels).toHaveLength(1);
		expect(body.channels[0]).toMatchObject({ id: channelId, status: "dead", exit_code: 2 });
		expect(body.channels[0]).not.toHaveProperty("end_id");
	});
});
