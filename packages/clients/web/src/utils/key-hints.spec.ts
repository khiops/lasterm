/**
 * The keys that work where the keyboard is (#639): what the strips name and the overlay lists,
 * by the kind of control and the place, with the app's own keys read from the shortcut table.
 */
import { describe, expect, it } from "vitest";
import {
	APP_SHORTCUT_NAMES,
	APP_SHORTCUTS,
	type AppActionId,
	outsideTerminalKeys,
	shortcutKeys,
} from "./app-shortcuts.js";
import {
	type ControlKind,
	controlKindOf,
	filterShortcutGroups,
	keyHintsShown,
	keyHintText,
	SHORTCUT_GROUP_NAMES,
	SHORTCUT_GROUPS,
	type ShortcutRow,
	settingsKeyHints,
	shortcutGroupOf,
	windowKeyHints,
	zoneKeyHints,
} from "./key-hints.js";
import SOURCE from "./key-hints.ts?raw";

/** An element from its markup, e.g. `<input type="range">`. */
function element(html: string): Element {
	const holder = document.createElement("div");
	holder.innerHTML = html;
	const el = holder.firstElementChild;
	if (el === null) throw new Error(`no element in ${html}`);
	return el;
}

describe("the kind of control the keyboard is on", () => {
	it.each<[string, ControlKind]>([
		['<input type="checkbox" role="switch">', "switch"],
		['<input type="checkbox">', "switch"],
		['<div role="switch" tabindex="0"></div>', "switch"],
		["<select><option>a</option></select>", "select"],
		['<input type="range">', "range"],
		['<div role="slider" tabindex="0"></div>', "range"],
		['<input type="text">', "textbox"],
		["<input>", "textbox"],
		['<input type="number">', "textbox"],
		['<input type="search">', "textbox"],
		["<textarea></textarea>", "textbox"],
		['<div contenteditable="true"></div>', "textbox"],
		['<input role="combobox">', "textbox"],
		['<button role="tab">Global</button>', "tab"],
		['<input type="radio">', "option"],
		['<button role="option">Mono</button>', "option"],
		["<button>Reset</button>", "other"],
		['<input type="color">', "other"],
		['<a href="#">link</a>', "other"],
	])("reads %s as %s", (html, kind) => {
		expect(controlKindOf(element(html))).toBe(kind);
	});
});

// The issue's own table of hints, for Settings (#639).
describe("the key hints in Settings", () => {
	it.each<[string, ReturnType<typeof settingsKeyHints>, string]>([
		["the menu", settingsKeyHints("menu", "other"), "↑↓ categories · → or Enter open · Esc close"],
		["a switch", settingsKeyHints("detail", "switch"), "Space toggle · Esc back to the menu"],
		// Not Alt+↓: the window takes it for pane.focusDown, even behind Settings (#637).
		["a select", settingsKeyHints("detail", "select"), "↑↓ choose · Esc back to the menu"],
		[
			"a slider",
			settingsKeyHints("detail", "range"),
			"←→ adjust · Home End ends · Esc back to the menu",
		],
		["a text or number field", settingsKeyHints("detail", "textbox"), "Esc back to the menu"],
		["an option", settingsKeyHints("detail", "option"), "←→ choose · Esc back to the menu"],
		["a button in a detail", settingsKeyHints("detail", "other"), "Esc back to the menu"],
		["a scope tab", settingsKeyHints(null, "tab"), "←→ scope · Tab into the settings"],
		["the close button", settingsKeyHints("close", "other"), "Esc close"],
		["the panel itself", settingsKeyHints(null, "other"), "Esc close"],
	])("names on %s: %s", (_where, hints, text) => {
		expect(keyHintText(hints)).toBe(text);
	});
});

