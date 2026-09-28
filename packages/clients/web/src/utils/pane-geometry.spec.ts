import { describe, expect, it } from "vitest";
import type { PaneNode } from "../composables/usePaneTree.js";
import {
	clampSplitRatio,
	PANE_RESIZE_STEP,
	paneInDirection,
	paneLeaves,
	paneRects,
	resizeTowards,
	SPLIT_RATIO_MAX,
	SPLIT_RATIO_MIN,
} from "./pane-geometry.js";

// ─── Building layouts ────────────────────────────────────────────────────────

const t = (id: string): PaneNode => ({ type: "terminal", channelId: `ch-${id}`, paneId: id });
const vacant = (id: string): PaneNode => ({ type: "vacant", id });
/** Side by side: `first` on the left. */
const cols = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
	type: "split",
	direction: "vertical",
	ratio,
	first,
	second,
});
/** Stacked: `first` on top. */
const rows = (first: PaneNode, second: PaneNode, ratio = 0.5): PaneNode => ({
	type: "split",
	direction: "horizontal",
	ratio,
	first,
	second,
});

const DIRECTIONS = ["left", "right", "up", "down"] as const;

/** Where Alt+arrow goes from each side of `id`. */
function neighbours(root: PaneNode, id: string) {
	return Object.fromEntries(DIRECTIONS.map((d) => [d, paneInDirection(root, id, d)]));
}

// ─── The panes' rectangles ───────────────────────────────────────────────────

describe("paneRects", () => {
	it("fills the tab with one pane", () => {
		expect(paneRects(t("a"))).toEqual([{ id: "a", left: 0, top: 0, right: 1, bottom: 1 }]);
	});

	it("gives a split's first child its ratio: the left one, or the upper one", () => {
		const root = cols(t("a"), rows(t("b"), vacant("v"), 0.25), 0.4);
		expect(paneRects(root)).toEqual([
			{ id: "a", left: 0, top: 0, right: 0.4, bottom: 1 },
			{ id: "b", left: 0.4, top: 0, right: 1, bottom: 0.25 },
			{ id: "v", left: 0.4, top: 0.25, right: 1, bottom: 1 },
		]);
	});

	it("lists the leaves in the tree's order, empty panes included, with their paths", () => {
		const root = cols(t("a"), rows(t("b"), vacant("v")));
		expect(paneLeaves(root).map((leaf) => [leaf.id, leaf.path])).toEqual([
			["a", ["first"]],
			["b", ["second", "first"]],
			["v", ["second", "second"]],
		]);
	});
});

// ─── Alt+arrows ──────────────────────────────────────────────────────────────

describe("paneInDirection", () => {
	it("goes nowhere from a tab's only pane", () => {
		expect(neighbours(t("a"), "a")).toEqual({ left: null, right: null, up: null, down: null });
	});

	it("crosses a split side by side, and stops at the tab's edges", () => {
		const root = cols(t("a"), t("b"));
		expect(neighbours(root, "a")).toEqual({ left: null, right: "b", up: null, down: null });
		expect(neighbours(root, "b")).toEqual({ left: "a", right: null, up: null, down: null });
	});

	it("crosses a stacked split", () => {
		const root = rows(t("a"), t("b"));
		expect(neighbours(root, "a")).toEqual({ left: null, right: null, up: null, down: "b" });
		expect(neighbours(root, "b")).toEqual({ left: null, right: null, up: "a", down: null });
	});

	// a | b
	//   | c
	it("goes from a tall pane to the upper of two it shares its side with equally", () => {
		const root = cols(t("a"), rows(t("b"), t("c")));
		expect(paneInDirection(root, "a", "right")).toBe("b");
		expect(paneInDirection(root, "b", "left")).toBe("a");
		expect(paneInDirection(root, "c", "left")).toBe("a");
		expect(neighbours(root, "b")).toEqual({ left: "a", right: null, up: null, down: "c" });
		expect(paneInDirection(root, "c", "up")).toBe("b");
	});

	// a | c      a: top 30%, c: top 70%
	// b | d
	it("goes to the pane it shares more of its side with, and never to one beside it only at a corner", () => {
		const root = cols(rows(t("a"), t("b"), 0.3), rows(t("c"), t("d"), 0.7));
		// a (0–0.3) meets c only.
		expect(paneInDirection(root, "a", "right")).toBe("c");
		// b (0.3–1) meets c over 0.4 and d over 0.3.
		expect(paneInDirection(root, "b", "right")).toBe("c");
		// d (0.7–1) meets b only.
		expect(paneInDirection(root, "d", "left")).toBe("b");
		// c (0–0.7) meets a over 0.3 and b over 0.4.
		expect(paneInDirection(root, "c", "left")).toBe("b");
	});

	// a | b
	// --+--
	// c | d
	it("moves around a grid of four", () => {
		const root = rows(cols(t("a"), t("b")), cols(t("c"), t("d")));
		expect(neighbours(root, "a")).toEqual({ left: null, right: "b", up: null, down: "c" });
		expect(neighbours(root, "b")).toEqual({ left: "a", right: null, up: null, down: "d" });
		expect(neighbours(root, "c")).toEqual({ left: null, right: "d", up: "a", down: null });
		expect(neighbours(root, "d")).toEqual({ left: "c", right: null, up: "b", down: null });
	});

	// a | b | c
	it("goes to the nearest pane on that side, not one further", () => {
		const root = cols(t("a"), cols(t("b"), t("c")));
		expect(paneInDirection(root, "a", "right")).toBe("b");
		expect(paneInDirection(root, "c", "left")).toBe("b");
		expect(paneInDirection(root, "b", "right")).toBe("c");
	});

	it("goes to an empty pane as to any other", () => {
		const root = cols(t("a"), vacant("v"));
		expect(paneInDirection(root, "a", "right")).toBe("v");
		expect(paneInDirection(root, "v", "left")).toBe("a");
	});

	it("goes nowhere from a pane the tab does not hold", () => {
		expect(paneInDirection(cols(t("a"), t("b")), "gone", "right")).toBeNull();
	});
});

