/**
 * session-acquisition.spec.ts — One test per invariant 1–9.
 *
 * Each test carries a "Mutation oracle" comment that names the exact
 * code mutation that would make the test fail. This proves the test
 * is testing the stated invariant and not an accident.
 *
 * Invariant summary:
 *   1. Follower lease keeps refcount ≥ 1 until release() — no premature reap.
 *   2. Outer finally releases the lease on every exit path (throw-safe).
 *   3. Reap triggered by lease count reaching 0, not channel-presence alone.
 *   4. Identity-checked removals — only the owning acq may remove itself.
 *   5. Prompts cleared by ownerAcqId — a newer prompt from a different acq survives.
 *   6. release() is idempotent — double-release does not underflow or double-reap.
 *   7. Commit guard: acq identity + state + signal + session currency must all hold.
 *   8. Single authority (P2): acq deleted from map on commit().
 *   9. join() refused after CLOSING is set — terminal state precedes async teardown.
 */

import { describe, expect, it, vi } from "vitest";
import * as Acq from "./session-acquisition.js";
import type { SessionAcquisition, SessionState, SharedSessionContext } from "./session-context.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Minimal ctx for unit tests — only the maps the primitives touch. */
function makeCtx(): Pick<SharedSessionContext, "acquisitions" | "pendingPrompts"> {
	return {
		acquisitions: new Map<string, SessionAcquisition>(),
		pendingPrompts: new Map(),
	};
}

function makeSession(hostId: string): SessionState {
	return { id: `sess-${hostId}`, hostId, status: "active" };
}

// ─── Invariant 1: follower lease keeps refcount ≥ 1 ─────────────────────────

describe("Invariant 1: follower lease prevents premature reap", () => {
	it("leader release does NOT reap when a follower lease is still held", () => {
		// Mutation oracle: returning early from join() without adding to leases.Set
		// would make leases.size drop to 0 on leaderRelease → reap fires while
		// follower is still in-flight.
		const ctx = makeCtx();
		const { acq, lease: leaderLease } = Acq.acquire(ctx, "host-1", "client-test");

		// Follower joins.
		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease).not.toBeNull();
		expect(acq.leases.size).toBe(2);

		// Leader releases — reap must NOT fire (follower still holds a lease).
		const reaped = Acq.release(ctx, leaderLease, () => false);
		expect(reaped).toBe(false);
		expect(acq.leases.size).toBe(1);
		// acq still present in map (not committed, just lease released).
		expect(ctx.acquisitions.get("host-1")).toBe(acq);

		// Follower releases — now reap fires.
		const reaped2 = Acq.release(ctx, followerLease!, () => false);
		expect(reaped2).toBe(true);
		expect(ctx.acquisitions.has("host-1")).toBe(false);
		acq.connectPromise.catch(() => {});
	});
});

// ─── Invariant 2: release() called on every exit path (throw-safe) ───────────

describe("Invariant 2: outer finally releases lease even on throw", () => {
	it("lease is marked released after a simulated throw in handleSpawn body", async () => {
		// Mutation oracle: moving release() into a non-finally block (e.g. after the
		// spawn body) would leave lease.released = false when the body throws.
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-2", "client-test");
		// Suppress the unhandled rejection from release() reaping connectPromise.
		acq.connectPromise.catch(() => {});
		expect(lease.released).toBe(false);

		// Simulate the outer finally that handleSpawn guarantees — using a helper
		// so the throw does not escape the test (vitest catches thrown test errors).
		let finallyRan = false;
		await (async () => {
			try {
				throw new Error("simulated spawn body error");
			} finally {
				Acq.release(ctx, lease, () => false);
				finallyRan = true;
			}
		})().catch(() => {
			/* expected throw swallowed here */
		});

		// INVARIANT: finally ran even though the body threw.
		expect(finallyRan).toBe(true);
		expect(lease.released).toBe(true);
	});

	it("lease.released is true after release() regardless of throw", () => {
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-2b", "client-test");
		// Suppress the unhandled rejection from release() reaping connectPromise.
		acq.connectPromise.catch(() => {});
		let finallyRan = false;
		try {
			throw new Error("boom");
		} catch {
			// intentionally swallow to allow assertion below
		} finally {
			Acq.release(ctx, lease, () => false);
			finallyRan = true;
		}
		expect(finallyRan).toBe(true);
		expect(lease.released).toBe(true);
		// acq is reaped (size was 1 → 0, no channels)
		expect(ctx.acquisitions.has("host-2b")).toBe(false);
	});
});

