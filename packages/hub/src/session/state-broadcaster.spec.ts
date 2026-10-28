import type { Host, ProtocolMessage } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import type { SftpSupport } from "./agent-deployer.js";
import { rememberSocketForwardingRefused } from "./remote-daemon.js";
import type { SharedSessionContext } from "./session-context.js";
import { SshAgent } from "./ssh-agent.js";
import { StateBroadcaster } from "./state-broadcaster.js";

// ─── Which agent is serving a host ───────────────────────────────────────────
//
// A hub deploys an agent matched to itself, so a version that differs means the
// one answering was started by an older hub and is still there — a remote
// daemon holding terminals, most often. The hub sends the comparison rather
// than both versions: it is the side that knows its own (#456).

const HOST = "host-1";
const SESSION = "session-1";

function makeBroadcaster(agentVersion: string | undefined) {
	const sent: ProtocolMessage[] = [];
	const agents = new Map<string, unknown>();
	if (agentVersion !== undefined) {
		agents.set(HOST, { helloMessage: { agentVersion }, connected: true });
	}

	const ctx = {
		agents,
		sessions: new Map([[HOST, { id: SESSION, hostId: HOST, status: "active" }]]),
		channels: new Map(),
		clients: new Map([["c1", { id: "c1", send: (m: ProtocolMessage) => sent.push(m) }]]),
		metaDal: { updateSessionStatus: vi.fn(), listKilledChannels: () => [] },
		titleDebounceTimers: new Map(),
		processTitleDebounceTimers: new Map(),
		bellTimestamps: new Map(),
		notificationTimestamps: new Map(),
		userDisconnectedHosts: new Set(),
		socketForwardingRefusals: new Map(),
	} as unknown as SharedSessionContext;

	return { sent, broadcaster: new StateBroadcaster(ctx) };
}

describe("StateBroadcaster — the agent serving a host", () => {
	it("says nothing when the agent is the one this hub carries", () => {
		const { sent, broadcaster } = makeBroadcaster(HUB_VERSION);
		broadcaster.updateSessionStatus(HOST, SESSION, "active");

		const state = sent.find((m) => m.type === "SESSION_STATE") as unknown as {
			outdatedAgent?: unknown;
		};
		expect(state).toBeTruthy();
		expect(state.outdatedAgent).toBeUndefined();
	});

	it("says which two disagree when they do", () => {
		const { sent, broadcaster } = makeBroadcaster("0.0.1-from-an-older-hub");
		broadcaster.updateSessionStatus(HOST, SESSION, "active");

		const state = sent.find((m) => m.type === "SESSION_STATE") as unknown as {
			outdatedAgent?: { running: string; expected: string };
		};
		expect(state.outdatedAgent).toEqual({
			running: "0.0.1-from-an-older-hub",
			expected: HUB_VERSION,
		});
	});

	it("says nothing when no agent is connected", () => {
		const { sent, broadcaster } = makeBroadcaster(undefined);
		broadcaster.updateSessionStatus(HOST, SESSION, "disconnected");

		const state = sent.find((m) => m.type === "SESSION_STATE") as unknown as {
			outdatedAgent?: unknown;
		};
		expect(state.outdatedAgent).toBeUndefined();
	});

	it("carries the same answer in the state a client gets on connect", () => {
		const { broadcaster } = makeBroadcaster("0.0.1-from-an-older-hub");
		const snapshot = broadcaster.getStateSnapshot();

		expect(snapshot.sessions[0]?.outdatedAgent).toEqual({
			running: "0.0.1-from-an-older-hub",
			expected: HUB_VERSION,
		});
	});
});

// ─── A server without SFTP ───────────────────────────────────────────────────
//
// The hub asks once connected whether the server offers SFTP, and sends its
// agent over the SSH command channel when it does not (#722). That is a note on
// the host, not an error: said in its state, and only when SFTP was refused.

function makeSftpBroadcaster(support: SftpSupport | null) {
	const sent: ProtocolMessage[] = [];
	const agent = new SshAgent({ id: HOST, type: "ssh", sshHost: "example.test" } as Host);
	agent.sftpSupport = support;
	const ctx = {
		agents: new Map([[HOST, agent]]),
		sessions: new Map([[HOST, { id: SESSION, hostId: HOST, status: "active" }]]),
		channels: new Map(),
		clients: new Map([["c1", { id: "c1", send: (m: ProtocolMessage) => sent.push(m) }]]),
		metaDal: { updateSessionStatus: vi.fn(), listKilledChannels: () => [] },
		titleDebounceTimers: new Map(),
		processTitleDebounceTimers: new Map(),
		bellTimestamps: new Map(),
		notificationTimestamps: new Map(),
		userDisconnectedHosts: new Set(),
		socketForwardingRefusals: new Map(),
	} as unknown as SharedSessionContext;
	return { sent, broadcaster: new StateBroadcaster(ctx) };
}

describe("StateBroadcaster — a server that offers no SFTP (#722)", () => {
	it("says so in the session's state and in the state a client gets on connect", () => {
		const { sent, broadcaster } = makeSftpBroadcaster({
			offered: false,
			reason: "Unable to start subsystem: sftp",
		});
		broadcaster.updateSessionStatus(HOST, SESSION, "active");

		expect(sent.find((m) => m.type === "SESSION_STATE")).toMatchObject({ sftpUnavailable: true });
		expect(broadcaster.getStateSnapshot().sessions[0]?.sftpUnavailable).toBe(true);
	});

	it.each([
		["offered", { offered: true }],
		["not asked yet", null],
	] as const)("says nothing when SFTP was %s", (_name, support) => {
		const { sent, broadcaster } = makeSftpBroadcaster(support);
		broadcaster.updateSessionStatus(HOST, SESSION, "active");

		expect(sent.find((m) => m.type === "SESSION_STATE")).not.toHaveProperty("sftpUnavailable");
		expect(broadcaster.getStateSnapshot().sessions[0]).not.toHaveProperty("sftpUnavailable");
	});
});

