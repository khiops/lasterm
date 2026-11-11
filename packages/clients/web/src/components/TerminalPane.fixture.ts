/**
 * TerminalPane mounted whole over its real terminal composable, for its specs
 * (#927, #936). Only xterm and its addons, which need a real canvas, are stood
 * in, as in composables/useTerminal.spec.ts: the stand-in records every clear
 * and write, and takes keys, typing and resizes as xterm does. The hub is a
 * socket the test answers, and the pane's parent records what it emits.
 *
 * Import it first: it registers its module mocks before anything imports the
 * pane, and sets a fresh window up around each test.
 */
import type { EndedOutput, Host, TerminalProfile } from "@lasterm/shared";
import { createPinia, type Pinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, vi } from "vitest";
import {
	type App,
	type ComputedRef,
	computed,
	createApp,
	defineComponent,
	h,
	nextTick,
	provide,
	type Ref,
} from "vue";

/** One terminal the pane made, as the stand-in for xterm keeps it. */
export interface StandInTerminal {
	cols: number;
	rows: number;
	options: Record<string, unknown>;
	element: HTMLElement;
	/** The key handler xterm was last given: xterm keeps one. */
	keyHandler: ((ev: KeyboardEvent) => boolean) | null;
	dataListeners: Array<(data: string) => void>;
	/** As xterm: a change of size is told to its listeners. */
	resize(cols: number, rows: number): void;
}

/** What the pane asked its profile for, and the profile it holds. */
export interface PaneProfile {
	hostId: Readonly<Ref<string | null | undefined>>;
	channelId: Readonly<Ref<string | null | undefined>>;
	profile: Ref<TerminalProfile>;
	/** Whether the profile has been read for that host and terminal yet. */
	read: Ref<boolean>;
}

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
	/** Whether a pane's profile is read as soon as it asks. */
	profileRead: true,
	/** Each pane's profile, in the order the panes were set up. */
	profiles: [] as unknown[],
	/** The terminals made, in order. */
	terminals: [] as unknown[],
	/** The size a fit gives a terminal: what its pane holds. */
	fit: { cols: 80, rows: 24 },
}));