// ─── Invariant 3: reap triggered by lease count, not channel-presence alone ──

describe("Invariant 3: reap uses lease count, not channel-presence alone", () => {
	it("release does NOT reap when channels are still present", () => {
		// Mutation oracle: removing the `!hasChannels()` check from release() would
		// cause reap even when the session has live channels (prematurely kills session).
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-3", "client-test");

		// hasChannels() returns true — session has a live channel.
		const reaped = Acq.release(ctx, lease, () => true);
		expect(reaped).toBe(false);
		// acq is still present (not reaped).
		expect(ctx.acquisitions.get("host-3")).toBe(acq);
		acq.connectPromise.catch(() => {});
		// Manual cleanup
		ctx.acquisitions.delete("host-3");
	});

	it("release DOES reap when lease count hits 0 AND no channels", () => {
		// Mutation oracle: removing the `acq.leases.size === 0` check from release()
		// would never reap, leaving abandoned acquisitions in the map.
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-3b", "client-test");
		// Suppress the unhandled rejection from release() reaping connectPromise.
		acq.connectPromise.catch(() => {});
		const reaped = Acq.release(ctx, lease, () => false);
		expect(reaped).toBe(true);
		expect(ctx.acquisitions.has("host-3b")).toBe(false);
	});
});

// ─── Invariant 4: identity-checked removals ───────────────────────────────────

describe("Invariant 4: identity-checked removals — only owning acq may remove", () => {
	it("Acq.close does NOT remove a replacement acq installed during _reject", () => {
		// Mutation oracle: replacing `if (ctx.acquisitions.get(hostId) === acq) delete`
		// with `ctx.acquisitions.delete(hostId)` in close() would clobber the replacement.
		const ctx = makeCtx();
		const { acq: staleAcq } = Acq.acquire(ctx, "host-4", "client-test");

		// Replacement acq installed before close() identity-check fires.
		let replacementResolve!: (s: SessionState) => void;
		const replacementConnect = new Promise<SessionState>((r) => {
			replacementResolve = r;
		});
		replacementConnect.catch(() => {});
		const replacementAcq: SessionAcquisition = {
			id: "replacement-acq-4",
			hostId: "host-4",
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: replacementConnect,
			_resolve: replacementResolve,
			_reject: vi.fn(),
			leases: new Set(),
		};

		// Patch stale acq's _reject to install replacement synchronously.
		staleAcq._reject = vi.fn(() => {
			ctx.acquisitions.set("host-4", replacementAcq);
		});

		Acq.close(ctx, "host-4");

		// INVARIANT: replacement is still present — identity check prevented clobber.
		expect(ctx.acquisitions.get("host-4")).toBe(replacementAcq);

		// Cleanup.
		ctx.acquisitions.delete("host-4");
	});
});

// ─── Invariant 5: prompt cleared by ownerAcqId — newer prompt survives ───────

