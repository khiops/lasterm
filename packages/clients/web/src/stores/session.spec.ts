import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./session.js";
import { useToastStore } from "./toast.js";

type Listener = (msg: ProtocolMessage) => void;

interface MockWsInstance {
	sent: ProtocolMessage[];
	emit: (msg: ProtocolMessage) => void;
	emitDisconnect: () => void;
	emitReconnect: () => void;
	/** How many times the transport was dialed: a redial drops the live socket. */
	connectCalls: number;
}

const wsHarness = vi.hoisted(() => ({
	instances: [] as MockWsInstance[],
	/** Hold AUTH_OK back, the way a hub answering over the network does. */
	deferAuth: false,
}));

vi.mock("../utils/hub-url.js", () => ({
	hubWsUrl: () => "ws://lasterm.test",
}));

vi.mock("../services/ws-client.js", () => {
	class MockWsClient {
		private connected = false;
		private readonly listeners = new Map<string, Set<Listener>>();
		private readonly disconnectListeners = new Set<() => void>();
		private readonly reconnectListeners = new Set<() => void>();
		readonly sent: ProtocolMessage[] = [];

		constructor() {
			wsHarness.instances.push(this);
		}

		connectCalls = 0;

		async connect(): Promise<void> {
			this.connectCalls++;
			this.connected = true;
		}

		send(msg: ProtocolMessage): void {
			this.sent.push(msg);
			if (msg.type === "AUTH" && !wsHarness.deferAuth) {
				this.emit({ type: "AUTH_OK", clientId: "client-1" });
			}
		}

		on(type: string, callback: Listener): () => void {
			if (!this.listeners.has(type)) this.listeners.set(type, new Set());
			this.listeners.get(type)?.add(callback);
			return () => {
				this.listeners.get(type)?.delete(callback);
			};
		}

		onReconnect(callback: () => void): () => void {
			this.reconnectListeners.add(callback);
			return () => this.reconnectListeners.delete(callback);
		}

		onDisconnect(callback: () => void): () => void {
			this.disconnectListeners.add(callback);
			return () => this.disconnectListeners.delete(callback);
		}

		close(): void {
			this.connected = false;
		}

		get isConnected(): boolean {
			return this.connected;
		}

		emit(msg: ProtocolMessage): void {
			for (const listener of this.listeners.get(msg.type) ?? []) {
				listener(msg);
			}
			for (const listener of this.listeners.get("*") ?? []) {
				listener(msg);
			}
		}

		emitDisconnect(): void {
			this.connected = false;
			for (const listener of this.disconnectListeners) listener();
		}

		/** The transport reconnected on its own and must be authenticated again. */
		emitReconnect(): void {
			this.connected = true;
			for (const listener of this.reconnectListeners) listener();
		}
	}

	return { WsClient: MockWsClient, createWsClient: () => new MockWsClient() };
});

const localStorageMap = new Map<string, string>();

vi.stubGlobal("localStorage", {
	getItem: (key: string) => localStorageMap.get(key) ?? null,
	setItem: (key: string, value: string) => localStorageMap.set(key, value),
	removeItem: (key: string) => localStorageMap.delete(key),
	clear: () => localStorageMap.clear(),
});

describe("useSessionStore — agent sync messages", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorageMap.clear();
		localStorageMap.set("lasterm_token", "test-token");
		wsHarness.instances.length = 0;
		wsHarness.deferAuth = false;
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("surfaces AGENT_SYNCED as an info toast", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();

		const toastStore = useToastStore();
		wsHarness.instances[0]?.emit({
			type: "AGENT_SYNCED",
			hostId: "host-1",
			hostname: "prod-box",
			message: "Agent on prod-box updated to the current version",
		});

		expect(toastStore.messages).toHaveLength(1);
		expect(toastStore.messages[0]).toMatchObject({
			level: "info",
			text: "Agent on prod-box updated to the current version",
		});
		expect(toastStore.messages[0]?.text).not.toContain("SHA256 mismatch");
	});

	it("does not surface legacy AGENT_UPDATED error frames as error toasts", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();

		const toastStore = useToastStore();
		wsHarness.instances[0]?.emit({
			type: "ERROR",
			code: "AGENT_UPDATED",
			message: "Legacy agent update notice",
		});

		expect(toastStore.messages).toHaveLength(0);
	});

	it("clears connected when the transport fails", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		expect(sessionStore.connected).toBe(true);

		wsHarness.instances[0]?.emitDisconnect();
		expect(sessionStore.connected).toBe(false);
	});
});