/** Parse every write taken so far, in order. */
export function drain(): void {
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
		keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;
		dataListeners: Array<(data: string) => void> = [];
		private resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
		private bellListeners: Array<() => void> = [];
		/** Where xterm takes the keyboard: its helper textarea, inside its element. */
		private input = document.createElement("textarea");
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
			this.element.className = "xterm";
			this.input.className = "xterm-helper-textarea";
			this.element.appendChild(this.input);
			xterm.terminals.push(this);
		}
		loadAddon(addon: { activate?: (terminal: unknown) => void }): void {
			addon.activate?.(this);
		}
		open(parent: HTMLElement): void {
			parent.appendChild(this.element);
		}
		onData(listener: (data: string) => void) {
			this.dataListeners.push(listener);
			return {
				dispose: () => {
					this.dataListeners = this.dataListeners.filter((l) => l !== listener);
				},
			};
		}
		onResize(listener: (size: { cols: number; rows: number }) => void) {
			this.resizeListeners.push(listener);
			return {
				dispose: () => {
					this.resizeListeners = this.resizeListeners.filter((l) => l !== listener);
				},
			};
		}
		onTitleChange() {
			return { dispose() {} };
		}
		onBell(listener: () => void) {
			this.bellListeners.push(listener);
			return { dispose() {} };
		}
		onScroll() {
			return { dispose() {} };
		}
		/** As xterm: the handler given last is the one it asks. */
		attachCustomKeyEventHandler(handler: (ev: KeyboardEvent) => boolean): void {
			this.keyHandler = handler;
		}
		hasSelection(): boolean {
			return false;
		}
		focus(): void {
			this.input.focus();
		}
		scrollToBottom(): void {}
		/** As xterm: a change of size is told to its listeners. */
		resize(cols: number, rows: number): void {
			if (cols === this.cols && rows === this.rows) return;
			this.cols = cols;
			this.rows = rows;
			for (const listener of [...this.resizeListeners]) listener({ cols, rows });
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

// A fit sizes the terminal to its pane, which holds `xterm.fit`.
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		private terminal: { resize(cols: number, rows: number): void } | null = null;
		activate(terminal: { resize(cols: number, rows: number): void }): void {
			this.terminal = terminal;
		}
		fit(): void {
			this.terminal?.resize(xterm.fit.cols, xterm.fit.rows);
		}
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

// The terminal's settings, read for it at once unless a test says otherwise:
// "When a terminal ends" asks, its default, so an end the pane finds shows the
// card (#592, #595). The test sees which host and terminal the pane asked
// for, and can change the profile or let it be read, as a reload would.
vi.mock("../composables/useResolvedProfile.js", async () => {
	const { DEFAULT_PROFILE } = await import("@lasterm/shared");
	const { computed, ref } = await import("vue");
	return {
		useResolvedProfile: (
			hostId: { value: string | null | undefined },
			channelId: { value: string | null | undefined },
		) => {
			const profile = ref({ ...DEFAULT_PROFILE, ...xterm.profile });
			const read = ref(xterm.profileRead);
			xterm.profiles.push({ hostId, channelId, profile, read });
			return {
				profile,
				resolvedFor: computed(() =>
					read.value ? { hostId: hostId.value ?? null, channelId: channelId.value ?? null } : null,
				),
				reload: async () => {},
			};
		},
	};
});

vi.mock("../composables/useBellSound.js", () => ({ playBellSound: vi.fn() }));

import { CHANNELS_ON_SCREEN_KEY } from "../composables/displayedChannels.js";
import { playBellSound } from "../composables/useBellSound.js";
import { useAuthStore } from "../stores/auth.js";
import { useChannelsStore } from "../stores/channels.js";
import { useSessionStore } from "../stores/session.js";
import TerminalPane from "./TerminalPane.vue";

export { xterm };

/** The bell sound the pane plays, as a mock. */
export const bellSound = vi.mocked(playBellSound);

export const HOST = "01HZZZZZZZZZZZZZZZZZZZZZH0";
export const T = "01HZZZZZZZZZZZZZZZZZZZZZT1";
export const S = "01HZZZZZZZZZZZZZZZZZZZZZS2";
/** This window, as the hub knows it: the holder of a write lock it takes. */
export const CLIENT = "01HZZZZZZZZZZZZZZZZZZZZCL1";
export const MOUSE_OFF = "\u001b[?1000l";

export type Frame = { type: string } & Record<string, unknown>;
type Listener = (msg: unknown) => void;

let app: App | null = null;
let pinia: Pinia;
export let root: HTMLElement;
/** Every frame the pane sent, in order. */
export let sent: Frame[];
/** A frame from the hub, handed to every listener for its type. */
export let hear: (msg: Frame) => void;
/** What the pane emitted to its parent, in order: the event, then its arguments. */
export let emitted: unknown[][];

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
		send: vi.fn((msg: Frame) => {
			sent.push(msg);
		}),
	};
	// Restart asks only a hub the window is paired with.
	const auth = useAuthStore();
	auth.token = "a".repeat(64);
	auth.clientId = CLIENT;
	const sessionStore = useSessionStore();
	sessionStore.hubEchoesSpawnRequestId = true;
	sessionStore.connected = true;
	sessionStore.wsClient = socket as unknown as typeof sessionStore.wsClient;
	vi.spyOn(sessionStore, "connect").mockResolvedValue();
}

