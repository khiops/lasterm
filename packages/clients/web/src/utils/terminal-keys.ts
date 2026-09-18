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
