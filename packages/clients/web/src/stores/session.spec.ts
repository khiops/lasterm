import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./session.js";
import { useToastStore } from "./toast.js";

type Listener = (msg: ProtocolMessage) => void;

interface MockWsInstance {
	sent: ProtocolMessage[];
	emit: (msg: ProtocolMessage) => void;
}

const wsHarness = vi.hoisted(() => ({
	instances: [] as MockWsInstance[],
}));

vi.mock("../utils/hub-url.js", () => ({
	hubWsUrl: () => "ws://lasterm.test",
}));

vi.mock("../services/ws-client.js", () => {
	class MockWsClient {
		private connected = false;
		private readonly listeners = new Map<string, Set<Listener>>();
		readonly sent: ProtocolMessage[] = [];

		constructor() {
			wsHarness.instances.push(this);
		}

		async connect(): Promise<void> {
			this.connected = true;
		}

		send(msg: ProtocolMessage): void {
			this.sent.push(msg);
			if (msg.type === "AUTH") {
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

		onReconnect(): () => void {
			return () => {};
		}

		onDisconnect(): () => void {
			return () => {};
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
	}

	return { WsClient: MockWsClient };
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
});
