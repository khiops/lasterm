/**
 * Moving the keyboard around the window (#637). F6 and Shift+F6 go from one zone to the next —
 * the host rail, the terminal list, the tab bar, the focused pane — as Windows' own F6 does in
 * Explorer and Edge. Within a zone, one element takes Tab (a roving `tabindex`) and the arrow
 * keys move between its items. Pure: the components and App.vue do the focusing.
 */

/** The zones, in the order F6 visits them. */
export const FOCUS_ZONES = ["rail", "sidebar", "tabs", "pane"] as const;
export type FocusZone = (typeof FOCUS_ZONES)[number];

export function isFocusZone(value: unknown): value is FocusZone {
	return (FOCUS_ZONES as readonly unknown[]).includes(value);
}

/**
 * The zone F6 (`step` 1) or Shift+F6 (`step` -1) goes to from `current`, wrapping around, or null
 * when no other zone can take the keyboard. A zone that is hidden, or has nothing to focus, is
 * passed over.
 */
export function zoneAfter(
	current: FocusZone,
	step: 1 | -1,
	canTakeFocus: (zone: FocusZone) => boolean,
): FocusZone | null {
	const count = FOCUS_ZONES.length;
	const from = FOCUS_ZONES.indexOf(current);
	for (let i = 1; i < count; i++) {
		const zone = FOCUS_ZONES[(((from + step * i) % count) + count) % count];
		if (zone !== undefined && canTakeFocus(zone)) return zone;
	}
	return null;
}

/**
 * Where an arrow key, Home or End goes in a list of `count` items, from `index`: ← and → along a
 * row, ↑ and ↓ down a column. At either end the keyboard stays where it is. Null for any other
 * key, which the list leaves alone.
 */
export function listMove(
	count: number,
	index: number,
	key: string,
	orientation: "horizontal" | "vertical",
): number | null {
	if (count === 0 || index < 0 || index >= count) return null;
	const [previous, next] =
		orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
	switch (key) {
		case previous:
			return Math.max(0, index - 1);
		case next:
			return Math.min(count - 1, index + 1);
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}

/**
 * Where an arrow key, Home or End goes in a grid of rows, from `current`: ← and → within its row,
 * ↑ and ↓ to the row above or below — whichever section it belongs to, since the rows are given
 * without their headers — to the same column, or the last of a shorter row. Home is the first
 * item, End the last. At an edge the keyboard stays where it is. Null for any other key, or for an
 * item that is not in the grid.
 */
export function gridMove(
	rows: readonly (readonly string[])[],
	current: string,
	key: string,
): string | null {
	const filled = rows.filter((row) => row.length > 0);
	const r = filled.findIndex((row) => row.includes(current));
	if (r === -1) return null;
	const row = filled[r] ?? [];
	const c = row.indexOf(current);
	const at = (rowIndex: number, column: number): string | null => {
		const target = filled[rowIndex];
		if (target === undefined) return current;
		return target[Math.min(column, target.length - 1)] ?? current;
	};
	switch (key) {
		case "ArrowLeft":
			return row[Math.max(0, c - 1)] ?? current;
		case "ArrowRight":
			return row[Math.min(row.length - 1, c + 1)] ?? current;
		case "ArrowUp":
			return r === 0 ? current : at(r - 1, c);
		case "ArrowDown":
			return r === filled.length - 1 ? current : at(r + 1, c);
		case "Home":
			return filled[0]?.[0] ?? current;
		case "End": {
			const last = filled[filled.length - 1];
			return last?.[last.length - 1] ?? current;
		}
		default:
			return null;
	}
}
