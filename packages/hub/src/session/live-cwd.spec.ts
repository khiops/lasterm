import type { AgentChannelStateMessage, ProtocolMessage } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import type { AgentConnection } from "./agent-connection.js";
import { cwdFields, liveCwdOf } from "./live-cwd.js";
import { SessionManager, type WsClient } from "./session-manager.js";

// ─── A local agent that answers as a real one does ───────────────────────────

/** What the mocked agent answers a CWD_QUERY with; null: it does not answer. */
const agentAnswers = vi.hoisted(() => ({
	cwdQuery: null as Record<string, unknown> | null,
	channelCount: 0,
}));

interface MockAgent {
	send: ReturnType<typeof vi.fn>;
	emit: (event: string, ...args: unknown[]) => boolean;
	listenerCount: (event: string) => number;
	connected: boolean;
}

const agents = vi.hoisted(() => [] as MockAgent[]);

vi.mock("./agent-launcher.js", () => {
	const { EventEmitter } = require("node:events");
	class MockLocalAgent extends EventEmitter {
		connected = true;
		constructor() {
			super();
			agents.push(this as unknown as MockAgent);
		}
		start = vi.fn().mockResolvedValue(undefined);
		waitForChannelState = vi.fn(() => Promise.resolve([]));
		close = vi.fn(() => {
			this.connected = false;
		});
		send = vi.fn((msg: Record<string, unknown>) => {
			if (msg.type === "SPAWN") {
				const channelId =
					(msg.channelId as string | undefined) ?? `ch-${++agentAnswers.channelCount}`;
				setImmediate(() =>
					this.emit("message", { type: "SPAWN_OK", requestId: msg.requestId, channelId }),
				);
			} else if (msg.type === "ATTACH") {
				setImmediate(() =>
					this.emit("message", {
						type: "ATTACH_OK",
						channelId: msg.channelId,
						requestId: msg.requestId,
						snapshot: { serialized: "", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
						lastSeq: 0,
					}),
				);
			} else if (msg.type === "CWD_QUERY" && agentAnswers.cwdQuery !== null) {
				const answer = { ...agentAnswers.cwdQuery, channelId: msg.channelId };
				setImmediate(() => this.emit("message", answer));
			}
		});
	}
	return {
		connectOrLaunch: vi.fn().mockImplementation(() => Promise.resolve(new MockLocalAgent())),
		resolveAgentPath: () => "/mock/agent/path",
		isAgentBinary: () => true,
	};
});

function makeClient(id: string, received: ProtocolMessage[]): WsClient {
	return { id, send: (msg) => received.push(msg), attachedChannels: new Set() };
}

function agent(): MockAgent {
	const current = agents.at(-1);
	if (current === undefined) throw new Error("expected an agent");
	return current;
}

function sentTypes(): string[] {
	return agent().send.mock.calls.map(([msg]) => (msg as { type: string }).type);
}

// ─── The validator ───────────────────────────────────────────────────────────

describe("what a CWD_CHANGE says (#834)", () => {
	it("takes a directory or null, from a source it knows", () => {
		expect(liveCwdOf({ cwd: "/tmp", source: "process", atPrompt: true })).toEqual({
			cwd: "/tmp",
			source: "process",
			atPrompt: true,
		});
		expect(liveCwdOf({ cwd: null, source: "shell", otherHost: "server" })).toEqual({
			cwd: null,
			source: "shell",
			otherHost: "server",
		});
		expect(liveCwdOf({ cwd: "/s", source: "start", foreground: "vim", atPrompt: false })).toEqual({
			cwd: "/s",
			source: "start",
			foreground: "vim",
			atPrompt: false,
		});
	});

	it("refuses a directory that is not one and a source it does not know", () => {
		expect(liveCwdOf({ cwd: 42, source: "process" })).toBeNull();
		expect(liveCwdOf({ source: "process" })).toBeNull();
		expect(liveCwdOf({ cwd: "/tmp", source: "guess" })).toBeNull();
		expect(liveCwdOf({ cwd: "/tmp" })).toBeNull();
	});

	it("leaves out the optional fields of the wrong type", () => {
		expect(
			liveCwdOf({ cwd: "/tmp", source: "process", atPrompt: "yes", foreground: 3, otherHost: {} }),
		).toEqual({ cwd: "/tmp", source: "process" });
	});

	it("says nothing in ATTACH_OK or STATE_SYNC until the agent has said it", () => {
		expect(cwdFields(undefined)).toEqual({});
		expect(cwdFields({ cwd: null, source: "process" })).toEqual({
			cwd: null,
			cwdSource: "process",
		});
		expect(
			cwdFields({ cwd: "/tmp", source: "process", atPrompt: false, foreground: "vim" }),
		).toEqual({ cwd: "/tmp", cwdSource: "process", foreground: "vim" });
	});
});

// ─── The hub ─────────────────────────────────────────────────────────────────

describe("a terminal's live directory in the hub (#834)", () => {
	let dbManager: ReturnType<typeof openTestDatabases>;
	let sm: SessionManager;
	let received: ProtocolMessage[];
	let channelId: string;

	beforeEach(async () => {
		agents.length = 0;
		agentAnswers.cwdQuery = null;
		agentAnswers.channelCount = 0;
		dbManager = openTestDatabases();
		sm = new SessionManager(dbManager);
		received = [];
		sm.addClient(makeClient("c-cwd", received));
		const spawned = await sm.handleSpawn("c-cwd", {
			type: "SPAWN",
			hostId: "local",
			cwd: "/start/dir",
		});
		if (spawned === null) throw new Error("expected a channel");
		channelId = spawned;
		await new Promise((resolve) => setImmediate(resolve));
		received.length = 0;
	});

	afterEach(async () => {
		await sm.shutdown();
		dbManager.close();
	});

	function cwdChange(fields: Record<string, unknown>): void {
		agent().emit("message", { type: "CWD_CHANGE", channelId, ...fields });
	}

	it("relays a CWD_CHANGE to the clients attached to the terminal", () => {
		cwdChange({ cwd: "/tmp", source: "process", atPrompt: true });
		expect(received).toContainEqual({
			type: "CWD_CHANGE",
			channelId,
			cwd: "/tmp",
			source: "process",
			atPrompt: true,
		});
	});

	it("ignores a CWD_CHANGE that is not one, or for a terminal it does not hold", () => {
		cwdChange({ cwd: 42, source: "process" });
		agent().emit("message", { type: "CWD_CHANGE", channelId: "nope", cwd: "/x", source: "shell" });
		expect(received.filter((m) => m.type === "CWD_CHANGE")).toEqual([]);
		expect(
			sm.getStateSnapshot().channels.find((c) => c.channelId === channelId),
		).not.toHaveProperty("cwd");
	});

	it("gives the last one in STATE_SYNC and ATTACH_OK", async () => {
		cwdChange({ cwd: "/srv/app", source: "shell", atPrompt: false, foreground: "vim" });

		const entry = sm.getStateSnapshot().channels.find((c) => c.channelId === channelId);
		expect(entry).toMatchObject({ cwd: "/srv/app", cwdSource: "shell", foreground: "vim" });

		const other: ProtocolMessage[] = [];
		sm.addClient(makeClient("c-other", other));
		expect(await sm.handleAttach("c-other", channelId)).toBe(true);
		const attachOk = other.find((m) => m.type === "ATTACH_OK");
		expect(attachOk).toMatchObject({
			cached: false,
			cwd: "/srv/app",
			cwdSource: "shell",
			foreground: "vim",
		});
	});

	it("gives an unknown directory as null, and nothing before the agent said any", async () => {
		const before = sm.getStateSnapshot().channels.find((c) => c.channelId === channelId);
		expect(before).not.toHaveProperty("cwd");
		expect(before).not.toHaveProperty("cwdSource");

		cwdChange({ cwd: null, source: "process" });
		const after = sm.getStateSnapshot().channels.find((c) => c.channelId === channelId);
		expect(after).toMatchObject({ cwd: null, cwdSource: "process" });
		expect(after).not.toHaveProperty("foreground");
	});

	it("leaves the directory the terminal starts in where it is", () => {
		cwdChange({ cwd: "/elsewhere", source: "process" });
		expect(new MetaDAL(dbManager.meta).getChannel(channelId)?.cwd).toBe("/start/dir");
		expect(sm.channels.get(channelId)?.cwd).toBe("/start/dir");
		expect(sm.channels.get(channelId)?.liveCwd?.cwd).toBe("/elsewhere");
	});

	it("forgets it when the terminal ends", () => {
		cwdChange({ cwd: "/tmp", source: "process" });
		agent().emit("message", { type: "CHANNEL_EXIT", channelId, exitCode: 0 });
		expect(sm.channels.get(channelId)?.liveCwd).toBeUndefined();
	});

	describe("a fresh read, asked of the agent", () => {
		it("sends CWD_QUERY and answers with what the agent read", async () => {
			agentAnswers.cwdQuery = { type: "CWD_CHANGE", cwd: "/fresh", source: "process" };
			const listening = agent().listenerCount("message");
			const outcome = await sm.queryChannelCwd(channelId);
			expect(agent().send).toHaveBeenCalledWith({ type: "CWD_QUERY", channelId });
			expect(outcome).toEqual({ kind: "ok", live: { cwd: "/fresh", source: "process" } });
			// The answer goes where every CWD_CHANGE goes.
			expect(sm.channels.get(channelId)?.liveCwd?.cwd).toBe("/fresh");
			expect(received).toContainEqual(
				expect.objectContaining({ type: "CWD_CHANGE", cwd: "/fresh" }),
			);
			expect(agent().listenerCount("message")).toBe(listening);
		});

		it("is not found when the agent no longer has the terminal", async () => {
			agentAnswers.cwdQuery = {
				type: "ERROR",
				code: "CHANNEL_NOT_FOUND",
				message: "channel not found",
			};
			expect(await sm.queryChannelCwd(channelId)).toEqual({ kind: "not-found" });
		});

		it("gives what was said last when the agent does not answer in time", async () => {
			cwdChange({ cwd: "/last", source: "shell" });
			const listening = agent().listenerCount("message");
			expect(await sm.queryChannelCwd(channelId, 20)).toEqual({
				kind: "timeout",
				last: { cwd: "/last", source: "shell" },
			});
			expect(agent().listenerCount("message")).toBe(listening);
		});

		it("asks nothing of an agent that is gone, nor about a terminal the hub does not hold", async () => {
			expect(await sm.queryChannelCwd("unknown")).toEqual({ kind: "not-found" });
			agent().connected = false;
			expect(await sm.queryChannelCwd(channelId)).toEqual({ kind: "not-connected", last: null });
			expect(sentTypes()).not.toContain("CWD_QUERY");
		});
	});

	it("asks a daemon for the directory of a terminal it adopts and knows nothing of", () => {
		const lifecycle = (
			sm as unknown as {
				lifecycle: {
					reconcileChannelState(
						hostId: string,
						states: AgentChannelStateMessage[],
						agent: AgentConnection,
					): void;
				};
			}
		).lifecycle;
		const hostId = sm.channels.get(channelId)?.hostId ?? "";
		const reported: AgentChannelStateMessage[] = [
			{ type: "AGENT_CHANNEL_STATE", channelId, title: "sh", pid: 42, alive: true },
		];

		lifecycle.reconcileChannelState(hostId, reported, agent() as unknown as AgentConnection);
		expect(agent().send).toHaveBeenCalledWith({ type: "CWD_QUERY", channelId });

		// One it already heard from is not asked again.
		agent().send.mockClear();
		cwdChange({ cwd: "/known", source: "process" });
		lifecycle.reconcileChannelState(hostId, reported, agent() as unknown as AgentConnection);
		expect(sentTypes()).not.toContain("CWD_QUERY");
	});
});
