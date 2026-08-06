/**
 * session-acquisition.ts — Session-acquisition state machine primitives.
 *
 * Implements the P1/P2/P3 design from docs/plans/session-acquisition-redesign.md.
 *
 * Six synchronous primitives (acquire, join, commit, fail, release, close) +
 * shutdownAll. Every state mutation is a synchronous check-and-mutate block —
 * no await between reading state and writing it. JS is single-threaded, so
 * synchronous blocks are atomic; interleaving happens only at explicit await
 * boundaries in callers.
 *
 * Reconnect integration (invariant 10) will slot in as a RECONNECTING generation:
 * the caller creates a new acquisition with state "RECONNECTING" (same shape,
 * same primitives), giving it its own AbortController. commit/fail/release/close
 * work identically on RECONNECTING acqs. No rework required in this module.
 */

import { generateId } from "@lasterm/shared";
import type {
	Lease,
	SessionAcquisition,
	SessionState,
	SharedSessionContext,
} from "./session-context.js";

// ─── acquire ─────────────────────────────────────────────────────────────────

/**
 * Create a new SessionAcquisition for hostId and return the leader's Lease.
 *
 * P1: synchronous — called BEFORE any await in handleSpawn; the caller must
 *     store the returned acq in ctx.acquisitions BEFORE the first await.
 * P2: caller must verify !ctx.acquisitions.has(hostId) && !liveSession BEFORE
 *     calling (ensures single authority).
 *
 * Invariant 1: the returned Lease keeps the refcount ≥ 1 until release() is called.
 * Invariant 8: acq is the sole authority while CONNECTING.
 */
export function acquire(
	ctx: Pick<SharedSessionContext, "acquisitions">,
	hostId: string,
	clientId: string,
): { acq: SessionAcquisition; lease: Lease } {
	let _resolve!: (s: SessionState) => void;
	let _reject!: (e: Error) => void;
	const connectPromise = new Promise<SessionState>((res, rej) => {
		_resolve = res;
		_reject = rej;
	});

	const acq: SessionAcquisition = {
		id: generateId(),
		hostId,
		state: "CONNECTING",
		controller: new AbortController(),
		connectPromise,
		_resolve,
		_reject,
		leases: new Set(),
	};
	// Fix B: attach a no-op .catch() so that reject() calls from fail()/close()
	// before any follower awaits the promise never produce an unhandled rejection.
	connectPromise.catch(() => {});

	const lease: Lease = {
		id: generateId(),
		hostId,
		acqId: acq.id,
		clientId,
		released: false,
		_acq: acq, // Fix A: back-reference so release() can decrement post-commit
	};

	acq.leases.add(lease);
	// P1: caller stores in ctx.acquisitions synchronously before any await.
	ctx.acquisitions.set(hostId, acq);
	return { acq, lease };
}

// ─── join ─────────────────────────────────────────────────────────────────────

/**
 * A follower joins an existing acquisition and gets a Lease.
 *
 * Returns null if the acq is CLOSING or FAILED — caller must behave as a
 * fresh leader (create a new acq once the terminal one is removed).
 *
 * Invariant 9: join refused once CLOSING/FAILED (state flip precedes async teardown).
 * Invariant 1: the returned Lease keeps refcount ≥ 1 until release().
 */
