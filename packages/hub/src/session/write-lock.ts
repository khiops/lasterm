import type {
	WriteDenyMessage,
	WriteLockMessage,
	WriteRequestMessage,
	WriteRevokedMessage,
} from "@lasterm/shared";

export interface WriteLockManagerOpts {
	sendToClient: (clientId: string, msg: unknown) => void;
	broadcastToChannel: (channelId: string, msg: unknown) => void;
}

/**
 * Manages the 3-tier write-lock protocol for channels.
 *
 * Tier 1 — Claim free lock: first attach auto-grants, subsequent clients claim and
 *           get a WRITE_REQUEST forwarded to the current holder.
 * Tier 2 — Holder grants/denies the requester voluntarily.
 * Tier 3 — Force-take: bypasses holder consent, sends WRITE_REVOKED to old holder.
 *
 * The manager is deliberately standalone (no SessionManager dep) and is unit-testable
 * through the two injected callbacks.
 */
export class WriteLockManager {
	/** channelId → holder clientId */
	private holders = new Map<string, string>();
	/** channelId → Set of attached clientIds */
	private attached = new Map<string, Set<string>>();

	private sendToClient: (clientId: string, msg: unknown) => void;
	private broadcastToChannel: (channelId: string, msg: unknown) => void;

	constructor(opts: WriteLockManagerOpts) {
		this.sendToClient = opts.sendToClient;
		this.broadcastToChannel = opts.broadcastToChannel;
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	/**
	 * Track a client attaching to a channel.
	 * If no holder exists yet, the first attaching client becomes the writer automatically.
	 */
	attach(channelId: string, clientId: string): void {
		let clients = this.attached.get(channelId);
		if (!clients) {
			clients = new Set();
			this.attached.set(channelId, clients);
		}
		clients.add(clientId);

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
		}
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
		}

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
	 * Input is denied only when another client explicitly holds the lock.
	 */
	isWriteLockHolder(channelId: string, clientId: string): boolean {
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
	 */
	onClientDisconnect(clientId: string): void {
		for (const [channelId, holder] of this.holders.entries()) {
			if (holder === clientId) {
				this.holders.delete(channelId);
				this._broadcastLock(channelId, null);
			}
		}
		// Clean up from attached sets
		for (const clients of this.attached.values()) {
			clients.delete(clientId);
		}
	}

	/**
	 * Cleanup all state for a destroyed channel.
	 */
	removeChannel(channelId: string): void {
		this.holders.delete(channelId);
		this.attached.delete(channelId);
	}

	/** Shutdown — clear all state. */
	shutdown(): void {
		this.holders.clear();
		this.attached.clear();
	}

	// ─── Private helpers ────────────────────────────────────────────────────

	private _broadcastLock(channelId: string, holder: string | null): void {
		const msg: WriteLockMessage = {
			type: "WRITE_LOCK",
			channelId,
			holder,
		};
		this.broadcastToChannel(channelId, msg);
	}

	/**
	 * Verifies the given clientId is the current holder for the channel.
	 * Returns true on success, false if verification fails (no-op for caller).
	 */
	private _verifyHolder(channelId: string, clientId: string): boolean {
		return this.holders.get(channelId) === clientId;
	}
}