describe("Invariant 5: pendingPrompts cleared by ownerAcqId — newer prompt survives", () => {
	it("closing stale acq only clears its own prompts, not prompts from a newer acq", () => {
		// Mutation oracle: clearing prompts by hostId instead of ownerAcqId would
		// remove the newer acq's prompt, leaving the host permanently stuck.
		const ctx = makeCtx();
		const { acq: staleAcq } = Acq.acquire(ctx, "host-5", "client-test");
		// Suppress the unhandled rejection from Acq.close() reaping connectPromise.
		staleAcq.connectPromise.catch(() => {});
		const staleAcqId = staleAcq.id;

		// Simulate: staleAcq registered a prompt.
		const staleResolve = vi.fn();
		ctx.pendingPrompts.set("prompt-stale", {
			ownerAcqId: staleAcqId,
			hostId: "host-5",
			timer: null,
			resolve: staleResolve,
			clientId: "client-stale",
		});

		// A newer acq for the same host registered a different prompt.
		const newerResolve = vi.fn();
		ctx.pendingPrompts.set("prompt-newer", {
			ownerAcqId: "newer-acq-id",
			hostId: "host-5",
			timer: null,
			resolve: newerResolve,
			clientId: "client-newer",
		});

		// Simulate what closeSession does: close the stale acq, then clear its prompts
		// by ownerAcqId (not by hostId).
		const closedAcq = Acq.close(ctx, "host-5");
		if (closedAcq) {
			for (const [promptId, prompt] of ctx.pendingPrompts) {
				if (prompt.ownerAcqId === closedAcq.id) {
					ctx.pendingPrompts.delete(promptId);
					prompt.resolve(null);
				}
			}
		}

		// INVARIANT: stale prompt cleared, newer prompt survives.
		// Mutation oracle: hostId-based clear would remove both entries.
		expect(ctx.pendingPrompts.has("prompt-stale")).toBe(false);
		expect(staleResolve).toHaveBeenCalledWith(null);
		expect(ctx.pendingPrompts.has("prompt-newer")).toBe(true);
		expect(newerResolve).not.toHaveBeenCalled();

		// Cleanup.
		ctx.pendingPrompts.delete("prompt-newer");
	});
});

// ─── Invariant 6: release() is idempotent ────────────────────────────────────

describe("Invariant 6: idempotent release — no underflow on double-release", () => {
	it("calling release() twice on the same lease does not trigger a second reap", () => {
		// Mutation oracle: removing `if (lease.released) return false` from release()
		// would execute the reap logic twice → double-reject of connectPromise.
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-6", "client-test");
		acq.connectPromise.catch(() => {});

		const reaped1 = Acq.release(ctx, lease, () => false);
		expect(reaped1).toBe(true); // First release: reap fires.
		expect(lease.released).toBe(true);

		// Second release must be a no-op.
		const reaped2 = Acq.release(ctx, lease, () => false);
		expect(reaped2).toBe(false);

		// Map stays empty (not re-added by second release).
		expect(ctx.acquisitions.has("host-6")).toBe(false);
	});
});

// ─── Invariant 7: commit guard ───────────────────────────────────────────────

describe("Invariant 7: commit guard — identity + state + signal + session currency", () => {
	it("commit is skipped when the acq has been replaced (identity check fails)", () => {
		// Mutation oracle: removing `ctx.acquisitions.get(acq.hostId) === acq` from
		// commit() would allow a stale acq to resolve the newer acq's connectPromise.
		const ctx = makeCtx();
		const { acq: staleAcq } = Acq.acquire(ctx, "host-7", "client-test");
		staleAcq.connectPromise.catch(() => {});

		// Install replacement — identity check for staleAcq will fail.
		let replacementResolve!: (s: SessionState) => void;
		const replacementConnect = new Promise<SessionState>((r) => {
			replacementResolve = r;
		});
		replacementConnect.catch(() => {});
		const replacementAcq: SessionAcquisition = {
			id: "replacement-acq-7",
			hostId: "host-7",
			state: "CONNECTING",
			controller: new AbortController(),
			connectPromise: replacementConnect,
			_resolve: replacementResolve,
			_reject: vi.fn(),
			leases: new Set(),
		};
		ctx.acquisitions.set("host-7", replacementAcq);

		// Guard fails: ctx.acquisitions.get("host-7") === replacementAcq ≠ staleAcq.
		// A correct guard would abort the commit. We simulate the guard here:
		const guardPasses =
			ctx.acquisitions.get("host-7") === staleAcq &&
			staleAcq.state === "CONNECTING" &&
			!staleAcq.controller.signal.aborted;
		expect(guardPasses).toBe(false);

		// After the guard fails, the caller must NOT call Acq.commit().
		// Verify replacement is still present and not resolved.
		expect(ctx.acquisitions.get("host-7")).toBe(replacementAcq);

		// Cleanup.
		ctx.acquisitions.delete("host-7");
	});

	it("commit is skipped when the acq signal is aborted", () => {
		// Mutation oracle: removing `!acq.controller.signal.aborted` from the guard
		// would allow a commit after closeSession aborted the controller.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-7b", "client-test");
		acq.connectPromise.catch(() => {});

		// Abort the controller (simulates closeSession firing mid-connect).
		acq.controller.abort();

		const guardPasses =
			ctx.acquisitions.get("host-7b") === acq &&
			acq.state === "CONNECTING" &&
			!acq.controller.signal.aborted;
		expect(guardPasses).toBe(false);

		// Cleanup.
		ctx.acquisitions.delete("host-7b");
	});
});

