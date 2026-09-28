import { describe, expect, it } from "vitest";
import { tabToSwitchTo } from "./tab-switch.js";

const TABS = ["t0", "t1", "t2", "t3"];
const ALL = null;

describe("Ctrl+Tab and Ctrl+Shift+Tab", () => {
	it("go to the next and the previous tab", () => {
		expect(tabToSwitchTo("next", TABS, 1, ALL)).toBe(2);
		expect(tabToSwitchTo("previous", TABS, 1, ALL)).toBe(0);
	});

	it("wrap around at either end", () => {
		expect(tabToSwitchTo("next", TABS, 3, ALL)).toBe(0);
		expect(tabToSwitchTo("previous", TABS, 0, ALL)).toBe(3);
	});

	it("stay on a tab that is alone", () => {
		expect(tabToSwitchTo("next", ["t0"], 0, ALL)).toBe(0);
		expect(tabToSwitchTo("previous", ["t0"], 0, ALL)).toBe(0);
	});

	it("go nowhere without a tab", () => {
		expect(tabToSwitchTo("next", [], 0, ALL)).toBeNull();
		expect(tabToSwitchTo({ goTo: 1 }, [], 0, ALL)).toBeNull();
	});
});

describe("Ctrl+Alt+digit", () => {
	it("goes to tab N", () => {
		expect(tabToSwitchTo({ goTo: 1 }, TABS, 3, ALL)).toBe(0);
		expect(tabToSwitchTo({ goTo: 3 }, TABS, 0, ALL)).toBe(2);
	});

	it("goes to the last tab past the count", () => {
		expect(tabToSwitchTo({ goTo: 5 }, TABS, 0, ALL)).toBe(3);
		expect(tabToSwitchTo({ goTo: 8 }, TABS, 0, ALL)).toBe(3);
	});

	// As in Windows Terminal: 9 is the last, however many tabs there are.
	it("goes to the last tab on 9, even with more than nine", () => {
		const twelve = Array.from({ length: 12 }, (_, i) => `t${i}`);
		expect(tabToSwitchTo({ goTo: 9 }, twelve, 0, ALL)).toBe(11);
		expect(tabToSwitchTo({ goTo: 8 }, twelve, 0, ALL)).toBe(7);
		expect(tabToSwitchTo({ goTo: 9 }, TABS, 0, ALL)).toBe(3);
	});
});

// With `[tabs] scope = "perHost"` the bar shows the tabs of the host in view only.
describe("with the bar showing one host's tabs", () => {
	const inView = new Set(["t0", "t2", "t3"]);

	it("counts only the tabs on the bar", () => {
		expect(tabToSwitchTo("next", TABS, 0, inView)).toBe(2);
		expect(tabToSwitchTo("previous", TABS, 2, inView)).toBe(0);
		expect(tabToSwitchTo("next", TABS, 3, inView)).toBe(0);
		expect(tabToSwitchTo({ goTo: 2 }, TABS, 0, inView)).toBe(2);
		expect(tabToSwitchTo({ goTo: 9 }, TABS, 0, inView)).toBe(3);
	});

	it("goes from a tab off the bar to the first shown, or the last", () => {
		expect(tabToSwitchTo("next", TABS, 1, inView)).toBe(0);
		expect(tabToSwitchTo("previous", TABS, 1, inView)).toBe(3);
	});

	it("goes nowhere when the bar shows none", () => {
		expect(tabToSwitchTo("next", TABS, 0, new Set())).toBeNull();
	});
});
