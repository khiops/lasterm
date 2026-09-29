import { describe, expect, it } from "vitest";
import {
	FOCUS_ZONES,
	type FocusZone,
	focusZoneOf,
	gridMove,
	listMove,
	nextInCycle,
	zoneAfter,
} from "./focus-zones.js";

const everywhere = (): boolean => true;
const except =
	(...hidden: FocusZone[]) =>
	(zone: FocusZone): boolean =>
		!hidden.includes(zone);

describe("F6 and Shift+F6", () => {
	it("visit the rail, the terminal list, the tab bar and the pane, in that order", () => {
		expect(FOCUS_ZONES).toEqual(["rail", "sidebar", "tabs", "pane"]);
		const visited: FocusZone[] = [];
		let zone: FocusZone = "pane";
		for (let i = 0; i < 4; i++) {
			zone = zoneAfter(zone, 1, everywhere) ?? zone;
			visited.push(zone);
		}
		expect(visited).toEqual(["rail", "sidebar", "tabs", "pane"]);
	});

	it("go the other way round with Shift", () => {
		const visited: FocusZone[] = [];
		let zone: FocusZone = "pane";
		for (let i = 0; i < 4; i++) {
			zone = zoneAfter(zone, -1, everywhere) ?? zone;
			visited.push(zone);
		}
		expect(visited).toEqual(["tabs", "sidebar", "rail", "pane"]);
	});

	it("pass over a zone that is hidden or has nothing to focus", () => {
		// The terminal list folded away.
		expect(zoneAfter("rail", 1, except("sidebar"))).toBe("tabs");
		expect(zoneAfter("tabs", -1, except("sidebar"))).toBe("rail");
		// No tab: neither the bar nor a pane can take the keyboard.
		expect(zoneAfter("sidebar", 1, except("tabs", "pane"))).toBe("rail");
	});

	it("stay put when no other zone can take the keyboard", () => {
		expect(zoneAfter("pane", 1, (zone) => zone === "pane")).toBeNull();
		expect(zoneAfter("rail", -1, () => false)).toBeNull();
	});
});

// The window's Esc and F6, and the key hints (#639), ask which zone an element is in.
describe("focusZoneOf", () => {
	it("is the zone an element sits under, or null outside every zone", () => {
		const rail = document.createElement("div");
		rail.dataset.focusZone = "rail";
		const badge = document.createElement("button");
		rail.appendChild(badge);
		const elsewhere = document.createElement("button");
		const unknown = document.createElement("div");
		unknown.dataset.focusZone = "footer";
		const inUnknown = document.createElement("button");
		unknown.appendChild(inUnknown);
		expect(focusZoneOf(badge)).toBe("rail");
		expect(focusZoneOf(rail)).toBe("rail");
		expect(focusZoneOf(elsewhere)).toBeNull();
		expect(focusZoneOf(inUnknown)).toBeNull();
		expect(focusZoneOf(null)).toBeNull();
		expect(focusZoneOf(window)).toBeNull();
	});
});

// Settings' own zones use it: its menu, its detail and its close button (#637).
describe("nextInCycle", () => {
	const ORDER = ["menu", "detail", "close"] as const;
	const any = (): boolean => true;

	it("goes round the list both ways", () => {
		expect(nextInCycle(ORDER, "menu", 1, any)).toBe("detail");
		expect(nextInCycle(ORDER, "close", 1, any)).toBe("menu");
		expect(nextInCycle(ORDER, "menu", -1, any)).toBe("close");
	});

	it("starts from the first going forward, and from the last going back, from nowhere", () => {
		expect(nextInCycle(ORDER, null, 1, any)).toBe("menu");
		expect(nextInCycle(ORDER, null, -1, any)).toBe("close");
	});

	it("passes over what cannot take the keyboard, and stays put when nothing else can", () => {
		expect(nextInCycle(ORDER, "menu", 1, (item) => item !== "detail")).toBe("close");
		expect(nextInCycle(ORDER, "menu", 1, (item) => item === "menu")).toBeNull();
		expect(nextInCycle(ORDER, null, 1, () => false)).toBeNull();
	});
});

