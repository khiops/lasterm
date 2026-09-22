import type { TerminalProfile, UiAttachOkMessage } from "@lasterm/shared";
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
	let resizeObserver: ResizeObserver | null = null;
	let onScrollbarChanged: (() => void) | null = null;
	/** Whether search matches are marked in the scrollbar gutter (profile). */
	let scrollbarMarkers = true;
	let outputUnsubscribe: (() => void) | null = null;
	let themeUnsubscribe: (() => void) | null = null;

	/**
	 * When false, keyboard input is suppressed (read-only mode).
	 * Set to true once the caller confirms write-lock ownership.
	 * Defaults to true so single-client setups work without auth.
	 */
	const canWrite = ref(true);

	/**
	 * Last cols/rows sent to the hub, used to avoid sending duplicate RESIZE
	 * messages that would trigger unnecessary SIGWINCH → prompt redraws.
	 */
	let lastSentCols = 0;
	let lastSentRows = 0;

	/** Debounce timer for RESIZE messages */
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;

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

	function sendResize(cols: number, rows: number): void {
		if (!channelId || !wsClient.isConnected) return;
		if (cols === lastSentCols && rows === lastSentRows) return;
		lastSentCols = cols;
		lastSentRows = rows;
		wsClient.send({ type: "RESIZE", channelId, cols, rows });
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

		// Terminal resize → send RESIZE to hub (debounced to coalesce rapid resizes)
		term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
			if (resizeTimer !== null) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				resizeTimer = null;
				sendResize(cols, rows);
			}, 50);
		});

		// Container resize → refit terminal
		resizeObserver = new ResizeObserver(() => {
			fitAddon.fit();
		});
		resizeObserver.observe(containerRef.value);
		onScrollbarChanged = (): void => {
			applyScrollbarWidth(term);
			fitAddon.fit();
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
		if (terminal.value) {
			sendResize(terminal.value.cols, terminal.value.rows);
		}
	}

	/**
	 * Re-attach to an existing channel: send ATTACH, wait for ATTACH_OK,
	 * restore snapshot + replay tail, then subscribe to live OUTPUT.
	 */
	/**
	 * Re-attach to an existing channel: send ATTACH, wait for ATTACH_OK,
	 * restore snapshot + replay tail, then subscribe to live OUTPUT.
	 *
	 * Dead channels are respawned by the hub under the same channel ID, so
	 * the caller always uses the original ID after this returns.
	 */
	async function reattachChannel(
		id: string,
		opts?: { preserveContent?: boolean },
	): Promise<{ writeLockHolder: string | null; cached: boolean }> {
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
					// The code travels with it: what a pane does about this is not a
					// decision to make by reading a sentence, which changes.
					reject(Object.assign(new Error(msg.message ?? msg.code), { code: msg.code }));
				}
			});

			wsClient.send({ type: "ATTACH", channelId: id });
		});

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

		// Set channelId — same ID always (respawn reuses the same channel ID)
		channelId = id;

		// Subscribe to live OUTPUT
		outputUnsubscribe = wsClient.on("OUTPUT", (msg) => {
			if (msg.type === "OUTPUT" && msg.channelId === channelId && terminal.value) {
				const data =
					msg.data instanceof Uint8Array ? msg.data : new TextEncoder().encode(String(msg.data));
				terminal.value.write(data);
			}
		});

		// Send ONE RESIZE with actual terminal dimensions so the PTY matches.
		// This is debounced + dedup'd so ResizeObserver won't cause duplicates.
		if (terminal.value) {
			sendResize(terminal.value.cols, terminal.value.rows);
		}

		return { writeLockHolder: result.writeLockHolder, cached: result.cached };
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
	}

	/** Tell the channel the size the terminal actually has, if it differs. */
	function syncChannelSize(): void {
		const term = terminal.value;
		if (term) sendResize(term.cols, term.rows);
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
		fitAddon.fit();
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
		fitAddon.fit();
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
		applyProfile,
		suppressNextResize,
		syncChannelSize,
		dispose,
		fitAddon,
	};
}
