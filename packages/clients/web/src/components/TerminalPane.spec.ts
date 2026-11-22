/**
 * TerminalPane, mounted whole over its real terminal composable
 * (TerminalPane.fixture.ts): the hub is a socket the test answers, xterm a
 * stand-in that takes keys, typing and resizes as xterm does. Each test drives
 * the pane as a person or the hub does (frames, clicks, keys, the stores it
 * reads) and checks what they see: the frames it sends, what it emits, its
 * text, its focus and how its own rules draw it.
 *
 * What a pane decides is left to pure functions with specs of their own
 * (exit-action.spec.ts, pane-cover.spec.ts, useWaitingAnswer.spec.ts,
 * useWaitForHost.spec.ts, composables/useTerminal.spec.ts). Here, a scenario
 * turns on each thing the pane tells them, so that one it fails to tell shows.
 * What happy-dom cannot draw (hover, a click reaching what lies under an
 * element) is in TerminalPane.browser.spec.ts.
 */
import { BUNDLED_THEMES, type Channel } from "@lasterm/shared";
import type { Terminal } from "@xterm/xterm";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { defineComponent, h, type Ref, ref } from "vue";
import "../styles/base.css";
import { useChannelsStore } from "../stores/channels.js";
import { useConfigStore } from "../stores/config.js";
import { useHostsStore } from "../stores/hosts.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useSessionStore } from "../stores/session.js";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import { useToastStore } from "../stores/toast.js";
import { useTransfersStore } from "../stores/transfers.js";
import { useWriteLockStore } from "../stores/writelock.js";
import {
	attaches,
	attachOk,
	bellSound,
	button,
	CLIENT,
	closePane,
	drain,
	dropConnection,
	dropQueueOf,
	emitted,
	type Frame,
	freshWindow,
	HOST,
	hear,
	host,
	lastOutput,
	listening,
	MOUSE_OFF,
	mount,
	mountPane,
	mountRoot,
	type PaneProps,
	paneProfile,
	paneText,
	parseOf,
	press,
	refuse,
	root,
	S,
	type StandInSearch,
	type StandInTerminal,
	sent,
	settle,
	spawnOk,
	spawnRefused,
	spawns,
	T,
	terminal,
	type,
	typeBinary,
	xterm,
} from "./TerminalPane.fixture.js";
import TerminalPane from "./TerminalPane.vue";

/** Another host: the one the rail has selected, or one a spawn is for. */
const PI = "01HZZZZZZZZZZZZZZZZZZZZZP3";
/** A terminal on HOST the client knows nothing of yet. */
const U = "01HZZZZZZZZZZZZZZZZZZZZZU4";
/** A third terminal on HOST (#1012). */
const V = "01HZZZZZZZZZZZZZZZZZZZZZV6";
/** The id App gives a pane that owes its spawn, and the one the hub gives the terminal. */
const NEW = "pending-1";
const REAL = "01HZZZZZZZZZZZZZZZZZZZZZR5";
/** Another window of the same hub. */
const OTHER_CLIENT = "01HZZZZZZZZZZZZZZZZZZZZCL2";
/**
 * RIS: what the pane writes before a live snapshot over a screen it kept, in
 * order after what xterm has not parsed yet (#1010).
 */
const FULL_RESET = "\u001bc";

// ─── The window around the pane ──────────────────────────────────────────────

/** What `performance.now()` says: the clock a pane times its terminal's run with. */
let now = 0;

/** Whether this window has the focus, as the browser says it. */
function setWindowFocus(focused: boolean): void {
	vi.spyOn(document, "hasFocus").mockReturnValue(focused);
	window.dispatchEvent(new Event(focused ? "focus" : "blur"));
}

beforeEach(() => {
	now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	setWindowFocus(true);
});

/** Time passes. */
function runFor(ms: number): void {
	now += ms;
}

/**
 * A bundled theme on the document, as the theme store applies it. Before the
 * pane is mounted: the window's own stores come after.
 */
function themed(name: string): void {
	setActivePinia(createPinia());
	useThemeStore().applyTheme(BUNDLED_THEMES[name]!);
}

function listed(id: string, status: Channel["status"], over: Partial<Channel> = {}): Channel {
	return {
		id,
		sessionId: "session-1",
		cols: 80,
		rows: 24,
		status,
		createdAt: "2026-11-11T00:00:00.000Z",
		updatedAt: "2026-11-11T00:00:00.000Z",
		...over,
	};
}

/** "Keep ended terminals in the sidebar", as Settings sets it. */
function keepEnded(): void {
	const config = useConfigStore();
	config.uiConfig = { ...config.uiConfig, panes: { ...config.uiConfig.panes, keepEnded: true } };
}

/** The pane's terminal is the one selected: its tab is shown, and the keyboard is in it. */
function shown(): void {
	useChannelsStore().selectChannel(T);
}

/** This window holds T's write lock. */
function writer(): void {
	useWriteLockStore().handleWriteLock(T, CLIENT);
}

/** The hub reports that T ended. */
function endIt(endReason?: "killed" | "stopped"): void {
	useChannelsStore().updateChannelStatus(T, "dead", 0, endReason);
}

/** "Always do this", clicked on another pane's card, as this window tells its panes. */
function chosenElsewhere(
	action: "restart" | "close",
	scope: "host" | "global",
	hostId = HOST,
): void {
	useConfigStore().announceAlwaysChoice({ action, scope, hostId, channelId: S, at: now });
}

/** The setting as the pane's profile now resolves it: the reload after a write. */
function settingNowSays(whenEnded: "ask" | "restart" | "close"): void {
	const { profile } = paneProfile();
	profile.value = { ...profile.value, whenEnded };
}

type Open = Omit<PaneProps, "channel"> & { channel?: Ref<string>; setUp?: () => void };

/** A pane attached to T running. */
async function openLive({ channel = ref(T), ...opts }: Open = {}): Promise<void> {
	mountPane(channel, "live", opts);
	await vi.waitFor(() => expect(attaches()).toHaveLength(1));
	attachOk(T, "LIVE");
	await settle();
}

/** A pane over T, which the list says has ended and the hub's refusal confirms. */
async function openEnded(opts: Open = {}): Promise<void> {
	mountPane(opts.channel ?? ref(T), "dead", opts);
	await vi.waitFor(() => expect(attaches()).toHaveLength(1));
	refuse(T, lastOutput());
	await vi.waitFor(() => expect(card()).not.toBeNull());
}

/** A pane that owes its spawn on `on`, as App opens one for "New terminal". */
function openNew(on: string, props: Omit<PaneProps, "channel"> = {}): Ref<string | null> {
	freshWindow();
	useChannelsStore().registerPendingSpawn(NEW, on);
	const channel = ref<string | null>(NEW);
	mount({ channel, ...props });
	return channel;
}

/**
 * A pane that owes its spawn on HOST, under a parent that remounts it over the
 * same pending id, as a split or a move does: `remount` gives it a new key.
 * The parent swaps the pending id for the new terminal, as App does.
 */
function openNewRemountable(): { channel: Ref<string | null>; remount(): Promise<void> } {
	freshWindow();
	useChannelsStore().registerPendingSpawn(NEW, HOST);
	const channel = ref<string | null>(NEW);
	const key = ref(0);
	mountRoot(
		defineComponent({
			setup: () => () =>
				h(TerminalPane, {
					key: key.value,
					channelId: channel.value,
					hostId: HOST,
					onChannelSpawned: (tempId: string, realId: string) => {
						emitted.push(["channel-spawned", tempId, realId]);
						if (channel.value === tempId) channel.value = realId;
					},
				}),
		}),
	);
	return {
		channel,
		remount: async () => {
			key.value++;
			await settle();
		},
	};
}

/** The window's connection opens only when the returned function is called: for the next pane to ask. */
function holdConnection(): () => void {
	let open: () => void = () => {};
	vi.mocked(useSessionStore().connect).mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				open = resolve;
			}),
	);
	return () => open();
}

// ─── What the pane shows and sends ───────────────────────────────────────────

const card = () => root.querySelector<HTMLElement>(".exit-card");
const quietLine = () => root.querySelector(".exit-status__text")?.textContent?.trim() ?? null;
const banner = () => root.querySelector(".detached-banner");
const errorBox = () => root.querySelector(".terminal-error__box");
const lockIndicator = () => root.querySelector(".wl-indicator");
const closes = () => emitted.filter(([event]) => event === "close-pane").map(([, ...args]) => args);
const inputs = () =>
	sent.filter((m) => m.type === "INPUT").map((m) => new TextDecoder().decode(m.data as Uint8Array));
const resizes = () =>
	sent
		.filter((m) => m.type === "RESIZE")
		.map(({ channelId, cols, rows }) => ({ channelId, cols, rows }));
/** The terminals the pane attached, in order. */
const attachedTo = () => attaches().map((m) => m.channelId);
/** The terminals what was typed went to, in order. */
const inputsTo = () => sent.filter((m) => m.type === "INPUT").map((m) => m.channelId);
const paneTitleText = () => root.querySelector(".pane-title")?.textContent?.trim() ?? null;
/** The hub sends `text` as what `channelId` printed. */
function print(channelId: string, text: string): void {
	hear({ type: "OUTPUT", channelId, data: new TextEncoder().encode(text) });
}
/** U runs on HOST too. */
function withU(): void {
	useChannelsStore().registerChannelHost(U, HOST);
}
const alwaysBox = () => card()?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
const scopeRadio = (label: string) =>
	[...(card()?.querySelectorAll<HTMLLabelElement>(".exit-scope-option") ?? [])].find(
		(l) => l.textContent?.trim() === label,
	);

/** Wait out the pane's resize debounce, so that a RESIZE it would send has gone. */
async function resizesSettle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(80);
	await settle();
}

/** A pane can measure itself: happy-dom lays nothing out, so every element says it has a size. */
function paneHasASize(): void {
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
}

// ─── Keys ────────────────────────────────────────────────────────────────────

// What the handler lets through is tested in utils/terminal-keys.spec.ts: the
// palette's chord never reaches the PTY, Ctrl+K does (#624). Here, that xterm
// asks that handler, and no other of the pane's, for each key event typed in
// it, with what the pane knows: its search, and the terminal's selection.
describe("TerminalPane keys", () => {
	const searchShown = () =>
		root.querySelector<HTMLElement>('[role="search"]')?.style.display !== "none";

	it("keeps the palette's chord from the shell, and lets Ctrl+K reach it", async () => {
		await openLive({ setUp: writer });

		expect(press({ ctrlKey: true, shiftKey: true, key: "P" }, "\u0010")).toBe(false);
		expect(press({ ctrlKey: true, key: "k" }, "\u000b")).toBe(true);

		expect(inputs()).toEqual(["\u000b"]);
	});

	// xterm hands its handler keypress and keyup as well as keydown.
	it("keeps the palette's chord from the shell whichever key event xterm hands on", async () => {
		await openLive({ setUp: writer });
		const palette = { ctrlKey: true, shiftKey: true, key: "P" };

		expect(press(palette, "\u0010", "keydown")).toBe(false);
		expect(press(palette, "\u0010", "keypress")).toBe(false);
		expect(press(palette, "\u0010", "keyup")).toBe(false);
	});

	it("opens its search on Ctrl+Shift+F, which the shell never sees", async () => {
		await openLive({ setUp: writer });
		expect(searchShown()).toBe(false);

		expect(press({ ctrlKey: true, shiftKey: true, key: "F" }, "\u0006")).toBe(false);
		await settle();

		expect(searchShown()).toBe(true);
		expect(inputs()).toEqual([]);
	});

	it("leaves Escape to its search while the search is open", async () => {
		await openLive({ setUp: writer });
		expect(press({ key: "Escape" }, "\u001b")).toBe(true);

		press({ ctrlKey: true, shiftKey: true, key: "F" }, "\u0006");
		await settle();

		expect(press({ key: "Escape" }, "\u001b")).toBe(false);
		expect(inputs()).toEqual(["\u001b"]);
	});

	it("copies a selection on Ctrl+C rather than interrupting the shell", async () => {
		await openLive({ setUp: writer });
		expect(press({ ctrlKey: true, key: "c" }, "\u0003")).toBe(true);

		xterm.selection = true;

		expect(press({ ctrlKey: true, key: "c" }, "\u0003")).toBe(false);
		expect(inputs()).toEqual(["\u0003"]);
	});

	it("leaves Ctrl+V to the browser's paste", async () => {
		await openLive({ setUp: writer });

		expect(press({ ctrlKey: true, key: "v" }, "\u0016")).toBe(false);
		expect(inputs()).toEqual([]);
	});
});

// ─── Layers ──────────────────────────────────────────────────────────────────

describe("TerminalPane layers", () => {
	beforeEach(() => {
		themed("one-half-dark");
	});

	const zIndex = (selector: string): number => {
		const el = root.querySelector(selector);
		if (el === null) throw new Error(`no ${selector} on screen`);
		return Number(getComputedStyle(el).zIndex);
	};
	const tinted = () =>
		useHostsStore().hosts.push(
			host(
				HOST,
				"pi",
				JSON.stringify({
					visualProfile: { tint: { enabled: true, color: "#ff0000", opacity: 10 } },
				}),
			),
		);

	// A pane that cannot spawn or attach says so in `.terminal-error`, and one
	// still connecting in `.terminal-loading`. Under the terminal's own opaque
	// background, both were painted out of sight: a failed spawn looked like an
	// empty terminal, offering the write lock of a channel that did not exist.
	it("shows that it is connecting above the terminal and its tint", async () => {
		mountPane(ref(T), "live", { setUp: tinted });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		expect(paneText()).toContain("Connecting…");
		expect(zIndex(".terminal-loading")).toBeGreaterThan(zIndex(".terminal-container"));
		expect(zIndex(".terminal-loading")).toBeGreaterThan(zIndex(".tint-overlay"));
	});

	it("shows a failure above the terminal and its tint", async () => {
		freshWindow();
		tinted();
		useChannelsStore().registerPendingSpawn(NEW, HOST);
		mount({ channel: ref(NEW) });
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		expect(zIndex(".terminal-error")).toBeGreaterThan(zIndex(".terminal-container"));
		expect(zIndex(".terminal-error")).toBeGreaterThan(zIndex(".tint-overlay"));
	});

	// The overlay lets clicks through to the terminal below it, so its own
	// buttons take them back. Without that the error offered a way out that
	// could not be clicked. (Clicked for real in TerminalPane.browser.spec.ts.)
	it("takes clicks on the actions the error offers", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		expect(getComputedStyle(root.querySelector(".terminal-error")!).pointerEvents).toBe("none");
		expect(getComputedStyle(errorBox()!).pointerEvents).toBe("auto");
	});
});

// ─── Given back the terminal it spawned (#965) ───────────────────────────────

// A pane skips the one change of terminal that follows its own spawn: its
// parent swaps the pending id for the terminal the pane just made and is
// already attached to. It skipped every later return to that terminal too,
// and stayed on the one it showed meanwhile, its keys going there.
describe("TerminalPane given back the terminal it spawned (#965)", () => {
	/** A pane that spawned REAL on HOST, attached to it without an ATTACH. */
	async function spawnedReal(): Promise<Ref<string | null>> {
		const channel = openNew(HOST);
		useChannelsStore().registerChannelHost(U, HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(REAL);
		await settle();
		expect(channel.value).toBe(REAL);
		return channel;
	}

	it("does not attach the terminal it has just spawned", async () => {
		await spawnedReal();

		expect(attachedTo()).toEqual([]);
	});

	it("attaches the terminal it spawned when it is given it back", async () => {
		const channel = await spawnedReal();
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([U]));
		attachOk(U, "U-SCREEN");
		await settle();

		channel.value = REAL;
		await settle();
		expect(attachedTo()).toEqual([U, REAL]);
		xterm.events.length = 0;
		attachOk(REAL, "REAL-SCREEN");
		await settle();
		print(U, "U-OUT");
		print(REAL, "REAL-OUT");

		expect(xterm.events).toEqual(["<reset>", "REAL-SCREEN", "REAL-OUT"]);
	});

	it("attaches the terminal it spawned when given it back before the other answered", async () => {
		const channel = await spawnedReal();
		useWriteLockStore().handleWriteLock(REAL, CLIENT);
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([U]));

		channel.value = REAL;
		await settle();
		expect(attachedTo()).toEqual([U, REAL]);
		attachOk(REAL, "REAL-SCREEN");
		await settle();
		type("x");

		expect(inputsTo()).toEqual([REAL]);
	});
});

// ─── A spawn that completes after the pane moved on (#971) ──────────────────

// A spawn takes seconds over SSH. Given another terminal meanwhile, the pane
// named that one as the pending id it spawned for, and its parent replaced it
// by the new terminal in every layout; closed meanwhile, it subscribed to the
// new terminal's output, and nothing took that listener away. The pane owes
// its spawn only while it shows the pending id.
describe("TerminalPane whose spawn completes after it moved on (#971)", () => {
	/** A pane owing its spawn on HOST, given U before the hub answers it. */
	async function givenUWhileSpawning(): Promise<Ref<string | null>> {
		const channel = openNew(HOST);
		useChannelsStore().registerChannelHost(U, HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		channel.value = U;
		await settle();
		return channel;
	}

	const spawnedEvents = () => emitted.filter(([event]) => event === "channel-spawned");

	it("leaves the terminal it was given meanwhile alone when its spawn completes", async () => {
		const channel = await givenUWhileSpawning();

		spawnOk(REAL);
		await settle();

		expect(spawnedEvents()).toEqual([]);
		expect(channel.value).toBe(U);
		expect(attachedTo()).toEqual([U]);
	});

	it("says nothing of a spawn that failed after it was given another terminal", async () => {
		await givenUWhileSpawning();

		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await settle();

		expect(errorBox()).toBeNull();
		expect(attachedTo()).toEqual([U]);
		expect(spawns()).toHaveLength(1);
	});

	it("spawns nothing when it is given another terminal before its spawn is sent", async () => {
		const channel = openNew(HOST);
		let connected: () => void = () => {};
		vi.mocked(useSessionStore().connect).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					connected = resolve;
				}),
		);
		useChannelsStore().registerChannelHost(U, HOST);
		await settle();
		channel.value = U;
		await settle();

		connected();
		await settle();

		expect(spawns()).toEqual([]);
		expect(attachedTo()).toEqual([U]);
	});

	it("keeps no watch of the terminal it spawned once it shows another", async () => {
		await givenUWhileSpawning();
		spawnOk(REAL);
		await vi.waitFor(() => expect(attachedTo()).toEqual([U]));
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(errorBox()).not.toBeNull();

		// U runs, and the pane is attached to nothing: it asks for U again.
		useChannelsStore().updateChannelStatus(U, "live");
		await settle();

		expect(attachedTo()).toEqual([U, U]);
	});

	it("leaves nothing listening when it is closed before its spawn completes", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		closePane();
		expect(listening("OUTPUT")).toBe(0);

		spawnOk(REAL);
		await settle();

		// The spawn's answer was taken: the window knows the new terminal's host.
		expect(useChannelsStore().channelHostMap.get(REAL)).toBe(HOST);
		expect(listening("OUTPUT")).toBe(0);
	});
});

// A pane that failed to open says why, and that is about what it was opening.
// Given another terminal from the sidebar, it kept saying so over it, never
// attaching it, until Retry.
describe("TerminalPane that failed to open, given another terminal (#971)", () => {
	it("opens it after its spawn failed", async () => {
		const channel = openNew(HOST);
		withU();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		channel.value = U;
		await settle();

		expect(errorBox()).toBeNull();
		expect(spawns()).toHaveLength(1);
		expect(attachedTo()).toEqual([U]);
	});

	it("opens it while its spawn waits for a password or passphrase that was not given", async () => {
		const channel = openNew(HOST);
		withU();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("AUTH_CANCELLED", "Authentication cancelled by user");
		await vi.waitFor(() =>
			expect(root.textContent).toContain("Not connected: the password or passphrase was not given"),
		);

		channel.value = U;
		await settle();

		expect(root.textContent).not.toContain(
			"Not connected: the password or passphrase was not given",
		);
		expect(spawns()).toHaveLength(1);
		expect(attachedTo()).toEqual([U]);
	});

	it("opens it after the attach of the one it showed went unanswered", async () => {
		const channel = ref(T);
		mountPane(channel, "live");
		withU();
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(errorBox()?.textContent).toContain("ATTACH timeout");

		channel.value = U;
		await settle();

		expect(errorBox()).toBeNull();
		expect(attachedTo()).toEqual([T, U]);
	});
});

