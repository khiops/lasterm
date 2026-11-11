/**
 * A pane's terminal and the hub: what it says when the input typed there was
 * dropped (#767), the size it draws at and sends (#831), and what it shows of
 * a terminal that has ended (#927). Only xterm and its addons are stand-ins.
 */
import type { EndedOutput, ProtocolMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useTerminal } from "./useTerminal.js";

const xterm = vi.hoisted(() => ({
	/** Everything written to a terminal, as text. */
	written: [] as string[],
	/** The size each write found its terminal at. */
	writtenAt: [] as Array<{ cols: number; rows: number }>,
	/** What a fit gives: the size the pane holds, as the test sets it. */
	fit: { cols: 80, rows: 24 },
	/** Clears and writes in order: "<reset>" for a clear, the text for a write. */
	events: [] as string[],
	/** The terminal created last, to type into. */
	last: null as { type(data: string): void } | null,
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "" };
		element = document.createElement("div");
		/** A cell 9 px wide, as xterm's core reports it to the fit addon. */
		_core = { _renderService: { dimensions: { css: { cell: { width: 9, height: 17 } } } } };
		private resizeListeners: Array<(size: { cols: number; rows: number }) => void> = [];
		private dataListeners: Array<(data: string) => void> = [];
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
			xterm.last = this;
		}
		/** What someone typing into the terminal makes it emit. */
		type(data: string): void {
			for (const listener of this.dataListeners) listener(data);
		}
		loadAddon(addon: { activate?: (terminal: unknown) => void }): void {
			addon.activate?.(this);
		}
		open(): void {}
		onData(listener: (data: string) => void) {
			this.dataListeners.push(listener);
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
		reset(): void {
			xterm.events.push("<reset>");
		}
		/** Parsed at once, as xterm does right after user input; its callback then. */
		write(data: string | Uint8Array, callback?: () => void): void {
			const text = typeof data === "string" ? data : new TextDecoder().decode(data);
			if (text !== "") {
				xterm.written.push(text);
				xterm.writtenAt.push({ cols: this.cols, rows: this.rows });
				xterm.events.push(text);
			}
			callback?.();
		}
		dispose(): void {}
	},
}));

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

vi.mock("./terminal-font.js", () => ({
	awaitTerminalFont: () => Promise.resolve(),
}));

/** A hub connection the test speaks for. */
function fakeWsClient() {
	const listeners = new Map<string, Set<(msg: ProtocolMessage) => void>>();
	const client = {
		isConnected: true,
		send: vi.fn(),
		on(type: string, callback: (msg: ProtocolMessage) => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(callback);
			listeners.set(type, set);
			return () => set.delete(callback);
		},
		onReconnect: () => () => {},
		onDisconnect: () => () => {},
		connect: () => Promise.resolve(),
		close() {},
	};
	return {
		client: client as unknown as IWsClient,
		hear(msg: ProtocolMessage): void {
			for (const callback of [...(listeners.get(msg.type) ?? [])]) callback(msg);
		},
		listening(type: string): number {
			return listeners.get(type)?.size ?? 0;
		},
	};
}

const NOTICE = "what you typed was dropped: this terminal is not taking input";

describe("a terminal whose input was dropped (#767)", () => {
	beforeEach(() => {
		xterm.written.length = 0;
		setActivePinia(createPinia());
	});

	function paneOn(channelId: string) {
		const hub = fakeWsClient();
		const pane = useTerminal(ref(document.createElement("div")), hub.client);
		pane.init();
		pane.attachChannel(channelId);
		xterm.written.length = 0;
		return { hub, pane };
	}

	it("says so in that terminal, on a line of its own", () => {
		const { hub } = paneOn("ch-1");

		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-1" });

		expect(xterm.written).toHaveLength(1);
		expect(xterm.written[0]).toContain(NOTICE);
		expect(xterm.written[0]).toMatch(/^\r\n.*\r\n$/s);
	});

	it("says it each time the hub does: once per gap, as the agent says it", () => {
		const { hub } = paneOn("ch-1");

		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-1" });
		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-1" });

		expect(xterm.written.filter((text) => text.includes(NOTICE))).toHaveLength(2);
	});

	it("says nothing of another terminal's", () => {
		const { hub } = paneOn("ch-1");

		hub.hear({ type: "INPUT_DROPPED", channelId: "ch-2" });

		expect(xterm.written).toEqual([]);
	});

	it("stops listening once the pane is gone", () => {
		const { hub, pane } = paneOn("ch-1");
		expect(hub.listening("INPUT_DROPPED")).toBe(1);

		pane.dispose();

		expect(hub.listening("INPUT_DROPPED")).toBe(0);
	});
});

