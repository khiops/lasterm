/**
 * Where a tab's panes are on screen, and which one lies on a side of another (#637): the geometry
 * behind Alt+arrows, which move the focus between panes, and Alt+Shift+arrows, which move a
 * divider. Pure: it reads a pane tree and returns ids, paths and ratios.
 *
 * A split's ratio is the share of its first child: the left one of a "vertical" split, whose
 * divider is vertical and whose children sit side by side, and the upper one of a "horizontal"
 * split, whose children are stacked. The dividers themselves are a few pixels wide, the same for
 * every split, so the rectangles here are where the panes are drawn up to that constant.
 */
import type { NodePath, PaneNode } from "../composables/usePaneTree.js";
import type { PaneDirection } from "./app-shortcuts.js";

/** The narrowest share a split gives a side: the mouse drags no further, nor do the keys. */
export const SPLIT_RATIO_MIN = 0.1;
export const SPLIT_RATIO_MAX = 0.9;

/** How far one Alt+Shift+arrow moves a divider: a twentieth of its split, as in Windows Terminal. */
export const PANE_RESIZE_STEP = 0.05;

/** A split's ratio kept within the bounds a divider can be dragged to. */
export function clampSplitRatio(ratio: number): number {
	return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio));
}

/** A leaf's id: a terminal's pane id, or an empty pane's own. */
export function leafId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.paneId;
	if (node.type === "vacant") return node.id;
	return null;
}

/** A leaf of the tree, and the path that reaches it. */
export interface PaneLeaf {
	id: string;
	node: Exclude<PaneNode, { type: "split" }>;
	path: NodePath;
}

/** Every leaf, terminals and empty panes, in the order the tree holds them: left, then top first. */
export function paneLeaves(root: PaneNode, path: NodePath = []): PaneLeaf[] {
	if (root.type !== "split") {
		return [{ id: leafId(root) ?? "", node: root, path }];
	}
	return [
		...paneLeaves(root.first, [...path, "first"]),
		...paneLeaves(root.second, [...path, "second"]),
	];
}

/** A pane's rectangle, in the tab's area: 0 to 1 across and down. */
export interface PaneRect {
	id: string;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Each leaf's rectangle, in tree order. */
export function paneRects(
	root: PaneNode,
	area: Omit<PaneRect, "id"> = { left: 0, top: 0, right: 1, bottom: 1 },
): PaneRect[] {
	if (root.type !== "split") return [{ id: leafId(root) ?? "", ...area }];
	if (root.direction === "vertical") {
		const edge = area.left + (area.right - area.left) * root.ratio;
		return [
			...paneRects(root.first, { ...area, right: edge }),
			...paneRects(root.second, { ...area, left: edge }),
		];
	}
	const edge = area.top + (area.bottom - area.top) * root.ratio;
	return [
		...paneRects(root.first, { ...area, bottom: edge }),
		...paneRects(root.second, { ...area, top: edge }),
	];
}

/** Rounding apart, two edges computed from the same divider are the same edge. */
const EPSILON = 1e-9;

/** How far `to` lies beyond `from` towards `direction`, or null when it is not on that side. */
function gapTowards(from: PaneRect, to: PaneRect, direction: PaneDirection): number | null {
	const gap =
		direction === "left"
			? from.left - to.right
			: direction === "right"
				? to.left - from.right
				: direction === "up"
					? from.top - to.bottom
					: to.top - from.bottom;
	return gap >= -EPSILON ? Math.max(0, gap) : null;
}

/** How much `a` and `b` share along the axis across `direction`. */
function overlapAcross(a: PaneRect, b: PaneRect, direction: PaneDirection): number {
	return direction === "left" || direction === "right"
		? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
		: Math.min(a.right, b.right) - Math.max(a.left, b.left);
}

/**
 * The pane Alt+arrow moves the focus to from `fromId`: the nearest one on that side that
 * overlaps it along the other axis, or null at the tab's edge. Between two as near, the one it
 * shares more of its side with, then the first in the tree (the upper, or the left one).
 */
export function paneInDirection(
	root: PaneNode,
	fromId: string,
	direction: PaneDirection,
): string | null {
	const rects = paneRects(root);
	const from = rects.find((rect) => rect.id === fromId);
	if (from === undefined) return null;
	let best: { id: string; gap: number; overlap: number } | null = null;
	for (const rect of rects) {
		if (rect.id === fromId) continue;
		const gap = gapTowards(from, rect, direction);
		const overlap = overlapAcross(from, rect, direction);
		if (gap === null || overlap <= EPSILON) continue;
		if (
			best === null ||
			gap < best.gap - EPSILON ||
			(Math.abs(gap - best.gap) <= EPSILON && overlap > best.overlap + EPSILON)
		) {
			best = { id: rect.id, gap, overlap };
		}
	}
	return best?.id ?? null;
}

function nodeAt(root: PaneNode, path: NodePath): PaneNode | null {
	let node: PaneNode = root;
	for (const turn of path) {
		if (node.type !== "split") return null;
		node = turn === "first" ? node.first : node.second;
	}
	return node;
}

/**
 * What Alt+Shift+arrow does from pane `paneId`: the split whose divider moves, and its new ratio,
 * or null when no divider runs across that axis.
 *
 * The divider moves towards the arrow, by `step` of its split, and no further than a mouse can
 * drag it. It is the nearest divider on that side of the pane, which grows the pane; at the tab's
 * edge, where there is none, the one on the other side moves the same way and the pane shrinks,
 * as in Windows Terminal.
 */
export function resizeTowards(
	root: PaneNode,
	paneId: string,
	direction: PaneDirection,
	step: number = PANE_RESIZE_STEP,
): { path: NodePath; ratio: number } | null {
	const leaf = paneLeaves(root).find((candidate) => candidate.id === paneId);
	if (leaf === undefined) return null;
	const axis = direction === "left" || direction === "right" ? "vertical" : "horizontal";
	// A divider on the pane's right or lower side belongs to a split holding the pane first.
	const turnOnThatSide = direction === "right" || direction === "down" ? "first" : "second";
	let fallback: NodePath | null = null;
	let target: NodePath | null = null;
	for (let depth = leaf.path.length - 1; depth >= 0; depth--) {
		const splitPath = leaf.path.slice(0, depth);
		const split = nodeAt(root, splitPath);
		if (split === null || split.type !== "split" || split.direction !== axis) continue;
		if (leaf.path[depth] === turnOnThatSide) {
			target = splitPath;
			break;
		}
		fallback ??= splitPath;
	}
	const path = target ?? fallback;
	if (path === null) return null;
	const split = nodeAt(root, path);
	if (split === null || split.type !== "split") return null;
	const towards = direction === "right" || direction === "down" ? step : -step;
	// Rounded, so that steps there and back come back to the same ratio, not one a hair off.
	const ratio = Math.round((split.ratio + towards) * 1e6) / 1e6;
	return { path, ratio: clampSplitRatio(ratio) };
}