// A split or a move mounts another pane over a new terminal's pending id. The
// spawn was the first pane's: the next one attached the pending id, and said
// its terminal was gone, while the terminal the spawn started was in no pane.
// The spawn is the pending id's now, whichever pane shows it.
describe("TerminalPane remounted over its new terminal (#980)", () => {
	it("a new terminal that failed keeps its failure and Retry when its pane remounts", async () => {
		const { remount } = openNewRemountable();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		await remount();

		await vi.waitFor(() => expect(errorBox()?.textContent).toContain("the shell could not start"));
		expect(button("Retry")).toBeDefined();
		expect(attaches()).toEqual([]);
		expect(spawns()).toHaveLength(1);
	});

	it("a pane remounted while its terminal starts sends its own size once it starts", async () => {
		paneHasASize();
		const { remount } = openNewRemountable();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ hostId: HOST, cols: 80, rows: 24 });

		// Remounted in a larger pane, before the hub answers.
		xterm.fit = { cols: 100, rows: 30 };
		await remount();
		spawnOk(REAL);
		useWriteLockStore().handleWriteLock(REAL, CLIENT);

		await vi.waitFor(() => expect(resizes()).toEqual([{ channelId: REAL, cols: 100, rows: 30 }]));
		await resizesSettle();
		expect(resizes()).toHaveLength(1);
		expect(spawns()).toHaveLength(1);
	});

	// The pane it replaced was waiting for the same connection: unmounted, it
	// starts nothing, and the remounted pane asks at its own size.
	it("a pane remounted before its terminal is asked for asks for it at its own size", async () => {
		const { remount } = openNewRemountable();
		let open: () => void = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		vi.mocked(useSessionStore().connect).mockImplementation(() => opened);
		await vi.waitFor(() => expect(useSessionStore().connect).toHaveBeenCalledTimes(1));

		xterm.fit = { cols: 100, rows: 30 };
		await remount();
		await vi.waitFor(() => expect(useSessionStore().connect).toHaveBeenCalledTimes(2));
		open();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		await settle();
		expect(spawns()).toHaveLength(1);
		expect(spawns()[0]).toMatchObject({ hostId: HOST, cols: 100, rows: 30 });
	});

	it("a new terminal closed before it is asked for is never asked for", async () => {
		openNew(HOST);
		const open = holdConnection();
		await vi.waitFor(() => expect(useSessionStore().connect).toHaveBeenCalledTimes(1));

		closePane();
		open();
		await settle();

		expect(spawns()).toEqual([]);
	});

	it("a pane that takes its terminal after it started shows what it printed", async () => {
		const { channel, remount } = openNewRemountable();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		const open = holdConnection();
		await remount();

		// Before the remounted pane asks: the hub reports the terminal running,
		// as the session store routes CHANNEL_STATE, answers the SPAWN, and the
		// terminal prints.
		useChannelsStore().updateChannelStatus(REAL, "live");
		spawnOk(REAL);
		print(REAL, "EARLY");
		await settle();
		open();

		await vi.waitFor(() => expect(attachedTo()).toEqual([REAL]));
		expect(channel.value).toBe(REAL);
		expect(emitted).toContainEqual(["channel-spawned", NEW, REAL]);
		xterm.events.length = 0;
		attachOk(REAL, "SNAPSHOT-WITH-EARLY");
		await settle();
		expect(xterm.events).toEqual(["<reset>", "SNAPSHOT-WITH-EARLY"]);
		expect(attachedTo()).toEqual([REAL]);
	});

	it("a Retry clicked before its pane remounts is sent by the remounted pane", async () => {
		const { channel, remount } = openNewRemountable();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());
		// The connection is held from the Retry until after the remount.
		let open: () => void = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		vi.mocked(useSessionStore().connect).mockImplementation(() => opened);

		button("Retry")?.click();
		await settle();
		await remount();
		open();

		await vi.waitFor(() => expect(spawns()).toHaveLength(2));
		spawnOk(REAL);
		await settle();
		expect(channel.value).toBe(REAL);
		expect(emitted).toContainEqual(["channel-spawned", NEW, REAL]);
		expect(errorBox()).toBeNull();
		expect(spawns()).toHaveLength(2);
	});
});

// ─── Spawn size ──────────────────────────────────────────────────────────────

describe("TerminalPane spawn size", () => {
	// The fit that follows a font arriving late has no channel to tell while the
	// channel is still being created, and recording its size as though it had
	// been sent left the PTY a width the window never had: the shell then drew
	// its prompt wider than the window and the caret fell a line below.
	it("tells the channel the size the terminal took while it was being created", async () => {
		paneHasASize();
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ hostId: HOST, cols: 80, rows: 24 });

		// A font arriving while the hub creates it refits the terminal to its pane.
		xterm.fit = { cols: 100, rows: 30 };
		terminal().resize(100, 30);
		spawnOk(REAL);
		// The hub gives the window that spawned it the write lock.
		useWriteLockStore().handleWriteLock(REAL, CLIENT);

		await vi.waitFor(() => expect(resizes()).toEqual([{ channelId: REAL, cols: 100, rows: 30 }]));
	});

	// No RESIZE for the size it was spawned at: it would only redraw the prompt.
	it("sends no size for a terminal spawned at the size it has", async () => {
		paneHasASize();
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(REAL);
		useWriteLockStore().handleWriteLock(REAL, CLIENT);
		await resizesSettle();

		expect(emitted).toContainEqual(["channel-spawned", NEW, REAL]);
		expect(resizes()).toEqual([]);
	});
});

// What a pane draws and sends is in composables/useTerminal.spec.ts.
describe("TerminalPane: one size per terminal (#831)", () => {
	it("decides its terminal's size while its client holds the write lock, and only then", async () => {
		paneHasASize();
		await openLive();
		await resizesSettle();
		// Another window decides: the pane draws the terminal at the PTY's size.
		expect(resizes()).toEqual([]);
		expect([terminal().cols, terminal().rows]).toEqual([100, 30]);

		useWriteLockStore().handleWriteLock(T, CLIENT);
		await vi.waitFor(() => expect(resizes()).toEqual([{ channelId: T, cols: 80, rows: 24 }]));

		useWriteLockStore().handleWriteLock(T, OTHER_CLIENT);
		hear({ type: "CHANNEL_SIZE", channelId: T, cols: 120, rows: 40 });
		await resizesSettle();
		expect(resizes()).toHaveLength(1);
		expect([terminal().cols, terminal().rows]).toEqual([120, 40]);
	});

	it("gives a terminal drawn at another's size a ground of its own, and lets its pane scroll", async () => {
		themed("one-half-dark");
		await openLive();
		const container = root.querySelector(".terminal-container")!;

		expect(getComputedStyle(container).overflow).toBe("auto");
		// The theme's host rail, #1e2127, not the terminal's own ground.
		expect(rgba(getComputedStyle(container).backgroundColor)).toEqual([30, 33, 39, 1]);
	});
});

// ─── Recovery ────────────────────────────────────────────────────────────────

describe("TerminalPane recovery", () => {
	// A pane that failed to spawn or attach had nothing to do but be closed: no
	// retry, and the reconnect watcher skipped it because it never became ready.
	it("offers to try again after a failure", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()?.textContent).toContain("the shell could not start"));

		button("Retry")?.click();

		await vi.waitFor(() => expect(spawns()).toHaveLength(2));
		expect(errorBox()).toBeNull();
	});

	it("offers to close the pane after a failure", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		button("Close")?.click();

		expect(closes()).toEqual([[NEW]]);
	});

	// The socket can be replaced while a pane is still opening, which is how one
	// of these panes ended up waiting out a ten-second timeout for nothing.
	it("sends an attach lost with its socket again by itself", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		useSessionStore().reconnectCount++;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(attaches()).toHaveLength(2);
		expect(errorBox()).toBeNull();
	});

	// A spawn may have reached the hub with only its answer lost: sending it
	// again would leave a second terminal nobody asked for.
	it("never sends a spawn lost with its socket again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));

		useSessionStore().reconnectCount++;
		await settle();
		await vi.advanceTimersByTimeAsync(15_000);
		await settle();

		expect(spawns()).toHaveLength(1);
		expect(errorBox()?.textContent).toContain("SPAWN timeout");
	});

	it("tries its spawn again when the connection comes back after it failed", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		useSessionStore().reconnectCount++;

		await vi.waitFor(() => expect(spawns()).toHaveLength(2));
		expect(errorBox()).toBeNull();
		expect(attaches()).toEqual([]);
	});

	it("tries again on its own when the connection comes back", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(errorBox()?.textContent).toContain("ATTACH timeout");

		useSessionStore().reconnectCount++;
		await settle();

		expect(attaches()).toHaveLength(2);
		expect(errorBox()).toBeNull();
	});
});

// ─── Host ────────────────────────────────────────────────────────────────────

// Tabs are global: a pane whose terminal runs on another host stays on screen
// while the rail shows a different one. Every pane was handed the selected
// host, so it resolved the wrong host's profile, and Restart — which is a
// spawn naming the terminal to bring back — named a host that terminal had
// never run on, and the hub refused it.
describe("TerminalPane host", () => {
	it("restarts a terminal on the host it runs on, not the rail's", async () => {
		await openEnded({ hostId: PI });

		button("Restart")?.click();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ hostId: HOST, reuseChannelId: T });
	});

	// What the restarted terminal prints before its attach is answered is
	// written at the size the pane draws: it starts at that size (#930).
	it("restarts a terminal at the size its pane draws it", async () => {
		await openEnded();
		expect([terminal().cols, terminal().rows]).toEqual([100, 30]);

		button("Restart")?.click();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ reuseChannelId: T, cols: 100, rows: 30 });
	});

	it("reads its profile for the host its terminal runs on, not the rail's", async () => {
		await openLive({ hostId: PI });

		expect(paneProfile().hostId.value).toBe(HOST);
	});

	// The rail's host is the last resort, for a pane whose terminal's host it
	// knows no other way (#625).
	it("speaks to the rail's host only while it knows of no other", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		freshWindow();
		mount({ channel: ref(T), hostId: PI });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		// With no host known for its terminal, its setting is never read for it:
		// the card comes once the pane has waited for it long enough.
		await vi.advanceTimersByTimeAsync(3_000);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());

		button("Restart")?.click();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ hostId: PI, reuseChannelId: T });
		expect(paneProfile().hostId.value).toBe(PI);
	});

	// An empty pane's picker, or the palette, can open a terminal on another
	// host than the one in view (#625): until its channel is known, the pane
	// speaks to the host its spawn is for, profile and theme included.
	it("speaks to the host its spawn is for until its channel is known", async () => {
		openNew(HOST, { hostId: PI });
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));

		expect(spawns()[0]).toMatchObject({ hostId: HOST });
		expect(paneProfile().hostId.value).toBe(HOST);
		// Asked again, as anything it reads changes, it still says so.
		useChannelsStore().registerChannelHost(S, PI);
		await settle();
		expect(paneProfile().hostId.value).toBe(HOST);

		spawnOk(REAL);
		await settle();
		expect(paneProfile().hostId.value).toBe(HOST);
	});
});

// ─── Restart ─────────────────────────────────────────────────────────────────

// ─── Options changed while shown (#997, #998) ────────────────────────────────

// Some of what the pane draws with was read once, when its xterm was made, and
// never again: a profile or host changed later left it as it was.
describe("TerminalPane takes what it draws with when it changes", () => {
	it("stops the cursor blinking when its style turns to underline, and back", async () => {
		await openLive();
		expect(terminal().options).toMatchObject({ cursorStyle: "block", cursorBlink: true });

		paneProfile().profile.value = { ...paneProfile().profile.value, cursorStyle: "underline" };
		await settle();
		expect(terminal().options).toMatchObject({ cursorStyle: "underline", cursorBlink: false });

		paneProfile().profile.value = { ...paneProfile().profile.value, cursorStyle: "bar" };
		await settle();
		expect(terminal().options).toMatchObject({ cursorStyle: "bar", cursorBlink: true });
	});

	it("tells the transfers store the file-transfer settings of its profile, and again when they change", async () => {
		xterm.profile = {
			transferDrop: "off",
			transferConfirmDrop: false,
			transferOnConflict: "skip",
		};
		await openLive();
		const transfers = useTransfersStore();
		expect(transfers.settingsFor(T)).toEqual({
			drop: "off",
			confirmDrop: false,
			onConflict: "skip",
			ended: false,
		});

		paneProfile().profile.value = {
			...paneProfile().profile.value,
			transferDrop: "upload",
			transferConfirmDrop: true,
			transferOnConflict: "replace",
		};
		await settle();

		expect(transfers.settingsFor(T)).toEqual({
			drop: "upload",
			confirmDrop: true,
			onConflict: "replace",
			ended: false,
		});
	});

	it("takes the font and scrollback of its profile when they change", async () => {
		await openLive();

		paneProfile().profile.value = {
			...paneProfile().profile.value,
			fontSize: 18,
			fontFamily: '"Fira Code"',
			scrollback: 1234,
		};
		await settle();

		expect(terminal().options).toMatchObject({
			fontSize: 18,
			fontFamily: expect.stringContaining('"Fira Code"'),
			scrollback: 1234,
		});
	});

	it("takes its host's theme when the host is given one while it is shown", async () => {
		await openLive({
			setUp: () => {
				useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
				useHostsStore().hosts = [host(HOST, "pi")];
			},
		});

		useHostsStore().hosts = [host(HOST, "pi", JSON.stringify({ theme: "nord" }))];
		await settle();

		expect(terminal().options.theme).toEqual(
			useThemeStore().toXtermTheme(BUNDLED_THEMES.nord!.colors),
		);
	});

	it("keeps its host's theme when the active theme changes", async () => {
		await openLive({
			setUp: () => {
				useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
				useHostsStore().hosts = [host(HOST, "pi", JSON.stringify({ theme: "nord" }))];
			},
		});

		useThemeStore().applyTheme(BUNDLED_THEMES.dracula!);
		await settle();

		expect(terminal().options.theme).toEqual(
			useThemeStore().toXtermTheme(BUNDLED_THEMES.nord!.colors),
		);
	});

	it("goes back to the active theme when its host's own is taken away", async () => {
		await openLive({
			setUp: () => {
				useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
				useHostsStore().hosts = [host(HOST, "pi", JSON.stringify({ theme: "nord" }))];
			},
		});
		useThemeStore().applyTheme(BUNDLED_THEMES.dracula!);
		await settle();

		useHostsStore().hosts = [host(HOST, "pi")];
		await settle();

		expect(terminal().options.theme).toEqual(
			useThemeStore().toXtermTheme(BUNDLED_THEMES.dracula!.colors),
		);
	});

	// The themes are fetched from the hub: a pane mounted before they came
	// never found its host's.
	it("takes its host's theme once the themes it names arrive", async () => {
		await openLive({
			setUp: () => {
				useThemeStore().availableThemes = [];
				useHostsStore().hosts = [host(HOST, "pi", JSON.stringify({ theme: "nord" }))];
			},
		});

		useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
		await settle();

		expect(terminal().options.theme).toEqual(
			useThemeStore().toXtermTheme(BUNDLED_THEMES.nord!.colors),
		);
	});
});

describe("TerminalPane restart", () => {
	// A Pi terminal came back — prompt on screen, write lock held — under an
	// overlay still saying "Shell exited": the attach at page load had found it
	// dead, and nothing unsaid that when Restart brought it back.
	it("drops the card once its Restart brought the terminal back", async () => {
		// A terminal no list shows, ended: only the hub's refusal says so.
		freshWindow();
		useChannelsStore().registerChannelHost(T, HOST);
		mount({ channel: ref(T) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));

		// Before the attach that follows is answered.
		expect(card()).toBeNull();
		expect(quietLine()).toBeNull();
		attachOk(T, "AGAIN");
		await settle();
		expect(card()).toBeNull();
	});

	it("drops the card once the hub says its terminal is starting again", async () => {
		await openEnded();

		useChannelsStore().updateChannelStatus(T, "born");
		await settle();

		expect(card()).toBeNull();
	});

	it("drops the card as soon as the hub says its terminal runs again", async () => {
		await openEnded();

		useChannelsStore().updateChannelStatus(T, "live");
		await settle();

		// Before the attach that follows is answered.
		expect(attaches()).toHaveLength(2);
		expect(card()).toBeNull();
	});

	// Under way, the card gives way to "Restarting…" (#595): nothing to press
	// again while it takes its time over SSH.
	it("says that a restart is under way, and why one failed", async () => {
		await openEnded();

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		await settle();
		expect(quietLine()).toBe("Restarting…");
		expect(card()).toBeNull();

		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(card()).not.toBeNull());
		expect(card()?.textContent).toContain("Could not restart it: the shell could not start");
	});

	// ─── A restart and the terminals the pane shows meanwhile (#929) ──────────

	/** Restart clicked over ended T: its SPAWN is sent, and not answered yet. */
	async function restartClicked(open: Open = {}): Promise<void> {
		await openEnded(open);
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
	}

	/** Restart over ended T, its SPAWN answered: the hub says T runs, and the pane attaches it. */
	async function restarted(open: Open = {}): Promise<void> {
		await restartClicked(open);
		useChannelsStore().updateChannelStatus(T, "live");
		spawnOk(T);
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T]));
	}

	it("attaches nothing once the pane shows another terminal", async () => {
		const channel = ref(T);
		await restartClicked({ channel, setUp: withU });
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		xterm.events.length = 0;

		spawnOk(T);
		await settle();
		print(T, "T-OUT");
		attachOk(U, "U-SCREEN");
		await settle();
		print(T, "T-OUT");

		expect(attachedTo()).toEqual([T, U]);
		expect(xterm.events).toEqual(["<reset>", "U-SCREEN"]);
	});

	it("says nothing of a restart's attach the pane left", async () => {
		const channel = ref(T);
		await restarted({ channel, setUp: withU });
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, U]));
		xterm.events.length = 0;
		print(T, "T-WAIT");
		expect(xterm.events).toEqual([]);
		attachOk(U, "U-SCREEN");
		await settle();
		xterm.events.length = 0;

		attachOk(T, "T-LATE", { writeLockHolder: OTHER_CLIENT });
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(xterm.events).toEqual([]);
		expect(useWriteLockStore().locks.get(T)).toBeUndefined();
		expect(errorBox()).toBeNull();
	});

	it("lets a reconnect's attach answer the restart's", async () => {
		await restarted();
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		xterm.events.length = 0;

		print(T, "BETWEEN");
		// The restart takes the write lock the answer names: the socket's attach does not.
		attachOk(T, "SNAP", { writeLockHolder: CLIENT });
		await settle();
		print(T, "AFTER");
		type("x");

		expect(xterm.events).toEqual(["<reset>", "SNAP", "AFTER"]);
		expect(inputs()).toEqual(["x"]);
		expect(inputsTo()).toEqual([T]);
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(errorBox()).toBeNull();
	});

	it("shows what the restarted terminal prints before its attach is answered (#930)", async () => {
		await restartClicked();
		useChannelsStore().updateChannelStatus(T, "live");
		xterm.events.length = 0;

		spawnOk(T);
		// The next socket message after SPAWN_OK: the restart's attach is out by
		// then, and listening, without any timer running (#930).
		await settle();
		print(T, "PROMPT$ ");
		attachOk(T, "SNAP", { tail: [new TextEncoder().encode("TAIL")] });
		await settle();
		print(T, "AFTER");

		expect(xterm.events).toEqual(["PROMPT$ ", "AFTER"]);
		expect(attachedTo()).toEqual([T, T]);
	});

	it("keeps what a restarted command printed before it ended again", async () => {
		await restartClicked();
		useChannelsStore().updateChannelStatus(T, "live");
		xterm.events.length = 0;
		spawnOk(T);
		await settle();

		print(T, "fail: boom");
		refuse(T, lastOutput());
		await settle();
		print(T, "late");

		expect(xterm.events).toEqual(["fail: boom", MOUSE_OFF]);
		await vi.waitFor(() => expect(card()).not.toBeNull());
	});

	it("says so when the restart's attach is not answered (#942)", async () => {
		await restarted();

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		xterm.events.length = 0;
		print(T, "after");

		expect(errorBox()?.textContent).toContain("ATTACH timeout — no response after 10s");
		expect(button("Retry")).toBeDefined();
		expect(button("Close")).toBeDefined();
		expect(card()).toBeNull();
		expect(xterm.events).toEqual([]);

		button("Retry")?.click();
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
	});

	it("says so when the restart's attach cannot be sent", async () => {
		await restartClicked();
		useChannelsStore().updateChannelStatus(T, "live");
		vi.mocked(useSessionStore().wsClient.send).mockImplementation((msg) => {
			if (msg.type === "ATTACH") throw new Error("WebSocket not connected");
			sent.push(msg as Frame);
		});
		xterm.events.length = 0;

		spawnOk(T);
		await settle();
		print(T, "after");

		expect(errorBox()?.textContent).toContain("WebSocket not connected");
		expect(button("Retry")).toBeDefined();
		expect(button("Close")).toBeDefined();
		expect(xterm.events).not.toContain("after");
	});

	it("says why when the restart cannot reach the hub", async () => {
		mountPane(ref(T), "live", {
			setUp: () => {
				useChannelsStore().channels = [listed(T, "live")];
			},
		});
		await vi.waitFor(() => expect(attachedTo()).toEqual([T]));
		refuse(T);
		await vi.waitFor(() => expect(card()).not.toBeNull());
		vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

		button("Restart")?.click();
		await settle();

		await vi.waitFor(() =>
			expect(card()?.textContent).toContain("Could not restart it: Failed to fetch"),
		);
		expect(errorBox()).toBeNull();
	});

	it("lets the pane it left reconnect at once", async () => {
		const channel = ref(T);
		await restarted({ channel, setUp: withU });
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, U]));
		attachOk(U, "U-CACHED", { cached: true });
		await settle();
		expect(banner()).not.toBeNull();

		button("Reconnect")?.click();
		await settle();

		expect(attachedTo()).toEqual([T, T, U, U]);
	});

	it("lets the pane it left reconnect at once, both attaches pending", async () => {
		const channel = ref(T);
		await restarted({ channel, setUp: withU });
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T, U]));
		attachOk(U, "U-CACHED", { cached: true });
		await settle();

		button("Reconnect")?.click();
		await settle();

		expect(attachedTo()).toEqual([T, T, T, U, U]);
	});

	it("lets a reconnect's refusal answer the restart's", async () => {
		await restarted({ setUp: writer });
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		xterm.events.length = 0;

		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).toEqual(["<reset>", "LAST-SCREEN", "fail: no such file", MOUSE_OFF]);
		await vi.waitFor(() => expect(card()).not.toBeNull());
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(errorBox()).toBeNull();
	});

	// The end the pane saw was the previous run's: the socket's attach no longer
	// keeps the screen over it, and the hub's last output, which holds what the
	// new run printed, replaces it (#929).
	it("replays the last output after restarting a terminal it saw end", async () => {
		await openLive();
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		// No report that T runs again has reached the pane yet: the restart's
		// own success forgets the end (the status watcher may not have heard).
		spawnOk(T);
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T]));
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		xterm.events.length = 0;

		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).toEqual(["<reset>", "LAST-SCREEN", "fail: no such file", MOUSE_OFF]);
	});

	it("shows the card of the terminal it was given during a restart", async () => {
		const channel = ref(T);
		await restartClicked({ channel, setUp: withU });

		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		refuse(U);
		await settle();

		await vi.waitFor(() => expect(card()).not.toBeNull());
		expect(button("Restart")).toBeDefined();
		expect(quietLine()).not.toBe("Restarting…");
	});

	it("lets the setting restart the terminal it was given during a restart", async () => {
		const channel = ref(T);
		await restartClicked({
			channel,
			setUp: () => {
				withU();
				// The setting restarts only a terminal whose write lock this window holds.
				useWriteLockStore().handleWriteLock(U, CLIENT);
			},
		});
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		useChannelsStore().updateChannelStatus(U, "live");
		attachOk(U, "U-LIVE");
		await settle();
		useChannelsStore().selectChannel(U);
		settingNowSays("restart");
		runFor(60_000);
		await settle();

		useChannelsStore().updateChannelStatus(U, "dead", 0);
		await settle();

		await vi.waitFor(() => expect(spawns()).toHaveLength(2));
		expect(spawns()[1]).toMatchObject({ reuseChannelId: U });
	});

	it("waits for the socket's attach before saying the restart's failed", async () => {
		await restarted();
		await vi.advanceTimersByTimeAsync(4_000);
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		await vi.advanceTimersByTimeAsync(6_500);
		await settle();
		expect(errorBox()).toBeNull();

		// The restart takes the write lock the answer names: the socket's attach does not.
		attachOk(T, "SNAP", { writeLockHolder: CLIENT });
		await settle();
		type("x");

		expect(errorBox()).toBeNull();
		expect(inputsTo()).toEqual([T]);
	});

	it("lets the pane reconnect once both attaches have failed", async () => {
		await restarted();
		await vi.advanceTimersByTimeAsync(4_000);
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		await vi.advanceTimersByTimeAsync(10_500);
		await settle();
		expect(errorBox()?.textContent).toContain("ATTACH timeout — no response after 10s");

		button("Retry")?.click();
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T, T]));
		attachOk(T, "CACHED", { cached: true });
		await settle();
		button("Reconnect")?.click();
		await settle();

		expect(attachedTo()).toEqual([T, T, T, T, T]);
	});

	it("keeps saying a terminal restarts when the pane comes back to it", async () => {
		const channel = ref(T);
		await restartClicked({ channel, setUp: withU });
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		refuse(U);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(2));

		channel.value = T;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T]));
		refuse(T);
		await settle();

		expect(quietLine()).toBe("Restarting…");
		expect(card()).toBeNull();
		expect(spawns()).toHaveLength(2);

		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await settle();

		expect(quietLine()).toBe("Restarting…");
		expect(card()).toBeNull();
	});
});

