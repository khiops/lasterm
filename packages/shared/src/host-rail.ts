// The host rail's geometry (#623): its badge sizes, the width of a rail of n
// columns, and the rows its badges fill.
//
// Shared because the hub reads it too: `[layout] host_rail_width`, the width in
// pixels a rail used to keep, becomes the column count that width holds.

/** The badge sizes Settings offers, smallest first. */
export const HOST_RAIL_BADGE_SIZES = ["small", "medium", "large"] as const;

export type HostRailBadgeSize = (typeof HOST_RAIL_BADGE_SIZES)[number];

/** What a badge size sets, in pixels. */
export interface HostRailBadgeGeometry {
	/** The badge's side. */
	badge: number;
	/** The initials' font size. */
	initials: number;
	/** The status dot's diameter, its border included. */
	dot: number;
	/** The corner radius of a selected or hovered badge. */
	squircle: number;
	/** The height of the selection pill, in one column. */
	pill: number;
}

/** Medium is the badge the rail has always had. */
export const HOST_RAIL_BADGE_GEOMETRY: Readonly<Record<HostRailBadgeSize, HostRailBadgeGeometry>> =
	{
		small: { badge: 28, initials: 11, dot: 8, squircle: 9, pill: 15 },
		medium: { badge: 36, initials: 14, dot: 10, squircle: 12, pill: 20 },
		large: { badge: 44, initials: 17, dot: 12, squircle: 14, pill: 24 },
	};

/** The space between two badges, across and down. */
export const HOST_RAIL_GAP = 6;
/** The space between the rail's edges and its badges, on each side. */
export const HOST_RAIL_PADDING = 6;
/** No rail is narrower, whatever its badges: one Medium column. */
export const HOST_RAIL_MIN_WIDTH = 48;
export const HOST_RAIL_MAX_COLUMNS = 5;

export function isHostRailBadgeSize(value: unknown): value is HostRailBadgeSize {
	return (HOST_RAIL_BADGE_SIZES as readonly unknown[]).includes(value);
}

/** A column count the rail can have: a whole number from 1 to the maximum. */
export function isHostRailColumns(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= HOST_RAIL_MAX_COLUMNS
	);
}

function clampColumns(columns: number): number {
	return Math.min(HOST_RAIL_MAX_COLUMNS, Math.max(1, columns));
}

/** The width of a rail of `columns` badges: the columns, the gaps between them, the padding. */
export function hostRailWidth(columns: number, size: HostRailBadgeSize): number {
	const n = clampColumns(Math.round(columns));
	const { badge } = HOST_RAIL_BADGE_GEOMETRY[size];
	return Math.max(HOST_RAIL_MIN_WIDTH, 2 * HOST_RAIL_PADDING + n * badge + (n - 1) * HOST_RAIL_GAP);
}

/** How many columns a rail of `width` pixels holds: at least one, at most the maximum. */
export function hostRailColumnsForWidth(width: number, size: HostRailBadgeSize): number {
	const { badge } = HOST_RAIL_BADGE_GEOMETRY[size];
	const fit = Math.floor((width - 2 * HOST_RAIL_PADDING + HOST_RAIL_GAP) / (badge + HOST_RAIL_GAP));
	return clampColumns(Number.isFinite(fit) ? fit : 1);
}

/**
 * The column count whose width is nearest `width`, where a released edge
 * snaps. Halfway between two, the wider. Measured against the widths
 * themselves, since one Small column is widened to the minimum.
 */
export function nearestHostRailColumns(width: number, size: HostRailBadgeSize): number {
	let nearest = 1;
	for (let n = 2; n <= HOST_RAIL_MAX_COLUMNS; n++) {
		const distance = Math.abs(hostRailWidth(n, size) - width);
		if (distance <= Math.abs(hostRailWidth(nearest, size) - width)) nearest = n;
	}
	return nearest;
}

/**
 * The column count a width kept by an earlier rail holds (`[layout]
 * host_rail_width`). Those rails had Medium badges only.
 */
export function hostRailColumnsFromLegacyWidth(width: number): number {
	return hostRailColumnsForWidth(width, "medium");
}

/**
 * `items` cut into rows of `columns`, in order: read left to right, then down,
 * the rows give the items back as they came.
 */
export function chunkIntoRows<T>(items: readonly T[], columns: number): T[][] {
	const size = Math.max(1, Math.floor(columns));
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		rows.push(items.slice(i, i + size));
	}
	return rows;
}

/**
 * `ids` with `movedId` put just before `targetId`, which is where a badge
 * dropped on another lands, in reading order. `movedId` may come from
 * elsewhere, another group's hosts: it is then added. When `targetId` is not
 * in `ids`, or is `movedId`, the order is unchanged.
 */
export function moveBefore(ids: readonly string[], movedId: string, targetId: string): string[] {
	if (movedId === targetId || !ids.includes(targetId)) return [...ids];
	const rest = ids.filter((id) => id !== movedId);
	rest.splice(rest.indexOf(targetId), 0, movedId);
	return rest;
}
