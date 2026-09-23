export interface SettingDefinition {
	/** Property key within the section (e.g. "fontSize", "closeButton") */
	key: string;
	label: string;
	description?: string;
	type: "text" | "number" | "select" | "toggle" | "range" | "color" | "font";
	/** UI category for navigation (e.g. "terminal", "tabs") */
	category: string;
	/**
	 * Config section name.
	 * - "terminal" → terminal profile (cascaded, all scopes)
	 * - "tabs" | "panes" | "search" | "startup" | "title" → UI config sub-section (global only)
	 */
	section: string;
	scopes: ("global" | "host" | "channel")[];
	options?: { label: string; value: string | number | boolean }[];
	min?: number;
	max?: number;
	step?: number;
	default?: string | number | boolean | undefined;
	/**
	 * Conditional visibility: only show this setting when another setting in the
	 * same section matches a specific value.
	 */
	showWhen?: { key: string; section: string; value: string };
	/**
	 * A setting that exists but cannot act while another one says so: shown, and
	 * disabled, with `reason` in place of its description. Hiding it instead
	 * would only raise the question of where it went.
	 */
	disabledWhen?: { key: string; section: string; value: string; reason: string };
}

/** UI config sub-sections — these route through PUT /api/config/ui */
const UI_SECTIONS = new Set(["tabs", "panes", "channels", "search", "startup", "title"]);

/**
 * Map a schema definition to the store's (section, key) pair.
 * - terminal → ("terminal", key)
 * - tabs/panes/search/startup/title → ("ui", "tabs.key")
 */
export function toStoreParams(def: SettingDefinition): {
	storeSection: string;
	storeKey: string;
} {
	if (UI_SECTIONS.has(def.section)) {
		return { storeSection: "ui", storeKey: `${def.section}.${def.key}` };
	}
	return { storeSection: def.section, storeKey: def.key };
}