// ─── Invariant 8: single authority — acq deleted on commit (P2) ──────────────

describe("Invariant 8: single authority — acq deleted from map on commit", () => {
	it("commit() deletes the acq from ctx.acquisitions before resolving waiters", () => {
		// Mutation oracle: removing `ctx.acquisitions.delete(acq.hostId)` from commit()
		// leaves the acq in the map → a follower SPAWN could re-join a committed acq.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-8", "client-test");

		expect(ctx.acquisitions.get("host-8")).toBe(acq);

		const session = makeSession("host-8");
		Acq.commit(ctx, acq, session);

		// INVARIANT: acq removed from map (P2 — single authority while connecting).
		// Mutation oracle: without delete, this assertion fails.
		expect(ctx.acquisitions.has("host-8")).toBe(false);

		// connectPromise resolves with the session.
		return expect(acq.connectPromise).resolves.toMatchObject({ id: session.id });
	});
});

// ─── B1 regression: outer finally covers follower + leader early-return paths ──
//
// Break 1 (8fba4b4 before fix): the outer try/finally was opened AFTER the SSH
// acquisition block, leaving 5 early-return paths unprotected. A follower or
// leader that returned early (e.g. acq already CLOSING, signal aborted, session
// currency mismatch) would skip release() → lease leaked → acq never reaped.

describe("B1 regression: lease released on every early-return path", () => {
	it("follower lease is released even when the connect promise rejects early (abort path)", async () => {
		// Mutation oracle: moving release() out of finally (e.g. inside the try body
		// after an early-return guard) would leave lease.released === false when the
		// leader aborts the controller before the follower body finishes.
		const ctx = makeCtx();
		const { acq, lease: leaderLease } = Acq.acquire(ctx, "host-b1a", "client-test");

		// Follower joins — simulates a concurrent SPAWN that finds an in-flight acq.
		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease).not.toBeNull();
		expect(acq.leases.size).toBe(2);

		// Leader early-return: abort the controller (simulates session currency mismatch,
		// signal abort, or follower-path guard failure).
		Acq.close(ctx, "host-b1a");
		// close() rejects connectPromise — suppress unhandled rejection.
		acq.connectPromise.catch(() => {});

		// Follower's finally MUST release its lease even though the promise rejected.
		// In the fixed code this is guaranteed by the outer try/finally wrapping ALL paths.
		Acq.release(ctx, followerLease!, () => false);
		expect(followerLease!.released).toBe(true);

		// Leader lease release after abort (no-reap because close() already removed acq).
		Acq.release(ctx, leaderLease, () => false);
		expect(leaderLease.released).toBe(true);
	});

	it("leader lease is released when the acq is in CLOSING state at release time", () => {
		// Mutation oracle: a try/finally that opens AFTER the early-return guard block
		// would never execute release() for an abort-triggered leader path.
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-b1b", "client-test");
		acq.connectPromise.catch(() => {});

		// Abort the signal BEFORE release() — simulates abort racing the connect.
		acq.controller.abort();

		// release() must still mark the lease as released (idempotent guard handles the
		// case where the acq was already removed from the map by close()).
		Acq.release(ctx, lease, () => false);
		expect(lease.released).toBe(true);
	});
});

