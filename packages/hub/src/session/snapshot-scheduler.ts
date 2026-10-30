import type { AgentConnection } from "./agent-connection.js";

const SNAPSHOT_IDLE_MS = 3_000; // 3s idle trigger
const SNAPSHOT_FORCED_MS = 5_000; // 5s forced trigger
const DEFAULT_MAX_CONCURRENT_SNAPSHOTS = 4;
const SNAPSHOT_TIMEOUT_MS = 5_000; // 5s timeout — free slot if agent never responds

interface ChannelTimers {
	lastOutputAt: number;
	lastSnapshotAt: number;
	/**
	 * The screen may differ from the last snapshot asked for: output or a resize
	 * came since. The timers ask only then. They used to ask every 5 s whatever
	 * happened, and an idle terminal left a snapshot of the same screen in the
	 * spool every 5 s, 64,509 of them in five days on one channel (#726).
	 */
	changed: boolean;
	idleTimer: ReturnType<typeof setTimeout> | null;
	forcedTimer: ReturnType<typeof setInterval> | null;
}

export class SnapshotScheduler {
	private channels = new Map<string, ChannelTimers>();
	/** Number of snapshots currently in-flight (awaiting SNAPSHOT_RES) */
	private _inFlightSnapshots = 0;
	private _maxConcurrentSnapshots: number;
	/**
	 * Per-channel timeout handles for in-flight snapshot requests.
	 * Cancelled when onSnapshotResponse fires; fires to free the slot on hang.
	 */
	private _snapshotTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private getAgent: (channelId: string) => AgentConnection | undefined,
		maxConcurrentSnapshots = DEFAULT_MAX_CONCURRENT_SNAPSHOTS,
	) {
		this._maxConcurrentSnapshots = maxConcurrentSnapshots;
	}

	/** Start tracking a channel for snapshot scheduling */
	trackChannel(channelId: string): void {
		if (this.channels.has(channelId)) return;

		const now = Date.now();
		const state: ChannelTimers = {
			lastOutputAt: now,
			lastSnapshotAt: 0,
			// Nothing says the stored snapshot, if any, is this screen.
			changed: true,
			idleTimer: null,
			forcedTimer: null,
		};
		this.channels.set(channelId, state);

		state.idleTimer = setTimeout(() => this._onIdleTimeout(channelId), SNAPSHOT_IDLE_MS);
		state.forcedTimer = setInterval(() => this._onForcedTimeout(channelId), SNAPSHOT_FORCED_MS);
	}

	/** Called when OUTPUT is received for a channel — reset idle timer */
	onOutput(channelId: string): void {
		const state = this.channels.get(channelId);
		if (!state) return;

		state.lastOutputAt = Date.now();
		state.changed = true;

		if (state.idleTimer !== null) {
			clearTimeout(state.idleTimer);
		}
		state.idleTimer = setTimeout(() => this._onIdleTimeout(channelId), SNAPSHOT_IDLE_MS);
	}

	/**
	 * Called when a channel is resized. The agent resizes its screen whether or
	 * not the program redraws, so it counts as a change, as output does.
	 */
	onResize(channelId: string): void {
		this.onOutput(channelId);
	}

	/** Called when last client detaches — trigger immediate snapshot */
	onDetach(channelId: string): void {
		this._requestSnapshot(channelId);
	}

	/** Stop tracking a channel (channel DEAD or session CLOSED) */
	untrackChannel(channelId: string): void {
		const state = this.channels.get(channelId);
		if (!state) return;

		if (state.idleTimer !== null) {
			clearTimeout(state.idleTimer);
		}
		if (state.forcedTimer !== null) {
			clearInterval(state.forcedTimer);
		}
		this.channels.delete(channelId);
	}

	/** Stop all tracking (shutdown) */
	shutdown(): void {
		for (const channelId of this.channels.keys()) {
			this.untrackChannel(channelId);
		}
		for (const t of this._snapshotTimeouts.values()) {
			clearTimeout(t);
		}
		this._snapshotTimeouts.clear();
	}

	private _onIdleTimeout(channelId: string): void {
		const state = this.channels.get(channelId);
		if (!state) return;
		state.idleTimer = null;
		if (state.changed) this._requestSnapshot(channelId);
	}

	private _onForcedTimeout(channelId: string): void {
		if (this.channels.get(channelId)?.changed) this._requestSnapshot(channelId);
	}

	/**
	 * Called when a SNAPSHOT_RES is received for a channel.
	 * Decrements the in-flight counter so the concurrency slot is freed.
	 */
	onSnapshotResponse(channelId: string): void {
		if (this._inFlightSnapshots > 0) {
			this._inFlightSnapshots--;
		}
		const t = this._snapshotTimeouts.get(channelId);
		if (t !== undefined) {
			clearTimeout(t);
			this._snapshotTimeouts.delete(channelId);
		}
	}

	/** Exposed for testing only */
	get inFlightSnapshots(): number {
		return this._inFlightSnapshots;
	}

	private _requestSnapshot(channelId: string): void {
		if (this._inFlightSnapshots >= this._maxConcurrentSnapshots) {
			// Max concurrent snapshots reached — silently defer (high-frequency path)
			return;
		}

		const state = this.channels.get(channelId);
		if (state) {
			state.lastSnapshotAt = Date.now();
		}

		const agent = this.getAgent(channelId);
		if (!agent?.connected) return;

		// Asked for, the snapshot covers the screen as it is: only a change after
		// this makes the next one worth taking. A deferred or unsent request
		// leaves the flag set, so the next tick asks again.
		if (state) state.changed = false;
		this._inFlightSnapshots++;
		agent.send({ type: "SNAPSHOT_REQ", channelId });

		// Safety valve: free the slot if the agent never responds (e.g. winpty hang)
		const existing = this._snapshotTimeouts.get(channelId);
		if (existing !== undefined) {
			clearTimeout(existing);
		}
		this._snapshotTimeouts.set(
			channelId,
			setTimeout(() => {
				this._snapshotTimeouts.delete(channelId);
				if (this._inFlightSnapshots > 0) {
					this._inFlightSnapshots--;
				}
				// Snapshot timeout — slot freed (agent may be busy or disconnected).
				// No snapshot came, so the screen is still to be taken.
				const timedOut = this.channels.get(channelId);
				if (timedOut) timedOut.changed = true;
			}, SNAPSHOT_TIMEOUT_MS),
		);
	}
}
