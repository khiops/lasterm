/**
 * The writer's files panel, shared with the readers (#838). In a reader's window, its choice per
 * terminal: none follows the writer's panel, floating; closed sticks; open docks. "Dock here".
 * What a writer's window tells the hub, and that a reader's tells it nothing. The lock changing
 * hands. And the sizes that follow (#831): the writer's own panel docks and narrows every pane of
 * its tab, so the other terminals it writes get their new size, while the writer's panel a reader
 * follows floats, and none of the terminals that reader writes is resized.
 *
 * The stores are the real ones, one Pinia per window, and so is each pane's terminal
 * (`useTerminal`); xterm, and the hub on the other side of the socket, are stand-ins.
 */
import type { ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { useTerminal } from "../composables/useTerminal.js";
import type { IWsClient } from "../services/ws-client.js";
import { filesPanelForm } from "../utils/files-panel.js";
import { useAuthStore } from "./auth.js";
import { useConfigStore } from "./config.js";
import { useFilesPanelStore } from "./files-panel.js";
import { useWriteLockStore } from "./writelock.js";

/** A cell is 10 px wide: a pane fits a tenth of its width in columns. */
const CELL = 10;

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "" };
		element = document.createElement("div");
		container: HTMLElement | null = null;
		_core = { _renderService: { dimensions: { css: { cell: { width: 10, height: 17 } } } } };
		private resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
		}
		loadAddon(addon: { activate?: (terminal: unknown) => void }): void {
			addon.activate?.(this);
		}
		open(container: HTMLElement): void {
			this.container = container;
		}
		onData() {
			return { dispose() {} };
		}
		onResize(listener: (size: { cols: number; rows: number }) => void) {
			this.resizeListeners.push(listener);
			return { dispose() {} };
		}
		resize(cols: number, rows: number): void {
			if (cols === this.cols && rows === this.rows) return;
			this.cols = cols;
			this.rows = rows;
			for (const listener of this.resizeListeners) listener({ cols, rows });
		}
		onTitleChange() {
			return { dispose() {} };
		}
		reset(): void {}
		write(): void {}
		dispose(): void {}
	},
}));

interface FittedTerminal {
	container: HTMLElement | null;
	resize(cols: number, rows: number): void;
}