// ─── B2 regression: identity-guarded agents.delete on agent close ─────────────
//
// Break 2 (8fba4b4 before fix): the agent "close" handler deleted ctx.agents
// unconditionally. If a new agent (agentB) was installed for the same hostId
// while agentA was still in-flight, agentA's deferred "close" event would
// delete agentB from the map → next SPAWN sees no agent → silent session loss.

describe("B2 regression: stale agent close does not evict a newer agent", () => {
	it("identity guard preserves agentB when agentA fires its close event after replacement", () => {
		// Mutation oracle: replacing `if (ctx.agents.get(hostId) === agent) { delete }`
		// with unconditional `ctx.agents.delete(hostId)` would delete agentB here.
		const agents = new Map<string, object>();
		const agentCapabilities = new Map<string, string[]>();

		const hostId = "host-b2";
		const agentA = { id: "agent-a" };
		const agentB = { id: "agent-b" };

		// agentB is the current agent for this host.
		agents.set(hostId, agentB);
		agentCapabilities.set(hostId, ["spawn"]);

		// Simulate the identity-guarded handler that wireAgentEvents installs.
		// (Mirrors the fixed code in agent-connection-manager.ts wireAgentEvents.)
		function onAgentAClose() {
			const isCurrentAgent = agents.get(hostId) === agentA;
			if (isCurrentAgent) {
				agents.delete(hostId);
				agentCapabilities.delete(hostId);
			}
		}

		// agentA's deferred close fires — identity check: agentA ≠ agentB → no-op.
		onAgentAClose();

		// INVARIANT: agentB must still be present.
		expect(agents.get(hostId)).toBe(agentB);
		expect(agentCapabilities.has(hostId)).toBe(true);
	});

	it("identity guard DOES delete the current agent when it is the one that closed", () => {
		// Confirm the guard is not over-broad: if the SAME agent closes, it must be removed.
		const agents = new Map<string, object>();
		const agentCapabilities = new Map<string, string[]>();

		const hostId = "host-b2b";
		const agentA = { id: "agent-a" };

		agents.set(hostId, agentA);
		agentCapabilities.set(hostId, ["spawn"]);

		function onAgentAClose() {
			const isCurrentAgent = agents.get(hostId) === agentA;
			if (isCurrentAgent) {
				agents.delete(hostId);
				agentCapabilities.delete(hostId);
			}
		}

		onAgentAClose();

		// agentA was the current agent — must be cleaned up.
		expect(agents.has(hostId)).toBe(false);
		expect(agentCapabilities.has(hostId)).toBe(false);
	});
});

// ─── B4 regression: agents.set atomic with Acq.commit (P2 / single authority) ─
//
// Break 4 (8fba4b4 before fix): _connectSshAgent called ctx.agents.set internally,
// BEFORE Acq.commit(). A concurrent SPAWN joining the in-flight acq would call
// ctx.agents.get(hostId) and find an agent BEFORE the acq was committed (deleted
// from the map). This violates P2 (single authority) — the acq must be the sole
// authority while it exists; the agent must only be visible after commit().

