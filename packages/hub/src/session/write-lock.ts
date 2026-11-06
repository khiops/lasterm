import type {
	WriteDenyMessage,
	WriteLockMessage,
	WriteRequestMessage,
	WriteRevokedMessage,
} from "@lasterm/shared";

export interface WriteLockManagerOpts {
	sendToClient: (clientId: string, msg: unknown) => void;
	broadcastToChannel: (channelId: string, msg: unknown) => void;
	/** Told when a force takes the lock from another client: a security event (SECURITY.md § 7.1). */
	onForce?: (force: { channelId: string; byClientId: string; fromClientId: string }) => void;
	/** Told after a channel's lock changed hands, was freed or kept: uploads wait or go on (#833). */
	onChange?: (channelId: string) => void;
}

/**
 * How long a holder that left keeps its claim on the lock, for its window to
 * come back (#846).
 *
 * A reload, the desktop's own after Tauri's IPC fallback (#823) among them,
 * takes the page a second or two to connect, authenticate and attach its
 * panes again. A socket that dropped comes back on the web's first reconnect
 * attempts, 1, 3 and 7 s after the drop (`ws-client.ts`), and attaches again
 * within about a second. Ten seconds covers all of that with room to spare.
 *
 * It is also how long the one client left waits for a lock nobody comes back
 * for, which is why it is no longer. That client is not stuck meanwhile: a
 * WRITE_CLAIM during the grace is granted at once.
 */
export const WRITE_LOCK_GRACE_MS = 10_000;

/** Which window a client belongs to: its token, and the window its AUTH named (#846). */
export interface ClientWindow {
	readonly tokenId: string;
	readonly windowId: string;
}

/** A departed holder's claim on a lock, kept for its window during the grace. */
interface Reservation {
	readonly window: string;
	readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * One string per window, under its token: two windows sharing a token are two
 * windows, and a client naming another device's window id is not that window.
 */
function windowKey(window: ClientWindow): string {
	return JSON.stringify([window.tokenId, window.windowId]);
}

/**
 * Manages the 3-tier write-lock protocol for channels.
 *
 * Tier 1 — Claim free lock: first attach auto-grants, subsequent clients claim and
 *           get a WRITE_REQUEST forwarded to the current holder.
 * Tier 2 — Holder grants/denies the requester voluntarily.
 * Tier 3 — Force-take: bypasses holder consent, sends WRITE_REVOKED to old holder.
 *
 * A holder that disconnects keeps its claim for a grace, so that its window,
 * reloaded or reconnected, gets the lock back rather than reading (#846).
 *
 * The manager is deliberately standalone (no SessionManager dep) and is unit-testable
 * through the two injected callbacks.
 */
export class WriteLockManager {
	/** channelId → holder clientId */
	private holders = new Map<string, string>();
	/** channelId → Set of attached clientIds */
	private attached = new Map<string, Set<string>>();
	/** clientId → its window, for the clients whose AUTH named one (#846) */
	private windows = new Map<string, string>();
	/** channelId → the claim kept for a holder that left, while its grace runs */
	private reservations = new Map<string, Reservation>();
	/** Set by shutdown: a hub going away keeps no lock for anyone. */
	private stopped = false;

	private sendToClient: (clientId: string, msg: unknown) => void;
	private broadcastToChannel: (channelId: string, msg: unknown) => void;
	private onForce: NonNullable<WriteLockManagerOpts["onForce"]>;
	private onChange: NonNullable<WriteLockManagerOpts["onChange"]>;