vi.mock("@xterm/addon-fit", () => ({
	// What the fit addon counts: as many cells as the pane holds.
	FitAddon: class {
		private terminal: FittedTerminal | null = null;
		activate(terminal: FittedTerminal): void {
			this.terminal = terminal;
		}
		fit(): void {
			const width = this.terminal?.container?.clientWidth ?? 0;
			this.terminal?.resize(Math.floor(width / 10), 24);
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

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const D = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
const ME = "client-me";
const OTHER = "client-other";

/** The terminal area beside the tab's panes, and the panel's width. */
const AREA = 1100;
const PANEL = 300;

/** The window's socket: what it sends, which the test reads as the hub would. */
function fakeHub() {
	const client = {
		isConnected: true,
		send: vi.fn(),
		on: () => () => {},
		onReconnect: () => () => {},
		onDisconnect: () => () => {},
		connect: () => Promise.resolve(),
		close() {},
	};
	const sent = () =>
		(client.send as ReturnType<typeof vi.fn>).mock.calls.map(([msg]) => msg as ProtocolMessage);
	return {
		client: client as unknown as IWsClient,
		/** The FILES_PANEL statements the window sent. */
		statements: () => sent().filter((msg) => msg.type === "FILES_PANEL"),
		/** The RESIZEs the window's panes sent for `channelId`, once their debounce ran. */
		resizes: (channelId: string) => {
			vi.advanceTimersByTime(100);
			return sent().filter((msg) => msg.type === "RESIZE" && msg.channelId === channelId);
		},
		forget: () => (client.send as ReturnType<typeof vi.fn>).mockClear(),
	};
}

/**
 * A window, with its stores in a Pinia of its own: holding the write lock of `writes`, reading
 * `reads` (someone else holds their lock), its tab showing all of them, the focus on `focused`.
 * Attached, it read in ATTACH_OK that each terminal's writer panel is closed.
 */
function windowOf(opts: { writes: string[]; reads: string[]; focused: string }) {
	setActivePinia(createPinia());
	useAuthStore().setClientId(ME);
	useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
	const locks = useWriteLockStore();
	for (const id of opts.writes) locks.handleWriteLock(id, ME);
	for (const id of opts.reads) locks.handleWriteLock(id, OTHER);
	const hub = fakeHub();
	const panel = useFilesPanelStore();
	panel.setWsClient(hub.client);
	const all = [...opts.writes, ...opts.reads];
	panel.setChannelsInTabs(new Set(all));
	panel.setFocused(opts.focused);
	for (const id of all) panel.takeWriterPanel(id, false);
	return {
		panel,
		locks,
		hub,
		/** The hub says the writer's panel opened or closed on `channelId` (FILES_PANEL). */
		hear: async (channelId: string, open: boolean) => {
			panel.takeWriterPanel(channelId, open);
			await nextTick();
		},
		/** The panel's form, as App.vue decides it for this window. */
		form: () =>
			filesPanelForm({
				windowWidth: 1400,
				areaWidth: AREA,
				panelWidth: PANEL,
				follows: panel.followsWriter,
			}),
	};
}

beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a reader's panel, per terminal (#838)", () => {
	it("none: follows the writer's, floating over the terminal, opening and closing with it", async () => {
		const reader = windowOf({ writes: [], reads: [A], focused: A });
		expect(reader.panel.shown).toBe(false);

		await reader.hear(A, true);
		expect([reader.panel.shown, reader.panel.followsWriter, reader.form()]).toEqual([
			true,
			true,
			"overlay",
		]);
		expect(reader.panel.isOpenOn(A)).toBe(true);

		await reader.hear(A, false);
		expect(reader.panel.shown).toBe(false);
	});

	it("closed: stays closed while the writer closes and reopens; reopened, it follows again", async () => {
		const reader = windowOf({ writes: [], reads: [A], focused: A });
		await reader.hear(A, true);

		reader.panel.close();
		await reader.hear(A, false);
		await reader.hear(A, true);
		expect(reader.panel.shown).toBe(false);
		expect(reader.panel.readerChoice(A)).toBe("closed");

		// Reopened while the writer's is open: it follows the writer again.
		reader.panel.toggleFor(A);
		expect([reader.panel.shown, reader.panel.followsWriter]).toEqual([true, true]);
		await reader.hear(A, false);
		expect(reader.panel.shown).toBe(false);
	});

	it("open: one the reader opened while the writer's was closed stays open, and docks", async () => {
		const reader = windowOf({ writes: [], reads: [A], focused: A });

		reader.panel.toggleFor(A);
		expect([reader.panel.shown, reader.panel.followsWriter, reader.form()]).toEqual([
			true,
			false,
			"docked",
		]);

		await reader.hear(A, true);
		await reader.hear(A, false);
		expect([reader.panel.shown, reader.panel.followsWriter]).toEqual([true, false]);
	});

	it("\"Dock here\" makes the writer's panel the reader's own: docked, it stays when the writer closes", async () => {
		const reader = windowOf({ writes: [], reads: [A], focused: A });
		await reader.hear(A, true);

		reader.panel.dockHere();
		expect([reader.panel.followsWriter, reader.form()]).toEqual([false, "docked"]);
		expect(reader.panel.readerChoice(A)).toBe("open");

		await reader.hear(A, false);
		expect(reader.panel.shown).toBe(true);
	});

	it("keeps its choice in this browser across a reload, and never tells the hub", async () => {
		const reader = windowOf({ writes: [], reads: [A], focused: A });
		await reader.hear(A, true);
		reader.panel.close();
		reader.panel.toggleFor(A);
		reader.panel.dockHere();
		reader.panel.close();
		await nextTick();
		expect(reader.hub.statements()).toEqual([]);

		// The page reloads: the choice is still there, and the writer's panel opening shows nothing.
		const again = windowOf({ writes: [], reads: [A], focused: A });
		expect(again.panel.readerChoice(A)).toBe("closed");
		await again.hear(A, true);
		expect(again.panel.shown).toBe(false);
	});

	it("is not changed by the writer's gestures", async () => {
		const reader = windowOf({ writes: [], reads: [A, B], focused: A });
		reader.panel.close();
		for (const open of [true, false, true]) await reader.hear(A, open);
		await reader.hear(B, true);
		expect([reader.panel.readerChoice(A), reader.panel.readerChoice(B)]).toEqual([
			"closed",
			"none",
		]);
	});
});

describe("the writer's panel, told to the hub (#838)", () => {
	it("says it open on the terminal it is attached to, and closed on A as it moves to B", async () => {
		const writer = windowOf({ writes: [A, B], reads: [], focused: A });

		writer.panel.openFor(null);
		await nextTick();
		expect(writer.hub.statements()).toEqual([{ type: "FILES_PANEL", channelId: A, open: true }]);
		expect(writer.form()).toBe("docked");
		await writer.hear(A, true);
		writer.hub.forget();

		writer.panel.setFocused(B);
		await nextTick();
		expect(writer.hub.statements()).toEqual([
			{ type: "FILES_PANEL", channelId: A, open: false },
			{ type: "FILES_PANEL", channelId: B, open: true },
		]);
	});

	it("says it closed when closed, and nothing while the hub has it so already", async () => {
		const writer = windowOf({ writes: [A], reads: [], focused: A });
		writer.panel.openFor(null);
		await writer.hear(A, true);
		writer.hub.forget();

		writer.panel.close();
		await nextTick();
		expect(writer.hub.statements()).toEqual([{ type: "FILES_PANEL", channelId: A, open: false }]);
		// The writer's own gestures leave its reader choice alone.
		expect(writer.panel.readerChoice(A)).toBe("none");
	});

	it("a reader following the writer's panel that takes the lock shares it open, and docks", async () => {
		const taker = windowOf({ writes: [], reads: [A], focused: A });
		await taker.hear(A, true);

		taker.locks.handleWriteLock(A, ME);
		await nextTick();

		expect([taker.panel.shown, taker.panel.followsWriter, taker.form()]).toEqual([
			true,
			false,
			"docked",
		]);
		// The hub has it open already: nothing to say.
		expect(taker.hub.statements()).toEqual([]);
	});

	it("a reader that closed its panel and takes the lock says it closed: the new writer's wins", async () => {
		const taker = windowOf({ writes: [], reads: [A], focused: A });
		await taker.hear(A, true);
		taker.panel.close();
		// Its own panel was left open on another terminal, earlier.
		taker.panel.setOpen(true);

		taker.locks.handleWriteLock(A, ME);
		await nextTick();

		expect(taker.panel.shown).toBe(false);
		expect(taker.hub.statements()).toEqual([{ type: "FILES_PANEL", channelId: A, open: false }]);
	});

	it("keeps its own panel as left when it gets the lock on attaching, or back after a reconnect", async () => {
		// Attaching first: no lock was known before it came.
		setActivePinia(createPinia());
		useAuthStore().setClientId(ME);
		useConfigStore().uiConfig = { onChannelDead: "readonly", experimental: { fileTransfer: true } };
		const panel = useFilesPanelStore();
		const hub = fakeHub();
		panel.setWsClient(hub.client);
		panel.setChannelsInTabs(new Set([A]));
		panel.setFocused(A);
		panel.setOpen(true);
		panel.takeWriterPanel(A, false);
		useWriteLockStore().handleWriteLock(A, ME);
		await nextTick();
		expect(panel.shown).toBe(true);
		expect(hub.statements()).toEqual([{ type: "FILES_PANEL", channelId: A, open: true }]);
		panel.takeWriterPanel(A, true);

		// A reconnect: a new client id, then the lock back under it.
		hub.forget();
		useAuthStore().setClientId("client-me-again");
		useWriteLockStore().handleWriteLock(A, "client-me-again");
		await nextTick();
		expect(panel.shown).toBe(true);
		expect(hub.statements()).toEqual([]);
	});

	it("says it open nowhere while file transfer is off", async () => {
		const writer = windowOf({ writes: [A], reads: [], focused: A });
		writer.panel.openFor(null);
		await writer.hear(A, true);
		writer.hub.forget();

		useConfigStore().uiConfig = { onChannelDead: "readonly" };
		await nextTick();
		expect(writer.hub.statements()).toEqual([{ type: "FILES_PANEL", channelId: A, open: false }]);
	});
});

describe("the sizes that follow (#831, #838)", () => {
	/**
	 * The tab's panes, A and D side by side, each with its terminal, deciding its size while the
	 * window writes it. `relayout` lays them out as App.vue's CSS does: a docked panel takes its
	 * width from the panes beside it; floating or as a sheet, it takes none.
	 */
	function tabOf(win: ReturnType<typeof windowOf>, ids: string[]) {
		const panes = ids.map((id) => {
			const container = document.createElement("div");
			Object.defineProperty(container, "clientHeight", { configurable: true, value: 600 });
			const terminal = useTerminal(ref(container), win.hub.client);
			return { id, container, terminal };
		});
		function relayout(): void {
			const taken = win.panel.shown && win.form() === "docked" ? PANEL : 0;
			for (const pane of panes) {
				Object.defineProperty(pane.container, "clientWidth", {
					configurable: true,
					value: (AREA - taken) / panes.length,
				});
			}
			// What the ResizeObserver does; happy-dom has no layout to observe.
			window.dispatchEvent(new Event("nt:scrollbar-changed"));
		}
		relayout();
		for (const pane of panes) {
			pane.terminal.init();
			pane.terminal.attachChannel(pane.id);
			pane.terminal.setDecidesSize(win.locks.isWriter(pane.id));
		}
		vi.advanceTimersByTime(100);
		win.hub.forget();
		return { relayout };
	}

	it("a reader of A split with D, which it writes: the writer opening its panel on A resizes D in no window", async () => {
		const reader = windowOf({ writes: [D], reads: [A], focused: A });
		const tab = tabOf(reader, [A, D]);

		await reader.hear(A, true);
		tab.relayout();

		// The reader shows the writer's panel, floating over A...
		expect([reader.panel.shown, reader.panel.followsWriter, reader.form()]).toEqual([
			true,
			true,
			"overlay",
		]);
		// ...so D's pane keeps its width, and D its size.
		expect(reader.hub.resizes(D)).toEqual([]);
		expect(reader.hub.statements()).toEqual([]);
	});

	it("the writer's docked panel narrows every pane of its tab: D, which it also writes, gets its new size", async () => {
		const writer = windowOf({ writes: [A, D], reads: [], focused: A });
		const tab = tabOf(writer, [A, D]);

		writer.panel.openFor(null);
		await nextTick();
		tab.relayout();

		const narrowed = (AREA - PANEL) / 2 / CELL;
		expect(writer.form()).toBe("docked");
		expect(writer.hub.statements()).toEqual([{ type: "FILES_PANEL", channelId: A, open: true }]);
		expect(writer.hub.resizes(D)).toEqual([
			{ type: "RESIZE", channelId: D, cols: narrowed, rows: 24 },
		]);
		expect(writer.hub.resizes(A)).toEqual([
			{ type: "RESIZE", channelId: A, cols: narrowed, rows: 24 },
		]);
	});

	it("a reader's own docked panel narrows its tab: of A and D, only D, which it writes, is resized", async () => {
		const reader = windowOf({ writes: [D], reads: [A], focused: A });
		const tab = tabOf(reader, [A, D]);

		await reader.hear(A, true);
		reader.panel.dockHere();
		tab.relayout();

		expect(reader.hub.resizes(D)).toEqual([
			{ type: "RESIZE", channelId: D, cols: (AREA - PANEL) / 2 / CELL, rows: 24 },
		]);
		expect(reader.hub.resizes(A)).toEqual([]);
		expect(reader.hub.statements()).toEqual([]);
	});
});