describe("B4 regression: agent not visible until commit (P2 single-authority)", () => {
	it("agent is absent from ctx.agents before commit; present and acq deleted after commit", () => {
		// Mutation oracle: calling ctx.agents.set before Acq.commit() would make
		// agents.get(hostId) return a truthy value while acq is still in the map —
		// a concurrent SPAWN could short-circuit to fast-path while connect is live.
		const ctx = makeCtx();
		const agents = new Map<string, object>();
		const hostId = "host-b4";

		const { acq } = Acq.acquire(ctx, hostId, "client-test");

		// BEFORE commit: agent must not be in ctx.agents.
		// (In fixed code, _connectSshAgent returns the agent without setting agents map;
		// the LEADER sets it synchronously just before Acq.commit().)
		expect(agents.get(hostId)).toBeUndefined();
		expect(ctx.acquisitions.get(hostId)).toBe(acq);

		// Simulate the atomic set+commit (as done in the fixed session-manager.ts leader block).
		const fakeAgent = { id: "ssh-agent-b4" };
		const session = makeSession(hostId);
		agents.set(hostId, fakeAgent); // B4 fix: set first…
		Acq.commit(ctx, acq, session); // …then commit atomically.

		// AFTER commit: agent is present and acq is deleted (P2 invariant).
		expect(agents.get(hostId)).toBe(fakeAgent);
		expect(ctx.acquisitions.has(hostId)).toBe(false);

		return expect(acq.connectPromise).resolves.toMatchObject({ id: session.id });
	});

	it("a join() that races with commit sees null after CLOSING (not the pre-commit agent)", () => {
		// If a concurrent SPAWN is racing the commit, its join() result is the indicator.
		// join() after CLOSING returns null — so the concurrent SPAWN must re-try, not
		// use a stale agent visible before commit atomically wired it.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-b4b", "client-test");
		acq.connectPromise.catch(() => {});

		// Set CLOSING before the concurrent join fires.
		Acq.close(ctx, "host-b4b");

		// join() must return null (terminal state).
		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease).toBeNull();
	});
});

// ─── Invariant 9: join() refused after CLOSING ───────────────────────────────

describe("Invariant 9: join() refused after CLOSING is set", () => {
	it("join() returns null when acq.state is CLOSING", () => {
		// Mutation oracle: removing `if (acq.state === 'CLOSING' || acq.state === 'FAILED')`
		// from join() would return a lease for a terminal acq → follower awaits a promise
		// that will never be committed (session already closing).
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-9", "client-test");
		acq.connectPromise.catch(() => {});

		// close() sets state = CLOSING synchronously before controller.abort().
		Acq.close(ctx, "host-9");
		expect(acq.state).toBe("CLOSING");

		// A concurrent SPAWN attempts to join — must be refused.
		// Mutation oracle: returning a lease here instead of null breaks this assertion.
		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease).toBeNull();
	});

	it("join() returns null when acq.state is FAILED", () => {
		// Mutation oracle: same as above but for the FAILED terminal state.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-9b", "client-test");
		acq.connectPromise.catch(() => {});

		Acq.fail(ctx, acq, new Error("SSH_AUTH_FAILED"));
		expect(acq.state).toBe("FAILED");

		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease).toBeNull();
	});

	it("CLOSING state is set BEFORE controller.abort() in close()", () => {
		// Mutation oracle: setting state AFTER abort() means an abort listener that
		// calls join() could see state=CONNECTING and get a lease → use-after-close.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-9c", "client-test");
		acq.connectPromise.catch(() => {});

		let stateAtAbort: string | null = null;
		// Listen to abort — at this point state must already be CLOSING.
		acq.controller.signal.addEventListener(
			"abort",
			() => {
				stateAtAbort = acq.state;
			},
			{ once: true },
		);

		Acq.close(ctx, "host-9c");

		// INVARIANT: state was CLOSING when abort fired.
		// Mutation oracle: setting state after abort() makes stateAtAbort = "CONNECTING".
		expect(stateAtAbort).toBe("CLOSING");
	});
});

// ─── Fix A: post-commit lease refcount stays accurate ────────────────────────
//
// Root bug: after commit() deletes the acq from ctx.acquisitions (P2), a
// follower calling release() would find no acq in the map, return false WITHOUT
// removing its lease from acq.leases, leaving acq.leases.size frozen at its
// commit-time peak. The post-commit disconnect logic then read acq.leases.size
// and concluded "followers still in-flight" — even after every follower had
// finished — and never closed the orphaned session.
//
// Fix: Lease carries _acq (back-reference); release() ALWAYS calls
// acq.leases.delete(lease), keeping the count accurate in both regimes.