export function join(acq: SessionAcquisition, clientId: string): Lease | null {
	// P1: synchronous state check — if terminal, refuse.
	if (acq.state === "CLOSING" || acq.state === "FAILED") {
		return null;
	}
	const lease: Lease = {
		id: generateId(),
		hostId: acq.hostId,
		acqId: acq.id,
		clientId,
		released: false,
		_acq: acq, // Fix A: back-reference so release() can decrement post-commit
	};
	acq.leases.add(lease);
	return lease;
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * Commit a successful connect: wire the session, delete the acq (P2), resolve waiters.
 *
 * The caller MUST verify the guard synchronously before calling:
 *   ctx.acquisitions.get(hostId) === acq
 *   && acq.state === "CONNECTING"
 *   && !acq.controller.signal.aborted
 *   && ctx.sessions.get(hostId)?.id === session.id   (session still current)
 *
 * If the guard fails, the caller must tear down the just-built agent and reject
 * instead. This prevents double-resolve and revival of a closed session.
 *
 * Invariant 7: single sync guarded step; invariant 8: acq deleted → P2.
 */
export function commit(
	ctx: Pick<SharedSessionContext, "acquisitions">,
	acq: SessionAcquisition,
	session: SessionState,
): void {
	// P1: synchronous — no await here.
	// Delete first so a follower that gets scheduled immediately sees no acq (P2).
	if (ctx.acquisitions.get(acq.hostId) === acq) {
		ctx.acquisitions.delete(acq.hostId);
	}
	acq._resolve(session);
}

// ─── fail ─────────────────────────────────────────────────────────────────────

/**
 * Mark the acquisition as FAILED, remove it from the map, reject waiters.
 * Called when the SSH connect fails (not aborted — use close() for intentional abort).
 *
 * Invariant 9: state flip (FAILED) precedes async teardown in caller.
 */
export function fail(
	ctx: Pick<SharedSessionContext, "acquisitions">,
	acq: SessionAcquisition,
	err: Error,
): void {
	// P1: synchronous state transition.
	acq.state = "FAILED";
	if (ctx.acquisitions.get(acq.hostId) === acq) {
		ctx.acquisitions.delete(acq.hostId);
	}
	acq._reject(err);
}

// ─── release ─────────────────────────────────────────────────────────────────

/**
 * Release a lease (idempotent — per-lease `released` flag).
 *
 * Fix A: uses `lease._acq` (back-reference set by acquire/join) to ALWAYS
 * remove the lease from acq.leases, even after commit() has deleted the acq
 * from ctx.acquisitions (P2). This keeps the refcount accurate in both regimes:
 *   - Pre-commit: standard reap path (leases.size===0 && no channels → CLOSING).
 *   - Post-commit: acq is gone from map; we still decrement leases.size so the
 *     caller's post-commit close decision (`acq.leases.size === 0`) is accurate.
 *
 * The `hasChannels` callback lets the caller check live channel presence without
 * coupling this module to the channels Map.
 *
 * Invariant 3: reap uses lease count, not channel-presence alone.
 * Invariant 6: idempotent; no underflow.
 * Invariant 9: state=CLOSING set BEFORE controller.abort() (joins refused from here on).
 *
 * @returns true if a pre-commit reap was triggered (acq aborted)
 */
export function release(
	ctx: Pick<SharedSessionContext, "acquisitions">,
	lease: Lease,
	hasChannels: () => boolean,
): boolean {
	// P1 + invariant 6: idempotent guard.
	if (lease.released) return false;
	lease.released = true;

	// Fix A: always remove from the set via the back-reference — this keeps
	// acq.leases.size accurate regardless of whether the acq is still in the map.
	const acq = lease._acq;
	acq.leases.delete(lease);

	// Check whether this acq is still the current authority for the host.
	const inMap = ctx.acquisitions.get(lease.hostId) === acq;

	if (!inMap) {
		// Acq was committed (P2) or already reaped — no pre-commit reap to trigger.
		// The caller is responsible for the post-commit close decision using acq.leases.size.
		return false;
	}

	if (acq.leases.size === 0 && !hasChannels()) {
		// Reap: P1 — synchronous state flip BEFORE abort.
		// Invariant 9: CLOSING is set here so concurrent join() calls see the terminal state.
		acq.state = "CLOSING";
		if (ctx.acquisitions.get(lease.hostId) === acq) {
			ctx.acquisitions.delete(lease.hostId);
		}
		acq.controller.abort();
		acq._reject(new Error("session abandoned: all spawn intents released with no channels"));
		return true;
	}
	return false;
}

// ─── close ────────────────────────────────────────────────────────────────────

/**
 * Explicitly close/abort a host's in-flight acquisition (from closeSession or shutdown).
 * Does NOT consume leases — callers' finally blocks still call release() harmlessly.
 *
 * Invariant 4: prompts are cleared by ownerAcqId — pass the acqId to the caller
 *              for clearing pendingPrompts (this module does not hold that ref).
 * Invariant 9: state=CLOSING set BEFORE controller.abort().
 *
 * @returns the acq that was closed, or null if no matching acq found.
 */
export function close(
	ctx: Pick<SharedSessionContext, "acquisitions">,
	hostId: string,
): SessionAcquisition | null {
	const acq = ctx.acquisitions.get(hostId);
	if (!acq) return null;

	// P1: synchronous state flip BEFORE abort.
	acq.state = "CLOSING";
	if (ctx.acquisitions.get(hostId) === acq) {
		ctx.acquisitions.delete(hostId);
	}
	acq.controller.abort();
	acq._reject(new Error("session closed"));
	return acq;
}

// ─── shutdownAll ──────────────────────────────────────────────────────────────

/**
 * Close all in-flight acquisitions (called by SessionManager.shutdown()).
 * After this call ctx.acquisitions is empty.
 *
 * Invariant spec §shutdown: for each acq: set CLOSING, abort, reject waiters;
 * then clear acquisitions + all prompts.
 */
export function shutdownAll(
	ctx: Pick<SharedSessionContext, "acquisitions" | "pendingPrompts">,
): void {
	for (const acq of ctx.acquisitions.values()) {
		acq.state = "CLOSING";
		acq.controller.abort();
		acq._reject(new Error("hub shutting down"));
	}
	ctx.acquisitions.clear();
	// Pending prompts are cleared by the caller (shutdown) along with other maps.
}
