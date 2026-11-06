import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useAuthStore } from "./auth.js";

interface LockState {
	holder: string | null;
	/**
	 * Nobody holds the lock: the hub keeps it for the holder that just left,
	 * whose window may come back within its grace (#846). Set only then.
	 */
	reserved?: true;
}

interface IncomingRequest {
	channelId: string;
	fromClientId: string;
}

/**
 * Write-lock store — tracks per-channel write-lock state and pending
 * transfer requests. Integrates with the WS service for sending protocol
 * messages and the auth store for clientId resolution.
 */
export const useWriteLockStore = defineStore("writelock", () => {
	const locks = ref<Map<string, LockState>>(new Map());
	const incomingRequest = ref<IncomingRequest | null>(null);

	// WsClient reference — injected after the session store connects
	let _wsClient: IWsClient | null = null;

	function setWsClient(client: IWsClient): void {
		_wsClient = client;
	}

	// ── Incoming protocol message handlers ──────────────────────────────────

	function handleWriteLock(channelId: string, holder: string | null, reserved = false): void {
		const next = new Map(locks.value);
		next.set(channelId, reserved && holder === null ? { holder, reserved: true } : { holder });
		locks.value = next;
	}

	function handleWriteRequest(channelId: string, fromClientId: string): void {
		incomingRequest.value = { channelId, fromClientId };
	}

	function handleWriteRevoked(channelId: string): void {
		// Our lock was force-taken; update state via subsequent WRITE_LOCK broadcast.
		// The lock map will be updated when the hub sends the WRITE_LOCK broadcast.
		// We clear any holder reference immediately so the UI becomes read-only.
		const current = locks.value.get(channelId);
		if (current) {
			const next = new Map(locks.value);
			next.set(channelId, { holder: null });
			locks.value = next;
		}
	}

	function handleWriteDeny(channelId: string): void {
		// Claim was denied; no state change needed — we remain a reader.
		// UI components should react by showing a "Denied" notification.
		// For now, we log to allow callers to react via a watch.
		console.warn(`[WriteLock] Claim denied for channel ${channelId}`);
	}

	// ── Outbound actions ─────────────────────────────────────────────────────

	/**
	 * Claim write access. If nobody holds the lock, it is granted immediately
	 * by the hub. If another client holds it, the hub forwards a WRITE_REQUEST
	 * to that client and waits for WRITE_GRANT or WRITE_DENY.
	 */
	function claim(channelId: string): void {
		_wsClient?.send({ type: "WRITE_CLAIM", channelId });
	}

	/**
	 * Current writer grants the lock to a requesting client (Tier 2).
	 */
	function grant(channelId: string, toClientId: string): void {
		_wsClient?.send({ type: "WRITE_GRANT", channelId, toClientId });
		incomingRequest.value = null;
	}

	/**
	 * Current writer denies the lock request (Tier 2).
	 */
	function deny(channelId: string, toClientId: string): void {
		_wsClient?.send({ type: "WRITE_DENY", channelId, toClientId });
		incomingRequest.value = null;
	}

	/**
	 * Force-take the lock regardless of who holds it (Tier 3).
	 */
	function forceTake(channelId: string): void {
		_wsClient?.send({ type: "WRITE_FORCE", channelId });
	}

	/**
	 * Release our write lock voluntarily.
	 */
	function release(channelId: string): void {
		_wsClient?.send({ type: "WRITE_RELEASE", channelId });
	}

	/**
	 * Set initial write-lock holder from ATTACH_OK response.
	 */
	function setInitialHolder(channelId: string, holder: string | null): void {
		const next = new Map(locks.value);
		next.set(channelId, { holder });
		locks.value = next;
	}

	/**
	 * Returns true if the current authenticated client holds the write lock
	 * for the given channel.
	 */
	const isWriter = computed(() => (channelId: string): boolean => {
		const authStore = useAuthStore();
		const lock = locks.value.get(channelId);
		return lock?.holder === authStore.clientId && authStore.clientId !== null;
	});

	function dismissRequest(): void {
		incomingRequest.value = null;
	}

	/**
	 * Remove lock entries for channels that are dead.
	 * Called after fetchChannels to clear stale "Writer" labels.
	 */
	function pruneDeadLocks(deadChannelIds: Set<string>): void {
		if (deadChannelIds.size === 0) return;
		const next = new Map(locks.value);
		for (const id of deadChannelIds) {
			next.delete(id);
		}
		locks.value = next;
	}

	return {
		locks,
		incomingRequest,
		isWriter,
		setWsClient,
		handleWriteLock,
		handleWriteRequest,
		handleWriteRevoked,
		handleWriteDeny,
		claim,
		grant,
		deny,
		forceTake,
		release,
		setInitialHolder,
		dismissRequest,
		pruneDeadLocks,
	};
});
