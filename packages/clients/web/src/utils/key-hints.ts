/**
 * The keys that work where the keyboard is (#639). The strip at the bottom of Settings, the one
 * under the rail and the list, and the keyboard shortcuts overlay all read them here: one source.
 *
 * A hint follows from where the keyboard is — Settings' menu or a category's detail, the host
 * rail, the terminal list, the tab bar — and from the kind of control it is on, read from its
 * role or its element: a switch, a select, a range, a text field, a tab, an option, an item of a
 * zone. The keys of the app's own actions come from the shortcut table (utils/app-shortcuts.ts)
 * and are never written here; the others are the controls' own, as the browser or the component
 * gives them.
 */
import type { KeyboardConfig } from "@lasterm/shared";
import {
	APP_SHORTCUT_NAMES,
	APP_SHORTCUTS,
	type AppActionId,
	outsideTerminalKeys,
	shortcutKeys,
} from "./app-shortcuts.js";
import { type FocusZone, focusZoneOf } from "./focus-zones.js";

/** Keys and what they do there: `{ keys: ["→", "Enter"], does: "open" }` reads "→ or Enter open". */
export interface KeyHint {
	/** Each a way to do it, as its cap is shown. */
	readonly keys: readonly string[];
	readonly does: string;
}

/** A hint line as it reads: "↑↓ categories · → or Enter open · Esc close". */
export function keyHintText(hints: readonly KeyHint[]): string {
	return hints.map((hint) => `${hint.keys.join(" or ")} ${hint.does}`).join(" · ");
}

/** Whether the strip shows at all: `[keyboard] key_hints`, on unless turned off. */
export function keyHintsShown(keyboard: KeyboardConfig | undefined): boolean {
	return keyboard?.keyHints !== false;
}

// ─── What the keyboard is on ─────────────────────────────────────────────────

/**
 * A control's kind, for the keys it takes itself. A checkbox turns with Space as a switch does,
 * and a radio is chosen with the arrows as an option is.
 */
export type ControlKind = "switch" | "select" | "range" | "textbox" | "tab" | "option" | "other";

