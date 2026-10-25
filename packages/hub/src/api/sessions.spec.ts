import type { AgentChannelStateMessage, HelloMessage, ProtocolMessage } from "@lasterm/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigResolver } from "../config.js";
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
import { SpoolDAL } from "../storage/spool.js";
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

const hello = (capabilities: string[]): HelloMessage => ({
	type: "HELLO",
	version: 1,
	agentVersion: "0.1.0",
	capabilities,
});

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
	registerChannelRoutes(server, metaDal, sm, new SpoolDAL(dbs.spool));
	await server.ready();
});

afterEach(async () => {
	await server.close();
	vi.restoreAllMocks();
	sm.beginQuit();
	await sm.shutdown();
	dbs.close();
});

/** The agent this hub reaches the host through, already connected. */
function connectedAgent(capabilities: string[], othersHold = 0): FakeSshAgent {
	const agent = new SshAgent({ id: hostId } as never) as FakeSshAgent;
	agent.helloMessage = hello(capabilities);
	agent.othersHold = othersHold;
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

// Replacing the agent ends its terminals, and on purpose: a pane set to
// restart them must not bring them back on the new one (#580).
describe("POST /api/hosts/:id/agent/replace, and the terminals that end with it (#580)", () => {
	it("says of each terminal that ends as the agent stops that the hub ended it", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"]);
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
		const agent = connectedAgent(["multiplex", "hub-identity"], 2);
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
		const agent = connectedAgent(["multiplex", "hub-identity"]);
		const { channelIds, heard } = liveTerminalsOn(agent, 2);

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expectEveryOneStopped(channelIds, heard);
	});

	it("does the same when the agent is stopped with its own --stop", async () => {
		const agent = connectedAgent(["multiplex"]);
		const { channelIds, heard } = liveTerminalsOn(agent, 2);

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.execOnHost).toHaveBeenCalledTimes(2);
		expectEveryOneStopped(channelIds, heard);
	});

	// On stdio the agent is not stopped, and nothing it runs ends.
	it("ends nothing when the agent is not stopped", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"]);
		agent.usedRemoteDaemon = false;
		const { channelIds, heard } = liveTerminalsOn(agent, 1);

		expect((await replace()).statusCode).toBe(409);

		const channelId = channelIds[0] ?? "";
		expect(endsOf(heard, channelId)).toEqual([]);
		expect(sm.channels.get(channelId)?.status).toBe("live");
		expect(new MetaDAL(dbs.meta).getChannel(channelId)?.status).toBe("live");
	});
});