describe("the key hints in the window's zones", () => {
	it("names, on an item of each zone, its keys and F6", () => {
		expect(keyHintText(zoneKeyHints("rail", true, "other") ?? [])).toBe(
			"←→↑↓ hosts · Enter select · F6 next area",
		);
		expect(keyHintText(zoneKeyHints("tabs", true, "tab") ?? [])).toBe(
			"←→ tabs · Enter open · Delete close · F6 next area",
		);
		expect(keyHintText(zoneKeyHints("sidebar", true, "other") ?? [])).toBe(
			"↑↓ terminals · Enter open · F6 next area",
		);
	});

	it("names F6 alone on another control of a zone", () => {
		expect(keyHintText(zoneKeyHints("rail", false, "other") ?? [])).toBe("F6 next area");
		expect(keyHintText(zoneKeyHints("tabs", false, "other") ?? [])).toBe("F6 next area");
	});

	// A terminal's keys are its program's; a tab or a terminal being renamed keeps its own.
	it("names nothing in a pane, nor in a text field", () => {
		expect(zoneKeyHints("pane", false, "textbox")).toBeNull();
		expect(zoneKeyHints("pane", false, "other")).toBeNull();
		expect(zoneKeyHints("tabs", false, "textbox")).toBeNull();
		expect(zoneKeyHints("sidebar", true, "textbox")).toBeNull();
	});

	it("reads the zone and the item from the page", () => {
		const layout = element(
			'<div><div data-focus-zone="rail"><div role="button" data-zone-item tabindex="0"></div>' +
				'<button class="footer">+</button></div>' +
				'<div data-focus-zone="pane"><textarea class="xterm-helper-textarea"></textarea></div>' +
				'<button class="outside">x</button></div>',
		);
		const pick = (selector: string): Element => {
			const found = layout.querySelector(selector);
			if (found === null) throw new Error(selector);
			return found;
		};
		expect(keyHintText(windowKeyHints(pick("[data-zone-item]")) ?? [])).toBe(
			"←→↑↓ hosts · Enter select · F6 next area",
		);
		expect(keyHintText(windowKeyHints(pick(".footer")) ?? [])).toBe("F6 next area");
		expect(windowKeyHints(pick("textarea"))).toBeNull();
		expect(windowKeyHints(pick(".outside"))).toBeNull();
	});
});

