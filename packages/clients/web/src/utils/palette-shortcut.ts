/**
 * The command palette's shortcut: Ctrl+Shift+P, as in Windows Terminal and VS Code (#624).
 * Cmd stands in for Ctrl, as it always has for the palette.
 *
 * The chord's one definition. The window's listener opens the palette on it (App.vue), and every
 * terminal's key handler keeps it from xterm (`terminalKeyHandler`), which acts on the keys it is
 * given whether or not the page has already taken them: Ctrl+K, the palette's key before, opened
 * the palette and still reached the shell as ^K.
 */
export function isPaletteShortcut(ev: KeyboardEvent): boolean {
	// Shift makes `key` "P", or "p" under Caps Lock. A synthetic keydown, such as
	// one from a browser's autofill, can carry no `key` at all.
	return (
		(ev.ctrlKey || ev.metaKey) && ev.shiftKey && !ev.altKey && (ev.key === "P" || ev.key === "p")
	);
}

/** The shortcut as Settings › Keybindings shows it. */
export const PALETTE_SHORTCUT_KEYS: readonly string[] = ["Ctrl", "Shift", "P"];
