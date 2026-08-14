import type { ProtocolMessage } from "@lasterm/shared";
import { decodeMessage, encodeMessage } from "@lasterm/shared";
import type { IWsClient } from "./ws-client.js";

type MessageListener = (msg: ProtocolMessage) => void;
type LifecycleListener = () => void;
type RelayEvent = { event: "closed" | "transport_error"; message?: string | null };
type PendingRelaySend = {
	relayId: string;
	generation: number;
	payload: ArrayBuffer;
};

const MAX_RELAYED_MESSAGE_BYTES = 512 * 1024;
const MAX_PENDING_RELAY_SENDS = 2;
const RELAY_FRAME_ENVELOPE_BYTES = 33;

/**
 * Desktop implementation of IWsClient.
 *
 * The Rust shell owns the pinned WebSocket. A Channel is only a push transport,
 * so each raw frame is acknowledged after this client has consumed it; Rust does
 * not read the next hub frame until that acknowledgement returns.
 */
export class DesktopWsClient implements IWsClient {
	private relayId: string | null = null;
	private listeners = new Map<string, Set<MessageListener>>();
	private reconnectListeners = new Set<LifecycleListener>();
	private disconnectListeners = new Set<LifecycleListener>();
	private reconnectUrl: string | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;
	private connectionGeneration = 0;
	private pendingFrame: ArrayBuffer | RelayEvent | undefined;
	private messageParts: Uint8Array[] = [];
	private messageBytes = 0;
	private nextInboundSequence = 1n;
	private pendingSends: PendingRelaySend[] = [];
	private sendInFlight = false;

	async connect(_url: string): Promise<void> {
		await this._connect(_url);
	}

	private async _connect(url: string): Promise<{ connected: boolean; generation: number }> {
		const { Channel, invoke } = await import("@tauri-apps/api/core");
		this._cancelReconnect();
		const generation = ++this.connectionGeneration;
		const previousRelayId = this.relayId;
		// A new connect supersedes the old receive callback immediately. Leaving
		// the old id live until the new native dial succeeds makes a failed
		// replacement look connected even though it can no longer receive frames.
		this.relayId = null;
		this.pendingFrame = undefined;
		this._resetMessage();
		this.nextInboundSequence = 1n;
		if (previousRelayId !== null) {
			this.pendingSends = this.pendingSends.filter((send) => send.relayId !== previousRelayId);
			void invoke("relay_hub_ws_close", { relayId: previousRelayId }).catch(() => undefined);
		}
		const stream = new Channel<ArrayBuffer | RelayEvent>((frame) => {
			if (generation !== this.connectionGeneration) return;
			this.pendingFrame = frame;
			this._drain();
		});

		const relayId = String(await invoke<string>("relay_hub_ws_connect", { stream }));
		if (generation !== this.connectionGeneration) {
			void invoke("relay_hub_ws_close", { relayId }).catch(() => undefined);
			return { connected: false, generation };
		}
		this.relayId = relayId;
		this.reconnectUrl = url;
		this.reconnectAttempt = 0;
		this._drain();
		return { connected: true, generation };
	}

	send(msg: ProtocolMessage): void {
		const relayId = this.relayId;
		if (relayId === null) throw new Error("WebSocket not connected");
		const generation = this.connectionGeneration;
		// Encode before reserving a queue slot. Invalid work must not consume the
		// bounded capacity needed by valid protocol messages behind it.
		const payload = encodeMessage(msg).slice().buffer;
		if (this.pendingSends.length >= MAX_PENDING_RELAY_SENDS) {
			this._transportFailure("WebSocket relay send queue is full", relayId, generation);
			return;
		}
		this.pendingSends.push({ relayId, generation, payload });
		void this._drainSends();
	}

