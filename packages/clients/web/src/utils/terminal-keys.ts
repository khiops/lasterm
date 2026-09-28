import { isPaletteShortcut } from "./palette-shortcut.js";

const ESC = "\x1b";

/** Same platform test as xterm.js, so the mapping matches what xterm 5 sent. */
export const IS_MAC =
	typeof navigator !== "undefined" &&
	["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

/**
 * The sequence xterm.js 5 sent for a lone Alt+arrow, or null for any other key.
 *
 * xterm 5 rewrote Alt+arrow as Ctrl+arrow (ESC b / ESC f for left and right on
 * macOS) so that shells move by word; xterm 6 dropped that rewrite and leaves
 * it to the embedder. Without it, Alt+Left sends ESC [1;3D, which default bash
 * and zsh bindings do not map to a word motion.
 */
export function altArrowSequence(ev: KeyboardEvent, isMac: boolean): string | null {
	if (!ev.altKey || ev.ctrlKey || ev.shiftKey || ev.metaKey) return null;
	switch (ev.key) {
		case "ArrowLeft":
			return isMac ? `${ESC}b` : `${ESC}[1;5D`;
		case "ArrowRight":
			return isMac ? `${ESC}f` : `${ESC}[1;5C`;
		case "ArrowUp":
			return isMac ? null : `${ESC}[1;5A`;
		case "ArrowDown":
			return isMac ? null : `${ESC}[1;5B`;
		default:
			return null;
	}
}

/** What a terminal's key handler needs from its pane. */
export interface TerminalKeyTarget {
	/** Opens the pane's search overlay. */
	openSearch(): void;
	/** Whether the pane's search overlay is open. */
	isSearchOpen(): boolean;
	/** Sends data to the PTY as though it were typed. */
	input(data: string): void;
	/** Whether the terminal has text selected. */
	hasSelection(): boolean;
	isMac: boolean;
}

/**
 * The handler a pane gives xterm's `attachCustomKeyEventHandler`. xterm calls it for every
 * keydown, keypress and keyup it receives: `false` keeps that event from xterm, so nothing of it
 * reaches the PTY, and `true` leaves xterm to send the key as it would.
 */
export function terminalKeyHandler(target: TerminalKeyTarget): (ev: KeyboardEvent) => boolean {
	return (ev) => {
		// The window's listener opens the palette on it. xterm does not look at
		// `defaultPrevented`, so only this keeps the chord from the shell (#624).
		if (isPaletteShortcut(ev)) return false;
		// Ctrl+Shift+F opens the search overlay rather than reaching xterm.
		if (ev.ctrlKey && ev.shiftKey && ev.key === "F") {
			if (ev.type === "keydown") target.openSearch();
			return false;
		}
		// When search overlay is open, let Escape propagate to the overlay
		if (ev.key === "Escape" && target.isSearchOpen()) return false;
		// When search is open, intercept Alt+C/R/W so they reach
		// useSearchShortcuts instead of being sent to the PTY
		if (ev.altKey && target.isSearchOpen()) {
			const k = ev.key.toLowerCase();
			if (k === "c" || k === "r" || k === "w") return false;
		}
		// Alt+arrow → word motion, as xterm 5 did before leaving it to embedders
		const altArrow = altArrowSequence(ev, target.isMac);
		if (altArrow !== null) {
			if (ev.type === "keydown") target.input(altArrow);
			return false;
		}
		// Ctrl+V / Ctrl+Shift+V → let browser handle paste from clipboard
		if (ev.ctrlKey && ev.key === "v") return false;
		// Ctrl+C with selection → copy to clipboard (not SIGINT)
		if (ev.ctrlKey && ev.key === "c" && target.hasSelection()) return false;
		return true;
	};
}