describe("one size per terminal (#831)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		xterm.written.length = 0;
		xterm.writtenAt.length = 0;
		xterm.fit = { cols: 80, rows: 24 };
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** A pane of `width`×`height` px, whose fit gives `fit`. */
	function pane(fit: { cols: number; rows: number }, width = 800, height = 600) {
		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { configurable: true, value: width });
		Object.defineProperty(container, "clientHeight", { configurable: true, value: height });
		xterm.fit = fit;
		const hub = fakeWsClient();
		const terminal = useTerminal(ref(container), hub.client);
		terminal.init();
		/** The RESIZEs this pane sent, once its debounce has run. */
		const resizes = () => {
			vi.advanceTimersByTime(100);
			return (hub.client.send as ReturnType<typeof vi.fn>).mock.calls
				.map(([msg]) => msg as ProtocolMessage)
				.filter((msg) => msg.type === "RESIZE");
		};
		/** The pane's own size changes, as a window or a split resizes it. */
		const resizePane = (next: { cols: number; rows: number }) => {
			xterm.fit = next;
			// What the ResizeObserver does; happy-dom has no layout to observe.
			window.dispatchEvent(new Event("nt:scrollbar-changed"));
		};
		const size = () => ({
			cols: terminal.terminal.value?.cols,
			rows: terminal.terminal.value?.rows,
		});
		return { container, hub, terminal, resizes, resizePane, size };
	}

	it("a reader draws the terminal at the size the hub says, and sends no RESIZE", () => {
		const reader = pane({ cols: 100, rows: 30 });
		reader.terminal.attachChannel("ch-1");

		reader.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 132, rows: 43 });
		reader.resizePane({ cols: 90, rows: 20 });

		expect(reader.size()).toEqual({ cols: 132, rows: 43 });
		expect(reader.resizes()).toEqual([]);
		// Top-left on a ground of its own, as wide as its columns.
		expect(reader.container.classList.contains("terminal-container--follows")).toBe(true);
		expect(reader.terminal.terminal.value?.element?.style.width).toMatch(/^\d+px$/);
	});

	it("ignores another terminal's size", () => {
		const reader = pane({ cols: 100, rows: 30 });
		reader.terminal.attachChannel("ch-1");
		reader.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 132, rows: 43 });

		reader.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-2", cols: 60, rows: 10 });

		expect(reader.size()).toEqual({ cols: 132, rows: 43 });
	});

	it("draws the screen it attaches to at the size it was drawn for", async () => {
		const reader = pane({ cols: 100, rows: 30 });
		const attached = reader.terminal.reattachChannel("ch-1");
		reader.hub.hear({
			type: "ATTACH_OK",
			channelId: "ch-1",
			snapshot: { serialized: "screen", cols: 132, rows: 43, cursorX: 0, cursorY: 0 },
			tail: [],
			writeLockHolder: "someone-else",
			cached: false,
			cols: 132,
			rows: 43,
		});
		await attached;

		expect(xterm.written).toEqual(["screen"]);
		expect(xterm.writtenAt).toEqual([{ cols: 132, rows: 43 }]);
		expect(reader.resizes()).toEqual([]);
	});

	it("becoming the writer sends its own fit, and the reader's ground goes", () => {
		const taker = pane({ cols: 100, rows: 30 });
		taker.terminal.attachChannel("ch-1");
		taker.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 132, rows: 43 });

		taker.terminal.setDecidesSize(true);

		expect(taker.size()).toEqual({ cols: 100, rows: 30 });
		expect(taker.resizes()).toEqual([{ type: "RESIZE", channelId: "ch-1", cols: 100, rows: 30 }]);
		expect(taker.container.classList.contains("terminal-container--follows")).toBe(false);
		expect(taker.terminal.terminal.value?.element?.style.width).toBe("");
	});

	it("the writer sends nothing when its fit is already the PTY's size", () => {
		const writer = pane({ cols: 132, rows: 43 });
		writer.terminal.attachChannel("ch-1");
		writer.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 132, rows: 43 });

		writer.terminal.setDecidesSize(true);

		expect(writer.resizes()).toEqual([]);
	});

	it("the writer sends its pane's size as it changes, and keeps it over what the hub says", () => {
		const writer = pane({ cols: 100, rows: 30 });
		writer.terminal.attachChannel("ch-1");
		writer.terminal.setDecidesSize(true);

		writer.resizePane({ cols: 110, rows: 32 });
		// The echo of an earlier size: the writer's pane is the size.
		writer.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 100, rows: 30 });

		expect(writer.size()).toEqual({ cols: 110, rows: 32 });
		expect(writer.resizes()).toEqual([
			{ type: "RESIZE", channelId: "ch-1", cols: 100, rows: 30 },
			{ type: "RESIZE", channelId: "ch-1", cols: 110, rows: 32 },
		]);
	});

	it("losing the lock draws the terminal at the PTY's size, as the hub last said it", () => {
		const writer = pane({ cols: 100, rows: 30 });
		writer.terminal.attachChannel("ch-1");
		writer.terminal.setDecidesSize(true);
		writer.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 100, rows: 30 });
		const before = writer.resizes().length;

		writer.terminal.setDecidesSize(false);
		writer.hub.hear({ type: "CHANNEL_SIZE", channelId: "ch-1", cols: 140, rows: 50 });
		writer.resizePane({ cols: 90, rows: 20 });

		expect(writer.size()).toEqual({ cols: 140, rows: 50 });
		expect(writer.resizes()).toHaveLength(before);
	});

	it("a pane out of sight sends no size: a hidden tab measures 0×0", () => {
		const hidden = pane({ cols: 2, rows: 1 }, 0, 0);
		hidden.terminal.attachChannel("ch-1");

		hidden.terminal.setDecidesSize(true);
		hidden.resizePane({ cols: 2, rows: 1 });

		expect(hidden.resizes()).toEqual([]);
	});

	it("a writer out of sight sends its size once it is shown, even when its fit did not change", async () => {
		const writer = pane({ cols: 100, rows: 30 });
		writer.terminal.setDecidesSize(true);
		Object.defineProperty(writer.container, "clientWidth", { configurable: true, value: 0 });
		Object.defineProperty(writer.container, "clientHeight", { configurable: true, value: 0 });
		// Attached in a tab in the background, to a PTY of another size: the
		// hub restarted, and another client decided meanwhile.
		const attached = writer.terminal.reattachChannel("ch-1");
		writer.hub.hear({
			type: "ATTACH_OK",
			channelId: "ch-1",
			snapshot: null,
			tail: [],
			writeLockHolder: "this-client",
			cached: false,
			cols: 132,
			rows: 43,
		});
		await attached;
		expect(writer.resizes()).toEqual([]);

		Object.defineProperty(writer.container, "clientWidth", { configurable: true, value: 800 });
		Object.defineProperty(writer.container, "clientHeight", { configurable: true, value: 600 });
		writer.resizePane({ cols: 100, rows: 30 });

		expect(writer.resizes()).toEqual([{ type: "RESIZE", channelId: "ch-1", cols: 100, rows: 30 }]);
	});

	it("a spawned terminal's pane sends nothing when its fit is the size it was spawned at", () => {
		const spawner = pane({ cols: 100, rows: 30 });
		spawner.terminal.suppressNextResize(100, 30);
		spawner.terminal.attachChannel("ch-1");
		spawner.terminal.syncChannelSize();

		// The hub grants the lock to the client that spawned it.
		spawner.terminal.setDecidesSize(true);

		expect(spawner.resizes()).toEqual([]);
	});
});