	constructor(opts: WriteLockManagerOpts) {
		this.sendToClient = opts.sendToClient;
		this.broadcastToChannel = opts.broadcastToChannel;
		this.onForce = opts.onForce ?? (() => undefined);
		this.onChange = opts.onChange ?? (() => undefined);
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	/**
	 * Record which window a client belongs to, as its AUTH said (#846). A holder
	 * whose window is known keeps its claim on the lock for a while after it
	 * leaves, and gets the lock back if its window attaches again meanwhile.
	 */
	identify(clientId: string, window: ClientWindow): void {
		this.windows.set(clientId, windowKey(window));
	}

	/**
	 * Track a client attaching to a channel.
	 * If no holder exists yet, the first attaching client becomes the writer automatically.
	 * While the lock is kept for a holder that left, its window gets it back, and
	 * any other client reads.
	 */
	attach(channelId: string, clientId: string): void {
		let clients = this.attached.get(channelId);
		if (!clients) {
			clients = new Set();
			this.attached.set(channelId, clients);
		}
		clients.add(clientId);

		const reservation = this.reservations.get(channelId);
		if (reservation !== undefined) {
			if (this.windows.get(clientId) === reservation.window) {
				// The holder's window is back: the lock is its again, and with it
				// the terminal's size, which nobody changed meanwhile (#846).
				this._endReservation(channelId);
				this.holders.set(channelId, clientId);
				this._broadcastLock(channelId, clientId);
			} else {
				this.sendToClient(clientId, lockMessage(channelId, null, true));
			}
			return;
		}

		if (!this.holders.has(channelId)) {
			// Auto-grant write lock to first attached client
			this.holders.set(channelId, clientId);
			this._broadcastLock(channelId, clientId);
		} else {
			// Notify the newly attached client of the current holder so it can
			// render the correct lock state immediately. Without this, a race
			// between ATTACH_OK and the auto-grant WRITE_LOCK can leave the
			// client with stale lock state.
			const holder = this.holders.get(channelId) ?? null;
			this.sendToClient(clientId, {
				type: "WRITE_LOCK",
				channelId,
				holder,
			} as WriteLockMessage);
		}
	}

	/**
	 * Track a client detaching from a channel.
	 * If the detaching client held the lock, it is released and WRITE_LOCK holder=null
	 * is broadcast to the remaining attached clients.
	 *
	 * No grace: a DETACH is a client saying it no longer shows the terminal, so
	 * there is nothing to come back for. A reload or a dropped socket is a
	 * disconnect (onClientDisconnect).
	 */
	detach(channelId: string, clientId: string): void {
		const clients = this.attached.get(channelId);
		if (clients) {
			clients.delete(clientId);
		}

		const holder = this.holders.get(channelId);
		if (holder === clientId) {
			this.holders.delete(channelId);
			this._broadcastLock(channelId, null);
			this._grantToSoleAttachedClient(channelId);
		}
	}

	/**
	 * Hand a freed lock to the one client left attached, if there is exactly one.
	 *
	 * A lock exists to arbitrate between people, and with one client attached
	 * there is nobody to arbitrate with: leaving it free means a terminal that
	 * refuses what is typed into it until someone finds the button. That is
	 * what a reconnection used to produce — the connection being replaced holds
	 * the lock, goes, and the one on screen is left with nothing (#465).
	 *
	 * With several attached it stays free on purpose: taking it for one of them
	 * would be choosing on their behalf.
	 *
	 * A holder that disconnected and whose window is known is waited for first,
	 * for WRITE_LOCK_GRACE_MS (#846): this runs when the grace ends.
	 */
	private _grantToSoleAttachedClient(channelId: string): void {
		if (this.holders.has(channelId)) return;
		const clients = this.attached.get(channelId);
		if (clients === undefined || clients.size !== 1) return;
		const [only] = clients;
		if (only === undefined) return;
		this.holders.set(channelId, only);
		this._broadcastLock(channelId, only);
	}

	// ─── Tier 1 ─────────────────────────────────────────────────────────────

	/**
	 * A client claims the write lock.
	 * - If no holder: grant immediately, broadcast WRITE_LOCK.
	 * - If already held by someone else: forward WRITE_REQUEST to the holder.
	 * - If the client is already the holder: no-op.
	 */
	claim(channelId: string, clientId: string): void {
		const current = this.holders.get(channelId);

		if (!current) {
			// A lock kept for a holder that left is free to whoever asks for it.
			this._endReservation(channelId);
			this.holders.set(channelId, clientId);
			this._broadcastLock(channelId, clientId);
			return;
		}

		if (current === clientId) {
			// Already the holder — no-op
			return;
		}

		// Forward request to current holder
		const req: WriteRequestMessage = {
			type: "WRITE_REQUEST",
			channelId,
			fromClientId: clientId,
		};
		this.sendToClient(current, req);
	}

	// ─── Tier 2 ─────────────────────────────────────────────────────────────

	/**
	 * The current holder grants the lock to a requester.
	 * Verifies that fromClientId is actually the current holder.
	 */
	grant(channelId: string, fromClientId: string, toClientId: string): void {
		if (!this._verifyHolder(channelId, fromClientId)) return;

		this.holders.set(channelId, toClientId);
		this._broadcastLock(channelId, toClientId);
	}

	/**
	 * The current holder denies a requester.
	 * Verifies that fromClientId is actually the current holder.
	 */
	deny(channelId: string, fromClientId: string, toClientId: string): void {
		if (!this._verifyHolder(channelId, fromClientId)) return;

		const denyMsg: WriteDenyMessage = {
			type: "WRITE_DENY",
			channelId,
			toClientId,
		};
		this.sendToClient(toClientId, denyMsg);
	}

	// ─── Tier 3 ─────────────────────────────────────────────────────────────

	/**
	 * Forcibly steal the write lock from the current holder.
	 * Sends WRITE_REVOKED to the old holder, then broadcasts WRITE_LOCK with new holder.
	 */
	force(channelId: string, clientId: string): void {
		const current = this.holders.get(channelId);

		if (current && current !== clientId) {
			const revokedMsg: WriteRevokedMessage = {
				type: "WRITE_REVOKED",
				channelId,
			};
			this.sendToClient(current, revokedMsg);
			this.onForce({ channelId, byClientId: clientId, fromClientId: current });
		}

		this._endReservation(channelId);
		this.holders.set(channelId, clientId);
		this._broadcastLock(channelId, clientId);
	}

	// ─── Voluntary release ──────────────────────────────────────────────────

	/**
	 * The holder voluntarily releases the write lock.
	 * Only the current holder can release; ignores calls from non-holders.
	 */
	release(channelId: string, clientId: string): void {
		if (!this._verifyHolder(channelId, clientId)) return;

		this.holders.delete(channelId);
		this._broadcastLock(channelId, null);
	}

	// ─── Query ──────────────────────────────────────────────────────────────

	/** Returns true only if clientId currently holds the write lock for channelId. */
	isHolder(channelId: string, clientId: string): boolean {
		return this.holders.get(channelId) === clientId;
	}

	/**
	 * Returns true if the client is allowed to send INPUT for this channel.
	 * Input is allowed when:
	 *   - No write lock is held (anyone may write), OR
	 *   - The client is the current write-lock holder.
	 * Input is denied when another client explicitly holds the lock, and while
	 * the lock is kept for a holder that left (#846).
	 */
	isWriteLockHolder(channelId: string, clientId: string): boolean {
		if (this.reservations.has(channelId)) return false;
		const holder = this.holders.get(channelId);
		return holder === undefined || holder === clientId;
	}

	/** Returns the current holder for a channel, or null if none. */
	getHolder(channelId: string): string | null {
		return this.holders.get(channelId) ?? null;
	}

	// ─── Bulk operations ────────────────────────────────────────────────────

	/**
	 * Called on client disconnect — releases all write locks held by this client
	 * across every channel they were attached to.
	 *
	 * A reload or a short drop is a disconnect, and the same window comes back
	 * on a new connection, under a new client id. So the lock of a client whose
	 * window is known is kept for that window for WRITE_LOCK_GRACE_MS before it
	 * is handed on (#846): coming back as a reader would hand the terminal's
	 * size, which the holder decides (#831), to whoever was left.
	 */
	onClientDisconnect(clientId: string): void {
		const window = this.windows.get(clientId);
		this.windows.delete(clientId);
		const freed: string[] = [];
		for (const [channelId, holder] of this.holders.entries()) {
			if (holder === clientId) {
				this.holders.delete(channelId);
				freed.push(channelId);
			}
		}
		// Clean up from attached sets
		for (const clients of this.attached.values()) {
			clients.delete(clientId);
		}
		// Only now is the departing client out of the attached sets, so "the one
		// client left" means what it says.
		for (const channelId of freed) {
			if (window !== undefined && !this.stopped) {
				this._keepFor(channelId, window);
			} else {
				this._broadcastLock(channelId, null);
				this._grantToSoleAttachedClient(channelId);
			}
		}
	}

	/**
	 * Cleanup all state for a destroyed channel.
	 */
	removeChannel(channelId: string): void {
		this._endReservation(channelId);
		this.holders.delete(channelId);
		this.attached.delete(channelId);
	}

	/**
	 * Shutdown — clear all state. A grace still running ends with the hub: its
	 * timer is cleared, and a socket closing after this keeps no lock.
	 */
	shutdown(): void {
		this.stopped = true;
		for (const { timer } of this.reservations.values()) clearTimeout(timer);
		this.reservations.clear();
		this.holders.clear();
		this.attached.clear();
		this.windows.clear();
	}

	// ─── Private helpers ────────────────────────────────────────────────────

	/**
	 * Keep the lock of a holder that left for its window, for the grace (#846).
	 *
	 * Its window may be back already, on a connection that attached before the
	 * old one was seen to close: that one has the lock at once. Otherwise nobody
	 * holds it, so nobody types and nobody resizes, and every client is told it
	 * is kept. That lasts until the window attaches again, someone claims or
	 * forces the lock, or the grace ends and it is handed on as any freed lock is.
	 */
	private _keepFor(channelId: string, window: string): void {
		for (const other of this.attached.get(channelId) ?? []) {
			if (this.windows.get(other) === window) {
				this.holders.set(channelId, other);
				this._broadcastLock(channelId, other);
				return;
			}
		}
		const timer = setTimeout(() => this._graceEnded(channelId), WRITE_LOCK_GRACE_MS);
		// A grace running must not keep a hub that is otherwise done alive.
		timer.unref();
		this.reservations.set(channelId, { window, timer });
		this._broadcastLock(channelId, null, true);
	}

	/** Nobody came back for a kept lock: it is free, and goes to the one client left. */
	private _graceEnded(channelId: string): void {
		this.reservations.delete(channelId);
		this._broadcastLock(channelId, null);
		this._grantToSoleAttachedClient(channelId);
	}

	/** Stop keeping a lock for a holder that left, if it is kept. */
	private _endReservation(channelId: string): void {
		const reservation = this.reservations.get(channelId);
		if (reservation === undefined) return;
		clearTimeout(reservation.timer);
		this.reservations.delete(channelId);
	}

	private _broadcastLock(channelId: string, holder: string | null, reserved = false): void {
		this.broadcastToChannel(channelId, lockMessage(channelId, holder, reserved));
		this.onChange(channelId);
	}

	/**
	 * Verifies the given clientId is the current holder for the channel.
	 * Returns true on success, false if verification fails (no-op for caller).
	 */
	private _verifyHolder(channelId: string, clientId: string): boolean {
		return this.holders.get(channelId) === clientId;
	}
}

/** WRITE_LOCK for a channel; `reserved` when the lock is kept for a holder that left. */
function lockMessage(
	channelId: string,
	holder: string | null,
	reserved: boolean,
): WriteLockMessage {
	return { type: "WRITE_LOCK", channelId, holder, ...(reserved && { reserved: true }) };
}
