/**
 * StateBroadcaster — handles all WebSocket state synchronisation:
 *   - broadcasting SESSION_STATE / CHANNEL_STATE / TITLE_CHANGE to UI clients
 *   - state snapshot construction (STATE_SYNC)
 *   - in-memory + DB status updates for sessions and channels
 *   - client attach/detach tracking
 *   - rate limiting for BELL / NOTIFICATION
 *   - display title resolution + debounced DB writes
 */

import type {
	AgentProcessTitleMessage,
	AgentTitleChangeMessage,
	ChannelCreatedMessage,
	ChannelStateMessage,
	ProtocolMessage,
	SessionStateMessage,
	StateSyncMessage,
} from "@lasterm/shared";
import { DEFAULT_CHANNEL_NAME, resolveChannelDisplayName } from "@lasterm/shared";
import type { SharedSessionContext } from "./session-context.js";
import type { WsClient } from "./session-manager.js";

const TITLE_DEBOUNCE_MS = 100;

export class StateBroadcaster {
	constructor(private readonly ctx: SharedSessionContext) {}

	// ─── Client registry ────────────────────────────────────────────────────

	addClient(client: WsClient): void {
		this.ctx.clients.set(client.id, client);
	}

	removeClient(clientId: string): void {
		const client = this.ctx.clients.get(clientId);
		if (!client) return;
		// Copy set to avoid mutating while iterating
		for (const channelId of [...client.attachedChannels]) {
			this.detachClient(clientId, channelId);
		}
		// NOTE: auth-prompt cancellation/retargeting is owned by SessionManager.removeClient,
		// which must run BEFORE this call. Do NOT cancel prompts here — the retarget logic
		// in session-manager.removeClient needs the pending entries to still be present.
		this.ctx.clients.delete(clientId);
	}

	getClientsForChannel(channelId: string): WsClient[] {
		const channel = this.ctx.channels.get(channelId);
		if (!channel) return [];
		const result: WsClient[] = [];
		for (const clientId of channel.clients) {
			const client = this.ctx.clients.get(clientId);
			if (client) result.push(client);
		}
		return result;
	}

	// ─── State snapshot ─────────────────────────────────────────────────────

	getStateSnapshot(): StateSyncMessage {
		const sessions: StateSyncMessage["sessions"] = [];
		for (const [hostId, state] of this.ctx.sessions) {
			if (state.status !== "closed") {
				sessions.push({ sessionId: state.id, hostId, status: state.status });
			}
		}
		const channels: StateSyncMessage["channels"] = [];
		for (const [channelId, ch] of this.ctx.channels) {
			if (ch.status !== "dead") {
				channels.push({
					channelId,
					sessionId: ch.sessionId,
					status: ch.status,
					displayTitle: ch.displayTitle,
				});
			}
		}
		return { type: "STATE_SYNC", sessions, channels };
	}

	// ─── Status updates (in-memory + DB + broadcast) ────────────────────────

	updateSessionStatus(
		hostId: string,
		sessionId: string,
		status: import("@lasterm/shared").SessionStatus,
	): void {
		const state = this.ctx.sessions.get(hostId);
		if (state && state.id === sessionId) {
			state.status = status;
		}
		this.ctx.metaDal.updateSessionStatus(sessionId, status);

		const stateMsg: SessionStateMessage = {
			type: "SESSION_STATE",
			sessionId,
			hostId,
			status,
		};
		this.broadcastToAllClients(stateMsg);
	}

	updateChannelStatus(
		channelId: string,
		sessionId: string,
		status: import("@lasterm/shared").ChannelStatus,
		exitCode?: number,
	): void {
		const ch = this.ctx.channels.get(channelId);
		if (ch) {
			ch.status = status;
		}
		this.ctx.metaDal.updateChannelStatus(channelId, status, exitCode);

		const stateMsg: ChannelStateMessage = {
			type: "CHANNEL_STATE",
			channelId,
			sessionId,
			status,
			...(exitCode !== undefined && { exitCode }),
		};
		// Broadcast to attached clients first; fall back to all clients for orphan/dead
		// when the channel has no more clients (they just detached).
		if (ch && ch.clients.size > 0) {
			this.broadcastToChannel(channelId, stateMsg);
		} else {
			this.broadcastToAllClients(stateMsg);
		}
	}

	// ─── Client attach/detach ────────────────────────────────────────────────

	detachClient(clientId: string, channelId: string): void {
		const channel = this.ctx.channels.get(channelId);
		if (channel) {
			channel.clients.delete(clientId);
			// live → orphan when last client detaches (and channel is still live)
			if (channel.clients.size === 0 && channel.status === "live") {
				this.updateChannelStatus(channelId, channel.sessionId, "orphan");
				this.ctx.scheduler.onDetach(channelId);
				this.checkSessionDetached(channel.hostId);
			}
		}
		this.ctx.clients.get(clientId)?.attachedChannels.delete(channelId);
	}

	/** If all clients detached from all channels of a host, session → detached */
	checkSessionDetached(hostId: string): void {
		const session = this.ctx.sessions.get(hostId);
		if (session?.status !== "active") return;

		// Check if any channel for this session is still live
		for (const ch of this.ctx.channels.values()) {
			if (ch.hostId === hostId && ch.status === "live") return;
		}

		this.updateSessionStatus(hostId, session.id, "detached");
	}

	// ─── Broadcast primitives ────────────────────────────────────────────────

	broadcastToChannel(channelId: string, msg: ProtocolMessage): void {
		const channel = this.ctx.channels.get(channelId);
		if (!channel) return;
		for (const clientId of channel.clients) {
			this.ctx.clients.get(clientId)?.send(msg);
		}
	}