// ─── An ended terminal's last output (#927) ─────────────────────────────────
//
// The hub's CHANNEL_DEAD carries what the terminal last printed. The pane
// shows it, drawn at the size it was drawn for, only for the terminal it still
// shows and only from its latest request, and then speaks to nothing: typing
// and resizing go nowhere until a terminal attaches again.
describe("an ended terminal's last output (#927)", () => {
	const MOUSE_OFF = "\u001b[?1000l";
	const SCREEN = { serialized: "SCREEN", cols: 100, rows: 30, cursorX: 0, cursorY: 0 };
	const bytes = (text: string) => new TextEncoder().encode(text);

	beforeEach(() => {
		vi.useFakeTimers();
		xterm.written.length = 0;
		xterm.writtenAt.length = 0;
		xterm.events.length = 0;
		xterm.fit = { cols: 80, rows: 24 };
		setActivePinia(createPinia());
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function pane() {
		const container = document.createElement("div");
		Object.defineProperty(container, "clientWidth", { configurable: true, value: 800 });
		Object.defineProperty(container, "clientHeight", { configurable: true, value: 600 });
		const hub = fakeWsClient();
		const terminal = useTerminal(ref(container), hub.client);
		terminal.init();
		const sent = () => {
			vi.advanceTimersByTime(100);
			return (hub.client.send as ReturnType<typeof vi.fn>).mock.calls
				.map(([msg]) => msg as ProtocolMessage)
				.filter((msg) => msg.type === "INPUT" || msg.type === "RESIZE");
		};
		const resizePane = (next: { cols: number; rows: number }) => {
			xterm.fit = next;
			window.dispatchEvent(new Event("nt:scrollbar-changed"));
		};
		const size = () => ({
			cols: terminal.terminal.value?.cols,
			rows: terminal.terminal.value?.rows,
		});
		/** The hub refuses the attach of `channelId` as ended, with `lastOutput` or none. */
		const refuse = (channelId: string, lastOutput?: EndedOutput) =>
			hub.hear({
				type: "ERROR",
				code: "CHANNEL_DEAD",
				message: "This terminal has ended.",
				channelId,
				...(lastOutput !== undefined && { lastOutput }),
			});
		/** Attach `channelId`, answered ATTACH_OK with a screen holding `text`. */
		const attachLive = async (
			channelId: string,
			text: string,
			opts?: { preserveContent?: boolean; keepScreenIfEnded?: boolean },
		) => {
			const attached = terminal.reattachChannel(channelId, opts);
			hub.hear({
				type: "ATTACH_OK",
				channelId,
				snapshot: { serialized: text, cols: 100, rows: 30, cursorX: 0, cursorY: 0 },
				tail: [],
				writeLockHolder: null,
				cached: false,
				cols: 100,
				rows: 30,
			});
			await attached;
		};
		/** Attach `channelId` and have it refused; resolves with the rejection's code. */
		const attachEnded = async (
			channelId: string,
			lastOutput?: EndedOutput,
			opts?: {
				preserveContent?: boolean;
				keepScreenIfEnded?: boolean;
				stillWanted?: () => boolean;
			},
		) => {
			const attached = terminal.reattachChannel(channelId, opts);
			refuse(channelId, lastOutput);
			return attached.then(
				() => "resolved",
				(err: { code?: string }) => err.code,
			);
		};
		return { hub, terminal, sent, resizePane, size, refuse, attachLive, attachEnded };
	}

	const output = (over: Partial<EndedOutput> = {}): EndedOutput => ({
		snapshot: SCREEN,
		tail: [bytes("a"), bytes("b")],
		cols: 100,
		rows: 30,
		...over,
	});

	it("shows an ended terminal's last output when the hub refuses the attach", async () => {
		const withScreen = pane();
		expect(await withScreen.attachEnded("T", output())).toBe("CHANNEL_DEAD");
		expect(xterm.events).toEqual(["<reset>", "SCREEN", "a", "b", MOUSE_OFF]);

		xterm.events.length = 0;
		xterm.writtenAt.length = 0;
		const noScreen = pane();
		expect(await noScreen.attachEnded("T", output({ snapshot: null }))).toBe("CHANNEL_DEAD");
		expect(xterm.events).toEqual(["<reset>", "a", "b", MOUSE_OFF]);
		expect(xterm.writtenAt.slice(0, 2)).toEqual([
			{ cols: 100, rows: 30 },
			{ cols: 100, rows: 30 },
		]);
	});

	it("draws an ended terminal's output at the size it last had", async () => {
		// A snapshot taken at another size than the terminal's last: the last one decides.
		const older = { ...SCREEN, cols: 120, rows: 40 };
		const atLastSize = Array(4).fill({ cols: 100, rows: 30 });
		const reader = pane();
		await reader.attachEnded("T", output({ snapshot: older }));
		expect(xterm.events).toEqual(["<reset>", "SCREEN", "a", "b", MOUSE_OFF]);
		expect(xterm.writtenAt).toEqual(atLastSize);

		xterm.events.length = 0;
		xterm.writtenAt.length = 0;
		const writer = pane();
		writer.terminal.setDecidesSize(true);
		await writer.attachEnded("T", output({ snapshot: older }));
		expect(xterm.events).toEqual(["<reset>", "SCREEN", "a", "b", MOUSE_OFF]);
		expect(xterm.writtenAt).toEqual(atLastSize);

		xterm.writtenAt.length = 0;
		const tailOnly = pane();
		await tailOnly.attachEnded("T", output({ snapshot: null }));
		expect(xterm.writtenAt[0]).toEqual({ cols: 100, rows: 30 });
	});

	it("says when an ended terminal's output was too long to send", async () => {
		const withScreen = pane();
		await withScreen.attachEnded("T", output({ tail: [], truncated: true }));
		expect(xterm.events).toEqual([
			"<reset>",
			"SCREEN",
			"\r\n\u001b[2m── output between this screen and now was dropped ──\u001b[0m\r\n",
			MOUSE_OFF,
		]);

		xterm.events.length = 0;
		const fresh = pane();
		await fresh.attachEnded("T", output({ snapshot: null, tail: [], truncated: true }));
		expect(xterm.events).toEqual([
			"<reset>",
			"\r\n\u001b[2m── its last output was too long to show ──\u001b[0m\r\n",
			MOUSE_OFF,
		]);

		const watched = pane();
		await watched.attachLive("T", "OLD");
		xterm.events.length = 0;
		await watched.attachEnded("T", output({ snapshot: null, tail: [], truncated: true }));
		expect(xterm.events).toEqual([MOUSE_OFF]);
	});

	it("shows what an ended terminal printed while the pane was away", async () => {
		const away = pane();
		await away.attachLive("T", "OLD");
		xterm.events.length = 0;

		await away.attachEnded("T", output({ snapshot: null, tail: [bytes("FINAL")] }));

		expect(xterm.events).toEqual(["<reset>", "FINAL", MOUSE_OFF]);
	});

	it("keeps the screen of a terminal it watched when the hub kept nothing", async () => {
		const nothing = output({ snapshot: null, tail: [] });

		const spawned = pane();
		spawned.terminal.attachChannel("T");
		xterm.events.length = 0;
		await spawned.attachEnded("T", nothing);
		expect(xterm.events).toEqual([MOUSE_OFF]);

		const attached = pane();
		await attached.attachLive("T", "OLD");
		xterm.events.length = 0;
		await attached.attachEnded("T", nothing);
		expect(xterm.events).toEqual([MOUSE_OFF]);
	});

	it("clears another terminal's screen when the ended one left nothing", async () => {
		const nothing = output({ snapshot: null, tail: [] });
		const reused = pane();
		await reused.attachLive("T", "T-SCREEN");
		await reused.attachEnded("S", output({ snapshot: null, tail: [bytes("S-OUT")] }));
		xterm.events.length = 0;

		await reused.attachEnded("T", nothing);
		expect(xterm.events).toEqual(["<reset>", MOUSE_OFF]);

		xterm.events.length = 0;
		await reused.attachEnded("S", nothing);
		expect(xterm.events).toEqual(["<reset>", MOUSE_OFF]);
	});

	it("writes nothing for an answer to an attach it no longer waits on", async () => {
		const quick = pane();
		const first = quick.terminal.reattachChannel("T").then(
			() => "resolved",
			(err: { code?: string }) => err.code,
		);
		const second = quick.terminal.reattachChannel("S").catch(() => undefined);

		quick.refuse("S", output({ snapshot: null, tail: [bytes("S-OUT")] }));
		quick.refuse("T", output({ snapshot: null, tail: [bytes("T-OUT")] }));
		await second;

		expect(await first).toBe("CHANNEL_DEAD");
		expect(xterm.events).toEqual(["<reset>", "S-OUT", MOUSE_OFF]);
	});

	it("writes nothing for a terminal the pane no longer shows", async () => {
		const moved = pane();
		const code = await moved.attachEnded("T", output(), { stillWanted: () => false });

		expect(code).toBe("CHANNEL_DEAD");
		expect(xterm.events).toEqual([]);
	});

	it("writes nothing for an older hub's refusal", async () => {
		const older = pane();
		await older.attachLive("S", "S-SCREEN");
		xterm.events.length = 0;

		expect(await older.attachEnded("T")).toBe("CHANNEL_DEAD");
		expect(xterm.events).toEqual([MOUSE_OFF]);
	});

	it("leaves the screen alone on a Reconnect or Restart refused as ended", async () => {
		const kept = pane();
		await kept.attachLive("T", "WHOLE");
		xterm.events.length = 0;

		await kept.attachEnded("T", output(), { preserveContent: true });
		expect(xterm.events).toEqual([MOUSE_OFF]);

		xterm.events.length = 0;
		await kept.attachEnded("T", output(), { keepScreenIfEnded: true });
		expect(xterm.events).toEqual([MOUSE_OFF]);
	});

	// Kept only on a refusal: an ATTACH_OK replaces the screen as it always does.
	it("replaces the screen on an ATTACH_OK even when asked to keep it if ended", async () => {
		const watched = pane();
		await watched.attachLive("T", "OLD");
		xterm.events.length = 0;

		await watched.attachLive("T", "RESTARTED", { keepScreenIfEnded: true });

		expect(xterm.events).toEqual(["<reset>", "RESTARTED"]);
	});

	describe("sends nothing for an ended terminal it shows", () => {
		for (const withOutput of [true, false]) {
			const label = withOutput ? "with its last output" : "from an older hub";

			/** The terminal this pane created, which the keys typed go through. */
			const typed = () => {
				const term = xterm.last;
				if (term === null) throw new Error("expected the pane's terminal");
				return term;
			};

			it(`in a pane that never attached, ${label}`, async () => {
				const fresh = pane();
				await fresh.attachEnded("T", withOutput ? output() : undefined);
				// A write lock arriving later makes it the size's decider: still nothing.
				fresh.terminal.setDecidesSize(true);
				typed().type("x");
				fresh.resizePane({ cols: 90, rows: 20 });
				expect(fresh.sent()).toEqual([]);
			});

			it(`in a pane that decided its size, ${label}`, async () => {
				const writer = pane();
				await writer.attachLive("T", "LIVE");
				writer.terminal.setDecidesSize(true);
				// Live, it sends both: typing and its own size.
				typed().type("x");
				writer.resizePane({ cols: 90, rows: 20 });
				expect(writer.sent().map((m) => m.type)).toEqual(
					expect.arrayContaining(["INPUT", "RESIZE"]),
				);
				(writer.hub.client.send as ReturnType<typeof vi.fn>).mockClear();

				await writer.attachEnded("T", withOutput ? output() : undefined);
				typed().type("y");
				writer.resizePane({ cols: 70, rows: 18 });
				expect(writer.sent()).toEqual([]);
			});
		}
	});

	it("draws an ended terminal at its size until a terminal attaches again", async () => {
		const writer = pane();
		writer.terminal.setDecidesSize(true);
		await writer.attachEnded("T", output());
		writer.resizePane({ cols: 80, rows: 24 });
		expect(writer.size()).toEqual({ cols: 100, rows: 30 });
		expect(writer.sent()).toEqual([]);

		await writer.attachLive("T", "RESTARTED", { preserveContent: true });

		expect(writer.size()).toEqual({ cols: 80, rows: 24 });
		expect(writer.sent()).toEqual([{ type: "RESIZE", channelId: "T", cols: 80, rows: 24 }]);
	});

	it("turns mouse reporting off in an ended terminal it shows", async () => {
		const shown = pane();
		await shown.attachEnded("T", output());
		expect(xterm.events.at(-1)).toBe(MOUSE_OFF);

		xterm.events.length = 0;
		const left = pane();
		await left.attachEnded("T", output(), { stillWanted: () => false });
		expect(xterm.events).not.toContain(MOUSE_OFF);

		left.terminal.turnMouseReportingOff();
		expect(xterm.events).toEqual([MOUSE_OFF]);
	});
});
