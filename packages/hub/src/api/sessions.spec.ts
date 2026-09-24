import type { HelloMessage, ProtocolMessage } from "@lasterm/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REMOTE_STATE_DIR_COMMAND,
	remoteDaemonPaths,
	remoteDaemonStopCommand,
} from "../session/remote-daemon.js";
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
		readonly sent: ProtocolMessage[] = [];
		send = vi.fn((msg: ProtocolMessage) => {
			this.sent.push(msg);
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
			// A daemon that stops says nothing: its connection ends.
			setImmediate(() => {
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
