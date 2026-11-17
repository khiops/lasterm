import type { EndedOutput, TerminalProfile, UiAttachOkMessage } from "@lasterm/shared";
import { MAX_INPUT_SIZE, PASTE_MAX_BYTES, sanitizeTitle } from "@lasterm/shared";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { type MaybeRefOrGetter, type Ref, ref, shallowRef, toValue, watch } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useChannelsStore } from "../stores/channels.js";
import { useThemeStore } from "../stores/theme.js";
import { useToastStore } from "../stores/toast.js";
import { terminalScrollbarWidth } from "../utils/terminal-scrollbar.js";
import { PasteStream, pasteInProgress } from "./paste-stream.js";
import { awaitTerminalFont } from "./terminal-font.js";
import { useTerminalSearch } from "./useTerminalSearch.js";

/** Maximum number of entries in the title stack (SC-05). */
const MAX_TITLE_STACK = 5;

/**
 * xterm.js composable.
 * Manages terminal lifecycle, input/output bridging to hub via WS, and resize handling.
 */
const DEFAULT_FONT_FAMILY = '"Consolas", "Liberation Mono", "Courier New", monospace';
const DEFAULT_FONT_SIZE = 14;
/** xterm's scrollbar width when no ruler width is set (its `DEFAULT_SCROLL_BAR_WIDTH`). */
const DEFAULT_XTERM_SCROLLBAR_WIDTH = 14;

/**
 * Turns mouse reporting off in the pane's own xterm (#927). A program that
 * turned it on and then ended leaves xterm sending the wheel and clicks to a
 * terminal that is gone, and plain selection off. In xterm 6 every
 * mouse-tracking DECRST sets the protocol to none, so this one is enough.
 */
const MOUSE_REPORTING_OFF = "\u001b[?1000l";

/** A paste's markers (#1012). */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/**
 * A pasted text with no paste marker left in it (#1012). One pass: each
 * character is kept, and a marker is dropped as soon as the kept text ends with
 * one, so that one formed again from the pieces around another is dropped too.
 * The two markers cannot overlap (each starts with the text's only ESC and
 * ends with `~`), so this leaves what removing them until none remains would,
 * in time linear in the text, however deeply its markers nest.
 */
function withoutPasteMarkers(text: string): string {
	const kept: string[] = [];
	for (let i = 0; i < text.length; i++) {
		const unit = text.charAt(i);
		kept.push(unit);
		const n = kept.length;
		if (
			unit === "~" &&
			n >= PASTE_START.length &&
			kept[n - 6] === "\u001b" &&
			kept[n - 5] === "[" &&
			kept[n - 4] === "2" &&
			kept[n - 3] === "0" &&
			(kept[n - 2] === "0" || kept[n - 2] === "1")
		) {
			kept.length = n - PASTE_START.length;
		}
	}
	return kept.join("");
}

/** What xterm reports on a focus change, when the program asked for it (`?1004`). */
const FOCUS_IN = "\u001b[I";
const FOCUS_OUT = "\u001b[O";

/** What an ATTACH_OK gives the pane that asked: everything else it already wrote. */
export interface AttachAnswer {
	writeLockHolder: string | null;
	cached: boolean;
	truncated: boolean;
}

/**
 * The code an attach is rejected with when its answer no longer concerns the
 * pane: it asked for another terminal since, or no longer shows this one
 * (#929). Nothing was written for it, and nothing is to be shown.
 */
export const ATTACH_SUPERSEDED = "ATTACH_SUPERSEDED";

/** RIS: xterm resets the terminal when it parses it, after what it was sent before. */
const FULL_RESET = "\u001bc";

/** An attach the hub has not answered yet. */
interface PendingAttach {
	request: number;
	channelId: string;
	/** Reconnect and Restart keep the screen; the hub's answer does not replace it. */
	preserveContent: boolean;
	/** Keeping the screen, a live answer replaces it all the same (#1010). */
	replaceIfLive: boolean;
	/** Keep the screen if the hub answers that the terminal has ended. */
	keepScreenIfEnded: boolean;
	stillWanted: () => boolean;
	timer: ReturnType<typeof setTimeout>;
	resolve: (answer: AttachAnswer) => void;
	reject: (err: unknown) => void;
}

