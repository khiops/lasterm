/**
 * Telling the desktop shell whether the theme in use is a dark one.
 *
 * DWM paints Mica and Acrylic in a light or a dark tint, and it takes that from
 * the window, never from the page: a dark theme under the light tint reads as a
 * pale film over everything. Only the desktop can set it, and only the page
 * knows which theme is in use, so the page says it every time a theme lands —
 * including a preview, which is a theme the user is looking at.
 *
 * Outside the desktop app this is nobody's business and does nothing.
 */

let lastToneSent: boolean | null = null;

function inTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Say that the theme now showing is dark, or light.
 *
 * Repeats are dropped: a theme lands on every preview frame, and the attribute
 * is a window-wide repaint.
 */
export function applyWindowTone(dark: boolean): void {
	if (!inTauri() || dark === lastToneSent) return;
	lastToneSent = dark;
	void import("@tauri-apps/api/core")
		.then(({ invoke }) => invoke("apply_window_tone", { dark }))
		.catch(() => {
			// A desktop that cannot take the tone keeps the one it has; the
			// theme itself has already been applied to the page.
			lastToneSent = null;
		});
}

/** Forget what was sent. For tests, which get a fresh window each time. */
export function resetWindowTone(): void {
	lastToneSent = null;
}
