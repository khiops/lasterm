import type { ProtocolMessage } from "@lasterm/shared";
import { decodeMessage, encodeMessage } from "@lasterm/shared";
import type { IWsClient } from "./ws-client.js";

type MessageListener = (msg: ProtocolMessage) => void;
type LifecycleListener = () => void;
type RelayEvent = { event: "closed" | "transport_error"; message?: string | null };

const MAX_RELAYED_MESSAGE_BYTES = 512 * 1024;

/**
 * Desktop implementation of IWsClient.
 *
 * The Rust shell owns the pinned WebSocket. A Channel is only a push transport,
 * so each raw frame is acknowledged after this client has consumed it; Rust does
 * not read the next hub frame until that acknowledgement returns.
 */
export class DesktopWsClient implements IWsClient {
	private relayId: number | null = null;
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

	async connect(_url: string): Promise<void> {
		const { Channel, invoke } = await import("@tauri-apps/api/core");
		const generation = ++this.connectionGeneration;
		const stream = new Channel<ArrayBuffer | RelayEvent>((frame) => {
			if (generation !== this.connectionGeneration) return;
			this.pendingFrame = frame;
			this._drain();
		});

		const relayId = await invoke<number>("relay_hub_ws_connect", { stream });
		if (generation !== this.connectionGeneration) {
			void invoke("relay_hub_ws_close", { relayId }).catch(() => undefined);
			return;
		}
		this.relayId = relayId;
		this.reconnectUrl = _url;
		this.reconnectAttempt = 0;
		this._drain();
	}

	send(msg: ProtocolMessage): void {
		const relayId = this.relayId;
		if (relayId === null) throw new Error("WebSocket not connected");
		const encoded = encodeMessage(msg);
		void import("@tauri-apps/api/core")
			.then(({ invoke }) =>
				invoke("relay_hub_ws_send", encoded.buffer, {
					headers: { "X-Lasterm-Ws-Id": String(relayId) },
				}),
			)
			.catch((error: unknown) => this._transportFailure(String(error)));
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
		if (bytes.byteLength < 2 || (bytes[0] !== 0 && bytes[0] !== 1)) {
			this._transportFailure("invalid WebSocket relay frame");
			return;
		}
		const chunk = bytes.slice(1);
		this.messageBytes += chunk.byteLength;
		if (this.messageBytes > MAX_RELAYED_MESSAGE_BYTES) {
			this._transportFailure("WebSocket relay message exceeds its bounded size");
			return;
		}
		this.messageParts.push(chunk);
		if (bytes[0] === 1) {
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
		this._acknowledge();
	}

	private _acknowledge(): void {
		const relayId = this.relayId;
		if (relayId === null) return;
		void import("@tauri-apps/api/core")
			.then(({ invoke }) => invoke("relay_hub_ws_ack", { relayId }))
			.catch((error: unknown) => this._transportFailure(String(error)));
	}

	private _closed(): void {
		if (this.relayId === null) return;
		this.relayId = null;
		this.pendingFrame = undefined;
		this._resetMessage();
		for (const listener of this.disconnectListeners) listener();
		this._scheduleReconnect();
	}

	private _transportFailure(error: string): void {
		if (this.relayId === null) return;
		console.error("[DesktopWsClient] Transport failure:", error);
		this.relayId = null;
		this.pendingFrame = undefined;
		this._resetMessage();
		// A failed TLS handshake or vanished hub is not a protocol close. Do not
		// expose it as onDisconnect, which consumers treat as a reconnectable
		// closed session.
		this._scheduleReconnect();
	}

	private _scheduleReconnect(): void {
		const url = this.reconnectUrl;
		if (!url) return;
		const delays = [1000, 2000, 4000, 8000, 15000, 30000];
		const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			this.reconnectAttempt++;
			try {
				await this.connect(url);
				for (const listener of this.reconnectListeners) listener();
			} catch {
				this._scheduleReconnect();
			}
		}, delay);
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