describe("listMove", () => {
	it("moves along a row with ← and →, and down a column with ↑ and ↓", () => {
		expect(listMove(4, 1, "ArrowRight", "horizontal")).toBe(2);
		expect(listMove(4, 1, "ArrowLeft", "horizontal")).toBe(0);
		expect(listMove(4, 1, "ArrowDown", "vertical")).toBe(2);
		expect(listMove(4, 1, "ArrowUp", "vertical")).toBe(0);
	});

	it("goes to either end with Home and End", () => {
		expect(listMove(4, 2, "Home", "horizontal")).toBe(0);
		expect(listMove(4, 1, "End", "vertical")).toBe(3);
	});

	it("stays at either end", () => {
		expect(listMove(4, 0, "ArrowLeft", "horizontal")).toBe(0);
		expect(listMove(4, 3, "ArrowDown", "vertical")).toBe(3);
	});

	it("leaves the other keys, and the other axis, alone", () => {
		expect(listMove(4, 1, "ArrowDown", "horizontal")).toBeNull();
		expect(listMove(4, 1, "ArrowRight", "vertical")).toBeNull();
		expect(listMove(4, 1, "Enter", "vertical")).toBeNull();
		expect(listMove(0, 0, "ArrowDown", "vertical")).toBeNull();
		expect(listMove(4, -1, "ArrowDown", "vertical")).toBeNull();
	});
});

describe("gridMove", () => {
	// The rail's rows in three columns: the local host alone, then Prod's a–e, then u1 and u2,
	// with the group headers between them left out.
	const THREE = [["local"], ["a", "b", "c"], ["d", "e"], ["u1", "u2"]];
	const ONE = [["local"], ["a"], ["b"], ["c"], ["d"], ["e"], ["u1"], ["u2"]];

	it("moves within a row with ← and →, and stops at its ends", () => {
		expect(gridMove(THREE, "b", "ArrowRight")).toBe("c");
		expect(gridMove(THREE, "b", "ArrowLeft")).toBe("a");
		expect(gridMove(THREE, "c", "ArrowRight")).toBe("c");
		expect(gridMove(THREE, "d", "ArrowLeft")).toBe("d");
	});

	it("moves between rows with ↑ and ↓, to the same column", () => {
		expect(gridMove(THREE, "a", "ArrowDown")).toBe("d");
		expect(gridMove(THREE, "e", "ArrowUp")).toBe("b");
	});

	it("lands on the last of a shorter row", () => {
		expect(gridMove(THREE, "c", "ArrowDown")).toBe("e");
	});

	it("crosses the group headers between the rows", () => {
		expect(gridMove(THREE, "local", "ArrowDown")).toBe("a");
		expect(gridMove(THREE, "b", "ArrowUp")).toBe("local");
		expect(gridMove(THREE, "e", "ArrowDown")).toBe("u2");
		expect(gridMove(THREE, "u1", "ArrowUp")).toBe("d");
	});

	it("stops at the first and the last row", () => {
		expect(gridMove(THREE, "local", "ArrowUp")).toBe("local");
		expect(gridMove(THREE, "u2", "ArrowDown")).toBe("u2");
	});

	it("goes to the first and the last badge with Home and End", () => {
		expect(gridMove(THREE, "d", "Home")).toBe("local");
		expect(gridMove(THREE, "a", "End")).toBe("u2");
	});

	it("in one column, goes up and down the rail, and nowhere sideways", () => {
		expect(gridMove(ONE, "local", "ArrowDown")).toBe("a");
		expect(gridMove(ONE, "e", "ArrowDown")).toBe("u1");
		expect(gridMove(ONE, "a", "ArrowUp")).toBe("local");
		expect(gridMove(ONE, "c", "ArrowRight")).toBe("c");
		expect(gridMove(ONE, "c", "ArrowLeft")).toBe("c");
	});

	it("leaves other keys and unknown badges alone", () => {
		expect(gridMove(THREE, "a", "Enter")).toBeNull();
		expect(gridMove(THREE, "gone", "ArrowDown")).toBeNull();
		expect(gridMove([], "a", "ArrowDown")).toBeNull();
	});
});