// "Nothing is written twice": the app's own keys are the table's.
describe("the key hints and the shortcut table", () => {
	it("name the zones' next-area key as the table gives it for outside a terminal", () => {
		const f6 = (outsideTerminalKeys("zone.next") ?? []).join("+");
		expect(f6).toBe("F6");
		for (const zone of ["rail", "sidebar", "tabs"] as const) {
			const hints = zoneKeyHints(zone, true, "other") ?? [];
			expect(hints.at(-1)).toEqual({ keys: [f6], does: "next area" });
		}
	});

	it("never write a chord of the table themselves", () => {
		// The module reads F6 from the table: its source spells no chord of it.
		const code = SOURCE.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
		expect(code).not.toMatch(/["'`]F6["'`]/);
		for (const id of Object.keys(APP_SHORTCUTS) as AppActionId[]) {
			expect(code, id).not.toContain(`"${shortcutKeys(id).join("+")}"`);
		}
	});
});

describe("whether the strip shows", () => {
	it("is on unless [keyboard] key_hints turns it off", () => {
		expect(keyHintsShown(undefined)).toBe(true);
		expect(keyHintsShown({})).toBe(true);
		expect(keyHintsShown({ keyHints: true })).toBe(true);
		expect(keyHintsShown({ keyHints: false })).toBe(false);
	});
});

describe("what the keyboard shortcuts overlay lists", () => {
	const chordRows = (): Extract<ShortcutRow, { kind: "chord" }>[] =>
		SHORTCUT_GROUPS.flatMap((group) =>
			group.rows.filter(
				(row): row is Extract<ShortcutRow, { kind: "chord" }> => row.kind === "chord",
			),
		);

	it("has the groups General, Tabs, Panes, Areas and Settings, in that order", () => {
		expect(SHORTCUT_GROUPS.map((group) => group.name)).toEqual([
			"General",
			"Tabs",
			"Panes",
			"Areas",
			"Settings",
		]);
		expect(SHORTCUT_GROUP_NAMES).toEqual(SHORTCUT_GROUPS.map((group) => group.name));
	});

	it("lists every action of the table once, in its order, with its name and its chord", () => {
		const rows = chordRows();
		expect(rows.map((row) => row.id)).toEqual(
			SHORTCUT_GROUP_NAMES.flatMap((name) =>
				(Object.keys(APP_SHORTCUTS) as AppActionId[]).filter((id) => shortcutGroupOf(id) === name),
			),
		);
		expect(new Set(rows.map((row) => row.id))).toEqual(new Set(Object.keys(APP_SHORTCUTS)));
		for (const row of rows) {
			expect(row.name).toBe(APP_SHORTCUT_NAMES[row.id]);
			expect(row.chord).toEqual(shortcutKeys(row.id));
			expect(row.outsideTerminal).toEqual(outsideTerminalKeys(row.id));
		}
	});

	it("puts each action in the group of its id", () => {
		expect(shortcutGroupOf("palette.open")).toBe("General");
		expect(shortcutGroupOf("help.shortcuts")).toBe("General");
		expect(shortcutGroupOf("settings.open")).toBe("Settings");
		expect(shortcutGroupOf("tab.goTo3")).toBe("Tabs");
		expect(shortcutGroupOf("pane.resizeUp")).toBe("Panes");
		expect(shortcutGroupOf("zone.previous")).toBe("Areas");
	});

	it("lists the keys inside each area and inside Settings, as the strips name them", () => {
		const keys = (group: string): [string, string][] =>
			(SHORTCUT_GROUPS.find((g) => g.name === group)?.rows ?? []).flatMap((row) =>
				row.kind === "keys" ? [[row.name, keyHintText(row.hints)] as [string, string]] : [],
			);
		expect(keys("Areas")).toEqual([
			["Host rail", keyHintText(zoneKeyHints("rail", true, "other") ?? [])],
			["Terminal list", keyHintText(zoneKeyHints("sidebar", true, "other") ?? [])],
			["Tab bar", keyHintText(zoneKeyHints("tabs", true, "other") ?? [])],
			["Back to the pane", "Esc from the rail, the list or the tab bar"],
		]);
		expect(keys("Settings")).toEqual([
			["Menu", keyHintText(settingsKeyHints("menu", "other"))],
			["Scope tabs", keyHintText(settingsKeyHints(null, "tab"))],
			["Switch", keyHintText(settingsKeyHints("detail", "switch"))],
			["Drop-down list", keyHintText(settingsKeyHints("detail", "select"))],
			["Slider", keyHintText(settingsKeyHints("detail", "range"))],
			["Choice of options", keyHintText(settingsKeyHints("detail", "option"))],
			["Text or number field", keyHintText(settingsKeyHints("detail", "textbox"))],
		]);
	});
});

describe("the overlay's search", () => {
	const names = (query: string): string[] =>
		filterShortcutGroups(SHORTCUT_GROUPS, query).flatMap((group) =>
			group.rows.map((row) => row.name),
		);

	it("keeps everything for an empty query", () => {
		expect(filterShortcutGroups(SHORTCUT_GROUPS, "  ")).toBe(SHORTCUT_GROUPS);
	});

	it("finds rows by name, in any case", () => {
		expect(names("split")).toEqual(["Split Right", "Split Down"]);
		expect(names("PALETTE")).toEqual(["Command Palette"]);
	});

	it("finds rows by their keys, and by their group", () => {
		expect(names("ctrl+shift+w")).toEqual(["Close Pane"]);
		expect(names("ctrl+/")).toEqual(["Keyboard Shortcuts"]);
		// F6 moves between the areas, and each area's strip names it.
		expect(names("f6")).toEqual([
			"Next Area (rail, list, tabs, pane)",
			"Previous Area",
			"Host rail",
			"Terminal list",
			"Tab bar",
		]);
		expect(names("slider")).toEqual(["Slider"]);
		expect(filterShortcutGroups(SHORTCUT_GROUPS, "panes").map((group) => group.name)).toEqual([
			"Panes",
		]);
	});

	it("needs every word, and drops the groups left empty", () => {
		expect(names("focus left")).toEqual(["Focus Left"]);
		expect(names("resize alt")).toEqual([
			"Resize Left",
			"Resize Right",
			"Resize Up",
			"Resize Down",
		]);
		expect(filterShortcutGroups(SHORTCUT_GROUPS, "nothing like this")).toEqual([]);
	});
});
