import { appShortcutOf } from "./app-shortcuts.js";

/** What a terminal's key handler needs from its pane. */
export interface TerminalKeyTarget {
	/** Opens the pane's search overlay. */
	openSearch(): void;
	/** Whether the pane's search overlay is open. */
	isSearchOpen(): boolean;
	/** Whether the terminal has text selected. */
	hasSelection(): boolean;
}

/**
 * The handler a pane gives xterm's `attachCustomKeyEventHandler`. xterm calls it for every
 * keydown, keypress and keyup it receives: `false` keeps that event from xterm, so nothing of it
 * reaches the PTY, and `true` leaves xterm to send the key as it would.
 *
 * Alt+arrows are no longer a word motion here: they move between panes (#637), as in Windows
 * Terminal, and a shell moves by word on Ctrl+←/→, which xterm sends as it is.
 */
export function terminalKeyHandler(target: TerminalKeyTarget): (ev: KeyboardEvent) => boolean {
	return (ev) => {
		// The app's shortcuts (utils/app-shortcuts.ts): the window's listener runs their
		// actions. xterm does not look at `defaultPrevented`, so only this keeps a chord
		// from the shell (#624, #631). A chord for outside a terminal, F6, is the shell's here.
		if (appShortcutOf(ev, "terminal") !== null) return false;
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
		// Ctrl+V / Ctrl+Shift+V → let browser handle paste from clipboard
		if (ev.ctrlKey && ev.key === "v") return false;
		// Ctrl+C with selection → copy to clipboard (not SIGINT)
		if (ev.ctrlKey && ev.key === "c" && target.hasSelection()) return false;
		return true;
	};
}
