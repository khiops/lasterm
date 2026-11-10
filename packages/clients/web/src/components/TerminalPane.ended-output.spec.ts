/**
 * A pane over a terminal that has ended (#927). It asks the hub for it even
 * when its list says it ended, and shows what the terminal last printed under
 * its exit card. It keeps an ending it watched when its socket comes back,
 * writes nothing of a terminal it has left, and Restart keeps the last output
 * above the new shell.
 *
 * The pane is mounted whole over its real terminal composable. Only xterm and
 * its addons, which need a real canvas, are stood in, as in
 * composables/useTerminal.spec.ts, and record every clear and write. The hub
 * is a socket the test answers.
 */
import type { EndedOutput } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, type Ref, ref } from "vue";

const xterm = vi.hoisted(() => ({
	/** Clears and writes in order: "<reset>" for a clear, the text for a write. */
	events: [] as string[],
	/**
	 * When a write is parsed: "now", inside `write()`, as xterm does right
	 * after user input; "later", when the test drains, as xterm's timer does.
	 * A parse rings the bell for a BEL, then calls the write's callback.
	 */
	parse: "now" as "now" | "later",
	queue: [] as Array<() => void>,
	/** The terminal settings the pane reads. */
	profile: {} as Record<string, unknown>,
}));

/** Parse every write taken so far, in order. */
function drain(): void {
	for (let next = xterm.queue.shift(); next !== undefined; next = xterm.queue.shift()) next();
}

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "" };
		element = document.createElement("div");
		buffer = { active: { viewportY: 0, baseY: 0, length: 0 } };
		_core = { _renderService: { dimensions: { css: { cell: { width: 9, height: 17 } } } } };
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
		}
		loadAddon(addon: { activate?: (terminal: unknown) => void }): void {
			addon.activate?.(this);
		}
		open(): void {}
		onData() {
			return { dispose() {} };
		}
		onResize() {
			return { dispose() {} };
		}
		onTitleChange() {
			return { dispose() {} };
		}
		private bellListeners: Array<() => void> = [];
		onBell(listener: () => void) {
			this.bellListeners.push(listener);
			return { dispose() {} };
		}
		onScroll() {
			return { dispose() {} };
		}
		attachCustomKeyEventHandler(): void {}
		hasSelection(): boolean {
			return false;
		}
		focus(): void {}
		scrollToBottom(): void {}
		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
		}
		reset(): void {
			xterm.events.push("<reset>");
		}
		write(data: string | Uint8Array, callback?: () => void): void {
			const text = typeof data === "string" ? data : new TextDecoder().decode(data);
			if (text !== "") xterm.events.push(text);
			const parse = () => {
				if (text.includes("\u0007")) for (const listener of this.bellListeners) listener();
				callback?.();
			};
			if (xterm.parse === "now") parse();
			else xterm.queue.push(parse);
		}
		dispose(): void {}
	},
}));

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		activate(): void {}
		fit(): void {}
	},
}));

vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

vi.mock("@xterm/addon-search", () => ({
	SearchAddon: class {
		findNext = vi.fn(() => true);
		findPrevious = vi.fn(() => true);
		clearDecorations = vi.fn();
		clearActiveDecoration = vi.fn();
		dispose = vi.fn();
		onDidChangeResults = vi.fn(() => ({ dispose() {} }));
	},
}));

vi.mock("../composables/terminal-font.js", () => ({
	awaitTerminalFont: () => Promise.resolve(),
}));

// The terminal's settings, read for it at once: "When a terminal ends" asks,
// its default, so an end the pane finds shows the card (#592, #595).
vi.mock("../composables/useResolvedProfile.js", async () => {
	const { DEFAULT_PROFILE } = await import("@lasterm/shared");
	const { computed, ref } = await import("vue");
	return {
		useResolvedProfile: (
			hostId: { value: string | null | undefined },
			channelId: { value: string | null | undefined },
		) => ({
			profile: ref({ ...DEFAULT_PROFILE, ...xterm.profile }),
			resolvedFor: computed(() => ({
				hostId: hostId.value ?? null,
				channelId: channelId.value ?? null,
			})),
			reload: async () => {},
		}),
	};
});