// ─── After a Reconnect (#556) ────────────────────────────────────────────────

describe("TerminalPane after a Reconnect (#556)", () => {
	// One decision for the banner and the card, so the pane cannot say "Not
	// connected" over a terminal it knows has ended.
	it("says Not connected over a terminal answered from memory, and never over one that ended", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		expect(banner()?.textContent).toContain("Not connected.");
		expect(card()).toBeNull();

		endIt();
		await settle();

		expect(card()).not.toBeNull();
		expect(banner()).toBeNull();
	});

	// The list holds the host in view; the hub's reports cover every other one.
	it("hears its terminal end whichever host is in view", async () => {
		await openLive({
			setUp: () => {
				writer();
				// The rail is on another host: the list carries none of HOST's terminals.
				useChannelsStore().activeHostId = PI;
			},
		});
		expect(lockIndicator()).not.toBeNull();

		endIt();
		await settle();
		type("ls\r");

		expect(card()).not.toBeNull();
		expect(lockIndicator()).toBeNull();
		expect(inputs()).toEqual([]);
	});

	it("takes the hub's answer to a Reconnect: ended", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		xterm.events.length = 0;

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T, lastOutput());
		await settle();

		expect(card()?.textContent).toContain("Shell exited");
		expect(button("Restart")).toBeDefined();
		expect(banner()).toBeNull();
		// What it showed stays: the hub's copy is not drawn over it.
		expect(xterm.events).not.toContain("<reset>");
		expect(xterm.events).not.toContain("LAST-SCREEN");
	});

	it("takes the hub's answer to a Reconnect: gone", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await settle();

		expect(card()?.textContent).toContain("This terminal no longer exists.");
		expect(button("Restart")).toBeUndefined();
		expect(button("Close")).toBeDefined();
		expect(banner()).toBeNull();
		// The answer ends what the Reconnect listened to (#930).
		xterm.events.length = 0;
		print(T, "late");
		expect(xterm.events).toEqual([]);
	});

	// Over its banner (#556), and over a terminal that ended and was brought
	// back from the sidebar or another window (#559).
	it("attaches again when the hub says the terminal behind its banner is live", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();

		useChannelsStore().updateChannelStatus(T, "live");
		await settle();

		expect(attaches()).toHaveLength(2);
	});

	// A screen answered from memory is the spool's copy: the terminal's own,
	// once the host is back, replaces it (#1010).
	it("draws the live answer over a screen answered from memory when the hub says the terminal is live (#1010)", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		xterm.events.length = 0;

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP", { tail: [new TextEncoder().encode("TAIL")] });
		await settle();

		// A reset written in the stream, after what xterm has not parsed yet, then
		// the snapshot, which sets the program's modes again (#1010, #1012).
		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP", "TAIL"]);
		expect(banner()).toBeNull();
	});

	it("draws the live answer to a Reconnect over a screen answered from memory (#1010)", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		xterm.events.length = 0;

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
		expect(banner()).toBeNull();
	});

	// Only a live answer ends the missed output: a Reconnect answered from
	// memory again leaves the copy to be replaced (#930, #1010).
	it("draws the live answer after a Reconnect answered from memory again (#1010)", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "AGAIN", { cached: true });
		await settle();
		xterm.events.length = 0;

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
		expect(banner()).toBeNull();
	});

	// A Reconnect that gets no answer at all changes nothing either: the next
	// one, answered live, still replaces the copy (#1010).
	it("draws the live answer to a Reconnect after one that got no answer (#1010)", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		xterm.events.length = 0;

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
		expect(banner()).toBeNull();
	});

	// The socket back over a live screen, answered from memory: the live
	// answer after it replaces that copy as well (#1010).
	it("draws the live answer over a copy from memory its socket's return brought (#1010)", async () => {
		await openLive();
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		xterm.events.length = 0;

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
		expect(banner()).toBeNull();
	});

	// What it drew live through the end it watched stays (#927).
	it("keeps the screen it watched end when the terminal is brought back live", async () => {
		await openLive();
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());
		xterm.events.length = 0;

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "BACK");
		await settle();

		expect(card()).toBeNull();
		expect(xterm.events).toEqual([]);
	});

	// A live answer ends the missed output: what the pane drew live after it,
	// through an end it watched, stays as well (#927, #1010).
	it("keeps the screen it watched end after a recovery from memory, when the terminal is brought back live", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP");
		await settle();
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());
		xterm.events.length = 0;

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "BACK");
		await settle();

		expect(card()).toBeNull();
		expect(xterm.events).toEqual([]);
	});

	// Any live answer ends it, the socket's return's as well as a Reconnect's.
	it("keeps the screen it watched end after a recovery by its socket's return, when the terminal is brought back live", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP");
		await settle();
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());
		xterm.events.length = 0;

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "BACK");
		await settle();

		expect(card()).toBeNull();
		expect(xterm.events).toEqual([]);
	});

	it("attaches again when a terminal it saw end is brought back from elsewhere", async () => {
		await openLive();
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "BACK");
		await settle();

		expect(card()).toBeNull();
	});

	it("does not attach again when the hub repeats that the terminal it is attached to runs", async () => {
		await openLive();

		useChannelsStore().updateChannelStatus(T, "live");
		await settle();

		expect(attaches()).toHaveLength(1);
	});

	// What the terminal prints while a Reconnect waits for the hub was dropped:
	// the screen is kept, and the snapshot that holds it is not written (#930).
	it("keeps what is printed while its attach is answered (#930)", async () => {
		mountPane(ref(T), "live", { setUp: writer });
		await vi.waitFor(() => expect(attachedTo()).toEqual([T]));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		xterm.events.length = 0;

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T]));
		// Asking again for the terminal it is bound to keeps the binding (#929).
		type("x");
		expect(inputsTo()).toEqual([T]);
		print(T, "DURING");
		attachOk(T, "LIVE-SNAP", { cached: true, tail: [new TextEncoder().encode("TAIL")] });
		await settle();
		print(T, "AFTER");

		expect(xterm.events).toEqual(["DURING", "AFTER"]);
	});

	it("attaches a terminal brought back while another restarts", async () => {
		const channel = ref(T);
		await openEnded({ channel, setUp: withU });
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		attachOk(U, "U-CACHED", { cached: true });
		await settle();
		expect(banner()).not.toBeNull();

		useChannelsStore().updateChannelStatus(U, "live");
		await settle();

		expect(attachedTo()).toEqual([T, U, U]);
	});

	/** Over T's banner, given U, then Reconnect clicked before U's first attach is answered. */
	async function reconnectBehindAnAttach(): Promise<void> {
		const channel = ref(T);
		mountPane(channel, "live", { setUp: withU });
		await vi.waitFor(() => expect(attachedTo()).toEqual([T]));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, U]));
		xterm.events.length = 0;
	}

	it("draws the snapshot an attach without preserveContent shares with a Reconnect", async () => {
		await reconnectBehindAnAttach();

		attachOk(U, "U-SNAP");
		await settle();

		expect(xterm.events).toEqual(["<reset>", "U-SNAP"]);
	});

	it("replays the last output a refusal shares with a Reconnect", async () => {
		await reconnectBehindAnAttach();

		refuse(U, lastOutput());
		await settle();

		expect(xterm.events).toEqual(["<reset>", "LAST-SCREEN", "fail: no such file", MOUSE_OFF]);
	});

	// The answer will replace the screen: output written just before it could
	// be parsed after its reset, so the Reconnect writes none early (#929).
	it("writes nothing early when the answer will replace the screen", async () => {
		await reconnectBehindAnAttach();

		print(U, "DURING");
		attachOk(U, "U-SNAP");
		await settle();

		expect(xterm.events).toEqual(["<reset>", "U-SNAP"]);
	});

	// Brought back from elsewhere, the terminal runs again: the end the pane saw
	// was the previous run's, and the hub's last output replaces it (#929).
	it("replays the last output after a terminal it saw end is brought back from elsewhere", async () => {
		await openLive();
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T]));
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, T, T]));
		xterm.events.length = 0;

		refuse(T, lastOutput());
		await settle();

		expect(xterm.events).toEqual(["<reset>", "LAST-SCREEN", "fail: no such file", MOUSE_OFF]);
	});
});

// ─── The live screen over one from memory, as xterm draws it (#1010) ─────────

/** What vt100's `contents_formatted` starts with: the cursor shown, plain attributes, a clear screen. */
const CLEAR = "\u001b[?25h\u001b[m\u001b[H\u001b[J";

/**
 * xterm itself (6.0.0), unopened, at the PTY's size: it parses every write and
 * reset the pane's stand-in takes, in the order the pane makes them.
 */
async function realXterm(): Promise<Terminal> {
	const { Terminal: Xterm } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
	const real = new Xterm({ cols: 100, rows: 30, allowProposedApi: true });
	onTestFinished(() => real.dispose());
	xterm.onWrite = (_term, text) => real.write(text);
	xterm.onReset = () => real.reset();
	return real;
}

/** Let `real` parse all it took: xterm parses on a timer, which these tests fake. */
async function parsedBy(real: Terminal): Promise<void> {
	let parsed = false;
	real.write("", () => {
		parsed = true;
	});
	for (let tick = 0; !parsed && tick < 100; tick++) await vi.advanceTimersByTimeAsync(1);
	expect(parsed).toBe(true);
}

/**
 * A pane over T, answered from memory with a copy whose tail ends in `left`,
 * then answered live, once the hub says T is live, with `snapshot` and `tail`:
 * xterm, having parsed all the pane wrote.
 */
async function liveOverRemembered(
	left: string,
	snapshot: string,
	tail = "",
	during = "",
	inputModes = "",
): Promise<Terminal> {
	mountPane(ref(T), "live");
	const real = await realXterm();
	await vi.waitFor(() => expect(attaches()).toHaveLength(1));
	attachOk(T, `${CLEAR}REMEMBERED`, { cached: true, tail: [new TextEncoder().encode(left)] });
	await settle();

	useChannelsStore().updateChannelStatus(T, "live");
	await vi.waitFor(() => expect(attaches()).toHaveLength(2));
	// Printed while the attach waits: the live snapshot holds it (#931).
	if (during !== "") print(T, during);
	attachOk(T, snapshot, {
		tail: tail === "" ? [] : [new TextEncoder().encode(tail)],
		...(inputModes !== "" && {
			snapshot: { serialized: snapshot, cols: 100, rows: 30, cursorX: 0, cursorY: 0, inputModes },
		}),
	});
	await settle();
	await parsedBy(real);
	return real;
}

/** The screen's first `count` rows, as xterm holds them, trailing blanks dropped. */
function screenRows(real: Terminal, count: number): string[] {
	const buffer = real.buffer.active;
	return Array.from(
		{ length: count },
		(_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "",
	);
}

// The copy from memory ends in whatever its program left set. The live answer
// replaces it as an attach that resets does: the snapshot assumes how a reset
// draws text, and carries the input modes the program has now (#1012).
describe("TerminalPane drawing the live screen over one from memory (#1010)", () => {
	it("draws what was printed while it waited before the snapshot, which covers it", async () => {
		const real = await liveOverRemembered("", `${CLEAR}live`, "", "DURING");

		expect(xterm.events.slice(-3)).toEqual(["DURING", FULL_RESET, `${CLEAR}live`]);
		expect(screenRows(real, 2)).toEqual(["live", ""]);
	});

	it("draws it from the top, whatever scrolling region and origin mode the copy left", async () => {
		const real = await liveOverRemembered(
			"\u001b[2;4r\u001b[?6h",
			`${CLEAR}one\r\ntwo\r\nthree\r\nfour\r\nfive`,
			// The program sets a region, then goes to the screen's top left corner.
			"\u001b[3;5r\u001b[HX",
		);

		expect(screenRows(real, 6)).toEqual(["Xne", "two", "three", "four", "five", ""]);
	});

	it("draws it in ASCII, whatever character set the copy left in use", async () => {
		const real = await liveOverRemembered(
			// DEC line drawing in G0 and G1, and G1 in use.
			"\u001b(0\u001b)0\u000e",
			`${CLEAR}live`,
			// The program readies line drawing in G1, as a terminal's `enacs` does,
			// and goes on writing in G0.
			"\u001b)0 now",
		);

		expect(screenRows(real, 1)).toEqual(["live now"]);
	});

	it("wraps its long rows, whatever the copy left of autowrap", async () => {
		const real = await liveOverRemembered("\u001b[?7l", `${CLEAR}${"a".repeat(100)}bc`);

		expect(screenRows(real, 2)).toEqual(["a".repeat(100), "bc"]);
	});

	it("writes over its text, whatever the copy left of insert mode", async () => {
		const real = await liveOverRemembered("\u001b[4h", `${CLEAR}live\u001b[H`, "L");

		expect(screenRows(real, 1)).toEqual(["Live"]);
	});

	it("draws it in the main buffer, as an attach that resets does", async () => {
		const real = await liveOverRemembered(`\u001b[?1049h${CLEAR}ALT`, `${CLEAR}live`);

		expect(real.buffer.active.type).toBe("normal");
		expect(screenRows(real, 1)).toEqual(["live"]);
	});

	it("draws it at once, whatever frame the copy left open", async () => {
		const real = await liveOverRemembered("\u001b[?2026h", `${CLEAR}live`);

		expect(real.modes.synchronizedOutputMode).toBe(false);
	});

	it("links none of it, whatever hyperlink the copy left open", async () => {
		const real = await liveOverRemembered(
			"\u001b]8;;https://example.invalid/\u001b\\",
			`${CLEAR}live`,
		);

		expect(screenRows(real, 1)).toEqual(["live"]);
		// xterm keeps a cell's link in its own cell data, which its API leaves out.
		const cell = real.buffer.active.getLine(real.buffer.active.baseY)?.getCell(0) as unknown as {
			extended: { urlId: number };
		};
		expect(cell.extended.urlId).toBe(0);
	});

	it("takes the input modes the program has now from the live snapshot, not those of the copy", async () => {
		const real = await liveOverRemembered(
			"\u001b[?1h\u001b=\u001b[?1000h",
			`${CLEAR}live`,
			"",
			"",
			"\u001b[?2004h\u001b[?1004h",
		);

		expect(real.modes).toMatchObject({
			applicationCursorKeysMode: false,
			applicationKeypadMode: false,
			bracketedPasteMode: true,
			mouseTrackingMode: "none",
			sendFocusMode: true,
		});
	});

	it("drops the copy's scrollback, as an attach that resets does", async () => {
		const real = await liveOverRemembered(`${"\r\n".repeat(30)}older`, `${CLEAR}live`);

		expect(real.buffer.active.baseY).toBe(0);
		expect(screenRows(real, 1)).toEqual(["live"]);
	});
});

// ─── Every attach reads the hub's answer (#559) ──────────────────────────────

// Every attach reads the answer the same way. The one after the socket came
// back read nothing, and the pane kept the banner, or dropped none, whatever
// the hub had said. The others: TerminalPane.ended-output.spec.ts.
describe("TerminalPane covers its terminal with what the hub answers now (#559)", () => {
	// The hub names the terminal it refuses; an older one may name none, and
	// its refusal is still the answer to the pane's attach.
	it("takes a refusal that names no terminal", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		hear({ type: "ERROR", code: "CHANNEL_DEAD", message: "This terminal has ended." });
		await settle();

		await vi.waitFor(() => expect(card()).not.toBeNull());
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(errorBox()).toBeNull();
	});

	it("drops its banner when the hub answers from the terminal once its socket is back", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();

		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE");
		await settle();

		expect(banner()).toBeNull();
	});

	it("shows the card when the hub says its terminal ended while its socket was away", async () => {
		await openLive();

		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		await settle();

		expect(card()).not.toBeNull();
		expect(errorBox()).toBeNull();
	});

	it("covers a terminal it is handed with the hub's answer", async () => {
		const channel = ref(T);
		await openLive({ channel, setUp: () => useChannelsStore().registerChannelHost(U, HOST) });

		channel.value = U;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(U);
		await settle();

		expect(card()).not.toBeNull();
		expect(errorBox()).toBeNull();
	});

	it("shows the card again when a terminal it restarted ends at once", async () => {
		freshWindow();
		useChannelsStore().registerChannelHost(T, HOST);
		mount({ channel: ref(T) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		await settle();

		expect(card()).not.toBeNull();
	});

	// An answer replaces all the pane knew, not only the part it speaks of.
	it("takes each answer whole: from memory, ended, then running", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		await settle();
		expect(card()).not.toBeNull();
		expect(banner()).toBeNull();

		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "LIVE");
		await settle();
		expect(card()).toBeNull();
		expect(banner()).toBeNull();
	});

	it("takes each answer whole: gone, then another terminal running", async () => {
		const channel = ref(T);
		mountPane(channel, "live", { setUp: () => useChannelsStore().registerChannelHost(U, HOST) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await vi.waitFor(() => expect(card()?.textContent).toContain("no longer exists"));

		channel.value = U;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(U, "U");
		await settle();

		expect(card()).toBeNull();
	});

	// A terminal its list says has ended is asked for all the same (#927), and
	// the hub's answer covers it.
	it("says a terminal it knew had ended is gone when the hub has no record of it", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await settle();

		expect(card()?.textContent).toContain("This terminal no longer exists.");
	});

	it("takes the answer of the new socket it asked again, once its socket was replaced while it waited", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		useSessionStore().reconnectCount++;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));

		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await settle();

		expect(card()?.textContent).toContain("This terminal no longer exists.");
	});

	it("covers the terminal it was handed while it opened with the hub's answer", async () => {
		const channel = ref(T);
		mountPane(channel, "dead", { setUp: () => useChannelsStore().registerChannelHost(U, HOST) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		channel.value = U;
		await settle();
		refuse(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));

		refuse(U);
		await settle();

		expect(card()).not.toBeNull();
		expect(errorBox()).toBeNull();
	});
});

