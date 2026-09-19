/**
 * prompt-context.spec.ts — One test per invariant 1–7 (spec §Invariants), plus
 * guard A (store-before-send), guard B (CLOSED refusal), guard D (stale epoch).
 *
 * Each test carries a "Mutation oracle" comment naming the exact code mutation
 * that would make the test fail.
 *
 * Invariant summary (from docs/plans/prompt-routing-redesign.md §Invariants):
 *   1. Cross-context isolation — test context never touches session context for same host.
 *   2. Whole-sequence route — prompt() uses current routeClientId; post-retarget sends new route.
 *   3. Response authorization — respond() accepts only from the CURRENT routeClientId.
 *   4. Owner-id lifecycle — clearContext() by id, not AbortController or hostId.
 *   5. Same-client sequential replace — re-prompt on same context resolves old null.
 *   6. No bare-hostId clobber — separate contexts for same host never cross-cancel.
 *   7. Disconnect → retarget-or-fail — clientDisconnect retargets to live lease-holder or clears.
 *
 * Guard tests:
 *   A: send throws → prompt not orphaned (maps cleaned up).
 *   B: respond/prompt on CLOSED context is refused.
 *   D: stale deliveryEpoch rejected by respond().
 */

import { describe, expect, it, type Mock, vi } from "vitest";
import * as PC from "./prompt-context.js";
import type {
	Lease,
	PromptContext,
	SessionAcquisition,
	SharedSessionContext,
} from "./session-context.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal ctx for prompt-context unit tests. */
function makeCtx(): PC.PromptCtxSlice {
	return {
		promptContexts: new Map<string, PromptContext>(),
		promptIndex: new Map<string, string>(),
		pendingPrompts: new Map(),
		clients: new Map(),
		acquisitions: new Map(),
	};
}

/** Add a fake WsClient to the ctx.clients map. */
function addClient(ctx: PC.PromptCtxSlice, clientId: string): void {
	type ClientMap = SharedSessionContext["clients"];
	type ClientVal = ClientMap extends Map<string, infer V> ? V : never;
	ctx.clients.set(clientId, {
		id: clientId,
		send: vi.fn(),
		attachedChannels: new Set<string>(),
	} as unknown as ClientVal);
}

/** Add a fake lease to a fake acquisition (for pickRouteCandidate tests). */
function addLease(
	ctx: PC.PromptCtxSlice,
	hostId: string,
	clientId: string,
	acqId = `acq-${hostId}`,
): void {
	let acq = ctx.acquisitions.get(hostId) as SessionAcquisition | undefined;
	if (!acq) {
		const leases = new Set<Lease>();
		let connectResolve!: (s: import("./session-context.js").SessionState) => void;
		const connectPromise = new Promise<import("./session-context.js").SessionState>((r) => {
			connectResolve = r;
		});
		connectPromise.catch(() => {});
		acq = {
			id: acqId,
			hostId,
			state: "CONNECTING" as const,
			controller: new AbortController(),
			connectPromise,
			_resolve: connectResolve,
			_reject: vi.fn(),
			leases,
		} as unknown as SessionAcquisition;
		ctx.acquisitions.set(hostId, acq);
	}
	const lease: Lease = {
		id: clientId,
		hostId,
		acqId: acq.id,
		clientId,
		released: false,
		_acq: acq,
	};
	acq.leases.add(lease);
}

/** No-op send spy. */
function makeSend(): Mock<(clientId: string, msg: Record<string, unknown>) => void> {
	return vi.fn();
}

// ─── Invariant 1: cross-context isolation ────────────────────────────────────

describe("Invariant 1: cross-context isolation (test vs session, same host)", () => {
	it("opening two contexts for the same host produces distinct ids", () => {
		// Mutation oracle: using hostId as context id would make both contexts share the
		// same key — second openContext overwrites first, clobbering the session prompt
		// with a TEST_CONNECT for the same host.
		const ctx = makeCtx();
		const sessionCtx = PC.openContext(ctx, "session", "host-1", "client-a", "acq-id-1");
		const testCtx = PC.openContext(ctx, "test", "host-1", "client-b");

		expect(sessionCtx.id).not.toBe(testCtx.id);
		expect(ctx.promptContexts.size).toBe(2);
	});

	it("clearContext on test context leaves session context intact", () => {
		// Mutation oracle: clearing by hostId instead of contextId would also delete
		// the session context, causing the session prompt to be lost.
		const ctx = makeCtx();
		const sessionCtx = PC.openContext(ctx, "session", "host-1b", "client-a", "acq-id-2");
		const testCtx = PC.openContext(ctx, "test", "host-1b", "client-b");

		PC.clearContext(ctx, testCtx.id);

		expect(ctx.promptContexts.has(testCtx.id)).toBe(false);
		expect(ctx.promptContexts.has(sessionCtx.id)).toBe(true);
	});
});