describe("useSessionStore — connect()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorageMap.clear();
		localStorageMap.set("lasterm_token", "test-token");
		wsHarness.instances.length = 0;
		wsHarness.deferAuth = false;
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// The hub closes any connection whose first message is not AUTH. A pane that
	// awaited connect() while the handshake was still in flight was told it could
	// go ahead, sent its ATTACH, and lost the connection and its own work with it.
	it("holds every caller until the handshake is answered", async () => {
		wsHarness.deferAuth = true;
		const sessionStore = useSessionStore();

		const first = sessionStore.connect();
		await Promise.resolve();
		const ws = wsHarness.instances[0];
		expect(ws?.sent.map((m) => m.type)).toEqual(["AUTH"]);

		let secondResolved = false;
		const second = sessionStore.connect().then(() => {
			secondResolved = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(secondResolved, "a caller was let through before AUTH_OK").toBe(false);

		ws?.emit({ type: "AUTH_OK", clientId: "client-1" });
		await first;
		await second;

		expect(secondResolved).toBe(true);
		// One handshake for both callers, and no second connection.
		expect(ws?.sent.filter((m) => m.type === "AUTH")).toHaveLength(1);
		expect(wsHarness.instances).toHaveLength(1);
	});
});

describe("useSessionStore — reconnect", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorageMap.clear();
		localStorageMap.set("lasterm_token", "test-token");
		wsHarness.instances.length = 0;
		wsHarness.deferAuth = false;
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Dialing a second socket closes the first under everyone, and that drop
	// starts the next reconnect: the app span its wheels, and no pane settled.
	// The transport can also be back before the store has re-authenticated, and
	// a caller landing in that window must wait rather than dial.
	it("joins the handshake of a reconnect instead of dialing again", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		const ws = wsHarness.instances[0];

		// A reconnect whose AUTH_OK has not landed yet
		wsHarness.deferAuth = true;
		ws?.emitReconnect();
		await vi.advanceTimersByTimeAsync(0);

		let resolved = false;
		const joined = sessionStore.connect().then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved, "a caller was let through mid-handshake").toBe(false);
		expect(ws?.connectCalls, "the live socket was dialed over").toBe(1);

		ws?.emit({ type: "AUTH_OK", clientId: "client-1" });
		await joined;
		expect(resolved).toBe(true);
		expect(ws?.connectCalls).toBe(1);
		expect(wsHarness.instances).toHaveLength(1);
	});
});

describe("useSessionStore — connect() with the transport already back", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		localStorageMap.clear();
		localStorageMap.set("lasterm_token", "test-token");
		wsHarness.instances.length = 0;
		wsHarness.deferAuth = false;
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for the handshake the reconnect will run, and dials nothing", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		const ws = wsHarness.instances[0];

		// The drop and its reconnect, as the transport reports them: the socket
		// is live again before the store has authenticated it.
		ws?.emitDisconnect();
		wsHarness.deferAuth = true;
		ws?.emitReconnect();

		let resolved = false;
		const waiting = sessionStore.connect().then(() => {
			resolved = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(resolved, "a caller was let through unauthenticated").toBe(false);
		expect(ws?.connectCalls, "the live socket was dialed over").toBe(1);

		ws?.emit({ type: "AUTH_OK", clientId: "client-1" });
		await waiting;
		expect(resolved).toBe(true);
		expect(ws?.connectCalls).toBe(1);
	});
});