export const settingsSchema: SettingDefinition[] = [
	// ─── Terminal category (cascaded — all scopes) ─────────────────────
	{
		key: "fontFamily",
		label: "Font Family",
		type: "font",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		description: "Font family for terminal rendering",
	},
	{
		key: "fontSize",
		label: "Font Size",
		type: "number",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		min: 8,
		max: 32,
		step: 1,
	},
	{
		key: "cursorStyle",
		label: "Cursor Style",
		type: "select",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		options: [
			{ label: "Block", value: "block" },
			{ label: "Underline", value: "underline" },
			{ label: "Bar", value: "bar" },
		],
	},
	{
		key: "scrollback",
		label: "Scrollback Lines",
		type: "number",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		min: 100,
		max: 100000,
		step: 100,
	},
	{
		key: "bellSound",
		label: "Bell Sound",
		type: "select",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		description: "Sound when terminal receives BEL character",
		options: [
			{ label: "Mute", value: "mute" },
			{ label: "System", value: "system" },
			{ label: "Custom", value: "custom" },
		],
	},
	{
		key: "bellCustomFile",
		label: "Custom Bell Sound",
		type: "text",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		description: "Audio file name in sounds directory (.wav, .mp3, .ogg)",
		showWhen: { key: "bellSound", section: "terminal", value: "custom" },
	},
	{
		key: "bellBadge",
		label: "Bell Badge",
		type: "toggle",
		category: "terminal",
		section: "terminal",
		scopes: ["global", "host", "channel"],
		description: "Show notification badge on tab when terminal receives BEL",
	},

	// ─── Terminal category — title settings (global only) ──────────────
	{
		key: "source",
		label: "Title Source",
		type: "select",
		category: "terminal",
		section: "title",
		scopes: ["global"],
		options: [
			{ label: "Dynamic (OSC 0/2)", value: "dynamic" },
			{ label: "Static", value: "static" },
			{ label: "Process name", value: "process" },
		],
		description: "Whether to use dynamic terminal title from the shell",
	},
	{
		key: "staticTitle",
		label: "Static Title",
		type: "text",
		category: "terminal",
		section: "title",
		scopes: ["global"],
		default: "Terminal",
		showWhen: { key: "source", section: "title", value: "static" },
	},
	{
		key: "maxLength",
		label: "Max Title Length",
		type: "number",
		category: "terminal",
		section: "title",
		scopes: ["global"],
		min: 10,
		max: 200,
	},
	{
		key: "windowTitle",
		label: "Update Window Title",
		type: "toggle",
		category: "terminal",
		section: "title",
		scopes: ["global"],
		description: "Update browser tab title with terminal title",
	},

	// ─── Tabs category (global only, UI config) ────────────────────────
	{
		key: "closeButton",
		label: "Close Button",
		type: "toggle",
		category: "tabs",
		section: "tabs",
		scopes: ["global"],
		description: "Show close button on tabs",
	},
	{
		key: "newTabPosition",
		label: "New Tab Position",
		type: "select",
		category: "tabs",
		section: "tabs",
		scopes: ["global"],
		options: [
			{ label: "End", value: "end" },
			{ label: "After Active", value: "afterActive" },
		],
	},
	{
		key: "scope",
		label: "Tabs Shown",
		type: "select",
		category: "tabs",
		section: "tabs",
		scopes: ["global"],
		options: [
			{ label: "Every host", value: "global" },
			{ label: "The host in view", value: "perHost" },
		],
		description: "Whether the tab bar keeps every terminal in view or only this host's.",
	},
	{
		key: "hostMarker",
		label: "Host Marker",
		type: "select",
		category: "tabs",
		section: "tabs",
		scopes: ["global"],
		disabledWhen: {
			key: "scope",
			section: "tabs",
			value: "perHost",
			reason: "Every tab in view is already on this host, so there is nothing to tell apart.",
		},
		options: [
			{ label: "Colour dot", value: "dot" },
			{ label: "Host initials", value: "initials" },
			{ label: "Coloured edge", value: "edge" },
			{ label: "None", value: "none" },
		],
		description: "Shows which host a tab's terminal is on.",
	},
	{
		key: "confirmCloseAll",
		label: "Confirm Close All",
		type: "toggle",
		category: "tabs",
		section: "tabs",
		scopes: ["global"],
	},
	{
		key: "confirmCloseOthers",
		label: "Confirm Close Others",
		type: "toggle",
		category: "tabs",
		section: "tabs",
		scopes: ["global"],
	},

	// ─── Panes category (global only, UI config) ───────────────────────
	{
		key: "maxPanes",
		label: "Max Panes",
		type: "number",
		category: "panes",
		section: "panes",
		scopes: ["global"],
		min: 1,
		max: 8,
	},

	// ─── Search category (global only, UI config) ──────────────────────
	{
		key: "position",
		label: "Search Position",
		type: "select",
		category: "search",
		section: "search",
		scopes: ["global"],
		options: [
			{ label: "Top Right", value: "top-right" },
			{ label: "Bottom Right", value: "bottom-right" },
			{ label: "Bottom Bar", value: "bottom-bar" },
		],
	},
	{
		key: "highlightOnClose",
		label: "Highlight on Close",
		type: "select",
		category: "search",
		section: "search",
		scopes: ["global"],
		options: [
			{ label: "Clear", value: "clear" },
			{ label: "Fade", value: "fade" },
			{ label: "Persist", value: "persist" },
		],
	},
	{
		key: "scrollbarMarkers",
		label: "Scrollbar Markers",
		type: "toggle",
		category: "search",
		section: "search",
		scopes: ["global"],
		description: "Show search results in scrollbar",
	},
	{
		key: "historySize",
		label: "Search History Size",
		type: "number",
		category: "search",
		section: "search",
		scopes: ["global"],
		min: 1,
		max: 100,
	},

	// ─── Channels category (global only, UI config) ────────────────────
	{
		key: "defaultGroupName",
		label: "Default group name",
		description: "Name for the ungrouped channels bucket",
		type: "text",
		category: "channels",
		section: "channels",
		scopes: ["global"],
	},
	{
		key: "autoGroup",
		label: "Auto-assign group",
		description: "Automatically assign new channels to a group",
		type: "select",
		category: "channels",
		section: "channels",
		scopes: ["global"],
		default: "none",
		options: [
			{ label: "No grouping", value: "none" },
			{ label: "First group", value: "first" },
		],
	},

	// ─── Startup category (global only, UI config) ─────────────────────
	{
		key: "autoOpenWelcome",
		label: "Auto-open Welcome Tab",
		type: "toggle",
		category: "startup",
		section: "startup",
		scopes: ["global"],
		description: "Show welcome tab when connecting to a host",
	},
];

/** Get schema entries for a specific category and scope */
export function getSchemaForCategoryScope(category: string, scope: string): SettingDefinition[] {
	return settingsSchema.filter(
		(d) => d.category === category && d.scopes.includes(scope as "global" | "host" | "channel"),
	);
}
