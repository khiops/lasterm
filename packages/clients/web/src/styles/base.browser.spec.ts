/**
 * The scrollbars base.css draws, in a browser: happy-dom draws no scrollbar, knows no
 * `::-webkit-scrollbar` and gives `scrollbar-width` no initial value. The scrollbar style is set
 * as Settings › Appearance sets it (applyScrollbar), and read back from the cascade and from the
 * room the scrollbars take.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./base.css";
import { useThemeStore } from "../stores/theme.js";

type ScrollbarStyle = "thin" | "wide" | "hidden";

function applyScrollbar(style: ScrollbarStyle): void {
	useThemeStore().applyScrollbar({
		style,
		thumbColor: "",
		trackColor: "",
		widthThin: 6,
		widthWide: 14,
	});
}

/** A box that scrolls both ways, holding more than it shows. */
function scroller(classes: string, inside = ""): string {
	return `<div class="${classes}" style="overflow: auto; width: 120px; height: 120px">${inside}<div style="width: 600px; height: 600px"></div></div>`;
}

let reader: HTMLElement;
let viewport: HTMLElement;
let xtermScrollbar: HTMLElement;
let list: HTMLElement;
let settings: HTMLElement;

function find(selector: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(selector);
	if (element === null) throw new Error(`no ${selector}`);
	return element;
}

beforeEach(() => {
	setActivePinia(createPinia());
	document.body.innerHTML = [
		scroller(
			"terminal-container terminal-container--follows",
			`<div class="xterm">${scroller("xterm-viewport")}<div class="xterm-scrollable-element"><div class="scrollbar vertical" style="width: 10px; height: 50px"></div></div></div>`,
		),
		scroller("sidebar-list"),
		scroller("settings-body"),
	].join("");
	reader = find(".terminal-container--follows");
	viewport = find(".xterm-viewport");
	xtermScrollbar = find(".xterm-scrollable-element > .scrollbar");
	list = find(".sidebar-list");
	settings = find(".settings-body");
});

afterEach(() => {
	document.documentElement.removeAttribute("class");
	document.documentElement.removeAttribute("style");
	document.body.replaceChildren();
});

/** The room an element's scrollbars take: its vertical one's width, its horizontal one's height. */
function room(element: HTMLElement): [number, number] {
	return [element.offsetWidth - element.clientWidth, element.offsetHeight - element.clientHeight];
}

function scrollbarWidth(element: Element): string {
	return getComputedStyle(element).getPropertyValue("scrollbar-width");
}

/** What the -webkit- rules give an element's scrollbar. */
function webkitScrollbar(element: Element): { display: string; width: string; height: string } {
	const style = getComputedStyle(element, "::-webkit-scrollbar");
	return { display: style.display, width: style.width, height: style.height };
}

// A reader's pane draws its terminal at another client's size (#831). Smaller
// than the terminal, it scrolls, and with Settings › Appearance › Scrollbar
// style "Hidden" it drew no scrollbar: the cut text was the only sign that the
// terminal went on past its edges (#845).
describe("base.css: scrollbars in hidden mode (#845)", () => {
	beforeEach(() => applyScrollbar("hidden"));

	it("never takes a reader's pane's own scrollbars away", () => {
		const [vertical, horizontal] = room(reader);
		expect(vertical).toBeGreaterThan(0);
		expect(horizontal).toBeGreaterThan(0);
		expect(webkitScrollbar(reader).display).toBe("inline");
	});

	it("draws them thin, in every engine", () => {
		expect(scrollbarWidth(reader)).toBe("thin");
		// --nt-scrollbar-width, which `*::-webkit-scrollbar` takes, is 0 here.
		expect(webkitScrollbar(reader)).toMatchObject({ width: "6px", height: "6px" });
	});

	it("still hides every other scrollbar, xterm's own in a reader's pane too", () => {
		for (const element of [list, viewport, settings]) {
			expect(room(element), element.className).toEqual([0, 0]);
			expect(scrollbarWidth(element), element.className).toBe("none");
			expect(webkitScrollbar(element).display, element.className).toBe("none");
		}
		expect(getComputedStyle(xtermScrollbar).display).toBe("none");
	});
});

describe("base.css: hidden mode alone hides scrollbars (#845)", () => {
	for (const style of ["thin", "wide"] as const) {
		it(`hides none in the ${style} style`, () => {
			applyScrollbar(style);
			for (const element of [reader, viewport, list, settings]) {
				const [vertical, horizontal] = room(element);
				expect(vertical, element.className).toBeGreaterThan(0);
				expect(horizontal, element.className).toBeGreaterThan(0);
				expect(webkitScrollbar(element).display, element.className).toBe("inline");
			}
			expect(getComputedStyle(xtermScrollbar).display).toBe("block");
		});
	}
});

// Thin and Wide drew the same scrollbars in Chromium 121+ and Firefox: the
// style's width reached only the -webkit- rules, and Chromium ignores those
// once an element has a standard scrollbar-color, as `*` gives every one (#853).
describe("base.css: the scrollbar style, by the standard scrollbar-width (#853)", () => {
	const STYLES = [
		{ style: "thin", own: "thin", inReader: "thin" },
		{ style: "wide", own: "auto", inReader: "auto" },
		{ style: "hidden", own: "none", inReader: "thin" },
	] as const;

	for (const { style, own, inReader } of STYLES) {
		it(`${style} gives an element scrollbar-width ${own}, and a reader's pane ${inReader}`, () => {
			applyScrollbar(style);
			expect(scrollbarWidth(settings)).toBe(own);
			expect(scrollbarWidth(reader)).toBe(inReader);
		});
	}

	it("draws Thin narrower than Wide", () => {
		applyScrollbar("thin");
		const [thin] = room(settings);
		applyScrollbar("wide");
		const [wide] = room(settings);
		expect(thin).toBeGreaterThan(0);
		expect(thin).toBeLessThan(wide);
	});
});