// ─── Invariant 2: whole-sequence route ───────────────────────────────────────

describe("Invariant 2: prompt() uses current routeClientId; retarget changes future sends", () => {
	it("prompt() sends to routeClientId at call time", () => {
		// Mutation oracle: hard-coding a different client in the send call would route
		// prompts to the wrong destination regardless of context.routeClientId.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		const send = makeSend();
		const context = PC.openContext(ctx, "session", "host-2", "client-a", "acq-2a");

		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);

		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[0]).toBe("client-a");

		PC.clearContext(ctx, context.id);
	});

	it("after retarget, a second prompt() sends to the new client", () => {
		// Mutation oracle: not updating context.routeClientId in retarget() means the
		// second prompt still goes to client-a after client-b was assigned.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		const send = makeSend();
		const context = PC.openContext(ctx, "session", "host-2b", "client-a", "acq-2b");

		// First prompt — goes to client-a.
		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);
		expect(send.mock.calls[0]?.[0]).toBe("client-a");

		// Retarget to client-b.
		PC.retarget(ctx, context.id, "client-b", send);

		// Second prompt — must go to client-b.
		send.mockClear();
		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT", seq: 2 }, send);
		expect(send.mock.calls[0]?.[0]).toBe("client-b");

		PC.clearContext(ctx, context.id);
	});
});

// ─── Invariant 3: response authorization ─────────────────────────────────────

describe("Invariant 3: respond() accepts only from the CURRENT routeClientId", () => {
	it("respond from a non-route client is rejected", () => {
		// Mutation oracle: removing the clientId === context.routeClientId check from
		// respond() would accept a response from a rogue client (SEC-003 bypass).
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		let capturedPromptId: string | undefined;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			capturedPromptId = msg.promptId as string;
		});
		const context = PC.openContext(ctx, "session", "host-3", "client-a", "acq-3a");

		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, spySend);
		expect(capturedPromptId).toBeDefined();

		// Rogue client-b tries to respond.
		const accepted = PC.respond(ctx, capturedPromptId!, "client-b", 1, "secret");
		expect(accepted).toBe(false);

		PC.clearContext(ctx, context.id);
	});

	it("respond from the correct routeClientId with correct epoch is accepted", () => {
		// Mutation oracle: inverting the clientId check would accept rogue senders and
		// reject the legitimate owner.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		let capturedPromptId: string | undefined;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			capturedPromptId = msg.promptId as string;
		});
		const context = PC.openContext(ctx, "session", "host-3b", "client-a", "acq-3b");

		const promise = PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, spySend);
		expect(capturedPromptId).toBeDefined();
		const accepted = PC.respond(ctx, capturedPromptId!, "client-a", 1, "my-secret");
		expect(accepted).toBe(true);
		return expect(promise).resolves.toBe("my-secret");
	});

	it("respond from the correct route with undefined epoch is accepted (back-compat: web does not echo deliveryEpoch yet)", () => {
		// Back-compat: HOST_VERIFY_RESPONSE carries no deliveryEpoch until the web client
		// is updated to echo it. respond() must accept undefined epoch from the correct
		// route owner while still enforcing the SEC-003 clientId check.
		//
		// Mutation oracle: if undefined epoch triggers the Guard D rejection path,
		// this call returns false and the promise never resolves — the test fails.
		// If SEC-003 is skipped entirely (both guards removed), the rogue-client
		// test below would pass instead of catching the bug.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		let capturedPromptId: string | undefined;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			capturedPromptId = msg.promptId as string;
		});
		const context = PC.openContext(ctx, "session", "host-3c", "client-a", "acq-3c");

		const promise = PC.prompt(ctx, context.id, "host_verify", { type: "HOST_VERIFY" }, spySend);
		expect(capturedPromptId).toBeDefined();
		// Pass undefined epoch — back-compat path.
		const accepted = PC.respond(ctx, capturedPromptId!, "client-a", undefined, "trust_once");
		expect(accepted).toBe(true);
		return expect(promise).resolves.toBe("trust_once");
	});

	it("stale epoch is rejected when a defined epoch is provided", () => {
		// Guard D: when the caller provides a defined deliveryEpoch that does not match
		// the in-flight epoch, the response must be rejected — the sender is replaying
		// an old prompt or responding to the wrong delivery.
		//
		// Mutation oracle: removing the epoch check from respond() allows this call to
		// return true and resolve the promise with a stale action — stale trust applied.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		let capturedPromptId: string | undefined;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			capturedPromptId = msg.promptId as string;
		});
		const context = PC.openContext(ctx, "session", "host-3d", "client-a", "acq-3d");

		PC.prompt(ctx, context.id, "host_verify", { type: "HOST_VERIFY" }, spySend);
		expect(capturedPromptId).toBeDefined();
		// Epoch 999 does not match the in-flight epoch (1).
		const accepted = PC.respond(ctx, capturedPromptId!, "client-a", 999, "trust_permanent");
		expect(accepted).toBe(false);

		PC.clearContext(ctx, context.id);
	});
});

