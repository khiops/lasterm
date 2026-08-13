import type { ProtocolMessage } from "@lasterm/shared";
import { decodeMessage, encodeMessage } from "@lasterm/shared";
import { isTauriRuntime } from "../utils/tauri-runtime.js";
import { DesktopWsClient } from "./desktop-ws-client.js";

type MessageListener = (msg: ProtocolMessage) => void;

/** Callback for client-side lifecycle events (not protocol messages). */
type LifecycleListener = () => void;

/**
 * Public interface for WsClient — used by composables to avoid
 * Pinia reactive proxy stripping private class members.
 */
export interface IWsClient {
	connect(url: string): Promise<void>;
	send(msg: ProtocolMessage): void;
	on(type: string, callback: MessageListener): () => void;
	onReconnect(callback: LifecycleListener): () => void;
	onDisconnect(callback: LifecycleListener): () => void;
	close(): void;
	readonly isConnected: boolean;
}

/** Selects the only client allowed for the active runtime. */
export function createWsClient(): IWsClient {
	return isTauriRuntime() ? new DesktopWsClient() : new WsClient();
}

/**
 * WebSocket client for hub communication.
 * Messages are raw MessagePack (no length-prefix framing — that is TCP-only).
 * Encoding/decoding delegates to @lasterm/shared codec (browser-safe: no Buffer).
 */
export class WsClient implements IWsClient {
	private ws: WebSocket | null = null;
	private listeners = new Map<string, Set<MessageListener>>();
	private reconnectListeners = new Set<LifecycleListener>();
	private disconnectListeners = new Set<LifecycleListener>();
	private reconnectUrl: string | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempt = 0;

	connect(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.binaryType = "arraybuffer";

			ws.onopen = () => {
				this.ws = ws;
				this.reconnectUrl = url;
				this.reconnectAttempt = 0;
				resolve();
			};

			ws.onerror = () => {
				reject(new Error(`WebSocket connection failed: ${url}`));
			};

			ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
				try {
					const data = new Uint8Array(event.data);
					const msg = decodeMessage(data);
					this._dispatch(msg);
				} catch (err) {
					console.error("[WsClient] Failed to decode message:", err);
				}
			};

			ws.onclose = () => {
				this.ws = null;
				for (const listener of this.disconnectListeners) {
					listener();
				}
				this._scheduleReconnect();
			};
		});
	}

	send(msg: ProtocolMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("WebSocket not connected");
		}
		const encoded = encodeMessage(msg);
		this.ws.send(encoded);
	}

	/**
	 * Subscribe to messages of a specific type.
	 * Use \"*\" to receive all messages.
	 * Returns an unsubscribe function.
	 */
	on(type: string, callback: MessageListener): () => void {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, new Set());
		}
		this.listeners.get(type)?.add(callback);
		return () => {
			this.listeners.get(type)?.delete(callback);
		};
	}

	/**
	 * Subscribe to client-side reconnect events.
	 * Unlike `on()`, this is NOT a protocol message — it fires when the WS
	 * auto-reconnects after a drop, so consumers can re-authenticate / refresh.
	 * Returns an unsubscribe function.
	 */
	onReconnect(callback: LifecycleListener): () => void {
		this.reconnectListeners.add(callback);
		return () => {
			this.reconnectListeners.delete(callback);
		};
	}

	/**
	 * Subscribe to client-side disconnect events.
	 * Fires when the WS connection drops (before auto-reconnect begins).
	 * Returns an unsubscribe function.
	 */
	onDisconnect(callback: LifecycleListener): () => void {
		this.disconnectListeners.add(callback);
		return () => {
			this.disconnectListeners.delete(callback);
		};
	}

	close(): void {
		this.reconnectUrl = null;
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.ws?.close();
		this.ws = null;
	}

	get isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
				// Notify reconnect listeners (client-side event, not a protocol message)
				for (const listener of this.reconnectListeners) {
					listener();
				}
			} catch {
				this._scheduleReconnect();
			}
		}, delay);
	}

	private _dispatch(msg: ProtocolMessage): void {
		// Type-specific listeners
		const typeListeners = this.listeners.get(msg.type);
		if (typeListeners) {
			for (const listener of typeListeners) {
				listener(msg);
			}
		}
		// Global catch-all listeners
		const globalListeners = this.listeners.get("*");
		if (globalListeners) {
			for (const listener of globalListeners) {
				listener(msg);
			}
		}
	}
}
