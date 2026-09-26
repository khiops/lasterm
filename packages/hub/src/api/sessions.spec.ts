import type { HelloMessage, ProtocolMessage } from "@lasterm/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REMOTE_STATE_DIR_COMMAND,
	remoteDaemonPaths,
	remoteDaemonStopCommand,
} from "../session/remote-daemon.js";
import type { SessionState, SharedSessionContext } from "../session/session-context.js";
import { SessionManager } from "../session/session-manager.js";
import { SshAgent } from "../session/ssh-agent.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { readReplaceAgentBody, registerSessionRoutes } from "./sessions.js";

// The connection to a remote daemon, as replaceAgent sees it: connected, a
// daemon, and answering a STOP the way the agent of #127 does.
vi.mock("../session/ssh-agent.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../session/ssh-agent.js")>();
	const { EventEmitter } = await import("node:events");
	class FakeSshAgent extends EventEmitter {
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
			this.connected = false;
		});
	}
	return { ...actual, SshAgent: FakeSshAgent };
});

type FakeSshAgent = SshAgent & {
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
	dbs = openTestDatabases();
	const metaDal = new MetaDAL(dbs.meta);
	hostId = metaDal.createHost({ type: "ssh", label: "pi", sshHost: "pi@pi.local" }).id;
	sm = new SessionManager(dbs);
	server = Fastify({ logger: false });
	registerSessionRoutes(server, metaDal, sm);
	await server.ready();
});

afterEach(async () => {
	await server.close();
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
function liveTerminalOn(agent: FakeSshAgent): { channelId: string; heard: ProtocolMessage[] } {
	const sessionId = "01K580SESSION0000000000000";
	const channelId = "01K580CHAN0000000000000001";
	const metaDal = new MetaDAL(dbs.meta);
	metaDal.createSession({ id: sessionId, hostId, status: "active" });
	metaDal.createChannel({ id: channelId, sessionId, status: "live", shell: "bash" });
	const internals = sm as unknown as {
		ctx: SharedSessionContext;
		agentMgr: { wireAgentEvents(hostId: string, sessionId: string, agent: unknown): void };
	};
	(internals.ctx.sessions as unknown as Map<string, SessionState>).set(hostId, {
		id: sessionId,
		hostId,
		status: "active",
	});
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
	internals.agentMgr.wireAgentEvents(hostId, sessionId, agent);
	const heard: ProtocolMessage[] = [];
	sm.addClient({ id: "c-window", send: (msg) => heard.push(msg), attachedChannels: new Set() });
	return { channelId, heard };
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
			expect.objectContaining({ exitCode: 0, endReason: "destroyed" }),
		]);
	});

	it("says nothing of the kind of a terminal that ends after a refused replace", async () => {
		const agent = connectedAgent(["multiplex", "hub-identity"], 2);
		const { channelId, heard } = liveTerminalOn(agent);

		expect((await replace()).statusCode).toBe(409);
		agent.emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });

		const ends = endsOf(heard, channelId);
		expect(ends).toHaveLength(1);
		expect(ends[0]).not.toHaveProperty("endReason");
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