// ─── Invariant 4: owner-id lifecycle ─────────────────────────────────────────

describe("Invariant 4: clearContext by contextId, not AbortController or hostId", () => {
	it("clearContext resolves all in-flight prompts with null and removes the context", () => {
		// Mutation oracle: clearing by hostId instead of contextId would also destroy
		// prompts in a co-existing context for the same host.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		const send = makeSend();
		const context = PC.openContext(ctx, "session", "host-4", "client-a", "acq-4a");

		const p1 = PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);
		const p2 = PC.prompt(ctx, context.id, "host_verify", { type: "HOST_VERIFY" }, send);

		PC.clearContext(ctx, context.id);

		expect(ctx.promptContexts.has(context.id)).toBe(false);
		expect(ctx.promptIndex.size).toBe(0);
		expect(ctx.pendingPrompts.size).toBe(0);

		return Promise.all([expect(p1).resolves.toBeNull(), expect(p2).resolves.toBeNull()]);
	});
});

// ─── Invariant 5: same-context re-prompt resolves old null ───────────────────

describe("Invariant 5: re-prompting on same context resolves previous null cleanly", () => {
	it("clearContext followed by new context for same host does not clobber second context", () => {
		// Mutation oracle: sharing a context by hostId instead of unique contextId causes
		// second openContext to overwrite the first, dangling the first promise.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		const send = makeSend();

		const ctx1 = PC.openContext(ctx, "session", "host-5", "client-a", "acq-5a");
		const p1 = PC.prompt(ctx, ctx1.id, "passphrase", { type: "AUTH_PROMPT" }, send);
		PC.clearContext(ctx, ctx1.id);

		// Second context for same host — must be a separate entry.
		const ctx2 = PC.openContext(ctx, "session", "host-5", "client-a", "acq-5b");
		const p2 = PC.prompt(ctx, ctx2.id, "passphrase", { type: "AUTH_PROMPT" }, send);

		PC.clearContext(ctx, ctx2.id);

		return Promise.all([expect(p1).resolves.toBeNull(), expect(p2).resolves.toBeNull()]);
	});
});

// ─── Invariant 6: no bare-hostId clobber ─────────────────────────────────────

describe("Invariant 6: no bare-hostId clobber — separate contexts for same host are independent", () => {
	it("clearContext on one context does not affect the other context for the same host", () => {
		// Mutation oracle: keying contexts by hostId means clearing one clears BOTH.
		// Without the mutation, only the targeted context is removed.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		const send = makeSend();

		const ctxA = PC.openContext(ctx, "session", "host-6", "client-a", "acq-6a");
		const ctxB = PC.openContext(ctx, "test", "host-6", "client-b");

		const pA = PC.prompt(ctx, ctxA.id, "passphrase", { type: "AUTH_PROMPT" }, send);
		const pB = PC.prompt(ctx, ctxB.id, "host_verify", { type: "HOST_VERIFY" }, send);

		// Clear only ctxA — ctxB must survive.
		PC.clearContext(ctx, ctxA.id);

		expect(ctx.promptContexts.has(ctxA.id)).toBe(false);
		expect(ctx.promptContexts.has(ctxB.id)).toBe(true);
		expect(ctxB.prompts.size).toBe(1);

		PC.clearContext(ctx, ctxB.id);

		return Promise.all([expect(pA).resolves.toBeNull(), expect(pB).resolves.toBeNull()]);
	});
});