export function useTerminal(
	containerRef: Ref<HTMLElement | null>,
	wsClient: IWsClient,
	profile?: TerminalProfile,
	/**
	 * The theme the pane's host names in its own profile (SC-03), read again
	 * whenever it changes: the pane's host, or that host's profile (#997).
	 */
	hostThemeName?: MaybeRefOrGetter<string | undefined>,
) {
	/**
	 * The pane's xterm. Each one holds one terminal's output for its whole life:
	 * the pane makes a new one before it writes another terminal's (#966).
	 * Shallow, so that it yields the xterm itself, which work tied to one xterm
	 * compares against.
	 */
	const terminal = shallowRef<Terminal | null>(null);
	const fitAddon = new FitAddon();
	const search = useTerminalSearch();
	let channelId: string | null = null;
	/**
	 * The terminal whose output the screen holds: the one attached last, the
	 * one listened to over a screen that held none, or the ended one whose last
	 * output it shows (#927). A refusal with nothing to show keeps a screen that
	 * is already that terminal's. Null for an xterm given no terminal yet.
	 */
	let shownId: string | null = null;
	/**
	 * The pane has asked for a terminal other than the one its xterm holds, and
	 * that xterm is still the pane's: what it reports about a terminal (a bell, a
	 * title, a scroll) is about the one left, and goes nowhere (#966).
	 */
	let leftHeld = false;
	/**
	 * Whether the agent that takes the shown terminal's input writes paste
	 * markers and cursor keys in its program's form, as the hub said on the
	 * SPAWN_OK or ATTACH_OK that bound it (#1012). The pane then brackets its
	 * pastes itself; otherwise xterm pastes as it always did.
	 */
	let adaptsInput = false;
	/**
	 * Whether that agent takes a paste as PASTE chunks, as the same answer said
	 * (#1014). The pane then streams its pastes, of any size up to the bound.
	 */
	let streamsPaste = false;
	/** The profile applied last, which a new xterm is made with. */
	let currentProfile = profile;
	/** Stops following the host's theme, once the pane is closed. */
	let stopHostTheme: (() => void) | null = null;
	/** The terminal colours the theme subscription gave last: a new xterm takes them. */
	let lastTheme: Record<string, string> | null = null;
	/** What `TerminalPane` wants told of every xterm's bells and scrolls. */
	const bellListeners: Array<(heldId: string) => void> = [];
	const scrollListeners: Array<(term: Terminal) => void> = [];
	/**
	 * Set while the pane shows an ended terminal's last output: the size that
	 * output was drawn at, which the pane keeps whatever its write lock says,
	 * until a terminal attaches again (#927).
	 */
	let endedSize: { cols: number; rows: number } | null = null;
	/** Counts attach requests, so that the latest of the pending ones is known. */
	let attachRequests = 0;
	/**
	 * The attaches this pane sent and the hub has not answered: all for one
	 * terminal, since asking for another one supersedes them (#929).
	 */
	let pendingAttaches: PendingAttach[] = [];
	/** The terminal whose OUTPUT this pane writes, if any. */
	let listeningTo: string | null = null;
	/** The pane is closed: it asks for no terminal and waits for no answer (#929). */
	let disposed = false;
	/**
	 * Replays each xterm is parsing now (#927). xterm parses a write later than
	 * it takes it, or inside `write()` right after user input, and calls each
	 * write's callback once that write is parsed: markers written around a
	 * replay therefore bracket its parse, whichever way it goes. Counted per
	 * xterm: one the pane replaced may still parse its markers, or never (#966).
	 */
	const replaysParsing = new WeakMap<Terminal, number>();
	let resizeObserver: ResizeObserver | null = null;
	let onScrollbarChanged: (() => void) | null = null;
	/** Whether search matches are marked in the scrollbar gutter (profile). */
	let scrollbarMarkers = true;
	let outputUnsubscribe: (() => void) | null = null;
	let inputDroppedUnsubscribe: (() => void) | null = null;
	let themeUnsubscribe: (() => void) | null = null;

	/**
	 * When false, keyboard input is suppressed (read-only mode).
	 * Set to true once the caller confirms write-lock ownership.
	 * Defaults to true so single-client setups work without auth.
	 */
	const canWrite = ref(true);

	/** Send typed input as INPUT, while the pane may: socket up, write lock held. */
	function sendInput(data: string): void {
		sendInputBytes(new TextEncoder().encode(data));
	}

	function sendInputBytes(data: Uint8Array): void {
		if (channelId && wsClient.isConnected && canWrite.value) {
			wsClient.send({ type: "INPUT", channelId, data });
		}
	}

	/** This pane's paste on its way as PASTE chunks (#1014). */
	const pasteStream = new PasteStream({
		send: (msg) => wsClient.send(msg),
		connected: () => wsClient.isConnected,
		canSend: () => Boolean(channelId && wsClient.isConnected && canWrite.value),
		toast: {
			show: (level, text, durationMs, action) =>
				useToastStore().show(level, text, durationMs, action),
			update: (id, text) => useToastStore().update(id, text),
			dismiss: (id) => useToastStore().dismiss(id),
		},
		sendInput,
	});
	let pasteUnsubscribe: (() => void) | null = null;
	// The write lock lost: a paste being sent stops, what was held with it goes.
	watch(canWrite, (writable) => {
		if (!writable) pasteStream.interrupt();
	});

	/**
	 * A paste to an agent that streams pastes (#1014): the text without
	 * markers, line ends as xterm sends them, UTF-8, at most PASTE_MAX_BYTES,
	 * one paste at a time.
	 */
	function streamPaste(term: Terminal, clipboard: DataTransfer | null): void {
		if (clipboard === null) return;
		const toast = useToastStore();
		if (pasteInProgress(channelId) !== null) {
			toast.show("warning", "A paste is still being sent to this terminal.");
			return;
		}
		const text = clipboard.getData("text/plain");
		const unmarked = text.includes("\u001b") ? withoutPasteMarkers(text) : text;
		const normalised = unmarked.replace(/\r?\n/g, "\r");
		const bytes = new TextEncoder().encode(normalised);
		if (bytes.byteLength > PASTE_MAX_BYTES) {
			toast.show("warning", "This paste is too large to send (16 MiB at most).");
			return;
		}
		if (bytes.byteLength === 0 || channelId === null || !wsClient.isConnected || !canWrite.value) {
			return;
		}
		// As xterm's own paste: the selection clears and the view goes down to
		// where the text is typed.
		term.clearSelection();
		term.scrollToBottom();
		pasteStream.start(channelId, bytes);
	}

	/**
	 * The size the PTY has, as far as this pane knows: the last one it sent, or
	 * the one the hub said. A RESIZE for it again would only trigger a needless
	 * SIGWINCH and a prompt redraw.
	 */
	let lastSentCols = 0;
	let lastSentRows = 0;

	/** Debounce timer for RESIZE messages */
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Whether this pane decides its terminal's size (#831).
	 *
	 * A terminal has one size, its PTY's, and one client decides it: the one
	 * holding the write lock, which the pane is told with `setDecidesSize`. That
	 * pane fits the terminal to itself and sends the hub its size. Every other
	 * pane draws the terminal at the PTY's size, top-left, and sends none: it
	 * would only fight the one deciding. With nobody holding the lock, nobody
	 * decides, and the size stays put.
	 */
	let decidesSize = false;

	/** The PTY's size as the hub last said it: in ATTACH_OK, then in CHANNEL_SIZE. */
	let ptySize: { cols: number; rows: number } | null = null;

	let sizeUnsubscribe: (() => void) | null = null;

	/**
	 * Title stack — tracks recent non-empty titles from xterm.js onTitleChange
	 * (OSC 0/2). Prevents blank titles during process exit → shell restore
	 * transitions (SC-05). Max depth: MAX_TITLE_STACK.
	 */
	const titleStack: string[] = [];

	/**
	 * Reactive current dynamic title derived from the title stack.
	 * null when stack is empty (fallback handled by useTabTitle).
	 */
	const currentDynamicTitle = ref<string | null>(null);

	/** Size xterm's scrollbar and ruler from the appearance setting and the profile. */
	function applyScrollbarWidth(term: Terminal): void {
		const width = terminalScrollbarWidth(useThemeStore().appearance.scrollbar, scrollbarMarkers);
		term.options.overviewRuler = { ...term.options.overviewRuler, width };
	}

	/** A line of Lasterm's own in the terminal, dimmed, on a line of its own. */
	function writeNotice(text: string): void {
		const dim = "\u001b[2m";
		const plain = "\u001b[0m";
		terminal.value?.write(`\r\n${dim}── ${text} ──${plain}\r\n`);
	}

	function sendResize(cols: number, rows: number): void {
		if (!channelId || !wsClient.isConnected || !decidesSize) return;
		if (cols === lastSentCols && rows === lastSentRows) return;
		lastSentCols = cols;
		lastSentRows = rows;
		wsClient.send({ type: "RESIZE", channelId, cols, rows });
	}

	/**
	 * Whether the pane has a size of its own to give. One out of sight — a tab
	 * in the background, a zone folded away — measures 0×0, and a fit to that
	 * would hand the PTY two columns.
	 */
	function paneMeasurable(): boolean {
		const el = containerRef.value;
		return el !== null && el.clientWidth > 0 && el.clientHeight > 0;
	}

	/**
	 * Size the terminal: to the pane when it decides the size, or while it has
	 * not been told the PTY's; to the PTY's otherwise.
	 */
	function layout(): void {
		const term = terminal.value;
		if (!term) return;
		if (endedSize !== null) {
			drawAtPtySize(term, endedSize);
			return;
		}
		if (decidesSize || ptySize === null) {
			drawAtPaneSize(term);
			if (!paneMeasurable()) return;
			fitAddon.fit();
			// Even when the fit changes nothing: a pane coming back into sight
			// has the size it had, which the PTY may no longer have.
			scheduleSync();
		} else {
			drawAtPtySize(term, ptySize);
		}
	}

	/** Send the size shortly, once a run of resizes has settled. */
	function scheduleSync(): void {
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			resizeTimer = null;
			syncChannelSize();
		}, 50);
	}

	/** Class the pane's container carries while it draws at the PTY's size. */
	const FOLLOWS_CLASS = "terminal-container--follows";

	/**
	 * Draw the terminal at the PTY's size, top-left in its pane.
	 *
	 * Not scaled down to fit a smaller pane: xterm maps a click to a cell with
	 * the cell size it measured, against the rectangle the browser reports, so
	 * under a CSS transform selection and links land on the wrong cells. The
	 * pane scrolls instead, and its text stays the size the profile says.
	 */
	function drawAtPtySize(term: Terminal, size: { cols: number; rows: number }): void {
		containerRef.value?.classList.add(FOLLOWS_CLASS);
		if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows);
		// xterm's element spans its pane, and its scrollbar its right edge: as
		// wide as a fit to this size would have made the pane, it keeps the
		// scrollbar against the last column and leaves the rest to the ground.
		const cell = measuredCellWidth(term);
		if (term.element && cell > 0) {
			term.element.style.width = `${Math.ceil(size.cols * cell + fitScrollbarWidth(term))}px`;
		}
	}

	/** Draw the terminal across its pane, as the one deciding its size does. */
	function drawAtPaneSize(term: Terminal): void {
		containerRef.value?.classList.remove(FOLLOWS_CLASS);
		if (term.element) term.element.style.width = "";
	}

	/** The width the fit addon leaves for xterm's scrollbar, by its own rule. */
	function fitScrollbarWidth(term: Terminal): number {
		if (term.options.scrollback === 0) return 0;
		return term.options.overviewRuler?.width || DEFAULT_XTERM_SCROLLBAR_WIDTH;
	}

	/**
	 * The width of a cell as xterm measured it. xterm says it only through its
	 * core, which is where the fit addon reads it too; 0 when it has not
	 * measured one yet.
	 */
	function measuredCellWidth(term: Terminal): number {
		const core = (
			term as unknown as {
				_core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } };
			}
		)._core;
		return core?._renderService?.dimensions?.css?.cell?.width ?? 0;
	}

	/** The hub said the PTY's size: when attaching, and whenever it changes. */
	function takePtySize(cols: number, rows: number): void {
		ptySize = { cols, rows };
		// The pane deciding the size knows the one it asked for; what the hub
		// says is kept for the moment it stops deciding. Any other pane follows.
		if (decidesSize) return;
		lastSentCols = cols;
		lastSentRows = rows;
		layout();
	}

	/**
	 * Say whether this pane decides its terminal's size: it does while its
	 * client holds the write lock (#831). Taking the lock makes the pane's own
	 * fit the terminal's size, at once; losing it makes the pane draw the
	 * terminal at the size the hub says.
	 */
	function setDecidesSize(decides: boolean): void {
		if (decidesSize === decides) return;
		decidesSize = decides;
		if (decides && ptySize !== null) {
			// Compared with the PTY's real size, not with what this pane sent
			// before someone else decided.
			lastSentCols = ptySize.cols;
			lastSentRows = ptySize.rows;
		}
		layout();
		syncChannelSize();
	}

	/** Wait for the font this terminal will measure itself with. */
	function awaitFont(): Promise<void> {
		return awaitTerminalFont(
			document.fonts,
			profile?.fontFamily ?? DEFAULT_FONT_FAMILY,
			profile?.fontSize ?? DEFAULT_FONT_SIZE,
		);
	}

	/**
	 * The xterm options a profile sets, alike for an xterm made with it and one
	 * it is applied to later: an option set only at making stays as it was
	 * when the profile changes (#998).
	 */
	function profileOptions(p: TerminalProfile | undefined) {
		return {
			cursorBlink: p?.cursorStyle !== "underline", // blink except underline (xterm default)
			fontSize: p?.fontSize ?? DEFAULT_FONT_SIZE,
			fontFamily: p?.fontFamily ?? DEFAULT_FONT_FAMILY,
			cursorStyle: p?.cursorStyle ?? "block",
			scrollback: p?.scrollback ?? 5000,
		};
	}

	/** The theme the pane's host names, when the themes include it (SC-03). */
	function hostTheme(): ReturnType<typeof useThemeStore>["availableThemes"][number] | undefined {
		const name = toValue(hostThemeName);
		return name ? useThemeStore().availableThemes.find((t) => t.name === name) : undefined;
	}

	/**
	 * The terminal colours to draw with: the host's own theme if it has one,
	 * else those the theme subscription gave last, else the active theme's.
	 */
	function themeInForce(): Record<string, string> {
		const themeStore = useThemeStore();
		const own = hostTheme();
		if (own) return themeStore.toXtermTheme(own.colors);
		if (lastTheme !== null) return lastTheme;
		const colors = themeStore.activeTheme?.colors;
		return colors ? themeStore.toXtermTheme(colors) : {};
	}

	/**
	 * Make an xterm in the pane and make it the pane's: the first one at mount,
	 * and each one that replaces it (#966). Every one is set up alike, from the
	 * profile applied last and the theme in force. One that replaces another
	 * starts at the old one's size and is sized by `layout()` after, since a
	 * pane out of sight has none of its own to fit to.
	 */
	function makeXterm(container: HTMLElement, size?: { cols: number; rows: number }): Terminal {
		const p = currentProfile;
		const themeStore = useThemeStore();

		scrollbarMarkers = p?.scrollbarMarkers !== false; // default true
		const term = new Terminal({
			allowProposedApi: true,
			allowTransparency: true,
			...profileOptions(p),
			overviewRuler: {
				width: terminalScrollbarWidth(themeStore.appearance.scrollbar, scrollbarMarkers),
			},
			theme: themeInForce(),
			...size,
		});

		term.loadAddon(fitAddon);
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(container);
		// Before the first fit, since what it counts is what the PTY is spawned with.
		syncMeasuredFont(term);
		if (size === undefined) {
			fitAddon.fit();
			search.init(term, { scrollbarMarkers });
		} else {
			search.rebind(term, { scrollbarMarkers });
		}
		terminal.value = term;
		// A font arriving late changes the cell, and with it the count: fit again
		// so the terminal and its PTY agree even when the wait above was skipped.
		void refitWhenFontSettles(
			term,
			p?.fontFamily ?? DEFAULT_FONT_FAMILY,
			p?.fontSize ?? DEFAULT_FONT_SIZE,
		);

		// xterm answers a `?1004h` with a focus report at once, inside the call
		// to its own handler (#1012). A replay's `?1004h` (the snapshot's input
		// modes) arms this, and the report it makes is not sent: it is not news.
		// A focus change the user makes, even while a long replay is parsed, and a
		// program's own live `?1004h`, are sent as before.
		// One report per `1004` in the sequence: xterm reports for each.
		let replayFocusReports = 0;
		term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
			if ((replaysParsing.get(term) ?? 0) > 0) {
				replayFocusReports = params.filter((param) => param === 1004).length;
			}
			return false;
		});

		// The agent decides how a paste reaches its program (#1012): while it
		// says so, the pane brackets every paste itself, one frame, its own
		// markers taken out, and xterm pastes nothing of its own. An agent that
		// streams pastes (#1014) gets them as PASTE chunks instead, unbracketed:
		// it writes the markers itself.
		term.element?.addEventListener(
			"paste",
			(event) => {
				if (streamsPaste) {
					event.stopPropagation();
					event.preventDefault();
					streamPaste(term, event.clipboardData);
					return;
				}
				if (!adaptsInput) return;
				event.stopPropagation();
				event.preventDefault();
				// No clipboard data: nothing to paste, as xterm sends nothing then.
				if (event.clipboardData === null) return;
				const text = event.clipboardData.getData("text/plain");
				// Each UTF-16 unit left is at least one UTF-8 byte. A marker taken out
				// is six units holding one ESC, and may join a CR to an LF, which then
				// make one: a text too long even so is refused before any of it is copied.
				let escapes = 0;
				let crlfs = 0;
				for (let at = 0; at < text.length; at++) {
					const unit = text.charCodeAt(at);
					if (unit === 0x1b) escapes++;
					else if (unit === 0x0a && at > 0 && text.charCodeAt(at - 1) === 0x0d) crlfs++;
				}
				const tooLarge = () =>
					useToastStore().show("warning", "This paste is too large to send (64 KiB at most).");
				if (
					text.length - 7 * escapes - crlfs + PASTE_START.length + PASTE_END.length >
					MAX_INPUT_SIZE
				) {
					tooLarge();
					return;
				}
				const stripped = escapes > 0 ? withoutPasteMarkers(text) : text;
				const form = `${PASTE_START}${stripped.replace(/\r?\n/g, "\r")}${PASTE_END}`;
				if (new TextEncoder().encode(form).byteLength > MAX_INPUT_SIZE) {
					tooLarge();
					return;
				}
				// xterm's own user-input path: the view goes to the bottom and the
				// selection clears, as for a paste xterm makes, and the gate below
				// sends it.
				term.input(form, true);
			},
			{ capture: true },
		);

		// Keyboard input → send INPUT to hub (only when holding write lock)
		term.onData((data: string) => {
			if (replayFocusReports > 0) {
				if (data === FOCUS_IN || data === FOCUS_OUT) {
					replayFocusReports--;
					return;
				}
				replayFocusReports = 0;
			}
			// Behind a paste still being sent to this terminal, from this pane or
			// another showing it, or its Ctrl+C (#1014).
			if (pasteInProgress(channelId)?.takeInput(data)) return;
			sendInput(data);
		});

		// Mouse reports in xterm's default encoding (no SGR) come as binary: each
		// character is one byte, 0-255, which TextEncoder would turn into two
		// above 127 (#1016).
		term.onBinary((data: string) => {
			const bytes = new Uint8Array(data.length);
			for (let at = 0; at < data.length; at++) bytes[at] = data.charCodeAt(at) & 0xff;
			sendInputBytes(bytes);
		});

		// Terminal resize → send RESIZE to hub (debounced to coalesce rapid
		// resizes), when this pane decides the size and still has one of its own.
		term.onResize(scheduleSync);

		// Terminal title change (OSC 0/2) → push to title stack, unless the pane
		// has left the terminal this xterm holds (#966).
		term.onTitleChange((raw: string) => {
			if (leftHeld) return;
			const clean = sanitizeTitle(raw); // defense-in-depth
			if (clean === "") {
				// INV-09: empty title — don't push, show top of stack instead
				return;
			}
			titleStack.push(clean);
			if (titleStack.length > MAX_TITLE_STACK) {
				titleStack.shift();
			}
			currentDynamicTitle.value = clean;
		});

		// A bell or a scroll is about the terminal this xterm holds, and only
		// while the pane has not left it (#966).
		term.onBell(() => {
			const held = shownId;
			if (leftHeld || held === null) return;
			for (const listener of [...bellListeners]) listener(held);
		});
		term.onScroll(() => {
			if (leftHeld) return;
			for (const listener of [...scrollListeners]) listener(term);
		});
		return term;
	}

	/**
	 * Give the pane a new xterm before it writes another terminal's output, and
	 * dispose the one holding the terminal it left (#966). What that one still
	 * parses (an answer to a query, a title, a mode, a bell, a scroll) then
	 * reaches nothing: a disposed xterm emits nothing. The keyboard follows when
	 * the old one had it.
	 */
	function replaceXterm(): void {
		const old = terminal.value;
		const container = containerRef.value;
		if (old === null || container === null) return;
		const hadKeyboard = old.element?.contains(document.activeElement) === true;
		const term = makeXterm(container, { cols: old.cols, rows: old.rows });
		if (hadKeyboard) term.focus();
		old.dispose();
		shownId = null;
		leftHeld = false;
		layout();
	}

	/**
	 * The pane asks for a terminal other than the one its xterm holds: that
	 * xterm's title, bells and scrolls are the left terminal's from now on, and
	 * its titles leave the tab (#966).
	 */
	function leaveHeld(): void {
		leftHeld = true;
		// A paste still going to the terminal left stops there (#1014).
		pasteStream.interrupt();
		adaptsInput = false;
		streamsPaste = false;
		titleStack.length = 0;
		currentDynamicTitle.value = null;
	}

	function init(): { cols: number; rows: number } {
		if (!containerRef.value) {
			console.error("[useTerminal] containerRef is null — cannot init");
			return { cols: 80, rows: 24 };
		}

		const themeStore = useThemeStore();
		const term = makeXterm(containerRef.value);

		// The PTY's size changed: the pane draws at it unless it decides it (#831).
		sizeUnsubscribe?.();
		sizeUnsubscribe = wsClient.on("CHANNEL_SIZE", (msg) => {
			if (msg.type === "CHANNEL_SIZE" && msg.channelId === channelId) {
				takePtySize(msg.cols, msg.rows);
			}
		});

		// A paste's answers, for the paste this pane is sending (#1014).
		pasteUnsubscribe?.();
		const offAck = wsClient.on("PASTE_ACK", (msg) => {
			if (msg.type === "PASTE_ACK") pasteStream.onAck(msg);
		});
		const offClosed = wsClient.on("PASTE_CLOSED", (msg) => {
			if (msg.type === "PASTE_CLOSED") pasteStream.onClosed(msg);
		});
		const offDown = wsClient.onDisconnect(() => pasteStream.interrupt());
		pasteUnsubscribe = () => {
			offAck();
			offClosed();
			offDown();
		};

		// What was typed went nowhere: the terminal takes no input, and its agent
		// drops what it cannot queue. Said here, once per gap as the agent says
		// it, rather than left to look like keys that did nothing (#767).
		inputDroppedUnsubscribe?.();
		inputDroppedUnsubscribe = wsClient.on("INPUT_DROPPED", (msg) => {
			if (msg.type === "INPUT_DROPPED" && msg.channelId === channelId) {
				writeNotice("what you typed was dropped: this terminal is not taking input");
			}
		});

		// Container resize → refit terminal
		resizeObserver = new ResizeObserver(() => {
			layout();
		});
		resizeObserver.observe(containerRef.value);
		// The xterm the pane has when the setting changes, not the one made first (#966).
		onScrollbarChanged = (): void => {
			const current = terminal.value;
			if (current) applyScrollbarWidth(current);
			layout();
		};
		window.addEventListener("nt:scrollbar-changed", onScrollbarChanged);

		// Subscribe to global theme changes so all terminals update live.
		// Per-host override (SC-03): if a host-specific theme is set, keep it.
		themeUnsubscribe = themeStore.onTerminalThemeChange((xtermTheme) => {
			lastTheme = xtermTheme;
			if (terminal.value) terminal.value.options.theme = themeInForce();
		});
		// The host's own theme follows the pane's host, that host's profile, and
		// the themes fetched from the hub, which may come after the pane (#997).
		stopHostTheme = watch(hostTheme, () => {
			if (terminal.value) terminal.value.options.theme = themeInForce();
		});

		return { cols: term.cols, rows: term.rows };
	}

	/**
	 * Write `id`'s OUTPUT to the terminal as it comes, once: asking again for
	 * the terminal already listened to keeps the same listener.
	 */
	function listenTo(id: string): void {
		// Listening writes: an xterm that held none holds this terminal now (#966).
		if (shownId === null) shownId = id;
		if (listeningTo === id && outputUnsubscribe !== null) return;
		outputUnsubscribe?.();
		listeningTo = id;
		outputUnsubscribe = wsClient.on("OUTPUT", (msg) => {
			if (msg.type === "OUTPUT" && msg.channelId === listeningTo && terminal.value) {
				// msg.data arrives as Uint8Array from MessagePack decode
				const data =
					msg.data instanceof Uint8Array ? msg.data : new TextEncoder().encode(String(msg.data));
				terminal.value.write(data);
			}
		});
	}

	function stopListening(): void {
		outputUnsubscribe?.();
		outputUnsubscribe = null;
		listeningTo = null;
	}

	/**
	 * Subscribe to OUTPUT messages for the given channel and write to terminal.
	 * Call after init() and after a successful SPAWN.
	 */
	function attachChannel(
		id: string,
		opts?: { adaptsInput?: boolean; streamsPaste?: boolean },
	): void {
		// A spawn that completes after the pane closed: nothing to bind, and
		// nothing may listen for a pane that is gone (#971).
		if (disposed) return;
		channelId = id;
		shownId = id;
		// As the SPAWN_OK that made it said (#1012, #1014).
		adaptsInput = opts?.adaptsInput === true;
		streamsPaste = opts?.streamsPaste === true;
		leaveEndedSize();
		listenTo(id);

		// Send initial RESIZE so the PTY matches our dimensions from the start
		syncChannelSize();
	}

	/** Listens for the hub's answers while an attach waits for one. */
	let answersUnsubscribe: (() => void) | null = null;

	function listenForAnswers(): void {
		if (answersUnsubscribe !== null) return;
		const offOk = wsClient.on("ATTACH_OK", (msg) => {
			if (msg.type === "ATTACH_OK") takeAttachOk(msg as UiAttachOkMessage);
		});
		const offErr = wsClient.on("ERROR", (msg) => {
			if (
				msg.type === "ERROR" &&
				(msg.code === "CHANNEL_NOT_FOUND" || msg.code === "CHANNEL_DEAD")
			) {
				takeRefusal(msg);
			}
		});
		answersUnsubscribe = () => {
			offOk();
			offErr();
		};
	}

	/** Settle `entries`, each by `outcome`, and stop waiting for answers once none is left. */
	function settle(entries: PendingAttach[], outcome: (entry: PendingAttach) => void): void {
		const settling = new Set(entries);
		pendingAttaches = pendingAttaches.filter((entry) => !settling.has(entry));
		if (pendingAttaches.length === 0) {
			answersUnsubscribe?.();
			answersUnsubscribe = null;
		}
		for (const entry of entries) {
			clearTimeout(entry.timer);
			outcome(entry);
		}
	}

	/** Settle `entries` as no longer the pane's concern: nothing written, nothing to show. */
	function supersede(entries: PendingAttach[]): void {
		settle(entries, (entry) =>
			entry.reject(
				Object.assign(new Error("Superseded by a later attach"), { code: ATTACH_SUPERSEDED }),
			),
		);
	}

	/**
	 * The attaches an answer naming `id` settles: all of them, the latest
	 * last. An answer naming no terminal is for the one they wait on.
	 */
	function answeredBy(id: string | undefined): PendingAttach[] {
		const first = pendingAttaches[0];
		if (first === undefined) return [];
		if (id !== undefined && id !== first.channelId) return [];
		return [...pendingAttaches];
	}

	/**
	 * Whether the pane still shows the terminal `waiting` asked for. When it
	 * does not, they are superseded, and they stop the listening they started.
	 */
	function stillWanted(waiting: PendingAttach[]): boolean {
		const latest = waiting[waiting.length - 1];
		if (latest === undefined || latest.stillWanted()) return true;
		if (listeningTo === latest.channelId) stopListening();
		supersede(waiting);
		return false;
	}

	/**
	 * The terminal attached. Its answer is written once for every attach that
	 * waited on it, by the one that keeps least: the screen is replaced unless
	 * every one of them keeps it (#929, #930), and one that keeps a copy from
	 * the hub's memory does not keep it from a live answer (#1010).
	 */
	function takeAttachOk(msg: UiAttachOkMessage): void {
		const waiting = answeredBy(msg.channelId);
		if (waiting.length === 0 || !stillWanted(waiting)) return;
		const id = msg.channelId;

		// The xterm holds another terminal's output: this one gets a new one,
		// before anything of it is written or sized, whatever the answer carries
		// (#966).
		if (shownId !== null && shownId !== id) replaceXterm();
		// A terminal attached: the size rules of #831 apply again.
		shownId = id;
		leaveEndedSize();
		// What the hub says of the agent that takes this terminal's input now
		// (#1012, #1014); absent from an older hub.
		adaptsInput = msg.adaptsInput === true;
		streamsPaste = msg.streamsPaste === true;

		// The PTY's size. A pane that does not decide it draws the screen below
		// at that size, the one it was drawn for (#831). One that decides it
		// compares its own with it, whatever it sent before: a restart spawned
		// the PTY anew, or another client decided meanwhile.
		if (typeof msg.cols === "number" && typeof msg.rows === "number") {
			lastSentCols = msg.cols;
			lastSentRows = msg.rows;
			takePtySize(msg.cols, msg.rows);
		}

		// Restore the snapshot and its tail before binding the terminal: no
		// RESIZE goes out while they are written. A replay: a bell in it
		// already rang (#927).
		const replaceScreen = waiting.some(
			(entry) => !entry.preserveContent || (entry.replaceIfLive && msg.cached !== true),
		);
		const tail = msg.tail ?? [];
		// Listening while it waited (a re-attach that kept the screen, replaced
		// because the answer is live, #1010), the xterm may not have parsed all
		// it was sent yet, which the snapshot holds: a reset written after it
		// clears it, where `reset()` would clear first and let it be parsed over
		// the snapshot. The snapshot then sets the program's modes again (#1012).
		const queuedOutput = listeningTo === id;
		replay(() => {
			const term = terminal.value;
			if (!term || !replaceScreen) return;
			if (msg.snapshot) {
				if (queuedOutput) term.write(FULL_RESET);
				else term.reset();
				// The program's screen and input modes (#1012): the alternate screen
				// before the screen is drawn into it, the modes after, and the tail
				// after them, so that a mode the tail sets wins. An older agent
				// sends neither.
				if (msg.snapshot.alternateScreen === true) term.write("\u001b[?1049h");
				const serialized = (msg.snapshot as { serialized?: string }).serialized;
				if (serialized) term.write(serialized);
				if (msg.snapshot.inputModes) term.write(msg.snapshot.inputModes);
			}
			for (const chunk of tail) {
				term.write(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer));
			}
		});

		// Restore dynamic title from ATTACH_OK (SC-02 — titles survive reconnects)
		if (msg.dynamicTitle) {
			titleStack.length = 0;
			titleStack.push(msg.dynamicTitle);
			currentDynamicTitle.value = msg.dynamicTitle;
		}

		if (msg.displayTitle) {
			useChannelsStore().setDisplayTitle(id, msg.displayTitle);
		}

		// Set channelId — same ID always (a restart reuses the same channel ID)
		channelId = id;
		// Live OUTPUT, once: an attach that kept the screen already listens, and
		// a pane asked for its terminal again by a click and by the hub's news
		// at once wrote every chunk twice when each subscribed.
		listenTo(id);

		// Send ONE RESIZE with actual terminal dimensions so the PTY matches,
		// when this pane decides it. Dedup'd so ResizeObserver won't cause
		// duplicates.
		syncChannelSize();

		const truncated = msg.truncated === true;
		if (truncated) {
			// A terminal cannot be handed a piece of a stream, so it was not: the
			// screen above is the last coherent one, and what followed is gone.
			// Saying so beats a pane that looks current and is not.
			writeNotice("output between this screen and now was dropped");
		}
		const answer: AttachAnswer = {
			writeLockHolder: msg.writeLockHolder ?? null,
			cached: msg.cached === true,
			truncated,
		};
		settle(waiting, (entry) => entry.resolve(answer));
	}

	/**
	 * The hub refused the attach: the terminal has ended, or it has no record
	 * of it. The listening ends, and an ended terminal's last output replaces
	 * the screen unless every attach that waited on it keeps the screen.
	 */
	function takeRefusal(msg: {
		code: string;
		message?: string;
		channelId?: string;
		lastOutput?: EndedOutput;
	}): void {
		const waiting = answeredBy(msg.channelId);
		const first = waiting[0];
		if (first === undefined || !stillWanted(waiting)) return;
		stopListening();
		// The code travels with it: what a pane does about this is not a
		// decision to make by reading a sentence, which changes.
		const refusal = Object.assign(new Error(msg.message ?? msg.code), { code: msg.code });
		try {
			// An answer about another terminal than the one the xterm holds: a new
			// xterm, so that nothing of the one left stays under this one's card
			// (#966). Asked over that other terminal's screen, none of the attaches
			// waiting keeps the screen (`reattachChannel`).
			if (shownId !== null && shownId !== first.channelId) replaceXterm();
			if (msg.code === "CHANNEL_DEAD") {
				const keepScreen = waiting.every(
					(entry) => entry.preserveContent || entry.keepScreenIfEnded,
				);
				showEnded(first.channelId, msg.lastOutput, keepScreen);
			}
		} finally {
			// Settled whatever the writes did: the timers are gone.
			settle(waiting, (entry) => entry.reject(refusal));
		}
	}

	/**
	 * No answer came for `entry`. A newer attach for the same terminal still
	 * waits: this one settles with it. Otherwise every attach waiting fails.
	 */
	function onDeadline(entry: PendingAttach): void {
		if (pendingAttaches.some((other) => other.request > entry.request)) return;
		fail(new Error("ATTACH timeout — no response after 10s"));
	}

	/** Every attach waiting fails with `err`, as superseded if the pane left their terminal. */
	function fail(err: Error): void {
		const waiting = [...pendingAttaches];
		const latest = waiting[waiting.length - 1];
		if (latest === undefined || !stillWanted(waiting)) return;
		if (listeningTo === latest.channelId) stopListening();
		settle(waiting, (entry) => entry.reject(err));
	}

	/**
	 * Re-attach to an existing channel: send ATTACH, wait for ATTACH_OK,
	 * restore snapshot + replay tail, then subscribe to live OUTPUT.
	 *
	 * A terminal that has ended is refused with CHANNEL_DEAD, and one the hub
	 * has no record of with CHANNEL_NOT_FOUND: an ATTACH never starts one
	 * again (#559). Restart brings it back under the same channel ID.
	 *
	 * Asking for a terminal settles every attach still waiting for another one
	 * at once, rejected with `ATTACH_SUPERSEDED`, as is one whose answer comes
	 * when the pane no longer shows its terminal: neither writes anything
	 * (#929). Attaches for the same terminal share its answer.
	 */
	async function reattachChannel(
		id: string,
		opts?: {
			/** Keep the screen and write what the terminal prints meanwhile (Reconnect, Restart). */
			preserveContent?: boolean;
			/**
			 * Keeping the screen, replace it if the hub answers live: it is a copy
			 * from the hub's memory, older than the agent's snapshot, which holds
			 * everything the terminal printed before it (#1010, #931).
			 */
			replaceIfLive?: boolean;
			/**
			 * Keep the screen if the hub answers that the terminal has ended; an
			 * ATTACH_OK replaces it as usual. For a pane over an ending it watched.
			 */
			keepScreenIfEnded?: boolean;
			/** Whether the pane still shows `id` when the answer comes; true when absent. */
			stillWanted?: () => boolean;
		},
	): Promise<AttachAnswer> {
		if (disposed) {
			return Promise.reject(
				Object.assign(new Error("The pane is closed"), { code: ATTACH_SUPERSEDED }),
			);
		}
		const request = ++attachRequests;
		supersede(pendingAttaches.filter((entry) => entry.channelId !== id));
		// Asking for another terminal: what is typed, what xterm answers by
		// itself and resizes go nowhere until an answer binds this one, rather
		// than to the terminal the pane left (#929).
		if (channelId !== null && channelId !== id) channelId = null;
		// The xterm holds another terminal: what it still reports is that one's,
		// and there is no screen of this one's to keep, so the attach replaces it
		// (#966). Asking again for the terminal it holds takes its reports again.
		const elsewhere = shownId !== null && shownId !== id;
		if (elsewhere) leaveHeld();
		else if (shownId === id) leftHeld = false;
		const preserveContent = opts?.preserveContent === true && !elsewhere;
		// Keeping the screen, the pane writes what the terminal prints while it
		// waits: the snapshot that holds it is not written (#930). Any other
		// attach writes the snapshot, which holds it; while one waits for this
		// terminal, the answer they share replaces the screen anyway, and
		// output written just before that could be parsed after it.
		const replacing = pendingAttaches.some(
			(entry) => entry.channelId === id && !entry.preserveContent,
		);
		if (!preserveContent) stopListening();
		else if (!replacing) listenTo(id);

		// Don't set channelId yet — prevents spurious RESIZE messages from
		// being sent to the hub during terminal.reset() / terminal.write()
		// which would cause the shell to redraw the prompt multiple times.
		return new Promise<AttachAnswer>((resolve, reject) => {
			const entry: PendingAttach = {
				request,
				channelId: id,
				preserveContent,
				replaceIfLive: opts?.replaceIfLive === true,
				keepScreenIfEnded: opts?.keepScreenIfEnded === true && !elsewhere,
				stillWanted: opts?.stillWanted ?? (() => true),
				timer: setTimeout(() => onDeadline(entry), 10_000),
				resolve,
				reject,
			};
			pendingAttaches.push(entry);
			listenForAnswers();
			try {
				wsClient.send({ type: "ATTACH", channelId: id });
			} catch (err) {
				// Never sent: nothing will answer it (#942).
				fail(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * Show what an ended terminal last printed, as its CHANNEL_DEAD carried it
	 * (#927), and stop speaking to it.
	 *
	 * The pane is then bound to no terminal: typing and resizing send nothing.
	 * The output is drawn at the size it was drawn for, whatever the write lock
	 * says, until a terminal attaches again. It replaces the screen when it
	 * has something to draw, as an ATTACH_OK's snapshot does: output printed
	 * while the pane's socket was away is in it. With nothing to draw, a screen
	 * that is already this terminal's stays, and another's is cleared. When the
	 * screen is kept (Reconnect, Restart, a re-attach over an ending the pane
	 * watched), nothing is cleared and no output is written. An older hub sends
	 * no last output, and none is written either. Whatever it shows, the pane
	 * then turns mouse reporting off: that changes nothing on screen.
	 */
	function showEnded(id: string, last: EndedOutput | undefined, keepScreen: boolean): void {
		channelId = null;
		const term = terminal.value;
		if (last !== undefined) {
			endedSize = { cols: last.cols, rows: last.rows };
			layout();
			if (term && !keepScreen) showLastOutput(term, id, last);
		}
		term?.write(MOUSE_REPORTING_OFF);
	}

	/** Write what an ended terminal last printed, as `showEnded` decides. */
	function showLastOutput(term: Terminal, id: string, last: EndedOutput): void {
		const somethingToDraw = last.snapshot !== null || last.tail.some((part) => part.byteLength > 0);
		if (somethingToDraw) {
			term.reset();
			replay(() => {
				if (last.snapshot?.serialized) term.write(last.snapshot.serialized);
				for (const part of last.tail) term.write(part);
			});
			if (last.truncated === true) {
				writeNotice("output between this screen and now was dropped");
			}
			shownId = id;
		} else if (shownId !== id) {
			term.reset();
			if (last.truncated === true) writeNotice("its last output was too long to show");
			shownId = id;
		}
	}

	/**
	 * Write a replay: what the hub kept, not what the terminal prints now. A
	 * bell in it rang when it was printed, so it rings no bell here (#927).
	 */
	function replay(write: () => void): void {
		const term = terminal.value;
		if (!term) {
			write();
			return;
		}
		term.write("", () => {
			replaysParsing.set(term, (replaysParsing.get(term) ?? 0) + 1);
		});
		write();
		term.write("", () => {
			replaysParsing.set(term, (replaysParsing.get(term) ?? 0) - 1);
		});
	}

	/** Whether the pane's xterm is parsing a replay now: a bell it reports is not news. */
	function bellMuted(): boolean {
		const term = terminal.value;
		return term !== null && (replaysParsing.get(term) ?? 0) > 0;
	}

	/** Turn mouse reporting off in this pane's xterm, as over an ended terminal (#927). */
	function turnMouseReportingOff(): void {
		terminal.value?.write(MOUSE_REPORTING_OFF);
	}

	/** Leave the size an ended terminal's output was drawn at, once a terminal attaches. */
	function leaveEndedSize(): void {
		if (endedSize === null) return;
		endedSize = null;
		layout();
	}

	/**
	 * Pre-set the RESIZE dedup state to the size the PTY was spawned at, so
	 * attachChannel's resize is a no-op and no SIGWINCH redraws the prompt.
	 *
	 * Those are the dimensions the caller asked the hub for, not the ones the
	 * terminal has now: a font that arrived while the channel was being created
	 * refits it, and a fit with no channel yet has nobody to tell. Recording
	 * the new size as though it had been sent left the PTY a width the window
	 * never had — the prompt then wrapped, a line early.
	 */
	function suppressNextResize(spawnedCols?: number, spawnedRows?: number): void {
		const term = terminal.value;
		if (!term) return;
		lastSentCols = spawnedCols ?? term.cols;
		lastSentRows = spawnedRows ?? term.rows;
		// The size the PTY has: the pane holds it until the hub says it decides,
		// then sends its fit if that differs (#831).
		ptySize = { cols: lastSentCols, rows: lastSentRows };
	}

	/**
	 * Whether what is typed here goes to `id` now: the terminal this pane
	 * spawned or the last one an answer bound it to, and not one it has since
	 * asked to leave (#929, #965).
	 */
	function isBoundTo(id: string): boolean {
		return channelId === id;
	}

	/**
	 * Tell the channel the size the terminal actually has, if it differs: only
	 * when this pane decides the size, and has one of its own (#831).
	 */
	function syncChannelSize(): void {
		const term = terminal.value;
		if (term && decidesSize && paneMeasurable()) sendResize(term.cols, term.rows);
	}

	/** Re-apply profile options (font, cursor, scrollback, scrollbar markers) to the live terminal. */
	function applyProfile(p: TerminalProfile): void {
		currentProfile = p;
		const term = terminal.value;
		if (!term) return;
		Object.assign(term.options, profileOptions(p));
		scrollbarMarkers = p.scrollbarMarkers !== false;
		applyScrollbarWidth(term);
		search.setScrollbarMarkers(scrollbarMarkers);
		// Bell audio handled by playBellSound() via onBell handler — not xterm.js
		// bellStyle is not in the shipped @xterm/xterm type definition; cast to suppress
		(term.options as Record<string, unknown>).bellStyle = "none";
		layout();
		// xterm measures a cell from the font in use, and a family just set — or
		// still loading — is measured only once the browser has drawn with it. A
		// fit in this tick keeps the old cell, which is how a PTY ended up 231
		// columns wide in a window that holds 206.
		void refitWhenFontSettles(
			term,
			p.fontFamily ?? DEFAULT_FONT_FAMILY,
			p.fontSize ?? DEFAULT_FONT_SIZE,
		);
	}

	/** Fit again once the font is loaded and the terminal has drawn with it. */
	async function refitWhenFontSettles(
		term: Terminal,
		fontFamily: string,
		fontSize: number,
	): Promise<void> {
		await awaitTerminalFont(document.fonts, fontFamily, fontSize);
		if (terminal.value !== term) return;
		syncMeasuredFont(term);
		// The cell is measured while the terminal draws, so the fit that reads it
		// has to come after that frame, not in the tick that asked for it.
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		});
		if (terminal.value !== term) return;
		layout();
	}

	/**
	 * Tell xterm the font the page is actually rendering.
	 *
	 * The terminal's rows inherit their family from the pane's CSS, so a font
	 * arriving late changes what is drawn without xterm noticing: it keeps the
	 * cell it measured first — a fallback — and a window holding 206 columns was
	 * fitted to 231, the width the PTY was then spawned and kept at.
	 */
	function syncMeasuredFont(term: Terminal): void {
		const rows = containerRef.value?.querySelector(".xterm-rows");
		if (!rows) return;
		const rendered = getComputedStyle(rows).fontFamily;
		if (!rendered) return;
		// Assigning is what makes xterm measure a cell again, and it only reacts
		// to a change. The first measure — taken before the web font arrived —
		// would otherwise stand for the life of the terminal, so when the family
		// already reads as the rendered one, go through another to come back.
		if (term.options.fontFamily === rendered) term.options.fontFamily = "monospace";
		term.options.fontFamily = rendered;
	}

	function dispose(): void {
		// A closed pane waits for no answer: none may subscribe it again (#929).
		disposed = true;
		supersede([...pendingAttaches]);
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = null;
		themeUnsubscribe?.();
		themeUnsubscribe = null;
		stopHostTheme?.();
		stopHostTheme = null;
		stopListening();
		inputDroppedUnsubscribe?.();
		inputDroppedUnsubscribe = null;
		pasteStream.interrupt();
		pasteUnsubscribe?.();
		pasteUnsubscribe = null;
		sizeUnsubscribe?.();
		sizeUnsubscribe = null;
		ptySize = null;
		if (onScrollbarChanged) {
			window.removeEventListener("nt:scrollbar-changed", onScrollbarChanged);
			onScrollbarChanged = null;
		}
		resizeObserver?.disconnect();
		resizeObserver = null;
		search.dispose();
		terminal.value?.dispose();
		terminal.value = null;
		channelId = null;
		shownId = null;
		leftHeld = false;
		endedSize = null;
		bellListeners.length = 0;
		scrollListeners.length = 0;
		titleStack.length = 0;
		currentDynamicTitle.value = null;
	}

	/**
	 * Tell `listener` of a bell in the pane's xterm, whichever it is then, with
	 * the terminal that xterm holds (#966). Not for a replay's bells: see
	 * `bellMuted`.
	 */
	function onBell(listener: (heldId: string) => void): void {
		bellListeners.push(listener);
	}

	/** Tell `listener` each time the pane's xterm, whichever it is then, scrolls (#966). */
	function onScroll(listener: (term: Terminal) => void): void {
		scrollListeners.push(listener);
	}

	return {
		terminal,
		awaitFont,
		canWrite,
		currentDynamicTitle,
		search,
		init,
		attachChannel,
		reattachChannel,
		isBoundTo,
		turnMouseReportingOff,
		bellMuted,
		onBell,
		onScroll,
		applyProfile,
		suppressNextResize,
		syncChannelSize,
		setDecidesSize,
		dispose,
		fitAddon,
	};
}