vi.mock("../composables/useBellSound.js", () => ({ playBellSound: vi.fn() }));

import { playBellSound } from "../composables/useBellSound.js";
import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useSessionStore } from "../stores/session.js";
import TerminalPane from "./TerminalPane.vue";

const HOST = "01HZZZZZZZZZZZZZZZZZZZZZH0";
const T = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const S = "01HZZZZZZZZZZZZZZZZZZZZZS2";
const MOUSE_OFF = "\u001b[?1000l";

type Listener = (msg: unknown) => void;

let app: App | null = null;
let root: HTMLElement;
let sent: Array<{ type: string } & Record<string, unknown>>;
let hear: (msg: { type: string } & Record<string, unknown>) => void;

/** A hub the test answers: every frame the pane sends is kept in `sent`. */
function fakeHub(): void {
	const listeners = new Map<string, Listener[]>();
	hear = (msg) => {
		for (const cb of [...(listeners.get(msg.type) ?? [])]) cb(msg);
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
		onReconnect: () => () => {},
		onDisconnect: () => () => {},
		send: vi.fn((msg: { type: string } & Record<string, unknown>) => {
			sent.push(msg);
		}),
	};
	// Restart asks only a hub the window is paired with.
	useAuthStore().token = "a".repeat(64);
	const sessionStore = useSessionStore();
	sessionStore.hubEchoesSpawnRequestId = true;
	sessionStore.connected = true;
	sessionStore.wsClient = socket as unknown as typeof sessionStore.wsClient;
	vi.spyOn(sessionStore, "connect").mockResolvedValue();
}

