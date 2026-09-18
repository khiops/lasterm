import type { AppearanceConfig } from "@lasterm/shared";

/**
 * Width in pixels to give xterm's `overviewRuler` option.
 *
 * Since xterm.js 6 the terminal draws its own scrollbar, and both that
 * scrollbar and the columns the fit addon reserves take their width from
 * `overviewRuler.width`, falling back to 14px when it is 0. So the ruler width
 * is how the thin/wide setting reaches the terminal. A hidden scrollbar still
 * needs a gutter for the search markers when they are on; without markers it
 * gets 1px, the smallest width that avoids the 14px fallback. The widths come
 * from config.toml unchecked, hence the floor at 1px.
 */
export function terminalScrollbarWidth(
	scrollbar: AppearanceConfig["scrollbar"],
	markers: boolean,
): number {
	const width =
		scrollbar.style === "wide"
			? scrollbar.widthWide
			: scrollbar.style === "hidden" && !markers
				? 1
				: scrollbar.widthThin;
	return Math.max(1, Math.round(width));
}