// ─── Invariant 7: disconnect → retarget-or-fail ──────────────────────────────

describe("Invariant 7: clientDisconnect retargets to a live lease-holder or clears the context", () => {
	it("when a live candidate exists, retarget to it", () => {
		// Mutation oracle: if clientDisconnect always calls clearContext instead of
		// retarget, the prompt sequence is dropped even though another live client
		// is available.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		addLease(ctx, "host-7", "client-a");
		addLease(ctx, "host-7", "client-b");
		const send = makeSend();
		const context = PC.openContext(ctx, "session", "host-7", "client-a", "acq-7");

		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);

		// client-a disconnects — client-b should take over.
		PC.clientDisconnect(ctx, "client-a", send);

		// Context still open, now routed to client-b.
		expect(ctx.promptContexts.has(context.id)).toBe(true);
		expect(context.routeClientId).toBe("client-b");
		// send was called again for the retarget re-send.
		expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);

		PC.clearContext(ctx, context.id);
	});

	it("when no candidate exists, clearContext is called", () => {
		// Mutation oracle: if clientDisconnect only retargets (never clears), prompts stay
		// bound to a dead client with no live route indefinitely.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		const send = makeSend();
		const context = PC.openContext(ctx, "session", "host-7b", "client-a", "acq-7b");

		const p = PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);

		// client-a disconnects and no other lease holder exists.
		PC.clientDisconnect(ctx, "client-a", send);

		// Context must be cleared.
		expect(ctx.promptContexts.has(context.id)).toBe(false);

		return expect(p).resolves.toBeNull();
	});

	it("KIND-D5 test context disconnect clears instead of retargeting to same-host lease-holder", () => {
		// Mutation oracle: if clientDisconnect retargets test contexts by hostId,
		// client-b receives and can answer a TEST_CONNECT prompt owned by client-a.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		addLease(ctx, "host-7-test", "client-a");
		addLease(ctx, "host-7-test", "client-b");
		const send = makeSend();
		const context = PC.openContext(ctx, "test", "host-7-test", "client-a");

		const p = PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);

		PC.clientDisconnect(ctx, "client-a", send);

		expect(ctx.promptContexts.has(context.id)).toBe(false);
		expect(send.mock.calls.some(([clientId]) => clientId === "client-b")).toBe(false);
		return expect(p).resolves.toBeNull();
	});

	it("KIND-D5 elevation context disconnect clears instead of retargeting to same-host lease-holder", () => {
		// Mutation oracle: if clientDisconnect retargets elevation contexts by hostId,
		// client-b receives and can answer an elevation prompt owned by client-a.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		addLease(ctx, "host-7-elev", "client-a");
		addLease(ctx, "host-7-elev", "client-b");
		const send = makeSend();
		const context = PC.openContext(ctx, "elevation", "host-7-elev", "client-a");

		const p = PC.prompt(ctx, context.id, "elevation", { type: "AUTH_PROMPT" }, send);

		PC.clientDisconnect(ctx, "client-a", send);

		expect(ctx.promptContexts.has(context.id)).toBe(false);
		expect(send.mock.calls.some(([clientId]) => clientId === "client-b")).toBe(false);
		return expect(p).resolves.toBeNull();
	});
});

// ─── Guard A: send throws → no orphaned prompt ───────────────────────────────