	broadcastToAllClients(msg: ProtocolMessage): void {
		for (const client of this.ctx.clients.values()) {
			client.send(msg);
		}
	}

	/**
	 * Broadcast a CHANNEL_CREATED message to all connected clients so observers
	 * learn about new channels without a manual fetchChannels.  The UI filters
	 * by host on the receiving end; the spawning client deduplicates against the
	 * channel it already obtained via fetchChannels after SPAWN_OK.
	 */
	broadcastChannelCreated(msg: ChannelCreatedMessage): void {
		this.broadcastToAllClients(msg);
	}

	// ─── Title management ───────────────────────────────────────────────────

	notifyChannelRenamed(channelId: string): void {
		const channel = this.ctx.channels.get(channelId);
		if (!channel) return;

		const displayTitle = this.resolveDisplayTitle(channelId);
		const msg = {
			type: "TITLE_CHANGE" as const,
			channelId,
			title: channel.dynamicTitle ?? "",
			displayTitle,
		};
		this.broadcastToChannel(channelId, msg);
	}

	broadcastDisplayTitles(): void {
		for (const [channelId, channel] of this.ctx.channels) {
			const displayTitle = this.resolveDisplayTitle(channelId);
			const msg = {
				type: "TITLE_CHANGE" as const,
				channelId,
				title: channel.dynamicTitle ?? "",
				displayTitle,
			};
			this.broadcastToChannel(channelId, msg);
		}
	}

	resolveDisplayTitle(channelId: string): string {
		const state = this.ctx.channels.get(channelId);
		if (!state) return DEFAULT_CHANNEL_NAME;

		const titleConfig = this.ctx.configResolver?.uiConfig.title ?? {};
		const source = titleConfig.source ?? "dynamic";
		const staticTitle = titleConfig.staticTitle ?? "";

		// Custom title (F2 rename) from DB — always wins
		const dbChannel = this.ctx.metaDal.getChannel(channelId);
		const customTitle = dbChannel?.title ?? null;

		const resolved = resolveChannelDisplayName(
			{ title: customTitle, dynamicTitle: state.dynamicTitle, processTitle: state.processTitle },
			source,
			staticTitle,
		);
		state.displayTitle = resolved;
		return resolved;
	}

	handleTitleChange(msg: AgentTitleChangeMessage): void {
		const channel = this.ctx.channels.get(msg.channelId);
		if (!channel) {
			this.ctx.hubLogger?.log(
				"warn",
				"state-broadcaster: TITLE_CHANGE for unknown channel, ignored",
				{ channelId: msg.channelId },
			);
			return;
		}

		// Update in-memory state before resolving displayTitle
		channel.dynamicTitle = msg.title;

		// Resolve displayTitle and broadcast enriched message to UI clients
		const displayTitle = this.resolveDisplayTitle(msg.channelId);
		this.broadcastToChannel(msg.channelId, { ...msg, displayTitle });

		// Debounce DB writes
		this.clearTitleDebounce(msg.channelId);
		this.ctx.titleDebounceTimers.set(
			msg.channelId,
			setTimeout(() => {
				this.ctx.titleDebounceTimers.delete(msg.channelId);
				this.ctx.metaDal.updateDynamicTitle(msg.channelId, msg.title);
			}, TITLE_DEBOUNCE_MS),
		);
	}

	clearTitleDebounce(channelId: string): void {
		const timer = this.ctx.titleDebounceTimers.get(channelId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.ctx.titleDebounceTimers.delete(channelId);
		}
	}

	handleProcessTitle(msg: AgentProcessTitleMessage): void {
		const channel = this.ctx.channels.get(msg.channelId);
		if (!channel) {
			this.ctx.hubLogger?.log(
				"warn",
				"state-broadcaster: PROCESS_TITLE for unknown channel, ignored",
				{ channelId: msg.channelId },
			);
			return;
		}

		// Update in-memory state before resolving displayTitle
		channel.processTitle = msg.title;

		// Resolve displayTitle and broadcast enriched message to UI clients
		const displayTitle = this.resolveDisplayTitle(msg.channelId);
		this.broadcastToChannel(msg.channelId, { ...msg, displayTitle });

		// Debounce DB writes
		this.clearProcessTitleDebounce(msg.channelId);
		this.ctx.processTitleDebounceTimers.set(
			msg.channelId,
			setTimeout(() => {
				this.ctx.processTitleDebounceTimers.delete(msg.channelId);
				this.ctx.metaDal.updateProcessTitle(msg.channelId, msg.title);
			}, TITLE_DEBOUNCE_MS),
		);
	}

	clearProcessTitleDebounce(channelId: string): void {
		const timer = this.ctx.processTitleDebounceTimers.get(channelId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.ctx.processTitleDebounceTimers.delete(channelId);
		}
	}

	// ─── Rate limiting ───────────────────────────────────────────────────────

	/**
	 * Sliding-window rate limiter: returns true if the event is allowed.
	 * Keeps at most `maxPerSecond` timestamps within the last 1000ms per channel.
	 */
	rateLimitCheck(store: Map<string, number[]>, channelId: string, maxPerSecond: number): boolean {
		const now = Date.now();
		const cutoff = now - 1000;
		let timestamps = store.get(channelId);
		if (!timestamps) {
			timestamps = [];
			store.set(channelId, timestamps);
		}
		// Evict entries older than 1 second
		while (timestamps.length > 0 && (timestamps[0] ?? 0) < cutoff) {
			timestamps.shift();
		}
		if (timestamps.length >= maxPerSecond) {
			return false;
		}
		timestamps.push(now);
		return true;
	}
}
