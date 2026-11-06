/**
 * base.css is the list of the `--nt-*` variables: it gives each one its value before a theme is
 * applied, and applyTheme overwrites them. A variable named anywhere else and declared nowhere
 * resolves to its fallback in every theme, as `--nt-sidebar-bg` did for every toast (#830).
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useThemeStore } from "../stores/theme.js";
import BASE from "./base.css?raw";

const SOURCES: Record<string, string> = {
	...import.meta.glob<string>("../**/*.vue", { query: "?raw", import: "default", eager: true }),
	"./base.css": BASE,
};

const DECLARED = new Set([...BASE.matchAll(/^\s*(--nt-[\w-]+)\s*:/gm)].map((m) => m[1] ?? ""));

describe("base.css (#830)", () => {
	it("declares every --nt-* variable the web client names", () => {
		expect(Object.keys(SOURCES).length).toBeGreaterThan(50);
		const undeclared: string[] = [];
		for (const [file, source] of Object.entries(SOURCES)) {
			for (const [, name] of source.matchAll(/var\(\s*(--nt-[\w-]+)/g)) {
				if (name && !DECLARED.has(name)) undeclared.push(`${file}: ${name}`);
			}
		}
		expect(undeclared).toEqual([]);
	});

	it("declares every variable a theme sets", () => {
		const root = document.documentElement.style;
		for (const theme of Object.values(BUNDLED_THEMES)) {
			document.documentElement.removeAttribute("style");
			setActivePinia(createPinia());
			useThemeStore().applyTheme(theme);
			for (let i = 0; i < root.length; i++) {
				const name = root.item(i);
				if (name.startsWith("--nt-")) expect(DECLARED.has(name), name).toBe(true);
			}
		}
	});
});

/** One selector of a rule of base.css, with the declarations of its rule. */
interface Rule {
	selector: string;
	body: string;
}

/** base.css's rules, comments left out, one entry per selector of a list. */
const RULES: Rule[] = [...BASE.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
	.flatMap(([, list = "", body = ""]) =>
		// A comma inside :where() or :not() does not end a selector.
		list.split(/,(?![^(]*\))/).map((selector) => ({ selector: selector.trim(), body })),
	)
	.filter((rule) => !rule.selector.startsWith(":root"));

const SCROLLBAR = /::-webkit-scrollbar$/;

/** The rules that take an element's scrollbars away, by the standard property or the -webkit- one. */
function hidingRules(element: Element): string[] {
	return RULES.filter(
		({ selector, body }) =>
			(/scrollbar-width:\s*none/.test(body) && !SCROLLBAR.test(selector)) ||
			(SCROLLBAR.test(selector) && /display:\s*none/.test(body)),
	)
		.filter(({ selector }) => element.matches(selector.replace(SCROLLBAR, "")))
		.map(({ selector }) => selector);
}

/** What the rules matching an element say of one of its properties, in the sheet's order. */
function declared(element: Element, property: string, scrollbar = false): string[] {
	return RULES.filter(({ selector }) => SCROLLBAR.test(selector) === scrollbar)
		.filter(({ selector }) => element.matches(selector.replace(SCROLLBAR, "")))
		.flatMap(({ body }) =>
			[...body.matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, "g"))].map(
				(m) => m[1]?.trim() ?? "",
			),
		);
}

// A reader's pane draws its terminal at another client's size (#831). Smaller
// than the terminal, it scrolls, and with Settings › Appearance › Scrollbar
// style "Hidden" it drew no scrollbar: the cut text was the only sign that the
// terminal went on past its edges (#845).
describe("base.css: scrollbars in hidden mode (#845)", () => {
	let reader: Element;
	let xtermScrollbar: Element;
	let viewport: Element;
	let list: Element;

	beforeEach(() => {
		document.body.innerHTML = `
			<div class="terminal-container terminal-container--follows">
				<div class="xterm">
					<div class="xterm-viewport"></div>
					<div class="xterm-scrollable-element"><div class="scrollbar vertical"></div></div>
				</div>
			</div>
			<div class="sidebar-list"></div>`;
		const find = (selector: string): Element => {
			const element = document.querySelector(selector);
			if (!element) throw new Error(`no ${selector}`);
			return element;
		};
		reader = find(".terminal-container--follows");
		xtermScrollbar = find(".xterm-scrollable-element > .scrollbar");
		viewport = find(".xterm-viewport");
		list = find(".sidebar-list");
		document.documentElement.classList.add("nt-scrollbar-hidden");
	});

	afterEach(() => {
		document.documentElement.classList.remove("nt-scrollbar-hidden");
		document.body.innerHTML = "";
	});

	it("never takes a reader's pane's own scrollbars away", () => {
		expect(hidingRules(reader)).toEqual([]);
	});

	it("draws them thin, in every engine", () => {
		expect(declared(reader, "scrollbar-width")).toEqual(["thin"]);
		// --nt-scrollbar-width, which `*::-webkit-scrollbar` takes, is 0 here.
		expect(declared(reader, "width", true).at(-1)).toMatch(/^[1-9]\d*px$/);
		expect(declared(reader, "height", true).at(-1)).toMatch(/^[1-9]\d*px$/);
	});

	it("still hides every other scrollbar, xterm's own in a reader's pane too", () => {
		expect(hidingRules(list)).toHaveLength(2);
		expect(hidingRules(viewport)).toHaveLength(2);
		expect(declared(xtermScrollbar, "display")).toContain("none");
	});

	it("hides none in the other styles", () => {
		document.documentElement.classList.remove("nt-scrollbar-hidden");
		for (const element of [reader, viewport, list]) expect(hidingRules(element)).toEqual([]);
		expect(declared(xtermScrollbar, "display")).toEqual([]);
		expect(declared(reader, "scrollbar-width")).toEqual([]);
	});
});

// Thin and Wide drew the same scrollbars in Chromium 121+ and Firefox: the
// style's width reached only the -webkit- rules, and Chromium ignores those
// once an element has a standard scrollbar-color, as `*` gives every one (#853).
describe("base.css: the scrollbar style, by the standard scrollbar-width (#853)", () => {
	let element: Element;
	let reader: Element;

	beforeEach(() => {
		setActivePinia(createPinia());
		document.body.innerHTML = `
			<div class="terminal-container terminal-container--follows"></div>
			<div class="settings-body"></div>`;
		reader = document.querySelector(".terminal-container--follows") as Element;
		element = document.querySelector(".settings-body") as Element;
	});

	afterEach(() => {
		document.documentElement.removeAttribute("class");
		document.documentElement.removeAttribute("style");
		document.body.innerHTML = "";
	});

	/** An element's scrollbar-width: the last rule that says, here also the most specific one. */
	function scrollbarWidth(of: Element): string {
		return declared(of, "scrollbar-width").at(-1) ?? "auto";
	}

	const STYLES = [
		{ style: "thin", own: "thin", inReader: "thin" },
		{ style: "wide", own: "auto", inReader: "auto" },
		{ style: "hidden", own: "none", inReader: "thin" },
	] as const;

	for (const { style, own, inReader } of STYLES) {
		it(`${style} gives an element scrollbar-width ${own}, and a reader's pane ${inReader}`, () => {
			useThemeStore().applyScrollbar({
				style,
				thumbColor: "",
				trackColor: "",
				widthThin: 6,
				widthWide: 14,
			});
			expect(scrollbarWidth(element)).toBe(own);
			expect(scrollbarWidth(reader)).toBe(inReader);
		});
	}
});