// A pane over an ended local terminal, in a global tab, showed an empty
// terminal with no overlay, no lock and no Restart once the sidebar had moved
// to the Raspberry Pi (#594). It had not attached, since the list said its
// terminal had ended, and it had kept nothing of that: its cover read the
// list of the host in view, which no longer carried it.
describe("TerminalPane over an ended terminal of the host not in view (#594)", () => {
	it("keeps the end it knew of when its attach went unanswered, whatever list is in view", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		freshWindow();
		const channels = useChannelsStore();
		channels.activeHostId = HOST;
		channels.channels = [listed(T, "dead", { exitCode: 1 })];
		channels.registerChannelHost(T, HOST);
		mount({ channel: ref(T) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(card()).not.toBeNull();

		// The rail moves to the Pi: its list does not carry T.
		channels.activeHostId = PI;
		channels.channels = [];
		await settle();

		expect(card()).not.toBeNull();
		expect(lockIndicator()).toBeNull();
	});

	// For the terminal it still shows only: a pane given another one while it
	// waited must not take that one for ended (#929).
	it("does not take a terminal it was handed while it waited for the one that ended", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const channel = ref(T);
		mountPane(channel, "dead", {
			setUp: () => {
				useChannelsStore().registerChannelHost(U, HOST);
				useChannelsStore().updateChannelStatus(U, "live");
			},
		});
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		channel.value = U;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(attaches()[1]).toMatchObject({ channelId: U });
		expect(card()).toBeNull();
	});
});

// ─── Answers for a terminal the pane left (#929) ─────────────────────────────

// The hub can answer an attach late: it waits on the agent, and on an SSH host
// first tries to reach it. A pane handed another terminal meanwhile took that
// late answer as its own: it drew the other terminal, covered itself with its
// state, and Close, as the setting, deleted the terminal it now showed.
describe("TerminalPane takes only the answers for the terminal it shows (#929)", () => {
	/**
	 * A pane attached to T, given U (its ATTACH left unanswered), then T again,
	 * whose second ATTACH is answered with the title "T-TITLE".
	 */
	async function movedBack({ setUp, ...open }: Open = {}): Promise<void> {
		const channel = ref(T);
		await openLive({
			...open,
			channel,
			setUp: () => {
				useChannelsStore().registerChannelHost(U, HOST);
				setUp?.();
			},
		});
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		channel.value = T;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T]));
		attachOk(T, "T-SECOND", { dynamicTitle: "T-TITLE" });
		await settle();
	}

	it("writes nothing from a late answer for a terminal it left", async () => {
		await movedBack({
			setUp: () => {
				useChannelsStore().channels = [listed(T, "live")];
			},
		});
		expect(paneTitleText()).toBe("T-TITLE");
		expect([terminal().cols, terminal().rows]).toEqual([100, 30]);
		xterm.events.length = 0;

		attachOk(U, "U-LATE", { cached: true, cols: 120, rows: 40, dynamicTitle: "U-TITLE" });
		await settle();
		print(U, "U-OUT");
		print(T, "T-OUT");

		// Each of them, whichever the others: a late answer takes none (#929).
		expect.soft(xterm.events).toEqual(["T-OUT"]);
		expect.soft(banner()).toBeNull();
		expect.soft([terminal().cols, terminal().rows]).toEqual([100, 30]);
		expect.soft(paneTitleText()).toBe("T-TITLE");
	});

	it("keeps its input on the terminal it shows after a late answer", async () => {
		await movedBack({ setUp: writer });

		attachOk(U, "U-LATE");
		await settle();
		type("x");

		expect(inputsTo()).toEqual([T]);
	});

	// Asking for another terminal unbinds the pane: typing, and xterm's own
	// replies, went to the terminal it left until the answer came (#929).
	it("sends nothing typed while it waits for another terminal", async () => {
		const channel = ref(T);
		// This window holds both terminals' write locks: typing in a pane showing
		// U is allowed, and only the binding decides where it goes.
		await openLive({
			channel,
			setUp: () => {
				writer();
				withU();
				useWriteLockStore().handleWriteLock(U, CLIENT);
			},
		});
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));

		type("x");
		expect(inputsTo()).toEqual([]);

		attachOk(U, "U-SCREEN");
		await settle();
		type("y");

		expect(inputs()).toEqual(["y"]);
		expect(inputsTo()).toEqual([U]);
	});

	it("is not closed by a late refusal for a terminal it left", async () => {
		xterm.profile = { whenEnded: "close" };
		await movedBack({ setUp: shown });

		refuse(U, lastOutput());
		await settle();
		await vi.advanceTimersByTimeAsync(3_000);
		await settle();

		expect(closes()).toEqual([]);
		expect(card()).toBeNull();
	});

	it("is not said gone by a late refusal for a terminal it left", async () => {
		await movedBack();

		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: U });
		await settle();

		expect(paneText()).not.toContain("This terminal no longer exists.");
		expect(card()).toBeNull();
	});

	it("shows no timeout for a terminal it left", async () => {
		await movedBack();

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(errorBox()).toBeNull();
	});

	/** A pane opening over T, given U and U selected before T's ATTACH is answered. */
	async function givenAnotherWhileOpening(): Promise<void> {
		const channel = ref(T);
		mountPane(channel, "live", {
			setUp: () => useChannelsStore().registerChannelHost(U, HOST),
		});
		await vi.waitFor(() => expect(attachedTo()).toEqual([T]));
		channel.value = U;
		useChannelsStore().selectChannel(U);
		await settle();
	}

	it("is not closed while opening by a refusal for the terminal it was given before", async () => {
		xterm.profile = { whenEnded: "close" };
		await givenAnotherWhileOpening();

		refuse(T, lastOutput());
		await settle();
		await vi.advanceTimersByTimeAsync(3_000);
		await settle();

		expect(closes()).toEqual([]);
		expect(card()).toBeNull();
		expect(attachedTo()).toEqual([T, U]);
		attachOk(U, "U-SCREEN");
		await settle();
		expect(xterm.events).toContain("U-SCREEN");
	});

	it("draws nothing while opening from the answer for the terminal it was given before", async () => {
		await givenAnotherWhileOpening();
		xterm.events.length = 0;

		attachOk(T, "T-SCREEN");
		await settle();

		expect(xterm.events).not.toContain("<reset>");
		expect(xterm.events).not.toContain("T-SCREEN");
		expect(attachedTo()).toEqual([T, U]);
	});

	it("shows no timeout while opening for the terminal it was given before", async () => {
		await givenAnotherWhileOpening();

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(errorBox()).toBeNull();
		expect(attachedTo()).toEqual([T, U]);
	});
});

// ─── A pane switched to another terminal (#966) ──────────────────────────────

// xterm parses a write later than it takes it, and the pane kept one xterm
// across terminals: what the terminal it left printed just before a switch was
// parsed once the next one had bound it. xterm's answer to its query was typed
// into the next terminal, its title and modes stayed, and a screen with no
// snapshot to replace it stayed up under the new binding. Each terminal now
// gets an xterm of its own, and the one it left is disposed.
describe("TerminalPane switched to another terminal (#966)", () => {
	const QUERY = "\u001b[6n";
	const REPLY = "\u001b[1;1R";
	/** A third terminal on HOST. */
	const V = "01HZZZZZZZZZZZZZZZZZZZZZV6";
	const xterms = () => [...root.querySelectorAll(".xterm")];
	/** The pane's one `.xterm`, the same element and not one that merely looks like it. */
	function theXterm(): Element | undefined {
		const all = xterms();
		expect(all).toHaveLength(1);
		return all[0];
	}
	const size = () => [terminal().cols, terminal().rows];
	const bells = (id: string) => useNotificationStore().bellCounts.get(id) ?? 0;
	const unread = (id: string) => useNotificationStore().unreadLines.get(id) ?? 0;
	const searchInput = () =>
		root.querySelector<HTMLInputElement>('input[aria-label="Search terminal"]');
	const searchShown = () =>
		root.querySelector<HTMLElement>('[role="search"]')?.style.display !== "none";
	const counts = () =>
		root.querySelector(".search-overlay__match-count")?.textContent?.trim() ?? null;
	const regexOn = () =>
		root
			.querySelector('button[title="Use Regular Expression"]')
			?.classList.contains("search-overlay__toggle--active") ?? false;
	const regexError = () =>
		root.querySelector(".search-overlay__regex-error")?.textContent?.trim() ?? "";
	const searches = () => xterm.searches as StandInSearch[];

	/** U and V run on HOST too. */
	function withTerminals(): void {
		const channels = useChannelsStore();
		channels.registerChannelHost(U, HOST);
		channels.registerChannelHost(V, HOST);
	}

	/** T and U are listed, with the titles the hub computed for them. */
	function listBoth(): void {
		useChannelsStore().channels = [
			listed(T, "live", { displayTitle: "T-NAME" }),
			listed(U, "live", { displayTitle: "U-NAME" }),
		];
	}

	/** This window holds both T's and U's write locks: the pane decides their size. */
	function writesBoth(): void {
		writer();
		useWriteLockStore().handleWriteLock(U, CLIENT);
	}

	/** A pane showing T, whose ATTACH_OK writes `T-SCREEN` and carries `answer`. */
	async function showingT({
		setUp,
		answer = {},
	}: {
		setUp?: () => void;
		answer?: Partial<Frame>;
	} = {}): Promise<Ref<string>> {
		const channel = ref(T);
		mountPane(channel, "live", {
			setUp: () => {
				withTerminals();
				setUp?.();
			},
		});
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "T-SCREEN", answer);
		await settle();
		return channel;
	}

	/** The pane given U: its ATTACH sent, not answered. */
	async function givenU(channel: Ref<string>): Promise<void> {
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo().at(-1)).toBe(U));
	}

	/** The pane given U, which answers with `U-SCREEN`. */
	async function switched(channel: Ref<string>, over: Partial<Frame> = {}): Promise<void> {
		await givenU(channel);
		attachOk(U, "U-SCREEN", over);
		await settle();
	}

	async function openSearch(): Promise<void> {
		press({ ctrlKey: true, shiftKey: true, key: "F" }, "\u0006");
		await settle();
	}

	async function typeSearch(query: string): Promise<void> {
		const input = searchInput();
		if (input === null) throw new Error("the search box is not shown");
		input.value = query;
		input.dispatchEvent(new Event("input"));
		await settle();
	}

	async function toggleRegex(): Promise<void> {
		root.querySelector<HTMLButtonElement>('button[title="Use Regular Expression"]')?.click();
		await settle();
	}

	it("sends the terminal it switched to nothing xterm answers for the one it left", async () => {
		const channel = await showingT({ setUp: writesBoth });
		xterm.answer = (text) => (text.includes(QUERY) ? REPLY : null);
		xterm.parse = "later";
		print(T, QUERY);
		await switched(channel);

		drain();
		await settle();

		expect(inputsTo()).toEqual([]);
	});

	it("shows the terminal it switched to in a new xterm and keeps only that one", async () => {
		const channel = await showingT();
		const before = terminal();

		await switched(channel);

		expect(terminal()).not.toBe(before);
		expect(theXterm()).toBe(terminal().element);
		expect(before.disposed).toBe(true);
	});

	it("shows an empty screen for a terminal switched to without a snapshot", async () => {
		const channel = await showingT();

		await switched(channel, { snapshot: null, tail: [], cached: true });

		expect(terminal().parsed).toEqual([]);
	});

	it("shows the title of the terminal it switched to, not the one it left", async () => {
		const channel = await showingT({ setUp: listBoth, answer: { dynamicTitle: "T-TITLE" } });
		expect(paneTitleText()).toBe("T-TITLE");

		await switched(channel);

		expect(paneTitleText()).toBe("U-NAME");
	});

	it("keeps the keyboard when it switches to another terminal", async () => {
		const channel = await showingT();
		terminal().focus();

		await switched(channel);

		expect(terminal().element.contains(document.activeElement)).toBe(true);
	});

	it("leaves the keyboard elsewhere when it switches without it", async () => {
		const channel = await showingT({ setUp: () => useChannelsStore().selectChannel(T) });
		const elsewhere = document.body.appendChild(document.createElement("button"));
		onTestFinished(() => elsewhere.remove());
		await givenU(channel);
		useChannelsStore().selectChannel(U);
		await settle();
		elsewhere.focus();

		attachOk(U, "U-SCREEN");
		await settle();

		expect(document.activeElement).toBe(elsewhere);
	});

	/** T's ATTACH_OK replay begun in its xterm: its opening marker parsed, not its closing one. */
	async function replayBegun(): Promise<{ channel: Ref<string>; left: StandInTerminal }> {
		const channel = ref(T);
		mountPane(channel, "live", { setUp: withTerminals });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		xterm.parse = "later";
		attachOk(T, "T-SCREEN");
		await settle();
		const left = terminal();
		parseOf(left, 1);
		return { channel, left };
	}

	it("rings the bell of the terminal it switched to while the one it left never finishes its replay", async () => {
		const { channel, left } = await replayBegun();
		await switched(channel);
		dropQueueOf(left);
		parseOf(terminal());

		print(U, "\u0007");
		parseOf(terminal());

		expect(bells(U)).toBe(1);
	});

	it("keeps the bells of the terminal it switched to's replay muted while the one it left finishes its own", async () => {
		const { channel, left } = await replayBegun();
		await givenU(channel);
		attachOk(U, "U-SCREEN\u0007");
		await settle();
		const shown = terminal();

		parseOf(shown, 1);
		parseOf(left);
		parseOf(shown);

		expect(bells(U)).toBe(0);
	});

	it("searches the terminal it switched to", async () => {
		const channel = await showingT();
		const [left] = searches();
		await switched(channel);

		await openSearch();
		await typeSearch("needle");

		const shown = searches().at(-1);
		expect(shown).not.toBe(left);
		expect(shown?.findNext).toHaveBeenCalledWith(
			"needle",
			expect.objectContaining({ incremental: true }),
		);
		expect(left?.dispose).toHaveBeenCalled();
	});

	/** The search settings the Settings page writes, set before the pane is shown. */
	function searchSettings(search: Record<string, unknown>): () => void {
		return () => {
			const config = useConfigStore();
			config.uiConfig = { ...config.uiConfig, search: { ...config.uiConfig.search, ...search } };
		};
	}
	const overlayClasses = () =>
		[...(root.querySelector('[role="search"]')?.classList ?? [])].filter((c) =>
			c.startsWith("search-overlay--"),
		);
	async function enter(): Promise<void> {
		searchInput()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
	}
	const history = () =>
		JSON.parse(localStorage.getItem("lasterm:search-history") ?? "[]").map(
			(e: { query: string }) => e.query,
		);

	it("puts its search where the settings put it", async () => {
		await showingT({ setUp: searchSettings({ position: "bottom-bar" }) });
		expect(overlayClasses()).toEqual(["search-overlay--bottom-bar"]);
	});

	it("puts its search at the top right when the settings name no place", async () => {
		await showingT();
		expect(overlayClasses()).toEqual(["search-overlay--top-right"]);
	});

	it("keeps what it found when the search closes and the settings say persist", async () => {
		await showingT({ setUp: searchSettings({ highlightOnClose: "persist" }) });
		await openSearch();
		await typeSearch("needle");
		const addon = searches().at(-1) as unknown as { clearDecorations: ReturnType<typeof vi.fn> };
		addon.clearDecorations.mockClear();

		searchInput()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();

		expect(searchShown()).toBe(false);
		expect(addon.clearDecorations).not.toHaveBeenCalled();
		expect(searchInput()?.value).toBe("needle");
	});

	it("clears what it found when the search closes and the settings say clear", async () => {
		await showingT({ setUp: searchSettings({ highlightOnClose: "clear" }) });
		await openSearch();
		await typeSearch("needle");
		const addon = searches().at(-1) as unknown as { clearDecorations: ReturnType<typeof vi.fn> };
		addon.clearDecorations.mockClear();

		searchInput()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();

		expect(searchShown()).toBe(false);
		expect(addon.clearDecorations).toHaveBeenCalledTimes(1);
		expect(searchInput()?.value).toBe("");
	});

	// Wrong implementations: "fade" handled as clear (cleared at once) or as persist (never cleared).
	it("closes the search at once and clears what it found a moment later when the settings say fade", async () => {
		await showingT({ setUp: searchSettings({ highlightOnClose: "fade" }) });
		await openSearch();
		await typeSearch("needle");
		const addon = searches().at(-1) as unknown as { clearDecorations: ReturnType<typeof vi.fn> };
		addon.clearDecorations.mockClear();

		searchInput()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();

		expect(searchShown()).toBe(false);
		expect(addon.clearDecorations).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(addon.clearDecorations).toHaveBeenCalledTimes(1), {
			timeout: 2000,
		});
	});

	it("remembers as many searches as the settings allow", async () => {
		localStorage.removeItem("lasterm:search-history");
		await showingT({ setUp: searchSettings({ historySize: 2 }) });
		await openSearch();
		for (const query of ["one", "two", "three"]) {
			await typeSearch(query);
			await enter();
		}

		expect(history()).toEqual(["three", "two"]);
	});

	it("searches an open query again in the terminal it switched to", async () => {
		const channel = await showingT();
		await openSearch();
		await toggleRegex();
		await typeSearch("ne+dle");
		searches()[0]?.report(3, 0);
		await settle();
		expect(counts()).toBe("1/3");

		await switched(channel);

		const shown = searches().at(-1);
		expect(searchInput()?.value).toBe("ne+dle");
		expect(regexOn()).toBe(true);
		expect(shown?.findNext).toHaveBeenCalledWith(
			"ne+dle",
			expect.objectContaining({ regex: true }),
		);
		expect(counts()).toBe("0/0");
		shown?.report(5, 1);
		await settle();
		expect(counts()).toBe("2/5");
	});

	it("shows no count of the terminal it left for an invalid search", async () => {
		const channel = await showingT();
		await openSearch();
		await toggleRegex();
		await typeSearch("needle");
		searches()[0]?.report(3, 0);
		await settle();
		await typeSearch("(");
		expect(counts()).toBe("1/3");
		expect(regexError()).not.toBe("");

		await switched(channel);

		expect(counts()).toBe("0/0");
		expect(searchInput()?.value).toBe("(");
		expect(regexError()).not.toBe("");
		expect(searches().at(-1)?.findNext).not.toHaveBeenCalled();
	});

	it("draws the terminal it switched to with the profile applied last", async () => {
		const channel = await showingT({
			setUp: () => {
				useThemeStore().appearance.scrollbar.style = "hidden";
			},
		});
		paneProfile().profile.value = {
			...paneProfile().profile.value,
			fontSize: 18,
			fontFamily: '"Fira Code"',
			cursorStyle: "underline",
			scrollback: 1234,
			scrollbarMarkers: false,
		};
		await settle();

		await switched(channel);

		expect(terminal().options).toMatchObject({
			fontSize: 18,
			fontFamily: '"Fira Code"',
			cursorStyle: "underline",
			cursorBlink: false,
			scrollback: 1234,
			overviewRuler: { width: 1 },
		});
	});

	it("draws the terminal it switched to in the theme set last", async () => {
		const channel = await showingT();
		const later = BUNDLED_THEMES.nord!;
		useThemeStore().applyTheme(later);
		await settle();

		await switched(channel);

		expect(terminal().options.theme).toEqual(useThemeStore().toXtermTheme(later.colors));
	});

	it("draws the terminal it switched to at its PTY size", async () => {
		const channel = await showingT();

		await switched(channel, { cols: 120, rows: 40 });

		expect(size()).toEqual([120, 40]);
	});

	it("sizes the scrollbar of the terminal it switched to", async () => {
		const channel = await showingT();
		await switched(channel);

		useThemeStore().appearance.scrollbar.widthThin = 9;
		window.dispatchEvent(new Event("nt:scrollbar-changed"));

		expect(terminal().options.overviewRuler).toMatchObject({ width: 9 });
	});

	it("draws the terminal it switched to in its host's theme", async () => {
		const own = BUNDLED_THEMES.nord!;
		const channel = await showingT({
			setUp: () => {
				useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
				useHostsStore().hosts = [host(HOST, "pi", JSON.stringify({ theme: own.name }))];
			},
		});
		useThemeStore().applyTheme(BUNDLED_THEMES.dracula!);
		await settle();

		await switched(channel);

		expect(terminal().options.theme).toEqual(useThemeStore().toXtermTheme(own.colors));
	});

	// The pane read its host's theme once, at mount: a terminal on another host
	// was drawn in the first host's theme (#997).
	it("draws a terminal on another host in that host's theme", async () => {
		const channel = await showingT({
			setUp: () => {
				useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
				useHostsStore().hosts = [
					host(HOST, "pi", JSON.stringify({ theme: "nord" })),
					host(PI, "other", JSON.stringify({ theme: "gruvbox-dark" })),
				];
			},
		});
		useChannelsStore().registerChannelHost(U, PI);

		await switched(channel);

		expect(terminal().options.theme).toEqual(
			useThemeStore().toXtermTheme(BUNDLED_THEMES["gruvbox-dark"]!.colors),
		);
	});

	it("draws a terminal on a host with no theme of its own in the active theme", async () => {
		const channel = await showingT({
			setUp: () => {
				useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
				useHostsStore().hosts = [
					host(HOST, "pi", JSON.stringify({ theme: "nord" })),
					host(PI, "other"),
				];
			},
		});
		useThemeStore().applyTheme(BUNDLED_THEMES.dracula!);
		await settle();
		useChannelsStore().registerChannelHost(U, PI);

		await switched(channel);

		expect(terminal().options.theme).toEqual(
			useThemeStore().toXtermTheme(BUNDLED_THEMES.dracula!.colors),
		);
	});

	it("fits the terminal it switched to to its pane", async () => {
		paneHasASize();
		const channel = await showingT({ setUp: writesBoth });
		expect(size()).toEqual([80, 24]);
		await givenU(channel);
		xterm.fit = { cols: 90, rows: 28 };

		attachOk(U, "U-SCREEN");
		await settle();

		expect(size()).toEqual([90, 28]);
		expect(terminal().unicode.activeVersion).toBe("11");
	});

	it("keeps the size of a pane out of sight that switches", async () => {
		xterm.fit = { cols: 132, rows: 43 };
		const channel = await showingT({ setUp: writesBoth });
		expect(size()).toEqual([132, 43]);
		await givenU(channel);
		xterm.fit = { cols: 90, rows: 28 };

		attachOk(U, "U-SCREEN");
		await settle();

		expect(size()).toEqual([132, 43]);
	});

	it("fits its terminal again once the font settles", async () => {
		paneHasASize();
		mountPane(ref(T), "live", { setUp: writer });
		// Promises only: the frames the refit waits for have not passed.
		await settle();
		expect(size()).toEqual([80, 24]);

		xterm.fit = { cols: 90, rows: 28 };

		await vi.waitFor(() => expect(size()).toEqual([90, 28]));
	});

	it("fits the terminal it switched to again once the font settles", async () => {
		paneHasASize();
		const channel = await showingT({ setUp: writesBoth });
		await switched(channel);
		expect(size()).toEqual([80, 24]);

		xterm.fit = { cols: 90, rows: 28 };

		await vi.waitFor(() => expect(size()).toEqual([90, 28]));
	});

	/**
	 * T attached from what the hub remembers (the banner shows), then U given and
	 * its ATTACH timed out: the banner stays over T's screen. Reconnect asks for U.
	 */
	async function reconnectingOverT(): Promise<void> {
		const channel = await showingT({ answer: { cached: true } });
		expect(banner()).not.toBeNull();
		await givenU(channel);
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, U]));
	}

	it("writes the snapshot of a terminal reconnected over another's screen", async () => {
		await reconnectingOverT();
		const before = terminal();
		print(U, "U-OUT");

		attachOk(U, "U-SCREEN");
		await settle();

		expect(terminal()).not.toBe(before);
		expect(terminal().parsed).toContain("U-SCREEN");
		expect(xterm.events).not.toContain("U-OUT");
	});

	it("shows an ended terminal it switched to in a new xterm", async () => {
		const channel = await showingT();
		const before = terminal();
		await givenU(channel);

		refuse(U, lastOutput());
		await settle();

		expect(terminal()).not.toBe(before);
		expect(before.disposed).toBe(true);
		expect(terminal().parsed).toContain("LAST-SCREEN");
	});

	it("shows the last output of a terminal reconnected over another's screen", async () => {
		await reconnectingOverT();

		refuse(U, lastOutput());
		await settle();

		expect(terminal().parsed).toContain("LAST-SCREEN");
	});

	it("shows an ended terminal it switched to over nothing of the one it left when the hub kept nothing", async () => {
		const channel = await showingT();
		const before = terminal();
		await givenU(channel);

		refuse(U);
		await settle();

		expect(terminal()).not.toBe(before);
		expect(terminal().parsed).not.toContain("T-SCREEN");
	});

	it("shows a terminal it switched to that is gone over nothing of the one it left", async () => {
		const channel = await showingT();
		const before = terminal();
		await givenU(channel);

		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: U });
		await settle();

		expect(terminal()).not.toBe(before);
		expect(terminal().parsed).toEqual([]);
	});

	describe("keeps its xterm when the terminal it shows is attached again", () => {
		it("by a Reconnect", async () => {
			await showingT({ answer: { cached: true } });
			const before = terminal().element;

			button("Reconnect")?.click();
			await vi.waitFor(() => expect(attachedTo()).toEqual([T, T]));
			attachOk(T, "T-AGAIN");
			await settle();

			expect(theXterm()).toBe(before);
		});

		it("by a Restart", async () => {
			await openEnded();
			const before = terminal().element;

			button("Restart")?.click();
			await vi.waitFor(() => expect(spawns()).toHaveLength(1));
			spawnOk(T);
			await vi.waitFor(() => expect(attaches()).toHaveLength(2));
			attachOk(T, "AGAIN");
			await settle();

			expect(theXterm()).toBe(before);
		});

		it("by the socket coming back", async () => {
			await openLive();
			const before = terminal().element;

			useSessionStore().reconnectCount++;
			await vi.waitFor(() => expect(attaches()).toHaveLength(2));
			attachOk(T, "AGAIN");
			await settle();

			expect(theXterm()).toBe(before);
		});
	});

	it("rings the bell of the terminal it switched to", async () => {
		const channel = await showingT();
		await switched(channel);

		print(U, "\u0007");

		expect(bells(U)).toBe(1);
	});

	it("takes its shortcuts in the terminal it switched to", async () => {
		const channel = await showingT();
		await switched(channel);

		expect(press({ ctrlKey: true, shiftKey: true, key: "F" }, "\u0006")).toBe(false);
		await settle();

		expect(searchShown()).toBe(true);
	});

	it("leaves no xterm when it closes after a switch", async () => {
		const channel = await showingT();
		await switched(channel);
		const shown = terminal();

		closePane();

		expect(root.querySelectorAll(".xterm")).toHaveLength(0);
		expect(shown.disposed).toBe(true);
	});

	it("rings nothing for a bell of the terminal it left while it waits for the next", async () => {
		xterm.profile = { bellSound: "system" };
		const channel = await showingT({ setUp: () => useChannelsStore().selectChannel(T) });
		xterm.parse = "later";
		print(T, "\u0007");
		await givenU(channel);

		drain();

		expect(bells(U)).toBe(0);
		expect(bells(T)).toBe(0);
		expect(bellSound).not.toHaveBeenCalled();
	});

	it("rings again for the terminal it holds once it asks for it again", async () => {
		const channel = await showingT();
		xterm.parse = "later";
		print(T, "\u0007");
		await givenU(channel);
		channel.value = T;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T]));

		drain();

		expect(bells(T)).toBe(1);
	});

	it("clears the badge of the selected terminal that rang", async () => {
		await showingT({ setUp: () => useChannelsStore().selectChannel(T) });
		useNotificationStore().setActivity(T);
		print(T, "\u0007");
		expect(bells(T)).toBe(1);

		await vi.advanceTimersByTimeAsync(1_000);

		expect(bells(T)).toBe(0);
		expect(useNotificationStore().activityDots.get(T) ?? false).toBe(false);
	});

	it("clears only the badge of the terminal that rang", async () => {
		const channel = await showingT({ setUp: () => useChannelsStore().selectChannel(T) });
		print(T, "\u0007");
		await givenU(channel);
		useChannelsStore().selectChannel(U);
		await settle();
		useNotificationStore().incrementBellCount(U);

		await vi.advanceTimersByTimeAsync(1_000);

		expect(bells(U)).toBe(1);
		expect(bells(T)).toBe(1);
	});

	it("keeps its xterm while it waits for the terminal it was given", async () => {
		const channel = await showingT();
		const before = terminal().element;

		await givenU(channel);

		expect(theXterm()).toBe(before);
	});

	it("keeps its xterm when the terminal it waits for is superseded", async () => {
		const channel = await showingT();
		const before = terminal().element;
		await givenU(channel);

		channel.value = V;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, V]));

		expect(theXterm()).toBe(before);
	});

	it("keeps its xterm when the terminal it was given never answers", async () => {
		const channel = await showingT();
		const before = terminal().element;
		await givenU(channel);

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(theXterm()).toBe(before);
	});

	it("keeps its xterm when its attach for the terminal it was given cannot be sent", async () => {
		const channel = await showingT();
		const before = terminal();
		vi.mocked(useSessionStore().wsClient.send).mockImplementation((msg) => {
			if (msg.type === "ATTACH") throw new Error("WebSocket not connected");
			sent.push(msg as Frame);
		});

		channel.value = U;
		await settle();

		expect(theXterm()).toBe(before.element);
		expect(before.disposed).toBe(false);
	});

	it("clears unread lines on a scroll in the terminal it switched to", async () => {
		const channel = await showingT();
		await givenU(channel);
		useChannelsStore().selectChannel(U);
		attachOk(U, "U-SCREEN");
		await settle();
		useNotificationStore().addUnreadLines(U, 7);

		print(U, "one\r\ntwo");

		expect(unread(U)).toBe(0);
	});

	it("shows the title of the terminal it was given while it waits for it", async () => {
		const channel = await showingT({ setUp: listBoth, answer: { dynamicTitle: "T-TITLE" } });
		xterm.parse = "later";
		print(T, "\u001b]0;T-LATE\u0007");
		await givenU(channel);

		drain();
		await settle();

		expect(paneTitleText()).toBe("U-NAME");
	});

	it("shows the title of the terminal it was given when it never answers", async () => {
		const channel = await showingT({ setUp: listBoth, answer: { dynamicTitle: "T-TITLE" } });
		xterm.parse = "later";
		print(T, "\u001b]0;T-LATE\u0007");
		await givenU(channel);
		drain();

		await vi.advanceTimersByTimeAsync(10_000);
		await settle();

		expect(paneTitleText()).toBe("U-NAME");
	});

	it("takes the titles of the terminal it holds again once it asks for it again", async () => {
		const channel = await showingT({ setUp: listBoth, answer: { dynamicTitle: "T-TITLE" } });
		xterm.parse = "later";
		print(T, "\u001b]0;T-NEW\u0007");
		await givenU(channel);
		channel.value = T;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T]));
		expect(paneTitleText()).toBe("T-NAME");

		drain();
		await settle();

		expect(paneTitleText()).toBe("T-NEW");
	});

	it("keeps the unread lines of the terminal it was given when the one it left scrolls", async () => {
		const channel = await showingT();
		useNotificationStore().addUnreadLines(U, 7);
		xterm.parse = "later";
		print(T, "one\r\ntwo");
		await givenU(channel);
		useChannelsStore().selectChannel(U);
		await settle();

		drain();

		expect(unread(U)).toBe(7);
	});

	it("clears unread lines on a scroll once it asks again for the terminal it holds", async () => {
		const channel = await showingT({ setUp: () => useChannelsStore().selectChannel(T) });
		xterm.parse = "later";
		print(T, "one\r\ntwo");
		await givenU(channel);
		channel.value = T;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T]));
		useNotificationStore().addUnreadLines(T, 5);

		drain();

		expect(unread(T)).toBe(0);
	});

	it("replaces an xterm that only listened to the terminal it left", async () => {
		const channel = ref(T);
		mountPane(channel, "dead", { setUp: withTerminals });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await vi.waitFor(() => expect(button("Restart")).toBeDefined());
		const before = terminal();
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		print(T, "T-EARLY");
		expect(before.parsed).toContain("T-EARLY");

		await switched(channel);

		expect(terminal()).not.toBe(before);
		expect(terminal().parsed).not.toContain("T-EARLY");
	});

	it("draws nothing the terminal it left printed on the screen of the one it switched to", async () => {
		const channel = await showingT();
		xterm.parse = "later";
		print(T, "T-LATE");
		await switched(channel);

		drain();

		expect(terminal().parsed).toEqual(["U-SCREEN"]);
	});
});