describe("POST /api/hosts/:id/agent/replace, on an agent other hubs use (#127)", () => {
	it("answers 409 with the count, and a forced retry sends STOP { force: true }", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"], 2);

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
		const agent = connectedAgent(["multiplex", "hub-identity"]);

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.sent).toEqual([{ type: "STOP", force: false }]);
	});

	it("uses the agent's --stop for an agent without hub-identity, as before", async () => {
		const agent = connectedAgent(["multiplex"]);

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.sent).toEqual([]);
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

	it("falls back to --stop when the STOP cannot be written", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"], 2);
		agent.send.mockImplementation(() => {
			throw new Error("SSH agent not connected");
		});

		const res = await replace();

		expect(res.statusCode).toBe(200);
		expect(agent.execOnHost).toHaveBeenCalledTimes(2);
	});

	it("refuses a force that is not a boolean, and asks the agent nothing", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"], 2);

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
		const agent = connectedAgent(["multiplex", "env-modes"]);
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

	it("answers 409 AGENT_TOO_OLD for an agent without env-modes, and asks it nothing", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"]);

		const res = await environment("inherit");

		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({ error: { code: "AGENT_TOO_OLD" } });
		expect(agent.sent).toEqual([]);
	});

	it("refuses a mode it does not know, and asks the agent nothing", async () => {
		const agent = connectedAgent(["env-modes"]);

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
		connectedAgent(["env-modes"]);

		expect(await sm.queryAgentEnvironment(hostId, "inherit", 20)).toEqual({ kind: "timeout" });
	});

	it("says not connected when the connection ends before the answer", async () => {
		const agent = connectedAgent(["env-modes"]);
		const asked = sm.queryAgentEnvironment(hostId, "inherit", 5_000);

		agent.emit("close");

		expect(await asked).toEqual({ kind: "not-connected" });
	});

	// Another request's answer is not this one's.
	it("reads only the answer to its own request", async () => {
		const agent = connectedAgent(["env-modes"]);
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
		expect(readReplaceAgentBody(undefined)).toEqual({ force: false });
		expect(readReplaceAgentBody(null)).toEqual({ force: false });
		expect(readReplaceAgentBody({})).toEqual({ force: false });
	});

	it("takes force as the boolean it is", () => {
		expect(readReplaceAgentBody({ force: true })).toEqual({ force: true });
		expect(readReplaceAgentBody({ force: false })).toEqual({ force: false });
	});

	it("refuses anything else, rather than guess that it means yes", () => {
		for (const body of [{ force: "true" }, { force: 1 }, { force: null }, [], "force", 1]) {
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
			const old = connectedAgent(["hub-identity"]);
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
		const old = connectedAgent(["hub-identity"]);
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
		agent.helloMessage = hello(["hub-identity"]);
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
				const old = connectedAgent(["hub-identity"]);
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
	const agent = connectedAgent(["hub-identity"]);
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

	function fixture(capabilities = ["hub-identity"], count = 2) {
		const agent = connectedAgent(capabilities);
		const live = liveTerminalsOn(agent, count);
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

	it("requires other-hub consent before any legacy command", async () => {
		const f = fixture([]);
		const response = await stop({ end_terminals: true });
		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: { code: "OTHER_HUBS_MAY_BE_AFFECTED" } });
		unchanged(f);
		expect(f.agent.send).not.toHaveBeenCalled();
		expect(f.agent.execOnHost).not.toHaveBeenCalled();
	});

	it.each(["exit-zero", "daemon-close"])("legacy stop confirms on %s", async (mode) => {
		const f = fixture([]);
		if (mode === "daemon-close") {
			f.agent.execOnHost.mockImplementation(async (command: string) => {
				if (command === REMOTE_STATE_DIR_COMMAND) return { stdout: "/state", exitCode: 0 };
				f.agent.connected = false;
				f.agent.emit("close");
				return { stdout: "", exitCode: 1 };
			});
		}
		const response = await stop({ end_terminals: true, force: true });
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ outcome: "stopped", ended: 2 });
		expect(f.agent.execOnHost).toHaveBeenCalledTimes(2);
		expect(f.agent.send).not.toHaveBeenCalled();
		for (const id of f.channelIds) expect(f.dal.getChannel(id)?.endReason).toBe("stopped");
	});

	it.each(["timeout", "error", "displaced", "closed_by_hub", "unsent"])(
		"unconfirmed STOP %s disables and disconnects",
		async (mode) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const f = fixture();
				f.agent.send.mockImplementation(() => {
					if (mode === "unsent") throw new Error("transport unavailable");
					if (mode === "timeout") return;
					queueMicrotask(() => {
						if (mode === "closed_by_hub") void f.agent.close();
						else
							f.agent.emit("message", {
								type: "ERROR",
								code: mode === "displaced" ? "DISPLACED" : "STOP_FAILED",
								message: "unconfirmed",
							});
					});
				});
				const result = disabled(f, { end_terminals: true });
				await new Promise<void>((resolve) => setImmediate(resolve));
				await new Promise<void>((resolve) => setImmediate(resolve));
				await vi.advanceTimersByTimeAsync(15_001);
				await result;
				expect(f.agent.execOnHost).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		},
	);

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
	])("legacy %s is unconfirmed", async (mode) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const f = fixture([]);
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
			await disabled(f, { end_terminals: true, force: true });
			if (mode === "missing-path") expect(f.agent.execOnHost).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

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
