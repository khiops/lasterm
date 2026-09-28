/**
 * Settings › Keybindings shows the app's shortcuts from the table the window and the terminals
 * read (#631, #637): what it says cannot drift from what works.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp } from "vue";
import {
	APP_SHORTCUTS,
	type AppActionId,
	shortcutKeys,
	TAB_NUMBERS,
} from "../../../utils/app-shortcuts.js";
import KeybindingsCategory from "./KeybindingsCategory.vue";
import SOURCE from "./KeybindingsCategory.vue?raw";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

/** Each row of the page: its group, its label, and the caps of its keys. */
function mountRows(): { group: string; label: string; keys: string[] }[] {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(KeybindingsCategory);
	app.mount(root);
	return [...root.querySelectorAll(".keybinding-group")].flatMap((group) => {
		const name = group.querySelector(".keybinding-group-title")?.textContent ?? "";
		return [...group.querySelectorAll(".keybinding-row")].map((row) => ({
			group: name,
			label: row.querySelector(".keybinding-label")?.textContent ?? "",
			keys: [...row.querySelectorAll("kbd")].map((k) => k.textContent ?? ""),
		}));
	});
}

describe("Settings › Keybindings", () => {
	// The label each action of the table is shown under, and the group it is in.
	const SHOWN: Record<AppActionId, [string, string]> = {
		"palette.open": ["General", "Command Palette"],
		"zone.next": ["Focus", "Next Area (rail, list, tabs, pane)"],
		"zone.previous": ["Focus", "Previous Area"],
		"tab.new": ["Tabs", "New Channel"],
		"tab.next": ["Tabs", "Next Tab"],
		"tab.previous": ["Tabs", "Previous Tab"],
		"tab.goTo1": ["Tabs", "Go to Tab 1"],
		"tab.goTo2": ["Tabs", "Go to Tab 2"],
		"tab.goTo3": ["Tabs", "Go to Tab 3"],
		"tab.goTo4": ["Tabs", "Go to Tab 4"],
		"tab.goTo5": ["Tabs", "Go to Tab 5"],
		"tab.goTo6": ["Tabs", "Go to Tab 6"],
		"tab.goTo7": ["Tabs", "Go to Tab 7"],
		"tab.goTo8": ["Tabs", "Go to Tab 8"],
		"tab.goTo9": ["Tabs", "Go to Last Tab"],
		"pane.splitRight": ["Panes", "Split Right"],
		"pane.splitDown": ["Panes", "Split Down"],
		"pane.close": ["Panes", "Close Pane"],
		"pane.focusLeft": ["Panes", "Focus Left"],
		"pane.focusRight": ["Panes", "Focus Right"],
		"pane.focusUp": ["Panes", "Focus Up"],
		"pane.focusDown": ["Panes", "Focus Down"],
		"pane.resizeLeft": ["Panes", "Resize Left"],
		"pane.resizeRight": ["Panes", "Resize Right"],
		"pane.resizeUp": ["Panes", "Resize Up"],
		"pane.resizeDown": ["Panes", "Resize Down"],
	};

	it("shows every shortcut of the table, with the keys the table gives it", () => {
		const rows = mountRows();
		for (const id of Object.keys(APP_SHORTCUTS) as AppActionId[]) {
			const [group, label] = SHOWN[id];
			const row = rows.find((candidate) => candidate.label === label);
			expect(row, id).toEqual({ group, label, keys: shortcutKeys(id) });
		}
	});

	it("shows Ctrl+Shift+W as closing a pane, and no chord closing a tab", () => {
		const rows = mountRows();
		expect(rows.find((row) => row.label === "Close Pane")?.keys).toEqual(["Ctrl", "Shift", "W"]);
		expect(rows.some((row) => row.label === "Close Tab")).toBe(false);
		expect(rows.find((row) => row.label === "Focus Left")?.keys).toEqual(["Alt", "←"]);
		expect(rows.find((row) => row.label === "Go to Tab 2")?.keys).toEqual(["Ctrl", "Alt", "2"]);
		expect(rows.find((row) => row.label === "Back to the Pane")?.keys).toEqual(["Escape"]);
	});

	it("reads the chords of the table from the table", () => {
		expect(TAB_NUMBERS).toHaveLength(9);
		expect(SOURCE).toMatch(/keys: shortcutKeys\(`tab\.goTo\$\{n\}`\)/);
		// Settings › Keybindings listed Ctrl+T, Ctrl+W, Ctrl+\ and Ctrl+- that nothing handled (#631).
		for (const stale of ['["Ctrl", "T"]', '["Ctrl", "W"]', '["Ctrl", "\\\\"]', '["Ctrl", "-"]']) {
			expect(SOURCE).not.toContain(stale);
		}
	});
});
