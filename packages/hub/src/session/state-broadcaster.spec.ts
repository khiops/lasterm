import type { ProtocolMessage } from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import type { SharedSessionContext } from "./session-context.js";
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
		metaDal: { updateSessionStatus: vi.fn() },
		titleDebounceTimers: new Map(),
		processTitleDebounceTimers: new Map(),
		bellTimestamps: new Map(),
		notificationTimestamps: new Map(),
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