const attaches = () => sent.filter((m) => m.type === "ATTACH");
const spawns = () => sent.filter((m) => m.type === "SPAWN");
const paneText = (): string => root.textContent?.replace(/\s+/g, " ") ?? "";
const button = (label: string) =>
	[...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

const lastOutput = (over: Partial<EndedOutput> = {}): EndedOutput => ({
	snapshot: { serialized: "LAST-SCREEN", cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
	tail: [new TextEncoder().encode("fail: no such file")],
	cols: 100,
	rows: 30,
	...over,
});

function refuse(channelId: string, last?: EndedOutput): void {
	hear({
		type: "ERROR",
		code: "CHANNEL_DEAD",
		message: "This terminal has ended.",
		channelId,
		...(last !== undefined && { lastOutput: last }),
	});
}

function attachOk(channelId: string, serialized: string): void {
	hear({
		type: "ATTACH_OK",
		channelId,
		snapshot: { serialized, cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
		tail: [],
		writeLockHolder: null,
		cached: false,
		cols: 100,
		rows: 30,
	});
}

/** Mount a pane over `channel`, whose terminal the client's list says is `status`. */
function mountPane(channel: Ref<string>, status: "dead" | "live"): void {
	const pinia = createPinia();
	setActivePinia(pinia);
	fakeHub();
	const channels = useChannelsStore();
	channels.registerChannelHost(T, HOST);
	channels.registerChannelHost(S, HOST);
	channels.updateChannelStatus(T, status, status === "dead" ? 1 : undefined);
	channels.updateChannelStatus(S, "dead", 1);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(TerminalPane, { channelId: channel.value, hostId: HOST }) });
	app.use(pinia);
	app.mount(root);
}

/** Let promises and watchers run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await nextTick();
		await Promise.resolve();
	}
}

beforeEach(() => {
	sent = [];
	xterm.events.length = 0;
	xterm.parse = "now";
	xterm.queue.length = 0;
	xterm.profile = {};
	vi.mocked(playBellSound).mockClear();
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("TerminalPane over a terminal that has ended (#927)", () => {
	it("opens an ended terminal with what it last printed under its card", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		expect(attaches()[0]).toMatchObject({ channelId: T });

		refuse(T, lastOutput());

		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
		expect(button("Close")).toBeDefined();
		expect(paneText()).toContain("exited");
		expect(xterm.events).toContain("LAST-SCREEN");
		expect(xterm.events).toContain("fail: no such file");
		expect(spawns()).toEqual([]);
	});

	it("shows the card when the hub does not answer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(button("Restart")).toBeDefined();
		expect(paneText()).not.toContain("timeout");
		expect(xterm.events).toEqual([]);
	});

	it("asks the new socket when its socket was replaced while it waited", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		// The socket is replaced while the pane opens: the ATTACH went out on the old one.
		useSessionStore().reconnectCount++;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(button("Restart")).toBeDefined();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T, lastOutput());
		await settle();
		expect(xterm.events).toContain("LAST-SCREEN");
	});

	it("keeps the last output above the restarted shell", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T, lastOutput());
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
		const replay = [...xterm.events];

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		const spawn = spawns()[0];
		expect(spawn).toMatchObject({ hostId: HOST, reuseChannelId: T });
		hear({ type: "SPAWN_OK", channelId: T, requestId: spawn?.requestId });
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "NEW-SHELL");
		await settle();

		// Not cleared, and the new shell's screen not drawn over it.
		expect(xterm.events).toEqual(replay);
		expect(replay.slice(0, 2)).toEqual(["<reset>", "LAST-SCREEN"]);
	});

	it("writes nothing of a terminal it left while opening", async () => {
		const channel = ref(T);
		mountPane(channel, "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = S;
		await settle();
		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).not.toContain("LAST-SCREEN");
		expect(xterm.events).not.toContain("fail: no such file");
		expect(xterm.events).toEqual([]);
	});
});

describe("TerminalPane over an ending it watched (#927)", () => {
	/** A pane attached live to T, which ends while it watches. */
	async function watchItEnd(): Promise<void> {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "WHOLE");
		await settle();
		useChannelsStore().updateChannelStatus(T, "dead", 1);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
	}

	/** The socket is replaced and the pane's re-attach is refused with `last`. */
	async function socketComesBack(last: EndedOutput): Promise<void> {
		const before = attaches().length;
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(before + 1));
		refuse(T, last);
		await settle();
	}

	it("turns mouse reporting off over a terminal that ended while watched", async () => {
		await watchItEnd();

		expect(xterm.events.at(-1)).toBe(MOUSE_OFF);
		// In its own xterm only.
		expect(sent.filter((m) => m.type === "INPUT" || m.type === "RESIZE")).toEqual([]);
	});

	it("keeps the whole ending it watched when its socket comes back", async () => {
		await watchItEnd();
		expect(xterm.events).toEqual(["<reset>", "WHOLE", MOUSE_OFF]);
		// Kept: no clear, no output, no notice; only the mouse reset (C12).
		const keptAgain = () => ["<reset>", "WHOLE", MOUSE_OFF, ...extraResets];
		const extraResets: string[] = [];

		await socketComesBack(lastOutput());
		extraResets.push(MOUSE_OFF);
		expect(xterm.events).toEqual(keptAgain());

		// Again: the refusal before reported the end as found, not as watched.
		await socketComesBack(lastOutput());
		extraResets.push(MOUSE_OFF);
		expect(xterm.events).toEqual(keptAgain());

		await socketComesBack(lastOutput({ snapshot: null, tail: [], truncated: true }));
		extraResets.push(MOUSE_OFF);
		expect(xterm.events).toEqual(keptAgain());
	});

	it("takes the hub's copy again once a terminal attached since", async () => {
		await watchItEnd();

		// Restarted, attached, then ended while its socket was down: found, not watched.
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		hear({ type: "SPAWN_OK", channelId: T, requestId: spawns()[0]?.requestId });
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "AGAIN");
		await settle();
		useSessionStore().connected = false;
		await settle();
		useSessionStore().connected = true;
		xterm.events.length = 0;

		await socketComesBack(
			lastOutput({ snapshot: null, tail: [new TextEncoder().encode("FOUND")] }),
		);

		expect(xterm.events).toEqual(["<reset>", "FOUND", MOUSE_OFF]);
	});

	it("takes a live terminal's screen when its socket comes back to it restarted", async () => {
		await watchItEnd();
		xterm.events.length = 0;

		// Restarted from another window while this pane's socket was down.
		const before = attaches().length;
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(before + 1));
		attachOk(T, "RESTARTED");
		await settle();

		expect(xterm.events).toEqual(["<reset>", "RESTARTED"]);
	});

	it("forgets the ending it watched when its terminal changes", async () => {
		const channel = ref(T);
		mountPane(channel, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "WHOLE");
		await settle();
		useChannelsStore().updateChannelStatus(T, "dead", 1);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());

		channel.value = S;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(S, lastOutput({ snapshot: null, tail: [new TextEncoder().encode("S-OUT")] }));
		await settle();
		channel.value = T;
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		refuse(T, lastOutput({ snapshot: null, tail: [new TextEncoder().encode("T-OUT")] }));
		await settle();
		expect(xterm.events.slice(-3)).toEqual(["<reset>", "T-OUT", MOUSE_OFF]);

		// Its screen is the hub's copy now, not the ending it watched.
		xterm.events.length = 0;
		await socketComesBack(
			lastOutput({ snapshot: null, tail: [new TextEncoder().encode("T-FINAL")] }),
		);
		expect(xterm.events).toEqual(["<reset>", "T-FINAL", MOUSE_OFF]);
	});

	it("turns no mouse off for a late answer about another terminal", async () => {
		const channel = ref(S);
		mountPane(channel, "live");
		useChannelsStore().updateChannelStatus(S, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(S, "S-LIVE");
		await settle();

		channel.value = T;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		channel.value = S;
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(S, "S-AGAIN");
		await settle();
		xterm.events.length = 0;

		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).toEqual([]);
	});
});