	on(type: string, callback: MessageListener): () => void {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set());
		this.listeners.get(type)?.add(callback);
		return () => this.listeners.get(type)?.delete(callback);
	}

	onReconnect(callback: LifecycleListener): () => void {
		this.reconnectListeners.add(callback);
		return () => this.reconnectListeners.delete(callback);
	}

	onDisconnect(callback: LifecycleListener): () => void {
		this.disconnectListeners.add(callback);
		return () => this.disconnectListeners.delete(callback);
	}

	close(): void {
		this.reconnectUrl = null;
		this.connectionGeneration++;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const relayId = this.relayId;
		this.relayId = null;
		this.pendingFrame = undefined;
		this._resetMessage();
		this.pendingSends = [];
		if (relayId !== null) {
			void import("@tauri-apps/api/core")
				.then(({ invoke }) => invoke("relay_hub_ws_close", { relayId }))
				.catch(() => undefined);
		}
	}

	get isConnected(): boolean {
		return this.relayId !== null;
	}

	private _drain(): void {
		if (this.relayId === null || this.pendingFrame === undefined) return;
		const frame = this.pendingFrame;
		this.pendingFrame = undefined;
		if (frame instanceof ArrayBuffer) {
			this._receiveChunk(frame);
		} else if (frame.event === "closed") {
			this._closed();
		} else {
			this._transportFailure(frame.message ?? "pinned hub WebSocket transport failed");
		}
	}

	private _receiveChunk(frame: ArrayBuffer): void {
		const bytes = new Uint8Array(frame);
		if (bytes.byteLength < RELAY_FRAME_ENVELOPE_BYTES) {
			this._transportFailure("invalid WebSocket relay frame");
			return;
		}
		const view = new DataView(frame);
		const relayId = view.getBigUint64(0, true).toString();
		const sequence = view.getBigUint64(8, true);
		if (relayId !== this.relayId || sequence !== this.nextInboundSequence) {
			this._transportFailure("WebSocket relay frame belongs to another relay or position");
			return;
		}
		const end = bytes[RELAY_FRAME_ENVELOPE_BYTES - 1];
		const marker = bytes[RELAY_FRAME_ENVELOPE_BYTES];
		if (end !== 0 || (marker !== 0 && marker !== 1)) {
			this._transportFailure("invalid WebSocket relay frame");
			return;
		}
		this.nextInboundSequence++;
		const acknowledgementToken = base64Url(bytes.slice(16, 32));
		const chunk = bytes.slice(RELAY_FRAME_ENVELOPE_BYTES + 1);
		this.messageBytes += chunk.byteLength;
		if (this.messageBytes > MAX_RELAYED_MESSAGE_BYTES) {
			this._transportFailure("WebSocket relay message exceeds its bounded size");
			return;
		}
		this.messageParts.push(chunk);
		if (marker === 1) {
			const message = new Uint8Array(this.messageBytes);
			let offset = 0;
			for (const part of this.messageParts) {
				message.set(part, offset);
				offset += part.byteLength;
			}
			this._resetMessage();
			try {
				this._dispatch(decodeMessage(message));
			} catch (error) {
				console.error("[DesktopWsClient] Failed to decode message:", error);
			}
		}
		this._acknowledge(relayId, sequence.toString(), acknowledgementToken);
	}

	private _acknowledge(relayId: string, sequence: string, acknowledgementToken: string): void {
		if (!this._isCurrentRelay(relayId)) return;
		const generation = this.connectionGeneration;
		void import("@tauri-apps/api/core")
			.then(({ invoke }) => invoke("relay_hub_ws_ack", { relayId, sequence, acknowledgementToken }))
			.catch((error: unknown) => this._transportFailure(String(error), relayId, generation));
	}

	private _closed(): void {
		if (this.relayId === null) return;
		this.relayId = null;
		this.pendingFrame = undefined;
		this._resetMessage();
		this.pendingSends = [];
		for (const listener of this.disconnectListeners) listener();
		this._scheduleReconnect();
	}

	private _transportFailure(error: string, relayId?: string, generation?: number): void {
		if (
			this.relayId === null ||
			(relayId !== undefined && !this._isCurrentRelay(relayId, generation))
		) {
			return;
		}
		console.error("[DesktopWsClient] Transport failure:", error);
		const activeRelayId = this.relayId;
		this.relayId = null;
		this.pendingFrame = undefined;
		this._resetMessage();
		this.pendingSends = [];
		if (activeRelayId !== null) {
			void import("@tauri-apps/api/core")
				.then(({ invoke }) => invoke("relay_hub_ws_close", { relayId: activeRelayId }))
				.catch((closeError: unknown) =>
					console.error("[DesktopWsClient] Failed to close relay:", closeError),
				);
		}
		for (const listener of this.disconnectListeners) listener();
		this._scheduleReconnect();
	}

	private _isCurrentRelay(relayId: string, generation = this.connectionGeneration): boolean {
		return this.relayId === relayId && this.connectionGeneration === generation;
	}

	/**
	 * Tauri commands are asynchronous even when Rust immediately accepts a
	 * message. Keep exactly one call in flight so the native input queue observes
	 * the caller's order; the bounded JS queue is the only place B may wait for A.
	 */
	private async _drainSends(): Promise<void> {
		if (this.sendInFlight) return;
		const send = this.pendingSends[0];
		if (!send) return;
		this.sendInFlight = true;
		try {
			const { invoke } = await import("@tauri-apps/api/core");
			await invoke("relay_hub_ws_send", send.payload, {
				headers: { "X-Lasterm-Ws-Id": String(send.relayId) },
			});
		} catch (error) {
			if (this._isCurrentRelay(send.relayId, send.generation)) {
				this._transportFailure(String(error), send.relayId, send.generation);
			}
		} finally {
			// `close` and a replacement connect may already have discarded this
			// entry. Remove only this completed work, never a newer relay's head.
			const index = this.pendingSends.indexOf(send);
			if (index !== -1) this.pendingSends.splice(index, 1);
			this.sendInFlight = false;
			void this._drainSends();
		}
	}

	private _scheduleReconnect(): void {
		const url = this.reconnectUrl;
		if (!url) return;
		const delays = [1000, 2000, 4000, 8000, 15000, 30000];
		const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
		const scheduledGeneration = this.connectionGeneration;
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (scheduledGeneration !== this.connectionGeneration || this.reconnectUrl !== url) return;
			this.reconnectAttempt++;
			try {
				const connection = await this._connect(url);
				if (
					connection.connected &&
					this.reconnectUrl === url &&
					this.relayId !== null &&
					this._isCurrentRelay(this.relayId, connection.generation)
				) {
					for (const listener of this.reconnectListeners) listener();
				}
			} catch {
				this._scheduleReconnect();
			}
		}, delay);
	}

	private _cancelReconnect(): void {
		if (this.reconnectTimer === null) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private _resetMessage(): void {
		this.messageParts = [];
		this.messageBytes = 0;
	}

	private _dispatch(msg: ProtocolMessage): void {
		for (const listener of this.listeners.get(msg.type) ?? []) listener(msg);
		for (const listener of this.listeners.get("*") ?? []) listener(msg);
	}
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