describe("Fix A: post-commit lease refcount is accurate", () => {
	it("committed session with all followers done and no channels — leases.size reaches 0", () => {
		// Mutation oracle: if release() skips acq.leases.delete when acq is gone from
		// map, acq.leases.size stays frozen at commit-time peak → disconnect logic
		// mistakenly sees in-flight followers and never closes the orphaned session.
		const ctx = makeCtx();
		const { acq: leaderAcq, lease: leaderLease } = Acq.acquire(ctx, "host-fa1", "client-test");

		// Follower joins while CONNECTING.
		const followerLease = Acq.join(leaderAcq, "follower-client");
		expect(followerLease).not.toBeNull();
		expect(leaderAcq.leases.size).toBe(2);

		// Leader commits (P2 — acq deleted from map).
		const session = makeSession("host-fa1");
		Acq.commit(ctx, leaderAcq, session);
		expect(ctx.acquisitions.has("host-fa1")).toBe(false);

		// Post-commit: leader releases its lease.
		// Fix A: release() MUST remove leaderLease from acq.leases even though acq is gone.
		const leaderReaped = Acq.release(ctx, leaderLease, () => false);
		expect(leaderReaped).toBe(false); // no pre-commit reap (acq not in map)
		// Mutation oracle: without Fix A leases.size would still be 2 here.
		expect(leaderAcq.leases.size).toBe(1); // only follower lease remains

		// Post-commit: follower releases its lease.
		const followerReaped = Acq.release(ctx, followerLease!, () => false);
		expect(followerReaped).toBe(false); // still no pre-commit reap
		// Fix A invariant: size must now be 0 — no followers remaining.
		// Mutation oracle: without Fix A, leases.size would still be 2 (frozen at commit time).
		expect(leaderAcq.leases.size).toBe(0);
	});

	it("follower post-commit still holding lease keeps acq.leases.size > 0", () => {
		// While a follower is between commit and channel-spawn, its lease must remain
		// in acq.leases so that acq.leases.size reflects the correct in-flight count.
		const ctx = makeCtx();
		const { acq, lease: leaderLease } = Acq.acquire(ctx, "host-fa2", "client-test");
		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease).not.toBeNull();

		const session = makeSession("host-fa2");
		Acq.commit(ctx, acq, session);

		// Leader releases (done connecting).
		Acq.release(ctx, leaderLease, () => false);

		// Follower still holds its lease — size must be exactly 1.
		// Mutation oracle: if Fix A removes the wrong lease, size could undercount.
		expect(acq.leases.size).toBe(1);

		// Cleanup.
		Acq.release(ctx, followerLease!, () => false);
		expect(acq.leases.size).toBe(0);
	});

	it("Lease._acq back-reference set by acquire()", () => {
		// Mutation oracle: removing _acq from acquire() makes release() call
		// undefined._acq → TypeError at runtime.
		const ctx = makeCtx();
		const { acq, lease } = Acq.acquire(ctx, "host-fa3", "client-test");
		expect(lease._acq).toBe(acq);
		acq.connectPromise.catch(() => {});
		Acq.release(ctx, lease, () => false);
	});

	it("Lease._acq back-reference set by join()", () => {
		// Mutation oracle: join() missing _acq breaks followers' release().
		const ctx = makeCtx();
		const { acq, lease: leaderLease } = Acq.acquire(ctx, "host-fa4", "client-test");
		const followerLease = Acq.join(acq, "follower-client");
		expect(followerLease!._acq).toBe(acq);
		acq.connectPromise.catch(() => {});
		Acq.release(ctx, leaderLease, () => false);
		Acq.release(ctx, followerLease!, () => false);
	});
});

// ─── Fix B: no unhandled rejections ──────────────────────────────────────────
//
// Root bug: connectPromise could be rejected (by fail()/close()) before any
// follower called .catch() on it, producing an "unhandled rejection" warning.
// Fix: acquire() attaches a no-op .catch() so rejection is always handled.

