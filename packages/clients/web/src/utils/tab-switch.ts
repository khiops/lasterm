import type { TabNumber } from "./app-shortcuts.js";

/** Where Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+Alt+digit go. */
export type TabSwitch = "next" | "previous" | { goTo: TabNumber };

/**
 * The index, among all `tabIds`, of the tab a switch lands on, or null when the bar shows none.
 *
 * Only the tabs the bar shows count (`inView`, null when it shows them all): with the bar showing
 * one host's tabs, the others are not there to go to. Next and previous wrap around. Tab N is the
 * Nth on the bar; the ninth, or one past the count, is the last (#637, as in Windows Terminal).
 */
export function tabToSwitchTo(
	target: TabSwitch,
	tabIds: readonly string[],
	activeIndex: number,
	inView: ReadonlySet<string> | null,
): number | null {
	const shown = tabIds.flatMap((id, index) => (inView === null || inView.has(id) ? [index] : []));
	const count = shown.length;
	if (count === 0) return null;
	if (typeof target === "object") {
		const nth = target.goTo === 9 ? count : Math.min(target.goTo, count);
		return shown[nth - 1] ?? null;
	}
	const at = shown.indexOf(activeIndex);
	// From a tab the bar does not show, the first shown is next, and the last is previous.
	if (at === -1) return (target === "next" ? shown[0] : shown[count - 1]) ?? null;
	const step = target === "next" ? 1 : -1;
	return shown[(at + step + count) % count] ?? null;
}
