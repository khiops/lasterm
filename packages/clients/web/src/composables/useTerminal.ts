import type { EndedOutput, TerminalProfile, UiAttachOkMessage } from "@lasterm/shared";
import { sanitizeTitle } from "@lasterm/shared";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { type Ref, ref } from "vue";
import type { IWsClient } from "../services/ws-client.js";
import { useChannelsStore } from "../stores/channels.js";
import { useThemeStore } from "../stores/theme.js";
import { terminalScrollbarWidth } from "../utils/terminal-scrollbar.js";
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

export function useTerminal(
	containerRef: Ref<HTMLElement | null>,
	wsClient: IWsClient,
	profile?: TerminalProfile,
	/** Explicit per-host theme name from host.profileJson (SC-03 override). */
	hostThemeName?: string,
) {
	const terminal = ref<Terminal | null>(null);
	const fitAddon = new FitAddon();
	const search = useTerminalSearch();
	let channelId: string | null = null;
	/**
	 * The terminal whose output the screen holds: the one attached last, or
	 * the ended one whose last output it shows (#927). A refusal with nothing
	 * to show keeps a screen that is already that terminal's.
	 */
	let shownId: string | null = null;
	/**
	 * Set while the pane shows an ended terminal's last output: the size that
	 * output was drawn at, which the pane keeps whatever its write lock says,
	 * until a terminal attaches again (#927).
	 */
	let endedSize: { cols: number; rows: number } | null = null;
	/** Counts attach requests: only the latest may write what a refusal carries. */
	let attachRequests = 0;
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
	let titleChangeDispose: (() => void) | null = null;

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

	function init(): { cols: number; rows: number } {
		if (!containerRef.value) {
			console.error("[useTerminal] containerRef is null — cannot init");
			return { cols: 80, rows: 24 };
		}

		const p = profile;
		const themeStore = useThemeStore();

		// Per-host theme override (SC-03): use hostThemeName from host.profileJson
		// if explicitly set. Otherwise use the runtime active theme.
		const hostTheme = hostThemeName
			? themeStore.availableThemes.find((t) => t.name === hostThemeName)
			: undefined;
		const initialColors = (hostTheme ?? themeStore.activeTheme)?.colors;
		const initialXtermTheme = initialColors ? themeStore.toXtermTheme(initialColors) : {};

		scrollbarMarkers = p?.scrollbarMarkers !== false; // default true
		const term = new Terminal({
			allowProposedApi: true,
			allowTransparency: true,
			cursorBlink: p?.cursorStyle !== "underline", // blink except underline (xterm default)
			fontSize: p?.fontSize ?? DEFAULT_FONT_SIZE,
			fontFamily: p?.fontFamily ?? DEFAULT_FONT_FAMILY,
			cursorStyle: p?.cursorStyle ?? "block",
			scrollback: p?.scrollback ?? 5000,
			overviewRuler: {
				width: terminalScrollbarWidth(themeStore.appearance.scrollbar, scrollbarMarkers),
			},
			theme: initialXtermTheme,
		});

		term.loadAddon(fitAddon);
		term.loadAddon(new Unicode11Addon());
		term.unicode.activeVersion = "11";
		term.open(containerRef.value);
		// Before the first fit, since what it counts is what the PTY is spawned with.
		syncMeasuredFont(term);
		fitAddon.fit();
		// A font arriving late changes the cell, and with it the count: fit again
		// so the terminal and its PTY agree even when the wait above was skipped.
		void refitWhenFontSettles(
			term,
			p?.fontFamily ?? DEFAULT_FONT_FAMILY,
			p?.fontSize ?? DEFAULT_FONT_SIZE,
		);
		search.init(term, { scrollbarMarkers });
		terminal.value = term;

		// Keyboard input → send INPUT to hub (only when holding write lock)
		term.onData((data: string) => {
			if (channelId && wsClient.isConnected && canWrite.value) {
				wsClient.send({
					type: "INPUT",
					channelId,
					data: new TextEncoder().encode(data),
				});
			}
		});

		// Terminal resize → send RESIZE to hub (debounced to coalesce rapid
		// resizes), when this pane decides the size and still has one of its own.
		term.onResize(scheduleSync);

		// The PTY's size changed: the pane draws at it unless it decides it (#831).
		sizeUnsubscribe?.();
		sizeUnsubscribe = wsClient.on("CHANNEL_SIZE", (msg) => {
			if (msg.type === "CHANNEL_SIZE" && msg.channelId === channelId) {
				takePtySize(msg.cols, msg.rows);
			}
		});

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
		onScrollbarChanged = (): void => {
			applyScrollbarWidth(term);
			layout();
		};
		window.addEventListener("nt:scrollbar-changed", onScrollbarChanged);

		// Terminal title change (OSC 0/2) → push to title stack
		titleChangeDispose?.();
		const titleDisposable = term.onTitleChange((raw: string) => {
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
		titleChangeDispose = () => titleDisposable.dispose();

		// Subscribe to global theme changes so all terminals update live.
		// Per-host override (SC-03): if a host-specific theme is set, keep it.
		themeUnsubscribe = themeStore.onTerminalThemeChange((xtermTheme) => {
			if (terminal.value) {
				if (hostTheme) {
					terminal.value.options.theme = themeStore.toXtermTheme(hostTheme.colors);
				} else {
					terminal.value.options.theme = xtermTheme;
				}
			}
		});

		return { cols: term.cols, rows: term.rows };
	}

	/**
	 * Subscribe to OUTPUT messages for the given channel and write to terminal.
	 * Call after init() and after a successful SPAWN.
	 */
	function attachChannel(id: string): void {
		channelId = id;
		shownId = id;
		leaveEndedSize();

		// Clean up previous subscription if any
		outputUnsubscribe?.();

		outputUnsubscribe = wsClient.on("OUTPUT", (msg) => {
			if (msg.type === "OUTPUT" && msg.channelId === channelId && terminal.value) {
				// msg.data arrives as Uint8Array from MessagePack decode
				const data =
					msg.data instanceof Uint8Array ? msg.data : new TextEncoder().encode(String(msg.data));
				terminal.value.write(data);
			}
		});

		// Send initial RESIZE so the PTY matches our dimensions from the start
		syncChannelSize();
	}

	/**
	 * Re-attach to an existing channel: send ATTACH, wait for ATTACH_OK,
	 * restore snapshot + replay tail, then subscribe to live OUTPUT.
	 */
	/**
	 * Re-attach to an existing channel: send ATTACH, wait for ATTACH_OK,
	 * restore snapshot + replay tail, then subscribe to live OUTPUT.
	 *
	 * A terminal that has ended is refused with CHANNEL_DEAD, and one the hub
	 * has no record of with CHANNEL_NOT_FOUND: an ATTACH never starts one
	 * again (#559). Restart brings it back under the same channel ID.
	 */
	async function reattachChannel(
		id: string,
		opts?: {
			preserveContent?: boolean;
			/** Whether the pane still shows `id` when the answer comes; true when absent. */
			stillWanted?: () => boolean;
		},
	): Promise<{ writeLockHolder: string | null; cached: boolean; truncated: boolean }> {
		const request = ++attachRequests;
		// Clean up previous OUTPUT subscription
		outputUnsubscribe?.();

		// Don't set channelId yet — prevents spurious RESIZE messages from
		// being sent to the hub during terminal.reset() / terminal.write()
		// which would cause the shell to redraw the prompt multiple times.

		// Send ATTACH and wait for ATTACH_OK or ERROR
		const result = await new Promise<{
			snapshot: unknown;
			tail: Uint8Array[];
			writeLockHolder: string | null;
			dynamicTitle: string | null;
			displayTitle: string | null;
			/**
			 * The hub answered from what it remembers, with nothing attached to
			 * the terminal itself. What is on screen is the last thing it showed,
			 * and what is typed into it goes nowhere.
			 */
			cached: boolean;
			/** Output between the snapshot and now was dropped rather than cut. */
			truncated: boolean;
			/** The PTY's size; null from a hub that does not say it. */
			size: { cols: number; rows: number } | null;
		}>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubOk();
				unsubErr();
				reject(new Error("ATTACH timeout — no response after 10s"));
			}, 10_000);

			const unsubOk = wsClient.on("ATTACH_OK", (msg) => {
				if (msg.type === "ATTACH_OK") {
					const uiMsg = msg as UiAttachOkMessage;
					if (uiMsg.channelId !== id) return;
					clearTimeout(timer);
					unsubOk();
					unsubErr();
					resolve({
						snapshot: uiMsg.snapshot,
						tail: uiMsg.tail ?? [],
						writeLockHolder: uiMsg.writeLockHolder ?? null,
						dynamicTitle: uiMsg.dynamicTitle ?? null,
						displayTitle: uiMsg.displayTitle ?? null,
						cached: uiMsg.cached === true,
						truncated: uiMsg.truncated === true,
						size:
							typeof uiMsg.cols === "number" && typeof uiMsg.rows === "number"
								? { cols: uiMsg.cols, rows: uiMsg.rows }
								: null,
					});
				}
			});

			const unsubErr = wsClient.on("ERROR", (msg) => {
				if (
					msg.type === "ERROR" &&
					(msg.code === "CHANNEL_NOT_FOUND" || msg.code === "CHANNEL_DEAD")
				) {
					// If the ERROR carries a channelId, only act when it matches the channel
					// being attached — prevents a broadcast error for a different channel
					// from incorrectly rejecting this pane's attach promise.
					if (msg.channelId !== undefined && msg.channelId !== id) return;
					clearTimeout(timer);
					unsubOk();
					unsubErr();
					// Only for the terminal the pane still shows, and only from its
					// latest request: an older answer, or one for a terminal it has
					// left, writes nothing (#927, #929).
					if (
						msg.code === "CHANNEL_DEAD" &&
						request === attachRequests &&
						(opts?.stillWanted?.() ?? true)
					) {
						showEnded(id, msg.lastOutput, opts?.preserveContent === true);
					}
					// The code travels with it: what a pane does about this is not a
					// decision to make by reading a sentence, which changes.
					reject(Object.assign(new Error(msg.message ?? msg.code), { code: msg.code }));
				}
			});

			wsClient.send({ type: "ATTACH", channelId: id });
		});

		// A terminal attached: the size rules of #831 apply again.
		shownId = id;
		leaveEndedSize();

		// The PTY's size. A pane that does not decide it draws the screen below
		// at that size, the one it was drawn for (#831). One that decides it
		// compares its own with it, whatever it sent before: a restart spawned
		// the PTY anew, or another client decided meanwhile.
		if (result.size !== null) {
			lastSentCols = result.size.cols;
			lastSentRows = result.size.rows;
			takePtySize(result.size.cols, result.size.rows);
		}

		// Restore snapshot if present (channelId still unset → no RESIZE sent)
		if (terminal.value && result.snapshot && !opts?.preserveContent) {
			terminal.value.reset();
			const serialized = (result.snapshot as { serialized?: string }).serialized;
			if (serialized) {
				terminal.value.write(serialized);
			}
		}

		// Replay tail chunks
		if (terminal.value && result.tail.length > 0 && !opts?.preserveContent) {
			for (const chunk of result.tail) {
				const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
				terminal.value.write(data);
			}
		}

		// Restore dynamic title from ATTACH_OK (SC-02 — titles survive reconnects)
		if (result.dynamicTitle) {
			titleStack.length = 0;
			titleStack.push(result.dynamicTitle);
			currentDynamicTitle.value = result.dynamicTitle;
		}

		if (result.displayTitle) {
			useChannelsStore().setDisplayTitle(id, result.displayTitle);
		}

		// Set channelId — same ID always (a restart reuses the same channel ID)
		channelId = id;

		// Subscribe to live OUTPUT. Another attach may have subscribed while this
		// one waited — a pane can be asked for its terminal again by the hub's
		// news as well as by a click — and keeping both wrote every chunk twice.
		outputUnsubscribe?.();
		outputUnsubscribe = wsClient.on("OUTPUT", (msg) => {
			if (msg.type === "OUTPUT" && msg.channelId === channelId && terminal.value) {
				const data =
					msg.data instanceof Uint8Array ? msg.data : new TextEncoder().encode(String(msg.data));
				terminal.value.write(data);
			}
		});

		// Send ONE RESIZE with actual terminal dimensions so the PTY matches,
		// when this pane decides it. Dedup'd so ResizeObserver won't cause
		// duplicates.
		syncChannelSize();

		if (result.truncated) {
			// A terminal cannot be handed a piece of a stream, so it was not: the
			// screen above is the last coherent one, and what followed is gone.
			// Saying so beats a pane that looks current and is not.
			writeNotice("output between this screen and now was dropped");
		}
		return {
			writeLockHolder: result.writeLockHolder,
			cached: result.cached,
			truncated: result.truncated,
		};
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
	 * that is already this terminal's stays, and another's is cleared. Under
	 * `preserveContent` (Reconnect, Restart, a re-attach over an ending the
	 * pane watched) nothing is written. An older hub sends no last output, and
	 * nothing is written either.
	 */
	function showEnded(id: string, last: EndedOutput | undefined, preserveContent: boolean): void {
		channelId = null;
		if (last === undefined) return;
		endedSize = { cols: last.cols, rows: last.rows };
		layout();
		const term = terminal.value;
		if (!term || preserveContent) return;
		const somethingToDraw = last.snapshot !== null || last.tail.some((part) => part.byteLength > 0);
		if (somethingToDraw) {
			term.reset();
			if (last.snapshot?.serialized) term.write(last.snapshot.serialized);
			for (const part of last.tail) term.write(part);
			if (last.truncated === true) {
				writeNotice("output between this screen and now was dropped");
			}
		} else if (shownId !== id) {
			term.reset();
			if (last.truncated === true) writeNotice("its last output was too long to show");
		} else {
			return;
		}
		shownId = id;
		term.write(MOUSE_REPORTING_OFF);
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
	 * Tell the channel the size the terminal actually has, if it differs: only
	 * when this pane decides the size, and has one of its own (#831).
	 */
	function syncChannelSize(): void {
		const term = terminal.value;
		if (term && decidesSize && paneMeasurable()) sendResize(term.cols, term.rows);
	}

	/** Re-apply profile options (font, cursor, scrollback, scrollbar markers) to the live terminal. */
	function applyProfile(p: TerminalProfile): void {
		const term = terminal.value;
		if (!term) return;
		term.options.fontFamily = p.fontFamily ?? DEFAULT_FONT_FAMILY;
		term.options.fontSize = p.fontSize ?? DEFAULT_FONT_SIZE;
		term.options.cursorStyle = p.cursorStyle ?? "block";
		term.options.scrollback = p.scrollback ?? 5000;
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
		if (resizeTimer !== null) clearTimeout(resizeTimer);
		resizeTimer = null;
		titleChangeDispose?.();
		titleChangeDispose = null;
		themeUnsubscribe?.();
		themeUnsubscribe = null;
		outputUnsubscribe?.();
		outputUnsubscribe = null;
		inputDroppedUnsubscribe?.();
		inputDroppedUnsubscribe = null;
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
		endedSize = null;
		titleStack.length = 0;
		currentDynamicTitle.value = null;
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
		turnMouseReportingOff,
		applyProfile,
		suppressNextResize,
		syncChannelSize,
		setDecidesSize,
		dispose,
		fitAddon,
	};
}