// ─── Alt+Shift+arrows ────────────────────────────────────────────────────────

describe("resizeTowards", () => {
	it("moves the divider on that side of the pane, which grows towards it", () => {
		const root = cols(t("a"), t("b"));
		expect(resizeTowards(root, "a", "right")).toEqual({ path: [], ratio: 0.55 });
		expect(resizeTowards(root, "b", "left")).toEqual({ path: [], ratio: 0.45 });
		const stacked = rows(t("a"), t("b"));
		expect(resizeTowards(stacked, "a", "down")).toEqual({ path: [], ratio: 0.55 });
		expect(resizeTowards(stacked, "b", "up")).toEqual({ path: [], ratio: 0.45 });
	});

	// Windows Terminal's: the divider still moves the way of the arrow.
	it("at the tab's edge, moves the divider on the other side, and the pane shrinks", () => {
		const root = cols(t("a"), t("b"));
		expect(resizeTowards(root, "a", "left")).toEqual({ path: [], ratio: 0.45 });
		expect(resizeTowards(root, "b", "right")).toEqual({ path: [], ratio: 0.55 });
	});

	it("does nothing when no divider runs across that axis", () => {
		expect(resizeTowards(t("a"), "a", "left")).toBeNull();
		const root = cols(t("a"), t("b"));
		expect(resizeTowards(root, "a", "up")).toBeNull();
		expect(resizeTowards(root, "b", "down")).toBeNull();
	});

	// a | b | c   (b and c share the second half)
	it("takes the nearest divider on that side, in a nested split", () => {
		const root = cols(t("a"), cols(t("b"), t("c")));
		// b's right side is the inner divider; its left side is the root's.
		expect(resizeTowards(root, "b", "right")).toEqual({ path: ["second"], ratio: 0.55 });
		expect(resizeTowards(root, "b", "left")).toEqual({ path: [], ratio: 0.45 });
		// c has no divider on its right: the nearest on its left moves right.
		expect(resizeTowards(root, "c", "right")).toEqual({ path: ["second"], ratio: 0.55 });
		expect(resizeTowards(root, "a", "right")).toEqual({ path: [], ratio: 0.55 });
	});

	// a | b
	//   | c
	it("reaches past a split of the other axis", () => {
		const root = cols(t("a"), rows(t("b"), t("c")));
		expect(resizeTowards(root, "c", "left")).toEqual({ path: [], ratio: 0.45 });
		expect(resizeTowards(root, "c", "up")).toEqual({ path: ["second"], ratio: 0.45 });
		expect(resizeTowards(root, "b", "down")).toEqual({ path: ["second"], ratio: 0.55 });
		expect(resizeTowards(root, "a", "down")).toBeNull();
	});

	it("moves an empty pane's divider as any other", () => {
		expect(resizeTowards(rows(vacant("v"), t("a")), "v", "down")).toEqual({
			path: [],
			ratio: 0.55,
		});
	});

	it("goes no further than the mouse can drag a divider", () => {
		expect(resizeTowards(cols(t("a"), t("b"), 0.88), "a", "right")?.ratio).toBe(SPLIT_RATIO_MAX);
		expect(resizeTowards(cols(t("a"), t("b"), SPLIT_RATIO_MAX), "a", "right")?.ratio).toBe(
			SPLIT_RATIO_MAX,
		);
		expect(resizeTowards(cols(t("a"), t("b"), 0.12), "b", "left")?.ratio).toBe(SPLIT_RATIO_MIN);
	});

	it("steps by a twentieth of the split", () => {
		expect(PANE_RESIZE_STEP).toBe(0.05);
		expect(resizeTowards(cols(t("a"), t("b"), 0.3), "a", "right")?.ratio).toBeCloseTo(0.35);
	});

	it("does nothing from a pane the tab does not hold", () => {
		expect(resizeTowards(cols(t("a"), t("b")), "gone", "right")).toBeNull();
	});
});

describe("clampSplitRatio", () => {
	it("keeps a ratio within the bounds a divider can be dragged to", () => {
		expect([SPLIT_RATIO_MIN, SPLIT_RATIO_MAX]).toEqual([0.1, 0.9]);
		expect(clampSplitRatio(0)).toBe(0.1);
		expect(clampSplitRatio(0.5)).toBe(0.5);
		expect(clampSplitRatio(1)).toBe(0.9);
	});
});