describe("TerminalPane lock indicator", () => {
	it("is hidden for a terminal the list says has ended, before the hub answers", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		await settle();

		expect(card()).toBeNull();
		expect(lockIndicator()).toBeNull();
	});

	// A terminal on another host that has ended is in no list the pane can
	// read, so `isDead` stays false: the indicator offered "No lock" under an
	// overlay saying the shell had exited.
	it("is hidden for a terminal the hub said has ended, which no list says", async () => {
		freshWindow();
		useChannelsStore().registerChannelHost(T, HOST);
		mount({ channel: ref(T) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		expect(lockIndicator()).not.toBeNull();

		refuse(T);
		await vi.waitFor(() => expect(card()).not.toBeNull());

		expect(lockIndicator()).toBeNull();
	});

	it("is hidden for a terminal the hub has no record of", async () => {
		freshWindow();
		useChannelsStore().registerChannelHost(T, HOST);
		mount({ channel: ref(T) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await vi.waitFor(() => expect(card()).not.toBeNull());

		expect(lockIndicator()).toBeNull();
	});
});

// ─── When the terminal ends (#574) ───────────────────────────────────────────
//
// What the setting does is decided in exit-action.ts and tested there. These
// check that the pane tells it what it sees, and does what it answers.

describe("TerminalPane when its terminal ends (#574)", () => {
	// Only a report heard while attached to it running, on a socket that stayed
	// up, is an end seen live; every other way of learning it is found, which the
	// setting answers only once the pane is on screen (here it is not).
	it("closes its pane over an end it saw, as the setting says", async () => {
		xterm.profile = { whenEnded: "close" };
		await openLive();

		endIt();
		await settle();

		expect(closes()).toEqual([[T, { keep: false }]]);
	});

	it("waits to be seen over an end it found when its attach was refused", async () => {
		xterm.profile = { whenEnded: "close" };
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		refuse(T);
		await settle();

		expect(closes()).toEqual([]);
		expect(quietLine()).toBe("Closes when this terminal is shown.");
	});

	it("takes an end reported after its socket went for one it found", async () => {
		xterm.profile = { whenEnded: "close" };
		await openLive();

		useSessionStore().connected = false;
		endIt();
		await settle();

		expect(closes()).toEqual([]);
		expect(quietLine()).toBe("Closes when this terminal is shown.");
	});

	// Told as it happens, before any report on the next socket can be read: a
	// socket that went and came back before the pane's watchers run is lost all
	// the same.
	it("takes an end reported once its socket went and came back at once for one it found", async () => {
		xterm.profile = { whenEnded: "close" };
		await openLive();

		useSessionStore().connected = false;
		useSessionStore().connected = true;
		endIt();
		await settle();

		expect(closes()).toEqual([]);
		expect(quietLine()).toBe("Closes when this terminal is shown.");
	});

	it("takes an end reported over a terminal answered from memory for one it found", async () => {
		xterm.profile = { whenEnded: "close" };
		await openLive();
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();

		endIt();
		await settle();

		expect(closes()).toEqual([]);
		expect(quietLine()).toBe("Closes when this terminal is shown.");
	});

	it("counts from the start of a terminal it spawned", async () => {
		xterm.profile = { whenEnded: "restart" };
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(T);
		await settle();

		runFor(1_000);
		endIt();
		await settle();

		expect(card()?.textContent).toContain(
			"It ended right after starting, so it wasn't restarted automatically.",
		);
	});

	it("counts from the start of a terminal it restarted", async () => {
		xterm.profile = { whenEnded: "restart" };
		// On screen in the window with the focus: the setting restarts what it found.
		mountPane(ref(T), "dead", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "AGAIN");
		await settle();
		useChannelsStore().updateChannelStatus(T, "live");
		await settle();

		runFor(1_000);
		useChannelsStore().updateChannelStatus(T, "dead", 1);
		await settle();

		expect(card()?.textContent).toContain(
			"It ended right after starting, so it wasn't restarted automatically.",
		);
	});

	it("restarts a terminal it watched run long enough, as one nobody asked for", async () => {
		xterm.profile = { whenEnded: "restart" };
		await openLive({ setUp: writer });

		runFor(6_000);
		endIt();
		await settle();

		expect(spawns()).toEqual([
			expect.objectContaining({ hostId: HOST, reuseChannelId: T, automatic: true }),
		]);
		expect(quietLine()).toBe("Restarting…");
	});

	it("leaves the end to its card while another window holds the write lock", async () => {
		xterm.profile = { whenEnded: "restart" };
		await openLive({ setUp: () => useWriteLockStore().handleWriteLock(T, OTHER_CLIENT) });

		runFor(6_000);
		endIt();
		await settle();

		expect(spawns()).toEqual([]);
		expect(card()?.textContent).toContain(
			"This window doesn't hold its write lock, so it wasn't restarted from here.",
		);
	});

	it("leaves the end of a terminal that runs a command to its card", async () => {
		xterm.profile = { whenEnded: "restart" };
		await openLive({
			setUp: () => {
				writer();
				useChannelsStore().channels = [listed(T, "live", { directProcess: true })];
			},
		});

		runFor(6_000);
		endIt();
		await settle();

		expect(spawns()).toEqual([]);
		expect(card()?.textContent).toContain(
			"It runs a command rather than a shell, so it isn't restarted automatically.",
		);
		expect(button("Configure")).toBeDefined();
	});

	// A terminal stopped from elsewhere is never restarted or closed (#580).
	it("leaves a terminal stopped from elsewhere to its card", async () => {
		xterm.profile = { whenEnded: "restart" };
		await openLive({ setUp: writer });

		runFor(6_000);
		endIt("killed");
		await settle();

		expect(spawns()).toEqual([]);
		expect(card()?.textContent).toContain("It was stopped from elsewhere, so it wasn't restarted.");
	});

	// The report's reason, else what the hub said of it in the list or at
	// connect: an end found heard no report (#592).
	it("says a terminal it found ended was stopped from elsewhere, as the hub said", async () => {
		xterm.profile = { whenEnded: "restart" };
		mountPane(ref(T), "dead", {
			setUp: () => useChannelsStore().updateChannelStatus(T, "dead", 1, "killed"),
		});
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		refuse(T);
		await vi.waitFor(() => expect(card()).not.toBeNull());

		expect(card()?.textContent).toContain("It was stopped from elsewhere, so it wasn't restarted.");
	});
});

describe("TerminalPane overlay (#574)", () => {
	// No second dialog, and no keep option on it: Close acts at once, and the
	// "Keep" setting says whether the terminal stays listed.
	it("closes at once, deleting the terminal", async () => {
		await openEnded();
		expect(card()?.textContent).not.toContain("Keep");

		button("Close")?.click();

		expect(closes()).toEqual([[T, { keep: false }]]);
	});

	it("closes at once, keeping the terminal listed when Settings says so", async () => {
		await openEnded({ setUp: keepEnded });

		button("Close")?.click();

		expect(closes()).toEqual([[T, { keep: true }]]);
	});

	// "When a terminal ends" is read where Settings cascades it: globally, for
	// the host, for the terminal. "Keep" is Settings' own.
	it("reads the setting from the terminal's resolved profile", async () => {
		xterm.profile = { whenEnded: "close" };
		await openLive({ setUp: keepEnded });

		endIt();
		await settle();

		expect(closes()).toEqual([[T, { keep: true }]]);
	});

	it.each([
		["Close", "close", "this host", "host"],
		["Close", "close", "everywhere", "global"],
		["Restart", "restart", "this host", "host"],
		["Restart", "restart", "everywhere", "global"],
	] as const)(
		'writes what %s does where "Always do this" says, %s, for this terminal and its host (%s, %s)',
		async (label, whenEnded, where, scope) => {
			await openEnded({ hostId: PI });
			const save = vi.spyOn(useConfigStore(), "saveWhenEnded").mockResolvedValue(true);

			alwaysBox()?.click();
			scopeRadio(where)?.click();
			button(label)?.click();

			expect(save).toHaveBeenCalledWith(whenEnded, scope, { hostId: HOST, channelId: T });
			if (label === "Close") expect(closes()).toEqual([[T, { keep: false }]]);
			else await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		},
	);

	it('writes nothing while "Always do this" is unchecked', async () => {
		await openEnded();
		const save = vi.spyOn(useConfigStore(), "saveWhenEnded").mockResolvedValue(true);

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));

		expect(save).not.toHaveBeenCalled();
	});

	// One checkbox, labelled by its words, so a click on them and a screen
	// reader both reach it.
	it('offers one "Always do this" box, which its words check', async () => {
		await openEnded();

		const boxes = card()?.querySelectorAll('input[type="checkbox"]');
		expect(boxes).toHaveLength(1);
		const words = card()?.querySelector<HTMLLabelElement>(`label[for="${alwaysBox()?.id}"]`);
		expect(words?.textContent?.trim()).toBe("Always do this");

		words?.click();

		expect(alwaysBox()?.checked).toBe(true);
	});

	// Where it applies is one choice among radios, grouped and named, so that
	// only one can be chosen and a screen reader says what they are for.
	// Picking one checks the box: it means nothing otherwise.
	it("offers where beside it, as one choice, and picking one checks the box", async () => {
		await openEnded();
		const group = card()?.querySelector('[role="radiogroup"]');
		expect(group?.getAttribute("aria-label")).toBe("Where to always do this");
		const radios = [...(group?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? [])];
		expect(radios.map((r) => r.closest("label")?.textContent?.trim())).toEqual([
			"this host",
			"everywhere",
		]);
		expect(new Set(radios.map((r) => r.name)).size).toBe(1);
		expect(group?.classList.contains("exit-scope--off")).toBe(true);

		scopeRadio("everywhere")?.click();
		await settle();

		expect(alwaysBox()?.checked).toBe(true);
		expect(radios.map((r) => r.checked)).toEqual([false, true]);
		expect(group?.classList.contains("exit-scope--off")).toBe(false);
	});

	// The browser groups radios by their name: each card's own, so that two
	// cards side by side each keep their choice.
	it("names each card's radios as one group of its own", async () => {
		mountPane(ref(T), "dead", { beside: ref(S) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		refuse(S);
		await vi.waitFor(() => expect(root.querySelectorAll(".exit-card")).toHaveLength(2));

		const names = [...root.querySelectorAll(".exit-card")].map((c) =>
			[...c.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => r.name),
		);
		for (const [first, second] of names) {
			expect(first).not.toBe("");
			expect(second).toBe(first);
		}
		expect(names[0]?.[0]).not.toBe(names[1]?.[0]);
	});

	// A group the keyboard is given, outside the tab order: Tab goes on to its
	// buttons.
	it('starts with "Always do this" unchecked, on this host, and gives the keyboard to its card', async () => {
		await openEnded({ setUp: shown });
		await settle();

		expect(alwaysBox()?.checked).toBe(false);
		expect(scopeRadio("this host")?.querySelector("input")?.checked).toBe(true);
		expect(document.activeElement).toBe(card());
		expect(card()?.getAttribute("role")).toBe("group");
		expect(card()?.getAttribute("tabindex")).toBe("-1");
	});

	// The Enter typed after `exit`, or pressed twice, lands on whatever holds the
	// keyboard when the overlay comes up: a button there would restart the shell.
	it("gives no button the keyboard", async () => {
		await openEnded({ setUp: shown });
		await settle();

		expect(document.activeElement?.tagName).not.toBe("BUTTON");
		expect(card()?.contains(document.activeElement)).toBe(true);
	});
});

// ─── "Always do this" answers the overlays already waiting (#586) ────────────
//
// What a waiting overlay does is answerWaiting's to say (exit-action.spec.ts),
// and how it waits useWaitingAnswer's (useWaitingAnswer.spec.ts). These check
// that the pane feeds them what it knows, and acts as its buttons do.

describe("TerminalPane follows a choice made on another overlay (#586)", () => {
	/** T, on screen, seen to end after running `ms` on a socket that stayed up. */
	async function seenEndingAfter(ms: number, open: Open = {}): Promise<void> {
		await openLive({
			...open,
			setUp: () => {
				writer();
				shown();
				open.setUp?.();
			},
		});
		runFor(ms);
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());
	}

	// Restart as the overlay's Restart, nobody asking; nothing written: the
	// other overlay did.
	it("restarts once its own setting says what was chosen, writing nothing", async () => {
		await seenEndingAfter(6_000);
		const save = vi.spyOn(useConfigStore(), "saveWhenEnded").mockResolvedValue(true);

		chosenElsewhere("restart", "global");
		await settle();
		expect(spawns()).toEqual([]);
		settingNowSays("restart");

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ reuseChannelId: T, automatic: true });
		expect(save).not.toHaveBeenCalled();
	});

	// Close as its Close, which the keep setting says whether to delete.
	it("closes as its own Close does, deleting the terminal", async () => {
		await seenEndingAfter(6_000);

		chosenElsewhere("close", "global");
		settingNowSays("close");
		await settle();

		expect(closes()).toEqual([[T, { keep: false }]]);
	});

	it("closes as its own Close does, keeping the terminal listed when Settings says so", async () => {
		await seenEndingAfter(6_000, { setUp: keepEnded });

		chosenElsewhere("close", "global");
		settingNowSays("close");
		await settle();

		expect(closes()).toEqual([[T, { keep: true }]]);
	});

	// Only an ended terminal's overlay, not one restarting.
	it("never follows a choice while its terminal restarts", async () => {
		await openEnded({ setUp: shown });
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));

		chosenElsewhere("close", "global");
		settingNowSays("close");
		await settle();

		expect(closes()).toEqual([]);
		expect(spawns()).toHaveLength(1);
	});

	it("keeps asking over an end that came right after it connected", async () => {
		await seenEndingAfter(1_000);

		chosenElsewhere("restart", "global");
		settingNowSays("restart");
		await settle();

		expect(spawns()).toEqual([]);
		expect(card()).not.toBeNull();
	});

	// As the overlay's reason: an end found later keeps what the one seen said.
	it("keeps what held back an end it saw when it finds that end again", async () => {
		await seenEndingAfter(1_000);
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		await settle();

		chosenElsewhere("restart", "global");
		settingNowSays("restart");
		await settle();

		expect(spawns()).toEqual([]);
	});

	// Handed one that has ended too, so that its card never goes meanwhile.
	it("forgets what held back its end when handed another terminal", async () => {
		const channel = ref(T);
		await seenEndingAfter(1_000, {
			channel,
			setUp: () => {
				useChannelsStore().registerChannelHost(U, HOST);
				useChannelsStore().updateChannelStatus(U, "dead", 1);
			},
		});
		channel.value = U;
		useChannelsStore().selectChannel(U);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(U);
		await vi.waitFor(() => expect(card()).not.toBeNull());

		chosenElsewhere("restart", "global");
		settingNowSays("restart");

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ reuseChannelId: U });
	});

	it("forgets what held back its end once its card goes", async () => {
		await seenEndingAfter(1_000);
		// Brought back from elsewhere: the card goes.
		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "BACK");
		await settle();
		expect(card()).toBeNull();
		// It ends again while the socket is away, and the pane finds it so.
		useSessionStore().connected = false;
		useSessionStore().connected = true;
		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		refuse(T);
		await vi.waitFor(() => expect(card()).not.toBeNull());

		chosenElsewhere("restart", "global");
		settingNowSays("restart");

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
	});

	it("forgets why its setting held back when handed another terminal", async () => {
		xterm.profile = { whenEnded: "restart" };
		const channel = ref(T);
		await openLive({
			channel,
			setUp: () => useChannelsStore().registerChannelHost(U, HOST),
		});
		runFor(6_000);
		endIt();
		await vi.waitFor(() => expect(card()?.textContent).toContain("doesn't hold its write lock"));

		// U's own setting asks: the card comes up for its end.
		settingNowSays("ask");
		channel.value = U;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(U);
		await vi.waitFor(() => expect(card()).not.toBeNull());

		expect(card()?.textContent).not.toContain("doesn't hold its write lock");
	});

	// Every pane of the tab shown, not only the selected one.
	it("follows once its tab is the one shown, selected or not", async () => {
		const onScreen = ref<ReadonlySet<string>>(new Set([S]));
		await openLive({ onScreen, setUp: writer });
		runFor(6_000);
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());

		chosenElsewhere("restart", "global");
		settingNowSays("restart");
		await settle();
		expect(spawns()).toEqual([]);

		onScreen.value = new Set([S, T]);

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
	});

	it("follows a choice made for its terminal's host, not the rail's", async () => {
		await seenEndingAfter(6_000, { hostId: PI });

		chosenElsewhere("restart", "host", PI);
		settingNowSays("restart");
		await settle();
		expect(spawns()).toEqual([]);

		chosenElsewhere("restart", "host", HOST);

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
	});

	// Only an ended terminal's overlay, not one gone.
	it("never follows over a terminal the hub has no record of", async () => {
		mountPane(ref(T), "live", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		hear({ type: "ERROR", code: "CHANNEL_NOT_FOUND", message: "No such terminal.", channelId: T });
		await vi.waitFor(() => expect(card()).not.toBeNull());

		chosenElsewhere("restart", "global");
		settingNowSays("restart");
		await settle();

		expect(spawns()).toEqual([]);
		expect(closes()).toEqual([]);
	});

	it("never follows over a terminal that runs a command", async () => {
		await seenEndingAfter(6_000, {
			setUp: () => {
				useChannelsStore().channels = [listed(T, "live", { directProcess: true })];
			},
		});

		chosenElsewhere("restart", "global");
		settingNowSays("restart");
		await settle();

		expect(spawns()).toEqual([]);
	});

	// The setting as its terminal resolves it, read again after each write.
	it("keeps asking when its terminal's own setting says otherwise", async () => {
		await seenEndingAfter(6_000);

		chosenElsewhere("restart", "global");
		settingNowSays("close");
		await settle();

		expect(spawns()).toEqual([]);
		expect(closes()).toEqual([]);
	});
});

