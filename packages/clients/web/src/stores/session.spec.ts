import type { Channel, ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { factsFromAttachOk, factsFromRefusal, paneCover } from "../utils/pane-cover.js";
import { useChannelsStore } from "./channels.js";
import { useConfigStore } from "./config.js";
import { useSessionStore } from "./session.js";
import { useThemeStore } from "./theme.js";
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

// ─── Configuration written elsewhere (#479) ─────────────────────────────────

describe("useSessionStore — CONFIG_CHANGED", () => {
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

	it("re-reads the UI sections when another client changed them", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		const configStore = useConfigStore();
		const loadUiConfig = vi.spyOn(configStore, "loadUiConfig").mockResolvedValue();

		wsHarness.instances[0]?.emit({ type: "CONFIG_CHANGED", scope: "ui" });

		expect(loadUiConfig).toHaveBeenCalledOnce();
	});

	it("tells the panes of a host that its profile changed", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		const configStore = useConfigStore();
		const events: unknown[] = [];
		configStore.onProfileChange((event) => events.push(event));

		wsHarness.instances[0]?.emit({ type: "CONFIG_CHANGED", scope: "host", hostId: "host-pi" });

		expect(events).toEqual([{ scope: "host", hostId: "host-pi" }]);
	});
});

describe("useSessionStore — CONFIG_CHANGED for the appearance", () => {
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

	it("re-reads and shows the appearance another client changed", async () => {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		const reload = vi.spyOn(useThemeStore(), "reloadAppearance").mockResolvedValue();

		wsHarness.instances[0]?.emit({ type: "CONFIG_CHANGED", scope: "appearance" });

		expect(reload).toHaveBeenCalledOnce();
	});
});

// ─── Reconnect, in a pane of a host not in view (#556) ──────────────────────
//
// Tabs are global, the channel list is the host in view's. A pane fronting a
// terminal on another host was answered from memory after a hub restart and
// said "Not connected". Its Reconnect brought the host back with the terminal
// gone, and the hub said so; the pane never heard it, and kept the banner
// until the page was reloaded.

