/**
 * A new terminal's pane after the page reloads (#992).
 *
 * The layout is saved with the ids of new terminals that never started, so a
 * new page restores leaves over ids no hub ever created a terminal for. The
 * pane attached over one anyway, which the hub answers as a terminal it has no
 * record of, and the pane said "This terminal no longer exists" over what was
 * only a terminal nobody had asked it to start yet.
 *
 * The pane is mounted whole; only xterm, which needs a real canvas, is
 * replaced. The hub is a socket that answers an ATTACH the way the hub does for
 * a terminal it never created.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, type Ref, ref } from "vue";

/** Every ATTACH the pane sent, and the hub's answer: it has no such record, but for `known`. */
const asked = vi.hoisted(() => ({ attaches: [] as string[], known: new Set<string>() }));

vi.mock("../composables/useTerminal.js", async () => {
	const { useTerminalSearch } = await import("../composables/useTerminalSearch.js");
	return {
		ATTACH_SUPERSEDED: "ATTACH_SUPERSEDED",
		useTerminal: () => ({
			terminal: ref({ cols: 80, rows: 24, onBell: () => {}, scrollToBottom: () => {} }),
			awaitFont: async () => {},
			canWrite: ref(false),
			currentDynamicTitle: ref(""),
			search: useTerminalSearch(),
			init: () => ({ cols: 80, rows: 24 }),
			attachChannel: () => {},
			reattachChannel: async (channelId: string) => {
				asked.attaches.push(channelId);
				if (asked.known.has(channelId)) {
					return { writeLockHolder: null, cached: false, truncated: false };
				}
				// No terminal was ever created under the id, which is what an
				// ATTACH for one learns.
				throw Object.assign(new Error("No such terminal."), {
					code: "CHANNEL_NOT_FOUND",
				});
			},
			applyProfile: () => {},
			isBoundTo: () => false,
			turnMouseReportingOff: () => {},
			suppressNextResize: () => {},
			syncChannelSize: () => {},
			setDecidesSize: () => {},
			dispose: () => {},
			fitAddon: {},
			onBell: () => {},
			onScroll: () => {},
		}),
	};
});

import { useChannelsStore } from "../stores/channels.js";
import { useSessionStore } from "../stores/session.js";
import TerminalPane from "./TerminalPane.vue";

const HOST = "host-pi";
const TEMP_ID = "pending-1";
/** A terminal the hub has a record of. */
const LIVE_ID = "01HZZZZZZZZZZZZZZZZZZZZZY3";

type Listener = (msg: unknown) => void;

let app: App | null = null;
let root: HTMLElement;
let spawns: { hostId?: string; requestId?: string }[];
let closed: unknown[][];

/**
 * A hub that has no terminal under any id but the ones it started: an ATTACH
 * for another is answered CHANNEL_NOT_FOUND, as the hub answers for an id it
 * never created. The `useTerminal` stand-in above is what throws it.
 */
function hubWithNoRecordOfTheId(): void {
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
					type: "SPAWN_OK",
					channelId: "started-1",
					hostId: msg.hostId,
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

/**
 * The page after a reload: a fresh set of stores, over the storage the page
 * before it left. `owed` is what that page had registered and not sent; `sent`
 * is the same, but with the SPAWN out and unanswered when it went away.
 *
 * The pane is mounted once, over `channel`, which `show` can point at another
 * id afterwards: the layout reuses the instance when the id of a leaf changes,
 * keeping its `paneId` as the key.
 */
async function reloadedPage(
	owed: boolean,
	show?: Ref<string>,
	{ sent = false }: { sent?: boolean } = {},
): Promise<void> {
	if (owed || sent) {
		// The page before this one: its store writes down the host it owed the
		// spawn for, then goes away.
		setActivePinia(createPinia());
		const store = useChannelsStore();
		store.registerPendingSpawn(TEMP_ID, HOST);
		if (sent) {
			store.holdPendingSpawn(TEMP_ID);
			store.runPendingSpawn(TEMP_ID, 80, 24);
		}
	}
	const pinia = createPinia();
	setActivePinia(pinia);
	hubWithNoRecordOfTheId();
	root = document.createElement("div");
	document.body.appendChild(root);
	const shown = show ?? ref(TEMP_ID);
	app = createApp({
		render: () =>
			h(TerminalPane, {
				channelId: shown.value,
				hostId: HOST,
				onClosePane: (...args: unknown[]) => closed.push(args),
				onChannelSpawned: (tempId: string, realId: string) => {
					spawned.push([tempId, realId]);
				},
			}),
	});
	app.use(pinia);
	app.mount(root);
	await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

let spawned: unknown[][];

const paneText = (): string => root.textContent?.replace(/\s+/g, " ") ?? "";

function button(label: string): HTMLButtonElement | undefined {
	return [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
}

beforeEach(() => {
	spawns = [];
	asked.attaches = [];
	closed = [];
	spawned = [];
	localStorage.clear();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("TerminalPane: a new terminal's pane after a reload (#992)", () => {
	it("does not say the terminal is gone", async () => {
		await reloadedPage(true);

		expect(paneText()).not.toContain("no longer exists");
		expect(root.querySelector(".exit-overlay")).toBeNull();
	});

	it("starts nothing by itself: the load is no request for a terminal", async () => {
		await reloadedPage(true);

		expect(spawns).toHaveLength(0);
	});

	it("asks the hub for nothing: no terminal was ever created under the id", async () => {
		await reloadedPage(true);

		expect(asked.attaches).toHaveLength(0);
	});

	it("offers to start the terminal again, on the host it was for", async () => {
		await reloadedPage(true);

		expect(button("Start")).toBeDefined();

		button("Start")?.click();
		await nextTick();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(spawns).toHaveLength(1);
		expect(spawns[0]?.hostId).toBe(HOST);
	});

	it("says the terminal is gone for an id with no spawn owed", async () => {
		await reloadedPage(false);

		expect(paneText()).toContain("no longer exists");
	});

	// The page went away with the SPAWN out and unanswered. The hub may have
	// created the terminal, so attaching is what finds it: starting one again
	// would leave a second terminal nobody asked for (#992).
	it("attaches rather than starting a second terminal for a spawn already sent", async () => {
		await reloadedPage(false, undefined, { sent: true });

		expect(spawns).toHaveLength(0);
		expect(asked.attaches).toContain(TEMP_ID);
		// A kind of "gone" the hub has to answer, not one the pane assumes.
		expect(paneText()).not.toContain("never started");
	});

	// The layout keeps a pane's instance when the id of its leaf changes: that is
	// how the sidebar opens a terminal in the pane in front (#965, #971). The card
	// belongs to the id, so it goes with the id it was shown for.
	it("takes the card off when the pane is given a terminal that exists", async () => {
		asked.known.add(LIVE_ID);
		const show = ref(TEMP_ID);
		await reloadedPage(true, show);
		expect(button("Start")).toBeDefined();

		show.value = LIVE_ID;
		await nextTick();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await nextTick();

		expect(paneText()).not.toContain("never started");
		expect(button("Start")).toBeUndefined();
		expect(asked.attaches).toContain(LIVE_ID);
	});
});