// ─── An end found follows the setting once seen (#592) ──────────────────────
//
// What it does is answerFoundEnd's to say (exit-action.spec.ts), and how it
// waits useWaitingAnswer's (useWaitingAnswer.spec.ts). These check that the
// pane hands it every end it finds, once, with what decides it.

describe("TerminalPane follows the setting over an end it found (#592)", () => {
	it("restarts a terminal it found ended, on screen in the window with the focus", async () => {
		xterm.profile = { whenEnded: "restart" };
		mountPane(ref(T), "dead", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		refuse(T);

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ reuseChannelId: T, automatic: true });
	});

	// Whatever the list said: here it said the terminal runs.
	it("restarts a terminal its attach found ended, which the list said runs", async () => {
		xterm.profile = { whenEnded: "restart" };
		mountPane(ref(T), "live", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));

		refuse(T);

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ reuseChannelId: T, automatic: true });
	});

	// Until its profile is read, a pane holds the default, which says "ask".
	it("waits for its setting to be read for its terminal, saying only that it exited", async () => {
		xterm.profile = { whenEnded: "restart" };
		xterm.profileRead = false;
		mountPane(ref(T), "dead", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await settle();
		expect(spawns()).toEqual([]);
		expect(quietLine()).toBe("Shell exited (code 1)");

		paneProfile().read();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
	});

	// Read for the terminal it shows now, on the host that terminal runs on: a
	// profile read for the terminal it showed before, or for the rail's host
	// before the client knew its terminal's, says nothing of this one's setting.
	it("waits for its setting to be read for the terminal it was handed", async () => {
		xterm.profile = { whenEnded: "restart" };
		const channel = ref(T);
		await openLive({
			channel,
			setUp: () => {
				shown();
				useChannelsStore().registerChannelHost(U, HOST);
			},
		});
		paneProfile().readsAtOnce.value = false;

		channel.value = U;
		useChannelsStore().selectChannel(U);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(U);
		await settle();
		expect(paneProfile().resolvedFor.value).toEqual({ hostId: HOST, channelId: T });
		expect(spawns()).toEqual([]);
		expect(quietLine()).toBe("Shell exited");

		paneProfile().read();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ reuseChannelId: U, automatic: true });
	});

	it("waits for its setting to be read on the host its terminal turns out to run on", async () => {
		xterm.profile = { whenEnded: "restart" };
		freshWindow();
		useChannelsStore().updateChannelStatus(T, "dead", 1);
		shown();
		mount({ channel: ref(T), hostId: PI });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		paneProfile().readsAtOnce.value = false;
		// The client learns where T runs: its profile was read for the rail's host.
		useChannelsStore().registerChannelHost(T, HOST);

		refuse(T);
		await settle();
		expect(paneProfile().resolvedFor.value).toEqual({ hostId: PI, channelId: T });
		expect(spawns()).toEqual([]);
		expect(quietLine()).toBe("Shell exited (code 1)");

		paneProfile().read();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).toMatchObject({ hostId: HOST, reuseChannelId: T, automatic: true });
	});

	// A setting that cannot be read must not leave the pane without its card;
	// and only the first word of an end is answered: hearing of it again does not
	// start the wait over.
	it("asks once its setting is too long in coming, and keeps asking when it hears of the end again", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		xterm.profileRead = false;
		mountPane(ref(T), "dead", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await settle();
		expect(quietLine()).toBe("Shell exited (code 1)");

		await vi.advanceTimersByTimeAsync(3_000);
		await settle();
		expect(card()).not.toBeNull();

		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		await settle();

		expect(card()).not.toBeNull();
		expect(quietLine()).toBeNull();
	});

	it("waits for its window to have the focus", async () => {
		xterm.profile = { whenEnded: "restart" };
		setWindowFocus(false);
		mountPane(ref(T), "dead", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await settle();
		expect(spawns()).toEqual([]);
		expect(quietLine()).toBe("Restarts when this window has the focus.");

		setWindowFocus(true);

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
	});

	// Why the hub ended it can come after the end was found: a kill keeps it asking.
	it("keeps asking once the hub says the terminal it found ended was killed", async () => {
		xterm.profile = { whenEnded: "restart" };
		setWindowFocus(false);
		mountPane(ref(T), "dead", { setUp: shown });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		refuse(T);
		await settle();

		useChannelsStore().updateChannelStatus(T, "dead", 1, "killed");
		await settle();
		expect(card()).not.toBeNull();
		setWindowFocus(true);
		await settle();

		expect(spawns()).toEqual([]);
	});

	// The restart the setting makes there runs under this pane: it takes the
	// profile and the bell a pane that attached takes, rather than return first.
	it("gives a pane over a terminal known to have ended its profile and its bell", async () => {
		xterm.profile = { bellSound: "system" };
		await openEnded();
		expect(terminal().options.bellStyle).toBe("none");

		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "AGAIN");
		await settle();
		hear({ type: "OUTPUT", channelId: T, data: new TextEncoder().encode("\u0007") });

		expect(useNotificationStore().bellCounts.get(T)).toBe(1);
		expect(bellSound).toHaveBeenCalledTimes(1);
	});

	// What the profile says of a bell, seen where the bell rings.
	const ring = () => hear({ type: "OUTPUT", channelId: T, data: new TextEncoder().encode("") });

	it("rings its sound but counts no badge for a bell when the profile turns the badge off", async () => {
		xterm.profile = { bellBadge: false, bellSound: "system" };
		await openLive();

		ring();

		expect(useNotificationStore().bellCounts.get(T)).toBeUndefined();
		expect(bellSound).toHaveBeenCalledTimes(1);
	});

	it("counts a badge for a bell when the profile turns the badge on", async () => {
		xterm.profile = { bellBadge: true, bellSound: "system" };
		await openLive();

		ring();

		expect(useNotificationStore().bellCounts.get(T)).toBe(1);
	});

	it("rings the custom sound file the profile names", async () => {
		xterm.profile = { bellSound: "custom", bellCustomFile: "bell.mp3" };
		await openLive();

		ring();

		expect(bellSound).toHaveBeenCalledTimes(1);
		expect(bellSound).toHaveBeenCalledWith({ sound: "custom", customSoundFile: "bell.mp3" });
	});

	it("rings no sound for a bell when the profile mutes it, and still counts the badge", async () => {
		xterm.profile = { bellSound: "mute" };
		await openLive();

		ring();

		expect(bellSound).not.toHaveBeenCalled();
		expect(useNotificationStore().bellCounts.get(T)).toBe(1);
	});
});

// ─── The card only when the pane asks (#595) ─────────────────────────────────
//
// Which of the card and the quiet line shows, and what the line says, is
// endedPaneShows's to decide (exit-action.spec.ts). These check that the pane
// feeds it what it knows, and shows what it answers.

describe("TerminalPane shows the card only when it asks (#595)", () => {
	// Still opening, it says "Connecting…", and has not taken in the end yet.
	it("says only that it is connecting while it opens over an ended terminal", async () => {
		mountPane(ref(T), "dead");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		await settle();

		expect(paneText()).toContain("Connecting…");
		expect(card()).toBeNull();
		expect(quietLine()).toBeNull();
	});

	it("shows the quiet line in place of the card while the setting restarts", async () => {
		xterm.profile = { whenEnded: "restart" };
		await openLive({ setUp: writer });

		runFor(6_000);
		endIt();
		await settle();

		expect(quietLine()).toBe("Restarting…");
		expect(card()).toBeNull();
	});

	// Announced politely, and heard: a live region already in the page when its
	// text changes. It takes neither the keyboard nor the pointer.
	it("tells a screen reader the quiet line, without taking the keyboard", async () => {
		xterm.profile = { whenEnded: "restart" };
		themed("one-half-dark");
		await openLive({
			setUp: () => {
				writer();
				shown();
			},
		});
		const region = root.querySelector('[role="status"]');
		expect(region?.textContent?.trim()).toBe("");
		const keyboard = document.activeElement;

		runFor(6_000);
		endIt();
		await settle();

		expect(region?.isConnected).toBe(true);
		expect(region?.textContent?.trim()).toBe("Restarting…");
		expect(document.activeElement).toBe(keyboard);
		expect(getComputedStyle(root.querySelector(".exit-status")!).pointerEvents).toBe("none");
	});

	// When the setting turns out to ask, or a restart failed, the card comes up
	// after the line, and takes the keyboard as it did before.
	it("gives the keyboard to the card each time it comes up, its box unchecked", async () => {
		await openEnded({ setUp: shown });
		vi.spyOn(useConfigStore(), "saveWhenEnded").mockResolvedValue(true);
		alwaysBox()?.click();
		scopeRadio("everywhere")?.click();

		button("Restart")?.click();
		await vi.waitFor(() => expect(quietLine()).toBe("Restarting…"));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(card()).not.toBeNull());
		await settle();

		expect(document.activeElement).toBe(card());
		expect(alwaysBox()?.checked).toBe(false);
		expect(scopeRadio("this host")?.querySelector("input")?.checked).toBe(true);
	});

	// An end seen live that the setting restarts: the dead report and the
	// restart are one step, so the card has no moment to show in.
	it("starts a live restart before anything is drawn", async () => {
		xterm.profile = { whenEnded: "restart" };
		await openLive({ setUp: writer });
		runFor(6_000);
		const cards: Node[] = [];
		const record = (records: MutationRecord[]) => {
			for (const { addedNodes } of records) {
				for (const node of addedNodes) {
					if (node instanceof Element && node.matches(".exit-overlay, :has(.exit-overlay)")) {
						cards.push(node);
					}
				}
			}
		};
		const drawing = new MutationObserver(record);
		drawing.observe(root, { childList: true, subtree: true });

		endIt();
		await settle();
		record(drawing.takeRecords());
		drawing.disconnect();

		expect(spawns()).toHaveLength(1);
		expect(cards).toEqual([]);
	});
});

// ─── A host its user disconnected (#648) ─────────────────────────────────────
//
// What the hub does with a start nobody asked for is session-manager's to
// say (session-manager-connection.spec.ts): it refuses it on such a host, and
// the pane waits for the host as for one away. These check that the pane says
// which of its restarts nobody asked for, and what it shows over a terminal
// whose host was disconnected.

describe("TerminalPane over a host its user disconnected (#648)", () => {
	it("leaves the card's Restart a person's, which connects the host again", async () => {
		await openEnded();

		button("Restart")?.click();

		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		expect(spawns()[0]).not.toHaveProperty("automatic");
	});

	it("shows its terminal not connected: what it last showed, typing going nowhere", async () => {
		await openLive({ hostId: PI });
		expect(banner()).toBeNull();

		useHostsStore().setDisconnectedByUser([PI]);
		await settle();
		expect(banner()).toBeNull();

		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();
		expect(banner()?.textContent).toContain(
			"Not connected. This is what this terminal last showed; typing here goes nowhere.",
		);
	});

	it("connects that host on its Reconnect, before attaching", async () => {
		await openLive();
		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();
		let connected: (answer: { ok: boolean; status: number; body: object }) => void = () => {};
		const connect = vi
			.spyOn(useHostsStore(), "connectHost")
			.mockReturnValue(new Promise((resolve) => (connected = resolve)));

		button("Reconnect")?.click();
		await settle();
		expect(connect).toHaveBeenCalledWith(HOST);
		expect(attaches()).toHaveLength(1);

		connected({ ok: true, status: 200, body: {} });

		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
	});

	// The terminal ran on while its host was disconnected: what it printed
	// then is in the live snapshot only (#1010).
	it("draws the live answer to its Reconnect over what it last showed (#1010)", async () => {
		await openLive();
		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();
		xterm.events.length = 0;
		// Connecting the host clears its disconnection before the attach goes.
		vi.spyOn(useHostsStore(), "connectHost").mockImplementation(async () => {
			useHostsStore().setDisconnectedByUser([]);
			return { ok: true, status: 200, body: {} };
		});

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
		expect(banner()).toBeNull();
	});

	it("draws the live answer to its Reconnect when it opened over a host already disconnected (#1010)", async () => {
		mountPane(ref(T), "live", { setUp: () => useHostsStore().setDisconnectedByUser([HOST]) });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		xterm.events.length = 0;
		vi.spyOn(useHostsStore(), "connectHost").mockImplementation(async () => {
			useHostsStore().setDisconnectedByUser([]);
			return { ok: true, status: 200, body: {} };
		});

		button("Reconnect")?.click();
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
	});

	it("draws the live answer over what it last showed when its host is connected from elsewhere (#1010)", async () => {
		await openLive();
		useHostsStore().setDisconnectedByUser([HOST]);
		useChannelsStore().updateChannelStatus(T, "orphan");
		await settle();
		xterm.events.length = 0;

		useHostsStore().setDisconnectedByUser([]);
		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual([FULL_RESET, "LIVE-SNAP"]);
		expect(banner()).toBeNull();
	});

	it("attaches at once on a Reconnect whose host nobody disconnected", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "REMEMBERED", { cached: true });
		await settle();
		const connect = vi.spyOn(useHostsStore(), "connectHost");

		button("Reconnect")?.click();

		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		expect(connect).not.toHaveBeenCalled();
	});

	// A pane still owed its spawn has no terminal yet: its Reconnect asked the
	// hub for the pending id, and the pane then said its terminal was gone
	// (#980). Retry or Connect is its way back.
	it("shows no Not connected banner while it is owed its spawn: while its spawn runs", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));

		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();

		expect(banner()).toBeNull();
		expect(button("Reconnect")).toBeUndefined();
		expect(attaches()).toEqual([]);
	});

	it("shows no Not connected banner while it is owed its spawn: after its spawn failed", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("SPAWN_FAILED", "the shell could not start");
		await vi.waitFor(() => expect(errorBox()).not.toBeNull());

		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();

		expect(banner()).toBeNull();
		expect(button("Reconnect")).toBeUndefined();
		expect(errorBox()?.textContent).toContain("the shell could not start");
		expect(button("Retry")).toBeDefined();
		expect(attaches()).toEqual([]);
	});

	it("shows no Not connected banner while it is owed its spawn: after its host's password or passphrase was not given", async () => {
		openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("AUTH_CANCELLED", "Authentication cancelled by user");
		await vi.waitFor(() => expect(button("Connect")).toBeDefined());

		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();

		expect(banner()).toBeNull();
		expect(button("Reconnect")).toBeUndefined();
		expect(button("Connect")).toBeDefined();
		expect(attaches()).toEqual([]);
	});

	it("shows no Not connected banner while it is owed its spawn: once it started", async () => {
		const channel = openNew(HOST);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnOk(REAL);
		await settle();
		expect(channel.value).toBe(REAL);

		useHostsStore().setDisconnectedByUser([HOST]);
		await settle();
		expect(banner()?.textContent).toContain("Not connected.");
		vi.spyOn(useHostsStore(), "connectHost").mockResolvedValue({ ok: true, status: 200, body: {} });
		button("Reconnect")?.click();

		await vi.waitFor(() => expect(attachedTo()).toEqual([REAL]));
	});
});