export const attaches = () => sent.filter((m) => m.type === "ATTACH");
export const spawns = () => sent.filter((m) => m.type === "SPAWN");
export const paneText = (): string => root.textContent?.replace(/\s+/g, " ") ?? "";
export const button = (label: string) =>
	[...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

export const lastOutput = (over: Partial<EndedOutput> = {}): EndedOutput => ({
	snapshot: { serialized: "LAST-SCREEN", cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
	tail: [new TextEncoder().encode("fail: no such file")],
	cols: 100,
	rows: 30,
	...over,
});

/** The hub refuses an ATTACH: the terminal has ended. */
export function refuse(channelId: string, last?: EndedOutput): void {
	hear({
		type: "ERROR",
		code: "CHANNEL_DEAD",
		message: "This terminal has ended.",
		channelId,
		...(last !== undefined && { lastOutput: last }),
	});
}

/**
 * The hub answers an ATTACH from the terminal itself, at the PTY's size of
 * 100×30; with `cached: true`, from what it remembers of it.
 */
export function attachOk(channelId: string, serialized: string, over: Partial<Frame> = {}): void {
	hear({
		type: "ATTACH_OK",
		channelId,
		snapshot: { serialized, cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
		tail: [],
		writeLockHolder: null,
		cached: false,
		cols: 100,
		rows: 30,
		...over,
	});
}

/** The hub answers the pane's last SPAWN: the terminal runs, as `channelId`. */
export function spawnOk(channelId: string): void {
	const spawn = spawns().at(-1);
	if (spawn === undefined) throw new Error("the pane sent no SPAWN");
	hear({ type: "SPAWN_OK", channelId, requestId: spawn.requestId });
}

/** The hub refuses the pane's last SPAWN, as it does: an ERROR under the SPAWN's name. */
export function spawnRefused(code: string, message: string, over: Partial<Frame> = {}): void {
	const spawn = spawns().at(-1);
	if (spawn === undefined) throw new Error("the pane sent no SPAWN");
	hear({ type: "ERROR", code, message, requestId: spawn.requestId, ...over });
}

/** A new window: its stores, and a hub the test answers. Set the stores up, then mount. */
export function freshWindow(): void {
	pinia = createPinia();
	setActivePinia(pinia);
	fakeHub();
}

/** What the pane is mounted with: its props, and the panes its layout says are on screen. */
export interface PaneProps {
	/** The terminal it shows; the parent swaps it for the real one once a spawn is answered, as App does. */
	channel: Ref<string | null>;
	/** The host the rail had selected when the pane was made. */
	hostId?: string | null;
	/** The terminals of the tab shown, as the layout provides them; none: no layout. */
	onScreen?: Ref<ReadonlySet<string>>;
}

/** Mount the pane in the window `freshWindow` set up. */
export function mount({ channel, hostId = HOST, onScreen }: PaneProps): void {
	root = document.createElement("div");
	document.body.appendChild(root);
	const Parent = defineComponent({
		setup() {
			if (onScreen !== undefined) {
				provide(
					CHANNELS_ON_SCREEN_KEY,
					computed(() => onScreen.value) as ComputedRef<ReadonlySet<string>>,
				);
			}
			return () =>
				h(TerminalPane, {
					channelId: channel.value,
					hostId,
					onClosePane: (...args: unknown[]) => emitted.push(["close-pane", ...args]),
					onConfigureCommand: (...args: unknown[]) => emitted.push(["configure-command", ...args]),
					onChannelSpawned: (tempId: string, realId: string) => {
						emitted.push(["channel-spawned", tempId, realId]);
						if (channel.value === tempId) channel.value = realId;
					},
				});
		},
	});
	app = createApp(Parent);
	app.use(pinia);
	app.mount(root);
}

/**
 * Mount a pane over `channel`, whose terminal the client's list says is
 * `status`: T and S run on HOST, and S has ended (code 1). `setUp` sets the
 * window's stores up further before the pane is mounted.
 */
export function mountPane(
	channel: Ref<string>,
	status: "dead" | "live",
	{ setUp, ...props }: Omit<PaneProps, "channel"> & { setUp?: () => void } = {},
): void {
	freshWindow();
	const channels = useChannelsStore();
	channels.registerChannelHost(T, HOST);
	channels.registerChannelHost(S, HOST);
	channels.updateChannelStatus(T, status, status === "dead" ? 1 : undefined);
	channels.updateChannelStatus(S, "dead", 1);
	setUp?.();
	mount({ channel: channel as Ref<string | null>, ...props });
}

/** A host as the hosts store lists it: an SSH host, with `profileJson` when given. */
export function host(id: string, label: string, profileJson?: string): Host {
	return {
		id,
		type: "ssh",
		label,
		iconType: "auto",
		trustRemoteHints: "ask",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: "2026-11-11T00:00:00.000Z",
		updatedAt: "2026-11-11T00:00:00.000Z",
		...(profileJson !== undefined && { profileJson }),
	};
}

/** Let promises and watchers run. */
export async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await nextTick();
		await Promise.resolve();
	}
}

/** The pane's terminal, as the stand-in for xterm keeps it. */
export function terminal(): StandInTerminal {
	const last = xterm.terminals.at(-1) as StandInTerminal | undefined;
	if (last === undefined) throw new Error("the pane made no terminal");
	return last;
}

/** The profile the pane set up first asked for. */
export function paneProfile(): PaneProfile {
	const first = xterm.profiles[0] as PaneProfile | undefined;
	if (first === undefined) throw new Error("the pane asked for no profile");
	return first;
}

/**
 * A key pressed in the terminal, as xterm takes it: its key handler first, and
 * what it lets through typed into the terminal as `data`. Says whether the
 * handler let it through.
 */
export function press(init: KeyboardEventInit, data: string): boolean {
	const term = terminal();
	const through = term.keyHandler?.(new KeyboardEvent("keydown", init)) ?? true;
	if (through) for (const listener of [...term.dataListeners]) listener(data);
	return through;
}

/** Text typed into the terminal, as xterm hands it on. */
export function type(data: string): void {
	for (const listener of [...terminal().dataListeners]) listener(data);
}

beforeEach(() => {
	sent = [];
	emitted = [];
	xterm.events.length = 0;
	xterm.parse = "now";
	xterm.queue.length = 0;
	xterm.profile = {};
	xterm.profileRead = true;
	xterm.profiles.length = 0;
	xterm.terminals.length = 0;
	xterm.fit = { cols: 80, rows: 24 };
	bellSound.mockClear();
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
