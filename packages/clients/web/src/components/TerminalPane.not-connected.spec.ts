/**
 * A new terminal whose host asked for a key's passphrase, and none was given
 * (#875): no shell ever started, so the pane says it is not connected, offers
 * Connect, which asks again, and Close. It said "AUTH_CANCELLED: Authentication
 * cancelled by user", as an error, and tried again by itself, asking again,
 * whenever the connection to the hub came back.
 *
 * The pane is mounted whole; only xterm, which needs a real canvas, is
 * replaced. The hub is a socket that answers each SPAWN the way the hub does
 * when the person cancels the prompt.
 */
import { ErrorCode } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";

vi.mock("../composables/useTerminal.js", async () => {
	const { useTerminalSearch } = await import("../composables/useTerminalSearch.js");
	return {
		useTerminal: () => ({
			terminal: ref({ cols: 80, rows: 24, onBell: () => {}, scrollToBottom: () => {} }),
			awaitFont: async () => {},
			canWrite: ref(false),
			currentDynamicTitle: ref(""),
			search: useTerminalSearch(),
			init: () => ({ cols: 80, rows: 24 }),
			attachChannel: () => {},
			reattachChannel: async () => ({ writeLockHolder: null, cached: false, truncated: false }),
			applyProfile: () => {},
			suppressNextResize: () => {},
			syncChannelSize: () => {},
			setDecidesSize: () => {},
			dispose: () => {},
			fitAddon: {},
		}),
	};
});

import { useChannelsStore } from "../stores/channels.js";
import { useSessionStore } from "../stores/session.js";
import TerminalPane from "./TerminalPane.vue";

const HOST = "host-pi";
const TEMP_ID = "pending-1";

type Listener = (msg: unknown) => void;

let app: App | null = null;
let root: HTMLElement;
let spawns: { hostId?: string; requestId?: string }[];
let closed: unknown[][];

/**
 * A hub that asks for the key's passphrase on every SPAWN, and answers it as
 * the hub does once the person cancelled: AUTH_CANCELLED, under the SPAWN's name.
 */
function hubWhosePassphraseIsCancelled(): void {
	const listeners = new Map<string, Listener[]>();
	const emit = (msg: { type: string } & Record<string, unknown>): void => {
		for (const cb of listeners.get(msg.type) ?? []) cb(msg);
	};
	const socket = {
		isConnected: true,
		on: vi.fn((type: string, cb: Listener) => {
			listeners.set(type, [...(listeners.get(type) ?? []), cb]);
			return () =>
				listeners.set(
					type,
					(listeners.get(type) ?? []).filter((c) => c !== cb),
				);
		}),
		send: vi.fn((msg: { type: string; hostId?: string; requestId?: string }) => {
			if (msg.type !== "SPAWN") return;
			spawns.push(msg);
			setTimeout(() => {
				emit({
					type: "AUTH_PROMPT",
					hostId: msg.hostId,
					promptType: "passphrase",
					message: "Enter passphrase for ~/.ssh/id_ed25519",
					promptId: `prompt-${spawns.length}`,
					deliveryEpoch: 1,
				});
				emit({
					type: "ERROR",
					code: ErrorCode.AUTH_CANCELLED,
					message: "Authentication cancelled by user",
					requestId: msg.requestId,
				});
			}, 0);
		}),
	};
	const sessionStore = useSessionStore();
	sessionStore.hubEchoesSpawnRequestId = true;
	sessionStore.wsClient = socket as unknown as typeof sessionStore.wsClient;
	vi.spyOn(sessionStore, "connect").mockResolvedValue();
}

/** The pane App.vue opens for "New channel": a spawn it owes, under a temporary id. */
async function openNewTerminal(): Promise<void> {
	const pinia = createPinia();
	setActivePinia(pinia);
	hubWhosePassphraseIsCancelled();
	useChannelsStore().registerPendingSpawn(TEMP_ID, HOST);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(TerminalPane, {
				channelId: TEMP_ID,
				hostId: HOST,
				onClosePane: (...args: unknown[]) => closed.push(args),
			}),
	});
	app.use(pinia);
	app.mount(root);
	await vi.waitFor(() => expect(spawns).toHaveLength(1));
	await vi.waitFor(() => expect(paneText()).not.toContain("Connecting…"));
}

const paneText = (): string => root.textContent?.replace(/\s+/g, " ") ?? "";

function button(label: string): HTMLButtonElement | undefined {
	return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

beforeEach(() => {
	spawns = [];
	closed = [];
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("TerminalPane: a new terminal whose passphrase was not given (#875)", () => {
	it("says it is not connected, and offers Connect and Close", async () => {
		await openNewTerminal();

		expect(paneText()).toContain("Not connected: the passphrase was not given");
		// Not an exit: no shell ever ran.
		expect(root.querySelector(".exit-overlay")).toBeNull();
		expect(paneText()).not.toContain("exited");
		// Not a failure, and no code for logs.
		expect(paneText()).not.toContain("AUTH_CANCELLED");
		expect(button("Retry")).toBeUndefined();
		expect(button("Restart")).toBeUndefined();
		expect(button("Connect")).toBeDefined();

		button("Close")?.click();
		expect(closed).toEqual([[TEMP_ID]]);
	});

	it("asks again on Connect, by spawning the terminal again", async () => {
		await openNewTerminal();

		button("Connect")?.click();
		await nextTick();

		expect(spawns).toHaveLength(2);
		expect(spawns[1]?.hostId).toBe(HOST);
		expect(paneText()).toContain("Connecting…");
		// Cancelled once more: the pane says so again.
		await vi.waitFor(() =>
			expect(paneText()).toContain("Not connected: the passphrase was not given"),
		);
	});

	// A pane that failed tries again when the hub's connection comes back. This
	// one did not fail: trying again would put the question back on screen
	// with nobody having asked for it.
	it("does not ask again by itself when the connection to the hub comes back", async () => {
		await openNewTerminal();

		useSessionStore().reconnectCount++;
		await nextTick();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(spawns).toHaveLength(1);
		expect(paneText()).toContain("Not connected: the passphrase was not given");
	});
});