// ─── A restart whose host is away waits for it (#605) ───────────────────────
//
// What a failure does is afterRestartFailure's to say (exit-action.spec.ts),
// and how the pane waits useWaitForHost's (useWaitForHost.spec.ts). These
// check that the pane hands it every restart's outcome, and shows its line.

describe("TerminalPane waits for the host of a restart that found it away (#605)", () => {
	/** A pane over T whose Restart found its host away. */
	async function restartFindsHostAway(open: Open = {}): Promise<void> {
		await openEnded({
			...open,
			setUp: () => {
				useHostsStore().hosts.push(host(HOST, "pi"));
				open.setUp?.();
			},
		});
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		spawnRefused("HOST_UNREACHABLE", "pi cannot be reached", {
			hostId: HOST,
			hostStatus: "disconnected",
		});
		await settle();
	}

	it("says which host it waits for", async () => {
		await restartFindsHostAway();

		expect(quietLine()).toBe("Waiting for pi…");
		expect(card()).toBeNull();
	});

	// Every restart goes through one road: the card's, the setting's, a choice
	// made on another overlay, and the host's return.
	it("restarts on the host's return, as one nobody asked for", async () => {
		await restartFindsHostAway();

		useHostsStore().updateSessionStatus(HOST, "active");

		await vi.waitFor(() => expect(spawns()).toHaveLength(2));
		expect(spawns()[1]).toMatchObject({ reuseChannelId: T, automatic: true });
	});

	it("waits over its terminal ended only", async () => {
		await restartFindsHostAway();
		// Brought back from elsewhere meanwhile.
		useChannelsStore().updateChannelStatus(T, "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "BACK");
		await settle();

		useHostsStore().updateSessionStatus(HOST, "active");
		await settle();

		expect(spawns()).toHaveLength(1);
	});

	// Handed another terminal that has ended too, it waits for nothing: the
	// host's return restarts neither.
	it("stops waiting for the host of a terminal it no longer shows", async () => {
		const channel = ref(T);
		await restartFindsHostAway({ channel });
		expect(quietLine()).toBe("Waiting for pi…");

		channel.value = S;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(S);
		await settle();
		expect(quietLine()).toBeNull();
		expect(card()).not.toBeNull();

		useHostsStore().updateSessionStatus(HOST, "active");
		await settle();

		expect(spawns()).toHaveLength(1);
	});

	// Given another terminal before the hub answered: the failure is not that
	// terminal's, and the host's return must not restart it (#929).
	it("waits for nothing once the pane shows another terminal", async () => {
		const channel = ref(T);
		await openEnded({
			channel,
			setUp: () => {
				useHostsStore().hosts.push(host(HOST, "pi"));
				withU();
			},
		});
		button("Restart")?.click();
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		useChannelsStore().updateChannelStatus(U, "live");
		attachOk(U, "U-LIVE");
		await settle();

		spawnRefused("HOST_UNREACHABLE", "pi cannot be reached", {
			hostId: HOST,
			hostStatus: "disconnected",
		});
		await settle();
		useHostsStore().updateSessionStatus(HOST, "active");
		await settle();

		expect(spawns()).toHaveLength(1);
		expect(errorBox()).toBeNull();
	});

	// Another restart, here a choice made on another overlay, decides afresh
	// whether to wait: its terminal ending again at once brings the card back.
	it("stops waiting for its host once another restart starts", async () => {
		await restartFindsHostAway({ setUp: shown });
		expect(quietLine()).toBe("Waiting for pi…");

		chosenElsewhere("restart", "global");
		settingNowSays("restart");
		await vi.waitFor(() => expect(spawns()).toHaveLength(2));
		spawnOk(T);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		refuse(T);
		await settle();

		expect(quietLine()).toBeNull();
		expect(card()?.textContent).toContain(
			"It ended right after starting, so it wasn't restarted automatically.",
		);
	});

	// Outside the live region, so that a screen reader hears the line alone. The
	// line lets clicks through; its Cancel takes them.
	it("offers Cancel beside the line, which brings the card back with the reason", async () => {
		themed("one-half-dark");
		await restartFindsHostAway();
		const cancel = button("Cancel");
		expect(cancel).toBeDefined();
		expect(cancel?.closest('[role="status"]')).toBeNull();
		expect(getComputedStyle(cancel!).pointerEvents).toBe("auto");

		cancel?.click();
		await settle();

		expect(quietLine()).toBeNull();
		expect(card()?.textContent).toContain("Could not restart it: pi cannot be reached");
	});
});

// ─── The card reads on any background ────────────────────────────────────────
//
// The card is drawn in the theme's own tokens, so its contrast is the theme's
// to guarantee. Checked here for every bundled theme, light and dark, against
// WCAG AA for text (4.5:1), with the colours the card's own rules draw.

/** A computed colour as [r, g, b, alpha]; null for none. */
function rgba(css: string): [number, number, number, number] | null {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css.trim());
	if (hex) return [1, 2, 3].map((i) => Number.parseInt(hex[i]!, 16)).concat(1) as never;
	const fn = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(css.trim());
	if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), Number(fn[4] ?? 1)];
	return null;
}

/** What `el`'s text is read on: the nearest ground that is not transparent. */
function groundOf(el: Element): [number, number, number] {
	for (let at: Element | null = el; at !== null; at = at.parentElement) {
		const colour = rgba(getComputedStyle(at).backgroundColor);
		if (colour === null || colour[3] === 0) continue;
		if (colour[3] !== 1) throw new Error(`${at.className}: a ground that is not opaque`);
		return [colour[0], colour[1], colour[2]];
	}
	throw new Error(`${el.className}: no ground`);
}

/**
 * The contrast of `el`'s text on its ground. Only for text drawn opaque, which
 * all of the card's is: its colour, and it and every element around it, at
 * full opacity, else the ratio of its colours says nothing of what is seen.
 */
function contrastOf(el: Element): number {
	const text = rgba(getComputedStyle(el).color);
	if (text === null) throw new Error(`${el.className}: no colour`);
	expect(text[3], `${el.className}: its text's alpha`).toBe(1);
	for (let at: Element | null = el; at !== null; at = at.parentElement) {
		const opacity = getComputedStyle(at).opacity;
		expect(opacity === "" ? 1 : Number(opacity), `${at.className}: its opacity`).toBe(1);
	}
	return contrastRatio([text[0], text[1], text[2]], groundOf(el));
}

describe("TerminalPane overlay card colours (#574)", () => {
	// Each theme's own: a dark theme's shadow is heavier than a light one's.
	it.each([
		{
			theme: "one-half-dark",
			ground: [40, 44, 52, 1],
			text: [220, 223, 228, 1],
			border: [62, 68, 82, 1],
			shadow: "0 4px 24px rgba(0, 0, 0, 0.6)",
		},
		{
			theme: "one-half-light",
			ground: [250, 250, 250, 1],
			text: [56, 58, 66, 1],
			border: [208, 208, 208, 1],
			shadow: "0 4px 24px rgba(0, 0, 0, 0.15)",
		},
	])(
		"draws the card on an opaque ground of $theme's, edged and under a shadow",
		async ({ theme, ground, text, border, shadow }) => {
			themed(theme);
			await openEnded();
			const style = getComputedStyle(card()!);

			expect(rgba(style.backgroundColor)).toEqual(ground);
			expect(rgba(style.color)).toEqual(text);
			for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
				expect(style[`border${side}Width`], side).toBe("1px");
				expect(style[`border${side}Style`], side).toBe("solid");
				expect(rgba(style[`border${side}Color`]), side).toEqual(border);
			}
			expect(style.boxShadow).toBe(shadow);
		},
	);

	// What the terminal last printed shows around the card, and can be read,
	// scrolled and selected there (#927): no scrim, no blur, and the overlay
	// lets the pointer through to the terminal everywhere but on the card.
	it("leaves an ended terminal's output readable around the card", async () => {
		themed("one-half-dark");
		await openEnded();
		const overlay = getComputedStyle(root.querySelector(".exit-overlay")!);

		expect(rgba(overlay.backgroundColor)?.[3] ?? 0).toBe(0);
		expect(["", "none"]).toContain(overlay.backdropFilter);
		expect(overlay.pointerEvents).toBe("none");
		expect(getComputedStyle(card()!).pointerEvents).toBe("auto");
	});

	it.each([
		{ theme: "one-half-dark", scrim: [0, 0, 0, 0.5] },
		{ theme: "one-half-light", scrim: [0, 0, 0, 0.3] },
	])(
		"keeps the gone card's scrim of $theme over a screen that is not that terminal's",
		async ({ theme, scrim }) => {
			themed(theme);
			mountPane(ref(T), "live");
			await vi.waitFor(() => expect(attaches()).toHaveLength(1));
			hear({
				type: "ERROR",
				code: "CHANNEL_NOT_FOUND",
				message: "No such terminal.",
				channelId: T,
			});
			await vi.waitFor(() => expect(card()).not.toBeNull());
			const overlay = getComputedStyle(root.querySelector(".exit-overlay")!);

			expect(rgba(overlay.backgroundColor)).toEqual(scrim);
			expect(overlay.backdropFilter).toBe("blur(2px)");
			expect(overlay.pointerEvents).toBe("auto");
		},
	);

	for (const name of Object.keys(BUNDLED_THEMES)) {
		it(`reads at 4.5:1 or better in ${name}`, async () => {
			xterm.profile = { whenEnded: "restart" };
			themed(name);
			// Its setting held back by another window's write lock: a reason on the card.
			await openLive({ setUp: () => useWriteLockStore().handleWriteLock(T, OTHER_CLIENT) });
			runFor(6_000);
			endIt();
			await vi.waitFor(() => expect(card()).not.toBeNull());
			vi.spyOn(useConfigStore(), "saveWhenEnded").mockResolvedValue(true);
			// Checked, so that where it applies is drawn at full strength.
			alwaysBox()?.click();
			await settle();
			const texts: Record<string, Element | null | undefined> = {
				message: card()?.querySelector(".exit-message"),
				reason: card()?.querySelector(".exit-reason"),
				checkbox: card()?.querySelector(".exit-option"),
				"where, chosen": scopeRadio("this host"),
				"where, not chosen": scopeRadio("everywhere"),
				button: button("Close"),
				Restart: button("Restart"),
			};
			for (const [what, el] of Object.entries(texts)) {
				if (el == null) throw new Error(`${what}: not on the card`);
				expect(contrastOf(el), what).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
			}

			// In place of the card, while it restarts (#595).
			button("Restart")?.click();
			await vi.waitFor(() => expect(quietLine()).toBe("Restarting…"));
			const line = root.querySelector(".exit-status__text")!;
			expect(contrastOf(line), "quiet line").toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
		});
	}
});

// ─── Pasting through an agent that adapts input (#1012) ──────────────────────
//
// While the hub says the terminal's agent writes input in its program's form,
// the pane brackets every paste itself, with the markers in its text taken
// out, and xterm pastes nothing of its own. Otherwise xterm pastes as always.

describe("TerminalPane pasting through an agent that adapts input (#1012)", () => {
	// What these measure is how a paste goes out, not the card a paste of several
	// lines gets first (#1015): their terminal never asks.
	beforeEach(() => {
		xterm.profile = { ...xterm.profile, pasteWarning: "never" };
	});

	const START = "\u001b[200~";
	const END = "\u001b[201~";

	/** A paste of `text` on the pane's xterm, as the browser fires it at its textarea. */
	function paste(text: string): Event {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
		terminal().textarea.dispatchEvent(event);
		return event;
	}

	/** A pane over T, the writer, attached with what the hub says of its agent. */
	async function attachedSaying(adaptsInput: boolean | undefined): Promise<void> {
		mountPane(ref(T), "live", { setUp: writer });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "LIVE", adaptsInput === undefined ? {} : { adaptsInput });
		await settle();
	}

	it("sends a paste bracketed by the pane, its own markers taken out, and nothing from xterm", async () => {
		await attachedSaying(true);

		paste(`a\nb${END}c${START}d`);

		expect(inputs()).toEqual([`${START}a\rbcd${END}`]);
	});

	// Removing them until none is left took a pass per level of nesting: a
	// clipboard of nested markers made it quadratic, before any size check.
	it("takes out deeply nested markers in time linear in the text", async () => {
		await attachedSaying(true);
		const depth = 100_000;
		const nested = `${"\u001b[20".repeat(depth)}\u001b[201~${"1~".repeat(depth)}x`;

		const started = performance.now();
		paste(nested);
		const took = performance.now() - started;

		expect(inputs()).toEqual([`${START}x${END}`]);
		expect(took).toBeLessThan(1000);
	});

	it("takes out a marker its text would form again once another is taken out", async () => {
		await attachedSaying(true);

		paste("\u001b[20\u001b[201~1~rm -rf ~\r");

		expect(inputs()).toEqual([`${START}rm -rf ~\r${END}`]);
	});

	it("leaves the paste to xterm when the agent does not adapt input", async () => {
		await attachedSaying(false);

		paste("a\nb");

		expect(inputs()).toEqual(["a\rb"]);
	});

	it("leaves the paste to xterm when an older hub says nothing of it", async () => {
		await attachedSaying(undefined);

		paste("a\nb");

		expect(inputs()).toEqual(["a\rb"]);
	});

	it("sends nothing, and lets xterm paste nothing, without the write lock", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "LIVE", { adaptsInput: true });
		await settle();

		const event = paste("a");

		expect(event.defaultPrevented).toBe(true);
		expect(inputs()).toEqual([]);
	});

	it("sends no mouse report without the write lock (#1016)", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "LIVE", { adaptsInput: true });
		await settle();

		typeBinary("\u001b[M !!");

		expect(inputs()).toEqual([]);
	});

	it("sends nothing, and lets xterm paste nothing, while the socket is down", async () => {
		await attachedSaying(true);
		(useSessionStore().wsClient as unknown as { isConnected: boolean }).isConnected = false;

		const event = paste("a");

		expect(event.defaultPrevented).toBe(true);
		expect(inputs()).toEqual([]);
	});

	it("sends a mouse report in xterm's default encoding as one byte per character (#1016)", async () => {
		await attachedSaying(true);

		// ESC [ M, then button, column and row each plus 32: 0xC8 is above 127.
		typeBinary("\u001b[M !È");

		const input = sent.filter((m) => m.type === "INPUT").at(-1);
		expect(Array.from((input?.data ?? []) as Uint8Array)).toEqual([27, 91, 77, 32, 33, 200]);
	});

	it("sends no mouse report while the socket is down (#1016)", async () => {
		await attachedSaying(true);
		(useSessionStore().wsClient as unknown as { isConnected: boolean }).isConnected = false;

		typeBinary("\u001b[M !!");

		expect(inputs()).toEqual([]);
	});

	it("refuses a paste too large for one INPUT, in bytes, with a toast and nothing written", async () => {
		await attachedSaying(true);
		xterm.events.length = 0;

		paste("x".repeat(65_530));
		paste("€".repeat(30_000));

		expect(inputs()).toEqual([]);
		expect(xterm.events).toEqual([]);
		expect(useToastStore().messages.map((m) => m.text)).toEqual([
			"This paste is too large to send (64 KiB at most).",
			"This paste is too large to send (64 KiB at most).",
		]);
	});

	it("brackets a paste on the terminal it spawned, from what its SPAWN_OK said", async () => {
		openNew(HOST);
		useWriteLockStore().handleWriteLock(REAL, CLIENT);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		hear({
			type: "SPAWN_OK",
			channelId: REAL,
			requestId: spawns().at(-1)?.requestId,
			adaptsInput: true,
		});
		await settle();

		paste("a");

		expect(attaches()).toEqual([]);
		expect(inputs()).toEqual([`${START}a${END}`]);
	});

	it("follows the terminal it shows: true to false, false to true, true to true", async () => {
		const channel = ref(T);
		mountPane(channel, "live", {
			setUp: () => {
				withU();
				useChannelsStore().registerChannelHost(V, HOST);
				const lock = useWriteLockStore();
				for (const id of [T, U, V]) lock.handleWriteLock(id, CLIENT);
			},
		});
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "T", { adaptsInput: true });
		await settle();

		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		attachOk(U, "U", { adaptsInput: false });
		await settle();
		paste("to-u");

		channel.value = T;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T]));
		attachOk(T, "T", { adaptsInput: true });
		await settle();
		paste("to-t");

		channel.value = V;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U, T, V]));
		attachOk(V, "V", { adaptsInput: true });
		await settle();
		paste("to-v");

		expect(inputs()).toEqual(["to-u", `${START}to-t${END}`, `${START}to-v${END}`]);
	});

	it("follows a later answer for the same terminal", async () => {
		await attachedSaying(true);

		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE", { adaptsInput: false });
		await settle();
		paste("plain");

		useSessionStore().reconnectCount++;
		await vi.waitFor(() => expect(attaches()).toHaveLength(3));
		attachOk(T, "LIVE", { adaptsInput: true });
		await settle();
		paste("bracketed");

		expect(inputs()).toEqual(["plain", `${START}bracketed${END}`]);
	});

	it("writes a snapshot from an older agent as before: no screen or mode state", async () => {
		mountPane(ref(T), "live");
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		xterm.events.length = 0;

		attachOk(T, "LIVE-SNAP");
		await settle();

		expect(xterm.events).toEqual(["<reset>", "LIVE-SNAP"]);
	});
});

// ─── Streaming a paste (#1014) ───────────────────────────────────────────────
//
// While the hub says the terminal's agent takes a paste as PASTE chunks, the
// pane sends it so: no markers (the agent writes them), at most 256 KiB not
// yet acknowledged, what is typed meanwhile held behind it, its progress shown
// after a second, and its outcome said when it ends early.