describe("TerminalPane given another terminal while it opens (#927)", () => {
	it("attaches the terminal it was given while it opened, once T is answered", async () => {
		const channel = ref(T);
		mountPane(channel, "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = S;
		await settle();
		refuse(T, lastOutput());

		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		expect(attaches()[1]).toMatchObject({ channelId: S });
	});

	it("attaches the terminal it was given while it opened, once T's attach timed out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const channel = ref(T);
		mountPane(channel, "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = S;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		expect(attaches()[1]).toMatchObject({ channelId: S });
	});
});

describe("TerminalPane rings no bell for a replay (#927)", () => {
	const BEL = "\u0007";
	const bytes = (text: string) => new TextEncoder().encode(text);

	for (const mode of ["now", "later"] as const) {
		it(`with writes parsed ${mode === "now" ? "inside write()" : "later"}`, async () => {
			xterm.parse = mode;
			xterm.profile = { bellSound: "system" };
			mountPane(ref(T), "live");
			await vi.waitFor(() => expect(attaches()).toHaveLength(1));
			// A live ATTACH_OK's snapshot is a replay.
			attachOk(T, `LIVE${BEL}`);
			await settle();
			drain();

			// A live bell taken before the replay, then a cached ATTACH_OK's snapshot
			// and tail, then a live bell after it: parsed in that order.
			hear({ type: "OUTPUT", channelId: T, data: bytes(`before${BEL}`) });
			useSessionStore().reconnectCount++;
			await vi.waitFor(() => expect(attaches()).toHaveLength(2));
			hear({
				type: "ATTACH_OK",
				channelId: T,
				snapshot: { serialized: `CACHED${BEL}`, cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
				tail: [bytes(`TAIL${BEL}`)],
				writeLockHolder: null,
				cached: true,
				cols: 100,
				rows: 30,
			});
			await settle();
			hear({ type: "OUTPUT", channelId: T, data: bytes(`after${BEL}`) });

			// And an ended terminal's last output.
			useSessionStore().reconnectCount++;
			await vi.waitFor(() => expect(attaches()).toHaveLength(3));
			refuse(T, lastOutput({ snapshot: null, tail: [bytes(`ENDED${BEL}`)] }));
			await settle();
			drain();
			await settle();

			expect(xterm.events).toContain(`ENDED${BEL}`);
			expect(useNotificationStore().bellCounts.get(T)).toBe(2);
			expect(vi.mocked(playBellSound)).toHaveBeenCalledTimes(2);
		});
	}
});