// ─── A server that refuses socket forwarding (#765) ──────────────────────────

describe("StateBroadcaster — a server that refuses socket forwarding (#765)", () => {
	const pi = {
		id: HOST,
		type: "ssh",
		sshHost: "pi.example",
		os: "linux",
		sshRemoteDaemon: true,
	} as Host;

	function makeRefusalBroadcaster(stored: Host, seenOn: Host | null) {
		const sent: ProtocolMessage[] = [];
		const socketForwardingRefusals = new Map<string, string>();
		if (seenOn !== null) rememberSocketForwardingRefused(socketForwardingRefusals, seenOn);
		const ctx = {
			agents: new Map(),
			sessions: new Map([[HOST, { id: SESSION, hostId: HOST, status: "active" }]]),
			channels: new Map(),
			clients: new Map([["c1", { id: "c1", send: (m: ProtocolMessage) => sent.push(m) }]]),
			metaDal: {
				updateSessionStatus: vi.fn(),
				listKilledChannels: () => [],
				getHost: () => stored,
			},
			titleDebounceTimers: new Map(),
			processTitleDebounceTimers: new Map(),
			bellTimestamps: new Map(),
			notificationTimestamps: new Map(),
			userDisconnectedHosts: new Set(),
			socketForwardingRefusals,
		} as unknown as SharedSessionContext;
		return { sent, broadcaster: new StateBroadcaster(ctx) };
	}

	it("says so in the session's state and in the state a client gets on connect", () => {
		const { sent, broadcaster } = makeRefusalBroadcaster(pi, pi);
		broadcaster.updateSessionStatus(HOST, SESSION, "active");

		expect(sent.find((m) => m.type === "SESSION_STATE")).toMatchObject({
			socketForwardingRefused: true,
		});
		expect(broadcaster.getStateSnapshot().sessions[0]?.socketForwardingRefused).toBe(true);
	});

	it.each([
		["never refused", pi, null],
		["refused on the route the host had before", pi, { ...pi, sshHost: "old.example" }],
		["refused for a host that keeps no daemon now", { ...pi, sshRemoteDaemon: false }, pi],
	] as const)("says nothing when %s", (_name, stored, seenOn) => {
		const { sent, broadcaster } = makeRefusalBroadcaster(stored as Host, seenOn as Host | null);
		broadcaster.updateSessionStatus(HOST, SESSION, "active");

		expect(sent.find((m) => m.type === "SESSION_STATE")).not.toHaveProperty(
			"socketForwardingRefused",
		);
		expect(broadcaster.getStateSnapshot().sessions[0]).not.toHaveProperty(
			"socketForwardingRefused",
		);
	});
});

// ─── Renaming a terminal that has ended ──────────────────────────────────────
//
// The tab of a dead terminal is one people keep, and rename. The hub stored the
// new name and answered 200, but announced it only to the channel's attached
// clients — of which a dead terminal has none — so the tab kept the old name
// until the next reload.

function makeRenameBroadcaster(inMemory: boolean) {
	const sent: ProtocolMessage[] = [];
	const channels = new Map<string, unknown>();
	if (inMemory) {
		channels.set("ch-1", {
			sessionId: SESSION,
			hostId: HOST,
			status: "dead",
			clients: new Set<string>(),
			dynamicTitle: "bash",
			processTitle: null,
		});
	}

	const ctx = {
		agents: new Map(),
		sessions: new Map([[HOST, { id: SESSION, hostId: HOST, status: "active" }]]),
		channels,
		clients: new Map([["c1", { id: "c1", send: (m: ProtocolMessage) => sent.push(m) }]]),
		metaDal: {
			updateSessionStatus: vi.fn(),
			getChannel: vi.fn().mockReturnValue({
				id: "ch-1",
				title: "the name I gave it",
				dynamicTitle: "bash",
				processTitle: null,
			}),
		},
		titleDebounceTimers: new Map(),
		processTitleDebounceTimers: new Map(),
		bellTimestamps: new Map(),
		notificationTimestamps: new Map(),
		userDisconnectedHosts: new Set(),
		socketForwardingRefusals: new Map(),
	} as unknown as SharedSessionContext;

	return { sent, broadcaster: new StateBroadcaster(ctx) };
}

describe("StateBroadcaster — renaming a terminal that has ended", () => {
	it("tells every client, since none is attached to a dead terminal", () => {
		const { sent, broadcaster } = makeRenameBroadcaster(true);
		broadcaster.notifyChannelRenamed("ch-1");

		expect(sent).toContainEqual(
			expect.objectContaining({ type: "TITLE_CHANGE", displayTitle: "the name I gave it" }),
		);
	});

	it("names one the hub no longer holds in memory, from its row", () => {
		const { sent, broadcaster } = makeRenameBroadcaster(false);
		broadcaster.notifyChannelRenamed("ch-1");

		expect(sent).toContainEqual(
			expect.objectContaining({ type: "TITLE_CHANGE", displayTitle: "the name I gave it" }),
		);
	});
});