describe("TerminalPane streaming a paste (#1014)", () => {
	// What these measure is how a paste goes out, not the card a paste of several
	// lines gets first (#1015): their terminal never asks.
	beforeEach(() => {
		xterm.profile = { ...xterm.profile, pasteWarning: "never" };
	});

	const CHUNK = 32 * 1024;
	type PasteFrame = {
		pasteId: number;
		seq: number;
		data: Uint8Array;
		last: boolean;
		channelId: string;
	};

	function paste(text: string): Event {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
		terminal().textarea.dispatchEvent(event);
		return event;
	}
	const chunks = () => sent.filter((m) => m.type === "PASTE") as unknown as PasteFrame[];
	const cancels = () => sent.filter((m) => m.type === "PASTE_CANCEL");
	const pasteId = () => chunks().at(-1)?.pasteId as number;
	const toasts = () => useToastStore().messages.map((m) => m.text);
	/** The order of what the pane sent of pastes and input. */
	const order = () =>
		sent
			.filter((m) => m.type === "PASTE" || m.type === "PASTE_CANCEL" || m.type === "INPUT")
			.map((m) =>
				m.type === "INPUT"
					? `INPUT ${new TextDecoder().decode(m.data as Uint8Array)}`
					: m.type === "PASTE"
						? `PASTE ${(m as unknown as PasteFrame).seq}`
						: "CANCEL",
			);
	function ack(seq: number, id = pasteId(), channelId = T): void {
		hear({ type: "PASTE_ACK", channelId, pasteId: id, seq });
	}
	function closed(reason: string, written?: number, id = pasteId()): void {
		hear({
			type: "PASTE_CLOSED",
			channelId: T,
			pasteId: id,
			reason,
			...(written === undefined ? {} : { written }),
		});
	}

	/** A pane over T, the writer, its agent streaming pastes (or what `over` says). */
	async function streaming(
		over: Record<string, unknown> = { adaptsInput: true, streamsPaste: true },
	) {
		mountPane(ref(T), "live", { setUp: writer });
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "LIVE", over);
		await settle();
	}

	it("WB1: sends a window of 8 chunks, then one more per acknowledgement, the last marked, no markers", async () => {
		await streaming();
		const text = "a".repeat(1024 * 1024);

		paste(text);

		expect(chunks()).toHaveLength(8);
		expect(chunks().map((c) => [c.seq, c.data.byteLength, c.last])).toEqual(
			[0, 1, 2, 3, 4, 5, 6, 7].map((seq) => [seq, CHUNK, false]),
		);
		ack(0);
		expect(chunks()).toHaveLength(9);
		for (let seq = 1; seq < 32; seq++) ack(seq);
		expect(chunks()).toHaveLength(32);
		expect(chunks().at(-1)?.last).toBe(true);
		expect(chunks().filter((c) => c.last)).toHaveLength(1);
		const joined = new TextDecoder().decode(Uint8Array.from(chunks().flatMap((c) => [...c.data])));
		expect(joined).toBe(text);
		expect(inputs()).toEqual([]);
	});

	it("WB2: strips the markers and turns line ends into CR before chunking, even across a chunk boundary", async () => {
		await streaming();
		const before = "x".repeat(CHUNK - 3);
		// The nested marker straddles the first chunk's end once stripped text is cut.
		paste(`${before}\u001b[20\u001b[201~1~a\r\nb\nc`);
		for (let seq = 0; seq < chunks().length; seq++) ack(seq);

		const joined = new TextDecoder().decode(Uint8Array.from(chunks().flatMap((c) => [...c.data])));
		expect(joined).toBe(`${before}a\rb\rc`);
	});

	it("WB2: applies the bound to the normalised bytes, not the raw text", async () => {
		await streaming();

		paste("a\r\n".repeat(6_000_000));

		expect(toasts()).toEqual([]);
		expect(chunks()).toHaveLength(8);
	});

	it("WB2: brings the view down and clears the selection, with no INPUT", async () => {
		await streaming();
		const active = terminal().buffer.active;
		active.baseY = 70;
		active.viewportY = 50;
		xterm.selection = true;

		paste("x");

		expect(active.viewportY).toBe(70);
		expect(xterm.selection).toBe(false);
		expect(inputs()).toEqual([]);
	});

	it("WB3: holds what is typed behind unsent chunks, and sends it after the last one", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		type("ab");
		expect(inputs()).toEqual([]);

		ack(0);

		expect(order().slice(-2)).toEqual(["PASTE 8", "INPUT ab"]);
	});

	it("drops a binary mouse report made while a paste is being sent (#1016)", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));

		typeBinary("\u001b[M !!");
		ack(0);

		expect(inputs()).toEqual([]);
	});

	it("WB3: cancels on Ctrl+C, then sends what was held, then the Ctrl+C", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		type("a");

		type("\u0003");

		expect(order().slice(-3)).toEqual(["CANCEL", "INPUT a", "INPUT \u0003"]);
		ack(0);
		expect(chunks()).toHaveLength(8);
	});

	it("WB3: sends what was held when the agent closes the paste", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		type("a");

		closed("overflow", 4096);

		expect(inputs()).toEqual(["a"]);
	});

	it("WB3: drops what was held when the agent is lost", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		type("a");

		closed("agent_lost");

		expect(inputs()).toEqual([]);
	});

	it("WB3: drops what was held when the write lock is lost, even once it comes back", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		type("a");

		useWriteLockStore().handleWriteLock(T, OTHER_CLIENT);
		await settle();
		useWriteLockStore().handleWriteLock(T, CLIENT);
		await settle();
		ack(0);

		expect(inputs()).toEqual([]);
		expect(chunks()).toHaveLength(8);
	});

	it("WB3: drops what was held when the pane leaves the terminal, sending it nowhere", async () => {
		const channel = ref(T);
		mountPane(channel, "live", {
			setUp: () => {
				withU();
				const lock = useWriteLockStore();
				for (const id of [T, U]) lock.handleWriteLock(id, CLIENT);
			},
		});
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "T", { adaptsInput: true, streamsPaste: true });
		await settle();
		paste("a".repeat(9 * CHUNK));
		type("a");

		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		attachOk(U, "U", { adaptsInput: true, streamsPaste: true });
		await settle();
		// The paste left behind holds nothing more: what is typed now goes, alone, to U.
		type("b");

		expect(inputs()).toEqual(["b"]);
		expect(inputsTo()).toEqual([U]);
	});

	it("WB3: refuses a second paste while chunks are unsent, and in its tail before the last acknowledgement", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		paste("second");
		for (let seq = 0; seq < 8; seq++) ack(seq);
		expect(chunks()).toHaveLength(9);
		paste("third");

		expect(chunks()).toHaveLength(9);
		expect(toasts()).toEqual([
			"A paste is still being sent to this terminal.",
			"A paste is still being sent to this terminal.",
		]);
	});

	it("WB3: cancels on Ctrl+C a paste whose chunks are all sent and not yet acknowledged", async () => {
		await streaming();
		paste("a".repeat(100 * 1024));
		expect(chunks().at(-1)?.last).toBe(true);

		type("\u0003");

		expect(order().slice(-2)).toEqual(["CANCEL", "INPUT \u0003"]);
	});

	it("WB3: holds what another pane showing the terminal types, and takes its Ctrl+C", async () => {
		freshWindow();
		writer();
		mountRoot(
			defineComponent({
				setup: () => () =>
					h("div", [
						h(TerminalPane, { channelId: T, hostId: HOST }),
						h(TerminalPane, { channelId: T, hostId: HOST }),
					]),
			}),
		);
		await vi.waitFor(() => expect(attaches()).toHaveLength(2));
		attachOk(T, "LIVE", { adaptsInput: true, streamsPaste: true });
		await settle();
		const [first, second] = (xterm.terminals as StandInTerminal[]).filter((x) => !x.disposed);
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", {
			value: { getData: () => "a".repeat(9 * CHUNK) },
		});
		first?.textarea.dispatchEvent(event);
		const typeIn = (term: typeof first, data: string) => {
			for (const listener of [...(term?.dataListeners ?? [])]) listener(data);
		};

		typeIn(second, "x");
		expect(inputs()).toEqual([]);
		typeIn(second, "");

		expect(order().slice(-3)).toEqual(["CANCEL", "INPUT x", "INPUT "]);
	});

	it("WB3: holds xterm's own reports behind unsent chunks, as typed keys", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));

		type("\u001b[I");
		expect(inputs()).toEqual([]);
		ack(0);

		expect(inputs()).toEqual(["\u001b[I"]);
	});

	it("WB4: shows the progress after a second, updates it, keeps it until the last acknowledgement", async () => {
		await streaming();
		paste("a".repeat(1024 * 1024));
		expect(toasts()).toEqual([]);

		vi.advanceTimersByTime(1000);
		expect(toasts()).toEqual(["Pasting 0 B of 1 MB (0 %)"]);
		expect(useToastStore().messages[0]?.action?.label).toBe("Cancel");
		for (let seq = 0; seq < 16; seq++) ack(seq);
		expect(toasts()).toEqual(["Pasting 512 KB of 1 MB (50 %)"]);

		vi.advanceTimersByTime(10_000);
		expect(toasts()).toHaveLength(1);
		for (let seq = 16; seq < 32; seq++) ack(seq);
		expect(toasts()).toEqual([]);
	});

	it("WB4: its Cancel sends PASTE_CANCEL, then what was held, sends no more chunks, and says what went", async () => {
		await streaming();
		paste("a".repeat(1024 * 1024));
		type("a");
		vi.advanceTimersByTime(1000);
		ack(0);
		ack(1);

		const progress = useToastStore().messages[0];
		useToastStore().act(progress?.id as number);
		ack(2);

		expect(order().slice(-2)).toEqual(["CANCEL", "INPUT a"]);
		expect(chunks()).toHaveLength(10);
		expect(toasts()).toEqual([
			"Paste cancelled: at least 65,536 bytes of 1,048,576 bytes reached the terminal.",
		]);
	});

	it("WB4: says what went after a Ctrl+C too", async () => {
		await streaming();
		paste("a".repeat(1024 * 1024));
		ack(0);

		type("\u0003");

		expect(toasts()).toEqual([
			"Paste cancelled: at least 32,768 bytes of 1,048,576 bytes reached the terminal.",
		]);
	});

	it("WB4: dismissing the progress only hides it: the paste goes on", async () => {
		await streaming();
		paste("a".repeat(1024 * 1024));
		vi.advanceTimersByTime(1000);

		useToastStore().dismiss(useToastStore().messages[0]?.id as number);
		for (let seq = 0; seq < 32; seq++) ack(seq);

		expect(cancels()).toEqual([]);
		expect(chunks()).toHaveLength(32);
		expect(toasts()).toEqual([]);
	});

	it("WB5: says exactly how much went when the agent says, and sends no more", async () => {
		await streaming();
		paste("a".repeat(1024 * 1024));

		closed("overflow", 98_304);
		ack(0);

		expect(chunks()).toHaveLength(8);
		expect(toasts()).toEqual([
			"Paste interrupted: 98,304 bytes of 1,048,576 bytes reached the terminal.",
		]);
	});

	it("WB5: says at least what was acknowledged when the agent is lost, or the socket drops", async () => {
		await streaming();
		paste("a".repeat(1024 * 1024));
		for (let seq = 0; seq < 3; seq++) ack(seq);
		closed("agent_lost");

		paste("b".repeat(1024 * 1024));
		for (let seq = 0; seq < 3; seq++) ack(seq);
		dropConnection();

		expect(toasts()).toEqual([
			"Paste interrupted: at least 98,304 bytes of 1,048,576 bytes reached the terminal.",
			"Paste interrupted: at least 98,304 bytes of 1,048,576 bytes reached the terminal.",
		]);
		expect(cancels()).toEqual([]);
	});

	it("WB6: cancels when the pane switches terminals, sends no more, and says what went", async () => {
		const channel = ref(T);
		mountPane(channel, "live", {
			setUp: () => {
				withU();
				const lock = useWriteLockStore();
				for (const id of [T, U]) lock.handleWriteLock(id, CLIENT);
			},
		});
		await vi.waitFor(() => expect(attaches()).toHaveLength(1));
		attachOk(T, "T", { adaptsInput: true, streamsPaste: true });
		await settle();
		paste("a".repeat(1024 * 1024));
		vi.advanceTimersByTime(1000);
		const id = pasteId();

		channel.value = U;
		await vi.waitFor(() => expect(attachedTo()).toEqual([T, U]));
		ack(0, id);

		expect(cancels()).toEqual([{ type: "PASTE_CANCEL", channelId: T, pasteId: id }]);
		expect(chunks()).toHaveLength(8);
		expect(toasts()).toEqual([
			"Paste interrupted: at least 0 bytes of 1,048,576 bytes reached the terminal.",
		]);
	});

	it("WB6: a pane remounted for the same terminal gives its next paste a greater id", async () => {
		const { channel, remount } = openNewRemountable();
		useWriteLockStore().handleWriteLock(REAL, CLIENT);
		await vi.waitFor(() => expect(spawns()).toHaveLength(1));
		hear({
			type: "SPAWN_OK",
			channelId: REAL,
			requestId: spawns().at(-1)?.requestId,
			streamsPaste: true,
		});
		await settle();
		expect(channel.value).toBe(REAL);
		paste("first");
		const first = pasteId();
		ack(0, first, REAL);

		await remount();
		await vi.waitFor(() => expect(attaches().length).toBeGreaterThan(0));
		attachOk(REAL, "REAL", { streamsPaste: true });
		await settle();
		paste("second");

		expect(pasteId()).toBeGreaterThan(first);
	});

	it("WB6: ignores an old paste's answers: the current one goes on, its credit unchanged", async () => {
		await streaming();
		paste("a".repeat(9 * CHUNK));
		const old = pasteId();
		type("\u0003");
		paste("b".repeat(9 * CHUNK));
		expect(chunks()).toHaveLength(16);

		ack(0, old);
		closed("cancelled", 0, old);

		expect(chunks()).toHaveLength(16);
		expect(toasts().filter((t) => t.startsWith("Paste interrupted"))).toEqual([]);
		ack(0);
		expect(chunks()).toHaveLength(17);
	});

	it("WB7: keeps #1012's single frame when the agent adapts input but does not stream pastes", async () => {
		await streaming({ adaptsInput: true, streamsPaste: false });

		paste("a");
		paste("x".repeat(65_530));

		expect(chunks()).toEqual([]);
		expect(inputs()).toEqual(["\u001b[200~a\u001b[201~"]);
		expect(toasts()).toEqual(["This paste is too large to send (64 KiB at most)."]);
	});

	it("WB7: leaves the paste to xterm when the agent does neither", async () => {
		await streaming({});

		paste("a\nb");

		expect(chunks()).toEqual([]);
		expect(inputs()).toEqual(["a\rb"]);
	});

	it("WB8: refuses a paste over 16 MiB of UTF-8, and sends one of exactly 16 MiB", async () => {
		await streaming();

		paste("€".repeat(5_592_406)); // 16 777 218 bytes
		expect(chunks()).toEqual([]);
		expect(toasts()).toEqual(["This paste is too large to send (16 MiB at most)."]);

		paste("x".repeat(16 * 1024 * 1024));
		expect(chunks()).toHaveLength(8);
	});
});

// ─── Asking before a paste of several lines (#1015) ──────────────────────────
//
// A paste its program would run line by line waits on a card over the pane:
// what the composable decides is in useTerminal.browser.spec.ts, the card's
// own content in PasteConfirm.spec.ts; this holds the pane's part: the setting
// it reads, "Don't ask again", and where the keyboard goes.

describe("TerminalPane asking before a paste of several lines (#1015)", () => {
	function paste(text: string): Event {
		const event = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
		terminal().textarea.dispatchEvent(event);
		return event;
	}
	const pasteCard = () => root.querySelector<HTMLElement>(".paste-confirm");
	const pasteButton = (label: string) =>
		[...(pasteCard()?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent?.trim() === label,
		) as HTMLButtonElement | undefined;
	const dontAsk = () => pasteCard()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
	const everywhere = () =>
		pasteCard()?.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
	const toasts = () => useToastStore().messages.map((t) => t.text);
	/** The config writes sent, in order: method, path and body. */
	const configWrites = () =>
		vi
			.mocked(fetch)
			.mock.calls.map(([url, init]) => ({
				method: (init as RequestInit | undefined)?.method,
				path: String(url).replace(/^[a-z]+:\/\/[^/]+/, ""),
				body: (init as RequestInit | undefined)?.body,
			}))
			.filter((call) => call.method === "PUT" || call.method === "PATCH")
			.map((call) => ({ ...call, body: JSON.parse(String(call.body)) }));

	/** A live pane over T, this window the writer, its tab shown and the keyboard in it. */
	async function openShown(): Promise<void> {
		await openLive({
			setUp: () => {
				writer();
				shown();
			},
		});
		terminal().focus();
	}

	/** A pane whose paste of `text` waits on its card. */
	async function asked(text = "a\nb"): Promise<void> {
		await openShown();
		paste(text);
		await settle();
		expect(pasteCard()).not.toBeNull();
	}

	it("asks with no setting, and sends the paste only on Paste", async () => {
		await asked();
		expect(inputs()).toEqual([]);
		pasteButton("Paste")?.click();
		await settle();
		expect(inputs()).toEqual(["a\rb"]);
		expect(pasteCard()).toBeNull();
	});

	it("sends a paste of several lines at once when its host says never ask", async () => {
		xterm.profile = { pasteWarning: "never" };
		await openShown();
		paste("a\nb");
		await settle();
		expect(pasteCard()).toBeNull();
		expect(inputs()).toEqual(["a\rb"]);
	});

	it("reads the setting at each paste", async () => {
		await asked();
		pasteButton("Cancel")?.click();
		await settle();
		const { profile } = paneProfile();
		profile.value = { ...profile.value, pasteWarning: "never" };
		await settle();
		paste("c\nd");
		await settle();
		expect(pasteCard()).toBeNull();
		expect(inputs()).toEqual(["c\rd"]);
	});

	it("writes never for this host on Paste with Don't ask again, and pastes", async () => {
		await asked();
		dontAsk()?.click();
		pasteButton("Paste")?.click();
		await settle();
		expect(inputs()).toEqual(["a\rb"]);
		await vi.waitFor(() =>
			expect(configWrites()).toEqual([
				{
					method: "PATCH",
					path: `/api/hosts/${HOST}/profile`,
					body: { profile: { pasteWarning: "never" } },
				},
				{
					method: "PATCH",
					path: `/api/channels/${T}/profile`,
					body: { profile: { pasteWarning: null } },
				},
			]),
		);
	});

	it("writes never everywhere, dropping the host's and the terminal's own, and pastes", async () => {
		xterm.profile = { pasteWarning: "always" };
		await asked();
		everywhere()?.click();
		pasteButton("Paste")?.click();
		await settle();
		expect(inputs()).toEqual(["a\rb"]);
		await vi.waitFor(() =>
			expect(configWrites()).toEqual([
				{
					method: "PUT",
					path: "/api/config/global",
					body: { terminal: { pasteWarning: "never" } },
				},
				{
					method: "PATCH",
					path: `/api/hosts/${HOST}/profile`,
					body: { profile: { pasteWarning: null } },
				},
				{
					method: "PATCH",
					path: `/api/channels/${T}/profile`,
					body: { profile: { pasteWarning: null } },
				},
			]),
		);
	});

	it("sends the paste without waiting for Don't ask again to be saved", async () => {
		await asked();
		let release: () => void = () => {};
		vi.mocked(fetch).mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					release = () => resolve(new Response("{}", { status: 200 }));
				}),
		);
		dontAsk()?.click();
		pasteButton("Paste")?.click();
		try {
			await settle();
			expect(inputs()).toEqual(["a\rb"]);
		} finally {
			release();
		}
	});

	it("says so when Don't ask again could not be saved, and pastes all the same", async () => {
		await asked();
		vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));
		dontAsk()?.click();
		pasteButton("Paste")?.click();
		await settle();
		expect(inputs()).toEqual(["a\rb"]);
		await vi.waitFor(() => expect(toasts()).toContain('Could not save "Don\'t ask again".'));
	});

	it("writes nothing on Cancel, even with Don't ask again checked", async () => {
		await asked();
		dontAsk()?.click();
		pasteButton("Cancel")?.click();
		await settle();
		expect(inputs()).toEqual([]);
		expect(configWrites()).toEqual([]);
	});

	it("writes nothing on Paste without Don't ask again", async () => {
		await asked();
		pasteButton("Paste")?.click();
		await settle();
		expect(inputs()).toEqual(["a\rb"]);
		expect(configWrites()).toEqual([]);
	});

	for (const label of ["Paste", "Cancel"]) {
		it(`gives the keyboard back to the terminal after ${label}`, async () => {
			await asked();
			pasteButton(label)?.focus();
			pasteButton(label)?.click();
			await settle();
			expect(document.activeElement).toBe(terminal().textarea);
		});
	}

	it("gives the keyboard back to the terminal when an attach takes the card away", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await asked();
		expect(document.activeElement).toBe(pasteCard());
		useSessionStore().reconnectCount++;
		await settle();
		await vi.advanceTimersByTimeAsync(10_000);
		await settle();
		expect(pasteCard()).toBeNull();
		expect(document.activeElement).toBe(terminal().textarea);
	});

	it("drops the paste when its terminal ends, and leaves the keyboard to the ended card", async () => {
		await asked();
		expect(document.activeElement).toBe(pasteCard());
		endIt();
		await vi.waitFor(() => expect(card()).not.toBeNull());
		await settle();
		expect(pasteCard()).toBeNull();
		expect(inputs()).toEqual([]);
		expect(document.activeElement).toBe(card());
	});

	it("takes the keyboard again for a paste that replaces the one it holds", async () => {
		await asked();
		terminal().focus();
		paste("c\nd\ne");
		await settle();
		expect(pasteCard()?.textContent).toContain("Paste 3 lines?");
		expect(document.activeElement).toBe(pasteCard());
	});

	it("gives the card the keyboard when search closes over it", async () => {
		await openShown();
		press({ ctrlKey: true, shiftKey: true, key: "F" }, "\u0006");
		await settle();
		terminal().focus();
		paste("a\nb");
		await settle();
		expect(pasteCard()).not.toBeNull();
		root.querySelector<HTMLButtonElement>(".search-overlay__btn--close")?.click();
		await settle();
		expect(document.activeElement).toBe(pasteCard());
	});

	it("gives the card the keyboard when its tab is shown again", async () => {
		await asked();
		(document.activeElement as HTMLElement | null)?.blur();
		useChannelsStore().selectChannel(S);
		await settle();
		useChannelsStore().selectChannel(T);
		await settle();
		expect(document.activeElement).toBe(pasteCard());
	});
});
