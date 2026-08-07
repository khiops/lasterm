/**
 * prompt-context.ts — PromptContext model operations.
 *
 * Free functions over a Pick<SharedSessionContext, …> slice (mirrors session-acquisition.ts style).
 *
 * Design: docs/plans/prompt-routing-redesign.md
 *
 * Key principles:
 *   P1: All critical-section mutations are synchronous — no await between read and write.
 *   Guard A: store-before-send in one synchronous block; on send failure, clear immediately.
 *   Guard B: CLOSED flag checked before any send or respond; post-close ignored.
 *   Guard C: deterministic route chooser (stable sort by lease id, not Map/Set iteration).
 *   Guard D: deliveryEpoch per prompt; respond accepts only matching (clientId, epoch).
 *   Guard F: clearContext is idempotent and called from terminal paths only.
 */

import { generateId } from "@lasterm/shared";
import type {
	ElevationPromptOwner,
	PromptContext,
	SharedSessionContext,
} from "./session-context.js";
import type { WsClient } from "./session-manager.js";

// ── Context slice accepted by all operations ──────────────────────────────────

/**
 * Minimal ctx slice needed by the prompt-context operations.
 * Defined explicitly (not via Pick) so promptContexts and promptIndex are
 * always present for production code and test slices.
 */
export interface PromptCtxSlice {
	promptContexts: Map<string, PromptContext>;
	elevationPromptOwners?: Map<string, ElevationPromptOwner>;
	promptIndex: Map<string, string>;
	pendingPrompts: SharedSessionContext["pendingPrompts"];
	clients: Map<string, WsClient>;
	channels?: SharedSessionContext["channels"];
	acquisitions: SharedSessionContext["acquisitions"];
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** In-flight prompt entry tracked internally per context. */
interface InFlightPrompt {
	readonly contextId: string;
	readonly type: "passphrase" | "host_verify" | "agent_verify" | "elevation";
	/** Monotonic counter — incremented on every (re)send / retarget. */
	deliveryEpoch: number;
	/** Timer for 120 s timeout (resolved null on expiry). */
	timer: ReturnType<typeof setTimeout> | null;
	/** Resolve function for the promise returned by prompt(). */
	resolve: (value: unknown) => void;
	/** Payload to re-send on retarget. */
	resendPayload: unknown;
}

/** Internal registry: promptId → InFlightPrompt. Module-private. */
const _inFlight = new Map<string, InFlightPrompt>();

/** Prompt timeout: 120 seconds (matches existing prompt timeout). */
const PROMPT_TIMEOUT_MS = 120_000;
const RECONNECT_CONTEXT_PREFIX = "reconnect:";

export function reconnectContextId(sessionId: string): string {
	return `${RECONNECT_CONTEXT_PREFIX}${sessionId}`;
}

export function isReconnectContextId(contextId: string): boolean {
	return contextId.startsWith(RECONNECT_CONTEXT_PREFIX);
}

export function reconnectSessionId(contextId: string): string | null {
	if (!isReconnectContextId(contextId)) return null;
	return contextId.slice(RECONNECT_CONTEXT_PREFIX.length);
}

// ── Operations ────────────────────────────────────────────────────────────────

/**
 * openContext — create and store a new PromptContext.
 *
 * @param ctx        ctx slice with promptContexts.
 * @param kind       "session" | "test" | "elevation"
 * @param hostId     The host this context belongs to.
 * @param routeClientId  Initial client that receives prompts.
 * @param acqId      For "session" kind: use acqId as the context id (stable).
 *                   For other kinds: pass undefined → a fresh ULID is generated.
 */
export function openContext(
	ctx: Pick<PromptCtxSlice, "promptContexts">,
	kind: PromptContext["kind"],
	hostId: string,
	routeClientId: string,
	acqId?: string,
): PromptContext {
	const id = kind === "session" && acqId ? acqId : generateId();
	const context: PromptContext = {
		id,
		kind,
		hostId,
		routeClientId,
		state: "OPEN",
		prompts: new Set(),
	};
	ctx.promptContexts.set(id, context);
	return context;
}

/**
 * prompt — issue a new prompt within a context.
 *
 * Guard A: store-before-send in one synchronous critical section. On send
 * failure the prompt is immediately cleaned up (no orphaned entry).
 * Guard B: context must be OPEN; rejected if absent or CLOSED.
 *
 * @param timeoutMs  Optional per-prompt timeout in ms. Defaults to PROMPT_TIMEOUT_MS (120s).
 *                   Pass a shorter value for prompt types that originally had tighter timeouts
 *                   (e.g. host-key verify and agent-binary verify both used 30s on origin/main).
 * @returns Promise resolved by respond() with the user's answer, or null on
 *          timeout / clearContext / send failure.
 */
export function prompt(
	ctx: PromptCtxSlice,
	contextId: string,
	type: "passphrase" | "host_verify" | "agent_verify" | "elevation",
	payload: unknown,
	send: (clientId: string, msg: Record<string, unknown>) => void,
	timeoutMs?: number,
): Promise<unknown> | null {
	// Guard B: re-read context and check CLOSED before doing anything.
	const context = ctx.promptContexts.get(contextId);
	if (!context || context.state === "CLOSED") {
		return null;
	}

	let { routeClientId } = context;
	if (!ctx.clients.has(routeClientId)) {
		const candidate = pickRouteCandidate(ctx, contextId, routeClientId);
		if (!candidate) {
			clearContext(ctx, contextId, send);
			return null;
		}
		context.routeClientId = candidate;
		routeClientId = candidate;
	}

	// Guard A: create promptId and deliveryEpoch synchronously.
	const promptId = generateId();
	const deliveryEpoch = 1;

	// Storage: insert into all three maps BEFORE sending.
	let _resolve!: (value: unknown) => void;
	const promise = new Promise<unknown>((res) => {
		_resolve = res;
	});

	const inFlight: InFlightPrompt = {
		contextId,
		type,
		deliveryEpoch,
		timer: null,
		resolve: _resolve,
		resendPayload: payload,
	};

	// Insert into context set + promptIndex + pendingPrompts BEFORE sending.
	context.prompts.add(promptId);
	ctx.promptIndex.set(promptId, contextId);
	ctx.pendingPrompts.set(promptId, {
		ownerAcqId: contextId,
		hostId: context.hostId,
		timer: null, // managed by _inFlight below
		resolve: _resolve,
		clientId: routeClientId,
		promptId,
		contextId,
		type,
		deliveryEpoch,
		resendPayload: payload,
	});
	_inFlight.set(promptId, inFlight);

	// Arm timeout (caller-supplied or 120 s default).
	const timer = setTimeout(() => {
		_clearPrompt(ctx, promptId);
		_resolve(null);
	}, timeoutMs ?? PROMPT_TIMEOUT_MS);
	inFlight.timer = timer;
	// Keep pendingPrompts in sync with the timer ref.
	const pending = ctx.pendingPrompts.get(promptId);
	if (pending) {
		// The timer field on PendingPrompt is readonly, but we need to update it.
		// Use a cast — this is the sole write point.
		(pending as { timer: ReturnType<typeof setTimeout> | null }).timer = timer;
	}

	// Guard A: send AFTER all storage is committed.
	try {
		send(routeClientId, {
			...(payload as Record<string, unknown>),
			promptId,
			deliveryEpoch,
		});
	} catch {
		// Guard A: send failure → clean up immediately; do not leave an orphan.
		_clearPrompt(ctx, promptId);
		_resolve(null);
	}

	return promise;
}

/**
 * respond — handle a response from a client.
 *
 * Guard B: ignored if the context is CLOSED.
 * Guard D + SEC-003: accept only if clientId === context.routeClientId
 *   AND deliveryEpoch matches. Reject stale/rogue senders.
 *
 * @returns true if accepted, false if rejected (stale epoch, wrong client, unknown prompt).
 */
export function respond(
	ctx: PromptCtxSlice,
	promptId: string,
	clientId: string,
	deliveryEpoch: number | undefined,
	value: unknown,
): boolean {
	const contextId = ctx.promptIndex.get(promptId);
	if (!contextId) return false;

	const context = ctx.promptContexts.get(contextId);
	if (!context) return false;

	// Guard B: ignore if CLOSED.
	if (context.state === "CLOSED") {
		return false;
	}

	const inFlight = _inFlight.get(promptId);
	if (!inFlight) return false;

	// SEC-003: always enforce that the responder is the current route client.
	if (clientId !== context.routeClientId) {
		return false;
	}

	// Guard D: enforce epoch match only when the caller provides a defined epoch.
	// Back-compat: the web client does not echo deliveryEpoch yet (that lands in a
	// later step when @lasterm/web echoes promptId+deliveryEpoch). Until then, callers
	// that cannot supply an epoch pass undefined and we skip the epoch check while
	// still enforcing the SEC-003 clientId check above.
	if (deliveryEpoch !== undefined && deliveryEpoch !== inFlight.deliveryEpoch) {
		return false;
	}

	// Accept: resolve + clean up.
	const resolve = inFlight.resolve;
	_clearPrompt(ctx, promptId);
	resolve(value);
	return true;
}

/**
 * retarget — change the route for a context and re-send all in-flight prompts.
 *
 * Guard B: no-op if CLOSED.
 * Guard C: caller is responsible for choosing newRouteClientId deterministically
 *   (use pickRouteCandidate).
 *
 * Each in-flight prompt gets an incremented deliveryEpoch so old responses
 * from the previous route are rejected by respond() (guard D).
 *
 * PROMPT_CANCEL: sends PROMPT_CANCEL to the OLD route before re-sending to the
 * new route so the old client's dialog dismisses automatically.
 */
export function retarget(
	ctx: PromptCtxSlice,
	contextId: string,
	newRouteClientId: string,
	send: (clientId: string, msg: Record<string, unknown>) => void,
): void {
	const context = ctx.promptContexts.get(contextId);
	// Guard B: no-op if absent or CLOSED.
	if (!context || context.state === "CLOSED") return;
	if (context.kind !== "session") return;

	const oldRouteClientId = context.routeClientId;

	// Mutate route (single place).
	context.routeClientId = newRouteClientId;

	// Re-send each in-flight prompt with incremented epoch.
	for (const promptId of context.prompts) {
		const inFlight = _inFlight.get(promptId);
		if (!inFlight) continue;

		inFlight.deliveryEpoch += 1;

		// Update pendingPrompts clientId + epoch.
		const pending = ctx.pendingPrompts.get(promptId);
		if (pending) {
			pending.clientId = newRouteClientId;
			if (pending.deliveryEpoch !== undefined) {
				(pending as { deliveryEpoch: number }).deliveryEpoch = inFlight.deliveryEpoch;
			}
		}

		// PROMPT_CANCEL: dismiss the dialog on the old route before re-sending to new route.
		if (oldRouteClientId !== newRouteClientId) {
			try {
				send(oldRouteClientId, { type: "PROMPT_CANCEL", promptId });
			} catch {
				// Best-effort — old route may already be gone.
			}
		}

		try {
			send(newRouteClientId, {
				...(inFlight.resendPayload as Record<string, unknown>),
				promptId,
				deliveryEpoch: inFlight.deliveryEpoch,
			});
		} catch {
			// Send failed — fall through; caller should handle via clientDisconnect.
		}
	}
}

/**
 * clearContext — terminal cleanup for a context.
 *
 * Guard B + F: sets state=CLOSED synchronously before any other work.
 * Idempotent: safe to call multiple times (no-op if absent or already CLOSED).
 * All in-flight prompts are resolved with null and removed from all maps.
 *
 * PROMPT_CANCEL: if `send` is provided and a prompt was already sent to the route
 * client (i.e. an in-flight prompt exists), sends PROMPT_CANCEL so the dialog
 * dismisses on the client side.
 *
 * @param send  Optional WS send callback. If provided, sends PROMPT_CANCEL for
 *              each in-flight prompt before resolving null.
 */
export function clearContext(
	ctx: PromptCtxSlice,
	contextId: string,
	send?: (clientId: string, msg: Record<string, unknown>) => void,
): void {
	const context = ctx.promptContexts.get(contextId);
	// Guard F: idempotent — no-op if absent or already CLOSED.
	if (!context || context.state === "CLOSED") return;

	const routeClientId = context.routeClientId;

	// Guard B: set CLOSED synchronously before touching any prompts.
	context.state = "CLOSED";

	// Clear all in-flight prompts.
	for (const promptId of [...context.prompts]) {
		const inFlight = _inFlight.get(promptId);
		const resolve = inFlight?.resolve;

		// PROMPT_CANCEL: dismiss the dialog on the route client.
		if (send) {
			try {
				send(routeClientId, { type: "PROMPT_CANCEL", promptId });
			} catch {
				// Best-effort — client may already be gone.
			}
		}

		_clearPrompt(ctx, promptId);
		resolve?.(null);
	}

	// Delete the context itself.
	ctx.promptContexts.delete(contextId);
	ctx.elevationPromptOwners?.delete(contextId);
}

export function trackElevationContext(
	ctx: Pick<PromptCtxSlice, "elevationPromptOwners">,
	contextId: string,
	owner: ElevationPromptOwner,
): void {
	if (!ctx.elevationPromptOwners) {
		ctx.elevationPromptOwners = new Map();
	}
	ctx.elevationPromptOwners.set(contextId, owner);
}

export function clearElevationContextsForSession(
	ctx: PromptCtxSlice,
	sessionId: string,
	send?: (clientId: string, msg: Record<string, unknown>) => void,
): void {
	clearElevationContextsWhere(ctx, (owner) => owner.sessionId === sessionId, send);
}

export function clearElevationContextsForChannel(
	ctx: PromptCtxSlice,
	channelId: string,
	send?: (clientId: string, msg: Record<string, unknown>) => void,
): void {
	clearElevationContextsWhere(ctx, (owner) => owner.channelId === channelId, send);
}

/**
 * pickRouteCandidate — deterministic route chooser (guard C).
 *
 * Returns the lexicographically-smallest (oldest ULID = earliest creation)
 * live lease-holder with a connected socket for the context's host,
 * excluding `excludeClientId`.
 *
 * ULID lexicographic order is monotonically increasing with time, so the
 * smallest ULID is the lease created first — avoids Map/Set nondeterminism.
 *
 * Returns null if no suitable candidate exists.
 */
export function pickRouteCandidate(
	ctx: PromptCtxSlice,
	contextId: string,
	excludeClientId: string,
): string | null {
	const context = ctx.promptContexts.get(contextId);
	if (!context) return null;
	if (context.kind !== "session") return null;

	if (isReconnectContextId(context.id)) {
		const sessionId = reconnectSessionId(context.id);
		if (!sessionId) return null;
		return pickReconnectRouteCandidate(ctx, context.hostId, sessionId, excludeClientId);
	}

	// Collect all live lease-holder clientIds for this host.
	const candidates: string[] = [];
	for (const acq of ctx.acquisitions.values()) {
		if (acq.hostId !== context.hostId) continue;
		for (const lease of acq.leases) {
			if (lease.clientId === excludeClientId) continue;
			if (lease.released) continue;
			if (!ctx.clients.has(lease.clientId)) continue;
			candidates.push(lease.clientId);
		}
	}

	if (candidates.length === 0) return null;

	// Guard C: deterministic — sort by clientId (ULID: lex = time order).
	candidates.sort();
	return candidates[0] ?? null;
}

export function pickReconnectRouteCandidate(
	ctx: Pick<PromptCtxSlice, "channels" | "clients">,
	hostId: string,
	sessionId: string,
	excludeClientId?: string,
): string | null {
	if (!ctx.channels) return null;

	const candidates = new Set<string>();
	for (const channel of ctx.channels.values()) {
		if (channel.hostId !== hostId) continue;
		if (channel.sessionId !== sessionId) continue;
		if (channel.status === "dead") continue;

		for (const clientId of channel.clients) {
			if (clientId === excludeClientId) continue;
			if (!ctx.clients.has(clientId)) continue;
			candidates.add(clientId);
		}
	}

	const sorted = [...candidates].sort();
	return sorted[0] ?? null;
}

/**
 * clientDisconnect — handle a client going away.
 *
 * For each context whose routeClientId === clientId:
 *   - "session": if a live candidate exists, retarget; otherwise clear.
 *   - "test" / "elevation": clear; these contexts are owned by one operation
 *     and must never move to an unrelated client.
 */
export function clientDisconnect(
	ctx: PromptCtxSlice,
	clientId: string,
	send: (clientId: string, msg: Record<string, unknown>) => void,
): void {
	// Snapshot context ids to iterate safely (retarget/clearContext may mutate the map).
	const contextIds = [...ctx.promptContexts.keys()];
	for (const contextId of contextIds) {
		const context = ctx.promptContexts.get(contextId);
		if (!context || context.state === "CLOSED") continue;
		if (context.routeClientId !== clientId) continue;

		if (context.kind !== "session") {
			clearContext(ctx, contextId, send);
			continue;
		}

		const candidate = pickRouteCandidate(ctx, contextId, clientId);
		if (candidate) {
			retarget(ctx, contextId, candidate, send);
		} else {
			clearContext(ctx, contextId, send);
		}
	}
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * _clearPrompt — remove a single prompt from all tracking maps.
 * Does NOT resolve the promise — caller is responsible.
 */
function _clearPrompt(
	ctx: Pick<PromptCtxSlice, "promptContexts" | "promptIndex" | "pendingPrompts">,
	promptId: string,
): void {
	const inFlight = _inFlight.get(promptId);
	if (inFlight?.timer !== null && inFlight?.timer !== undefined) {
		clearTimeout(inFlight.timer);
	}
	_inFlight.delete(promptId);

	const contextId = ctx.promptIndex.get(promptId);
	ctx.promptIndex.delete(promptId);
	ctx.pendingPrompts.delete(promptId);

	if (contextId) {
		const context = ctx.promptContexts.get(contextId);
		context?.prompts.delete(promptId);
	}
}

function clearElevationContextsWhere(
	ctx: PromptCtxSlice,
	matches: (owner: ElevationPromptOwner) => boolean,
	send?: (clientId: string, msg: Record<string, unknown>) => void,
): void {
	const owners = ctx.elevationPromptOwners;
	if (!owners) return;

	for (const [contextId, owner] of [...owners.entries()]) {
		if (!matches(owner)) continue;
		clearContext(ctx, contextId, send);
		owners.delete(contextId);
	}
}