describe("useSessionStore — a pane over another host's terminal, after Reconnect (#556)", () => {
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

	const PI_CHANNEL = "ch-on-the-pi";
	const LOCAL_CHANNEL: Channel = {
		id: "ch-local",
		sessionId: "s-local",
		shell: "pwsh",
		cols: 80,
		rows: 24,
		status: "live",
		createdAt: "2026-09-25T00:00:00Z",
		updatedAt: "2026-09-25T00:00:00Z",
	};

	/**
	 * The page as it loads after a hub restart: the rail shows the local host,
	 * and a tab shows a terminal on the Pi that the hub restored from meta.db.
	 */
	async function pageLoaded() {
		const sessionStore = useSessionStore();
		await sessionStore.connect();
		const channels = useChannelsStore();
		channels.activeHostId = "host-local";
		channels.channels = [LOCAL_CHANNEL];
		const ws = wsHarness.instances[0];
		ws?.emit({
			type: "STATE_SYNC",
			sessions: [
				{ sessionId: "s-local", hostId: "host-local", status: "active" },
				{ sessionId: "s-pi", hostId: "host-pi", status: "disconnected" },
			],
			channels: [
				{ channelId: LOCAL_CHANNEL.id, sessionId: "s-local", status: "live" },
				{ channelId: PI_CHANNEL, sessionId: "s-pi", status: "orphan" },
			],
		});
		return { ws, channels };
	}

	/** The Pi pane, whose attach was answered from what the hub remembers. */
	function piPane(channels: ReturnType<typeof useChannelsStore>) {
		return paneCover({
			status: channels.statusOf(PI_CHANNEL),
			ended: false,
			gone: false,
			detached: true,
		});
	}

	it("replaces Not connected with the exit overlay once the hub says the terminal ended", async () => {
		const { ws, channels } = await pageLoaded();
		expect(piPane(channels)).toBe("not-connected");

		// Reconnect: the hub reaches the Pi, whose new daemon holds nothing.
		ws?.emit({ type: "SESSION_STATE", sessionId: "s-pi", hostId: "host-pi", status: "active" });
		ws?.emit({ type: "CHANNEL_STATE", channelId: PI_CHANNEL, sessionId: "s-pi", status: "dead" });

		expect(piPane(channels)).toBe("exited");
		// The sidebar still lists the host in view, and only it.
		expect(channels.channels.map((c) => c.id)).toEqual([LOCAL_CHANNEL.id]);
	});

	// The pane attaches again when the hub says its terminal is live, and that
	// is said of a terminal that already was: each report has to be news.
	it("hands the pane every report that its terminal is live, the same one twice included", async () => {
		const { ws, channels } = await pageLoaded();
		const live = {
			type: "CHANNEL_STATE",
			channelId: PI_CHANNEL,
			sessionId: "s-pi",
			status: "live",
		} as const;

		ws?.emit(live);
		const first = channels.reportOf(PI_CHANNEL);
		ws?.emit(live);
		const second = channels.reportOf(PI_CHANNEL);

		expect(first?.status).toBe("live");
		expect(second?.status).toBe("live");
		expect(second).not.toBe(first);
		// Live is no ending: the banner stays until the attach answers.
		expect(piPane(channels)).toBe("not-connected");
	});

	// The pane must not bring back a terminal that was stopped from elsewhere,
	// and only the report says it was (#580).
	it("hands the pane why the hub ended a terminal, when the hub ended it", async () => {
		const { ws, channels } = await pageLoaded();

		ws?.emit({
			type: "CHANNEL_STATE",
			channelId: PI_CHANNEL,
			sessionId: "s-pi",
			status: "dead",
			endReason: "destroyed",
		});
		expect(channels.reportOf(PI_CHANNEL)).toEqual({ status: "dead", endReason: "destroyed" });

		ws?.emit({
			type: "CHANNEL_STATE",
			channelId: PI_CHANNEL,
			sessionId: "s-pi",
			status: "dead",
			exitCode: 0,
		});
		expect(channels.reportOf(PI_CHANNEL)).toEqual({ status: "dead", exitCode: 0 });
	});

	// A STATE_SYNC follows every new socket, and the pane attaches again. What
	// both say is what holds now, not what this window heard before (#559).
	it("takes what the STATE_SYNC of a new socket says over a report from before it", async () => {
		const { ws, channels } = await pageLoaded();
		// The Pi terminal ends while this window watches, and the pane is told.
		ws?.emit({ type: "CHANNEL_STATE", channelId: PI_CHANNEL, sessionId: "s-pi", status: "dead" });
		const ended = factsFromRefusal("CHANNEL_DEAD");
		if (ended === null) throw new Error("expected an answer");
		expect(paneCover({ status: channels.statusOf(PI_CHANNEL), ...ended })).toBe("exited");

		// The socket drops. Meanwhile the terminal is restarted from another
		// window, and this one misses the news. The socket comes back.
		const sync: ProtocolMessage = {
			type: "STATE_SYNC",
			sessions: [
				{ sessionId: "s-local", hostId: "host-local", status: "active" },
				{ sessionId: "s-pi-2", hostId: "host-pi", status: "active" },
			],
			channels: [
				{ channelId: LOCAL_CHANNEL.id, sessionId: "s-local", status: "live" },
				{ channelId: PI_CHANNEL, sessionId: "s-pi-2", status: "live" },
			],
		};
		ws?.emit(sync);

		// The pane attaches again, and reaches the terminal: nothing covers it.
		expect(channels.statusOf(PI_CHANNEL)).toBe("live");
		expect(
			paneCover({ status: channels.statusOf(PI_CHANNEL), ...factsFromAttachOk(false) }),
		).toBeNull();
		// Said again, the same status is no news for the pane to act on.
		const report = channels.reportOf(PI_CHANNEL);
		ws?.emit(sync);
		expect(channels.reportOf(PI_CHANNEL)).toBe(report);
		// And the sidebar still lists the host in view, and only it.
		expect(channels.channels.map((c) => c.id)).toEqual([LOCAL_CHANNEL.id]);
	});
});