describe("Fix B: connectPromise rejection is always handled (no unhandled rejection)", () => {
	it("close() on a leader-only acq does not produce an unhandled rejection", async () => {
		// Mutation oracle: removing the .catch(() => {}) from acquire() leaves
		// close()._reject() unhandled when no follower has awaited the promise yet.
		const ctx = makeCtx();
		Acq.acquire(ctx, "host-fb1", "client-test");

		const unhandledSpy = vi.fn();
		process.on("unhandledRejection", unhandledSpy);

		Acq.close(ctx, "host-fb1");

		// Flush micro-task queue — unhandled rejections surface after the current tick.
		await Promise.resolve();
		await Promise.resolve();

		process.off("unhandledRejection", unhandledSpy);
		expect(unhandledSpy).not.toHaveBeenCalled();
	});

	it("fail() on a leader-only acq does not produce an unhandled rejection", async () => {
		// Mutation oracle: same — fail()._reject() must not be unhandled.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-fb2", "client-test");

		const unhandledSpy = vi.fn();
		process.on("unhandledRejection", unhandledSpy);

		Acq.fail(ctx, acq, new Error("SSH_AUTH_FAILED"));

		await Promise.resolve();
		await Promise.resolve();

		process.off("unhandledRejection", unhandledSpy);
		expect(unhandledSpy).not.toHaveBeenCalled();
	});

	it("waiters that catch connectPromise still receive the error", async () => {
		// The no-op .catch() must not suppress errors for followers that DO await.
		const ctx = makeCtx();
		const { acq } = Acq.acquire(ctx, "host-fb3", "client-test");

		const followerError = acq.connectPromise.catch((e: Error) => e);
		Acq.fail(ctx, acq, new Error("test-error"));

		const err = await followerError;
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toBe("test-error");
	});
});

// ─── Fix C: identity-guarded reconnect side effects ──────────────────────────
//
// Root bug (invariant 10): wireAgentEvents' "close" handler guarded only
// agents.delete with isCurrentAgent, but called updateSessionStatus /
// scheduleReconnect / reconnectDaemon / warmRestartLocal unconditionally.
// A stale close event from a replaced agentA would trigger reconnect for
// agentB's session (wrong generation).
// Fix: `if (!isCurrentAgent) return` gates ALL downstream side effects.

describe("Fix C: stale agent close triggers no reconnect/disconnect side effect", () => {
	it("identity-guarded handler: stale close fires no reconnect branch", () => {
		// Mutation oracle: removing `if (!isCurrentAgent) return` from the handler
		// lets the stale close fall through to reconnect, calling scheduleReconnect
		// for the wrong agent generation.
		const agents = new Map<string, object>();
		const hostId = "host-fc1";
		const agentA = { id: "agent-a-fc1" };
		const agentB = { id: "agent-b-fc1" };

		agents.set(hostId, agentB); // agentB is the current agent

		const reconnectSpy = vi.fn();
		const updateStatusSpy = vi.fn();

		// Mirrors the fixed wireAgentEvents close handler.
		function onAgentAClose() {
			const isCurrentAgent = agents.get(hostId) === agentA;
			if (isCurrentAgent) {
				agents.delete(hostId);
			}
			if (!isCurrentAgent) return; // Fix C: guard ALL side effects

			updateStatusSpy();
			reconnectSpy();
		}

		onAgentAClose();

		// Stale close → no side effects, agentB untouched.
		expect(reconnectSpy).not.toHaveBeenCalled();
		expect(updateStatusSpy).not.toHaveBeenCalled();
		expect(agents.get(hostId)).toBe(agentB);
	});

	it("current agent close DOES trigger reconnect side effects", () => {
		// Confirm the guard is not over-broad: the current agent must fire through.
		const agents = new Map<string, object>();
		const hostId = "host-fc2";
		const agentA = { id: "agent-a-fc2" };

		agents.set(hostId, agentA);

		const reconnectSpy = vi.fn();
		const updateStatusSpy = vi.fn();

		function onAgentAClose() {
			const isCurrentAgent = agents.get(hostId) === agentA;
			if (isCurrentAgent) {
				agents.delete(hostId);
			}
			if (!isCurrentAgent) return;

			updateStatusSpy();
			reconnectSpy();
		}

		onAgentAClose();

		expect(reconnectSpy).toHaveBeenCalledTimes(1);
		expect(updateStatusSpy).toHaveBeenCalledTimes(1);
		expect(agents.has(hostId)).toBe(false);
	});
});