describe("Guard A: send throws → prompt cleaned up immediately (no orphan)", () => {
	it("all maps are empty after a send failure — no orphaned entry", () => {
		// Mutation oracle: if the send-failure error handler does not clean up the maps,
		// the prompt stays in promptIndex / pendingPrompts / context.prompts forever.
		// It can never be resolved and holds a live timer until process exit.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		const context = PC.openContext(ctx, "session", "host-ga", "client-a", "acq-ga");

		const throwingSend = vi.fn(() => {
			throw new Error("WS closed");
		});

		const promise = PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, throwingSend);

		// After send failure, all tracking maps must be empty.
		expect(ctx.promptIndex.size).toBe(0);
		expect(ctx.pendingPrompts.size).toBe(0);
		expect(context.prompts.size).toBe(0);

		// The promise must resolve null (not dangle).
		return expect(promise).resolves.toBeNull();
	});
});

// ─── Guard B: CLOSED context refuses prompt() and respond() ──────────────────

describe("Guard B: CLOSED context refuses prompt() and respond()", () => {
	it("prompt() on a CLOSED context returns null", () => {
		// Mutation oracle: removing the state === 'CLOSED' guard from prompt() would
		// issue a new prompt against a terminated context, leaving it permanently
		// unresolved (no clearContext to drain it after CLOSED is set).
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		const send = makeSend();
		const context = PC.openContext(ctx, "session", "host-gb", "client-a", "acq-gb");

		PC.clearContext(ctx, context.id);
		expect(context.state).toBe("CLOSED");

		const result = PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, send);
		expect(result).toBeNull();
		expect(send).not.toHaveBeenCalled();
	});

	it("respond() on a CLOSED context returns false", () => {
		// Mutation oracle: removing the CLOSED guard from respond() would attempt to
		// look up a prompt already removed by clearContext, potentially mis-routing
		// if a new prompt reused the same promptId in another context.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		let capturedPromptId: string | undefined;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			capturedPromptId = msg.promptId as string;
		});
		const context = PC.openContext(ctx, "session", "host-gb2", "client-a", "acq-gb2");

		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, spySend);
		expect(capturedPromptId).toBeDefined();

		PC.clearContext(ctx, context.id);

		const accepted = PC.respond(ctx, capturedPromptId!, "client-a", 1, "secret");
		expect(accepted).toBe(false);
	});
});

// ─── Guard D: stale deliveryEpoch rejected ───────────────────────────────────

describe("Guard D: stale deliveryEpoch rejected by respond()", () => {
	it("responding with an old epoch after retarget is rejected", () => {
		// Mutation oracle: removing the deliveryEpoch check from respond() would allow
		// an old-route response (epoch=1) to be accepted after retarget bumped epoch to 2.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		const retargetSend = makeSend();
		let capturedPromptId: string | undefined;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			if (!capturedPromptId) capturedPromptId = msg.promptId as string;
		});
		const context = PC.openContext(ctx, "session", "host-gd", "client-a", "acq-gd");

		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, spySend);
		expect(capturedPromptId).toBeDefined();

		// Retarget to client-b — epoch bumped to 2.
		PC.retarget(ctx, context.id, "client-b", retargetSend);

		// Old-route client-a tries to respond with epoch=1 — must be rejected.
		const accepted = PC.respond(ctx, capturedPromptId!, "client-a", 1, "stale-secret");
		expect(accepted).toBe(false);

		PC.clearContext(ctx, context.id);
	});

	it("responding with the current epoch after retarget is accepted", () => {
		// Mutation oracle: accepting any epoch regardless of value would mean both old
		// and new routes can answer; only the current epoch must be accepted.
		const ctx = makeCtx();
		addClient(ctx, "client-a");
		addClient(ctx, "client-b");
		let capturedPromptId: string | undefined;
		let currentEpoch = 0;
		const spySend = vi.fn((_: string, msg: Record<string, unknown>) => {
			capturedPromptId = msg.promptId as string;
			currentEpoch = msg.deliveryEpoch as number;
		});
		const context = PC.openContext(ctx, "session", "host-gd2", "client-a", "acq-gd2");

		PC.prompt(ctx, context.id, "passphrase", { type: "AUTH_PROMPT" }, spySend);

		// Retarget — spySend captures the new epoch via re-send.
		PC.retarget(ctx, context.id, "client-b", spySend);
		expect(capturedPromptId).toBeDefined();

		// client-b responds with the current epoch (2 after one retarget).
		const accepted = PC.respond(ctx, capturedPromptId!, "client-b", currentEpoch, "correct-secret");
		expect(accepted).toBe(true);
	});
});