/** The inputs a user types into. */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** An element's kind of control: its ARIA role first, then what element it is. */
export function controlKindOf(el: Element): ControlKind {
	switch (el.getAttribute("role")) {
		case "switch":
		case "checkbox":
			return "switch";
		case "slider":
			return "range";
		case "textbox":
		case "searchbox":
		case "spinbutton":
		case "combobox":
			return "textbox";
		case "tab":
			return "tab";
		case "option":
		case "radio":
			return "option";
	}
	const tag = el.tagName.toLowerCase();
	if (tag === "select") return "select";
	if (tag === "textarea") return "textbox";
	if (tag === "input") {
		const type = (el.getAttribute("type") ?? "text").toLowerCase();
		if (type === "checkbox") return "switch";
		if (type === "radio") return "option";
		if (type === "range") return "range";
		return TEXT_INPUT_TYPES.has(type) ? "textbox" : "other";
	}
	return el.getAttribute("contenteditable") === "true" ? "textbox" : "other";
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** Settings' own zones (SettingsPanel): its menu, a category's detail, its close button. */
export type SettingsZone = "menu" | "detail" | "close";

const CLOSE_SETTINGS: KeyHint = { keys: ["Esc"], does: "close" };
const BACK_TO_MENU: KeyHint = { keys: ["Esc"], does: "back to the menu" };

const MENU_KEYS: readonly KeyHint[] = [
	{ keys: ["↑↓"], does: "categories" },
	{ keys: ["→", "Enter"], does: "open" },
	CLOSE_SETTINGS,
];

const SCOPE_KEYS: readonly KeyHint[] = [
	{ keys: ["←→"], does: "scope" },
	{ keys: ["Tab"], does: "into the settings" },
];

/**
 * The keys a control takes itself, in a category's detail; a text field's are its typing. A
 * select's are its arrows: Alt+↓, which would open it, is the table's `pane.focusDown`, which the
 * window takes from the page behind a modal dialog (#637), so the select never gets it.
 */
const CONTROL_KEYS: Readonly<Record<ControlKind, readonly KeyHint[]>> = {
	switch: [{ keys: ["Space"], does: "toggle" }],
	select: [{ keys: ["↑↓"], does: "choose" }],
	range: [
		{ keys: ["←→"], does: "adjust" },
		{ keys: ["Home End"], does: "ends" },
	],
	textbox: [],
	tab: [{ keys: ["←→"], does: "tabs" }],
	option: [{ keys: ["←→"], does: "choose" }],
	other: [],
};

/**
 * The keys where the keyboard is in Settings: in its menu, the menu's; in a category's detail, the
 * control's own and Esc back to the menu; on a scope tab (the panel's tablist, outside the
 * detail), the scopes'; anywhere else in the panel, Esc closes it (SettingsPanel's own rules).
 */
export function settingsKeyHints(zone: SettingsZone | null, kind: ControlKind): readonly KeyHint[] {
	if (zone === "menu") return MENU_KEYS;
	if (zone === "detail") return [...CONTROL_KEYS[kind], BACK_TO_MENU];
	if (kind === "tab") return SCOPE_KEYS;
	return [CLOSE_SETTINGS];
}

// ─── The window's zones ──────────────────────────────────────────────────────

/** The zones with a strip: the rail, the terminal list and the tab bar. Never a pane. */
export type HintZone = Exclude<FocusZone, "pane">;

/** F6 where the zones have a strip, which is outside a terminal: the table's chord for there. */
function nextAreaHint(): KeyHint {
	const keys = outsideTerminalKeys("zone.next") ?? shortcutKeys("zone.next");
	return { keys: [keys.join("+")], does: "next area" };
}

/** The keys on a zone's items: a host, a terminal, a tab (HostRail, ChannelSidebar, TabBar). */
const ZONE_ITEM_KEYS: Readonly<Record<HintZone, readonly KeyHint[]>> = {
	rail: [
		{ keys: ["←→↑↓"], does: "hosts" },
		{ keys: ["Enter"], does: "select" },
	],
	sidebar: [
		{ keys: ["↑↓"], does: "terminals" },
		{ keys: ["Enter"], does: "open" },
	],
	tabs: [
		{ keys: ["←→"], does: "tabs" },
		{ keys: ["Enter"], does: "open" },
		{ keys: ["Delete"], does: "close" },
	],
};

/**
 * The keys in one of the window's zones: on one of its items, its arrows and keys, then F6; on
 * another control there (a button), F6 alone. None in the panes, whose keys are the terminal's
 * program's, nor in a text field (a tab or a terminal being renamed), which keeps its own.
 */
export function zoneKeyHints(
	zone: FocusZone,
	onItem: boolean,
	kind: ControlKind,
): readonly KeyHint[] | null {
	if (zone === "pane" || kind === "textbox") return null;
	return [...(onItem ? ZONE_ITEM_KEYS[zone] : []), nextAreaHint()];
}

/** The keys for where the keyboard is in the window: its zone's, from its `data-focus-zone`. */
export function windowKeyHints(el: Element): readonly KeyHint[] | null {
	const zone = focusZoneOf(el);
	if (zone === null) return null;
	return zoneKeyHints(zone, el.hasAttribute("data-zone-item"), controlKindOf(el));
}

// ─── The keyboard shortcuts overlay ──────────────────────────────────────────

export const SHORTCUT_GROUP_NAMES = ["General", "Tabs", "Panes", "Areas", "Settings"] as const;
export type ShortcutGroupName = (typeof SHORTCUT_GROUP_NAMES)[number];

/** The group an action of the table is listed under, from the first part of its id. */
export function shortcutGroupOf(id: AppActionId): ShortcutGroupName {
	switch (id.split(".")[0]) {
		case "tab":
			return "Tabs";
		case "pane":
			return "Panes";
		case "zone":
			return "Areas";
		case "settings":
			return "Settings";
		default:
			return "General";
	}
}

/** A line of the overlay: an action of the table and its chord, or the keys of a place. */
export type ShortcutRow =
	| {
			readonly kind: "chord";
			readonly key: string;
			readonly name: string;
			readonly id: AppActionId;
			readonly chord: readonly string[];
			/** Its chord outside a terminal (F6), or null. */
			readonly outsideTerminal: readonly string[] | null;
	  }
	| {
			readonly kind: "keys";
			readonly key: string;
			readonly name: string;
			readonly hints: readonly KeyHint[];
	  };

export interface ShortcutGroup {
	readonly name: ShortcutGroupName;
	readonly rows: readonly ShortcutRow[];
}

function keysRow(key: string, name: string, hints: readonly KeyHint[] | null): ShortcutRow {
	return { kind: "keys", key, name, hints: hints ?? [] };
}

/** The keys inside each zone, as its strip names them on its items, and Esc out of them. */
const AREA_ROWS: readonly ShortcutRow[] = [
	keysRow("area:rail", "Host rail", zoneKeyHints("rail", true, "other")),
	keysRow("area:sidebar", "Terminal list", zoneKeyHints("sidebar", true, "other")),
	keysRow("area:tabs", "Tab bar", zoneKeyHints("tabs", true, "other")),
	keysRow("area:back", "Back to the pane", [
		{ keys: ["Esc"], does: "from the rail, the list or the tab bar" },
	]),
];

/** The keys inside Settings, as its strip names them. */
const SETTINGS_ROWS: readonly ShortcutRow[] = [
	keysRow("settings:menu", "Menu", settingsKeyHints("menu", "other")),
	keysRow("settings:scope", "Scope tabs", settingsKeyHints(null, "tab")),
	keysRow("settings:switch", "Switch", settingsKeyHints("detail", "switch")),
	keysRow("settings:select", "Drop-down list", settingsKeyHints("detail", "select")),
	keysRow("settings:range", "Slider", settingsKeyHints("detail", "range")),
	keysRow("settings:option", "Choice of options", settingsKeyHints("detail", "option")),
	keysRow("settings:textbox", "Text or number field", settingsKeyHints("detail", "textbox")),
];

/**
 * What the overlay lists: every action of the table, in its order, under its group, then the
 * keys inside the zones (Areas) and inside Settings.
 */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = SHORTCUT_GROUP_NAMES.map((name) => ({
	name,
	rows: [
		...(Object.keys(APP_SHORTCUTS) as AppActionId[])
			.filter((id) => shortcutGroupOf(id) === name)
			.map(
				(id): ShortcutRow => ({
					kind: "chord",
					key: id,
					name: APP_SHORTCUT_NAMES[id],
					id,
					chord: shortcutKeys(id),
					outsideTerminal: outsideTerminalKeys(id),
				}),
			),
		...(name === "Areas" ? AREA_ROWS : []),
		...(name === "Settings" ? SETTINGS_ROWS : []),
	],
}));

/** What a row is found by: its group, its name, and its keys as they read. */
function searchTextOf(group: ShortcutGroup, row: ShortcutRow): string {
	const keys =
		row.kind === "chord"
			? [row.chord.join("+"), row.outsideTerminal?.join("+") ?? ""].join(" ")
			: keyHintText(row.hints);
	return `${group.name} ${row.name} ${keys}`.toLowerCase();
}

/**
 * The rows that hold every word of `query`, in their groups; a group left with none goes. An
 * empty query keeps them all.
 */
export function filterShortcutGroups(
	groups: readonly ShortcutGroup[],
	query: string,
): readonly ShortcutGroup[] {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter((word) => word.length > 0);
	if (words.length === 0) return groups;
	return groups
		.map((group) => ({
			name: group.name,
			rows: group.rows.filter((row) => {
				const text = searchTextOf(group, row);
				return words.every((word) => text.includes(word));
			}),
		}))
		.filter((group) => group.rows.length > 0);
}
