/**
 * Settings › Keybindings shows the app's shortcuts from the table the window and the terminals
 * read (#631, #637): what it says cannot drift from what works.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, type Component, createApp } from "vue";
import { useShortcutsOverlay } from "../../../composables/useShortcutsOverlay.js";
import {
	APP_SHORTCUTS,
	type AppActionId,
	outsideTerminalKeys,
	readSwitchesFrom,
	shortcutKeys,
} from "../../../utils/app-shortcuts.js";
import KeybindingsCategory from "./KeybindingsCategory.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	readSwitchesFrom(() => false);
	vi.doUnmock("../../../utils/app-shortcuts.js");
	vi.resetModules();
});

interface Row {
	group: string;
	label: string;
	keys: string[];
	/** The caps shown for outside a terminal, or null. */
	outsideTerminal: string[] | null;
	/** What the row says, as read. */
	text: string;
}

/** Each row of the page: its group, its label, and the caps of its keys. */
function mountRows(page: Component = KeybindingsCategory): Row[] {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(page);
	app.mount(root);
	const caps = (el: Element | null): string[] =>
		el === null ? [] : [...el.querySelectorAll(":scope > kbd")].map((k) => k.textContent ?? "");
	return [...root.querySelectorAll(".keybinding-group")].flatMap((group) => {
		const name = group.querySelector(".keybinding-group-title")?.textContent ?? "";
		return [...group.querySelectorAll(".keybinding-row")].map((row) => {
			const alias = row.querySelector(".keybinding-alias");
			return {
				group: name,
				label: row.querySelector(".keybinding-label")?.textContent ?? "",
				keys: caps(row.querySelector(".keybinding-keys")),
				outsideTerminal: alias === null ? null : caps(alias),
				text: (row.querySelector(".keybinding-keys")?.textContent ?? "")
					.replace(/\s+/g, " ")
					.trim(),
			};
		});
	});
}

describe("Settings › Keybindings", () => {
	// The label each action of the table is shown under, and the group it is in.
	const SHOWN: Record<AppActionId, [string, string]> = {
		"palette.open": ["General", "Command Palette"],
		"settings.open": ["General", "Settings"],
		"help.shortcuts": ["General", "Keyboard Shortcuts"],
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
		"files.toggle": ["Files", "Files Panel"],
	};

	it("shows every shortcut of the table, with the keys the table gives it", () => {
		readSwitchesFrom(() => true);
		const rows = mountRows();
		for (const id of Object.keys(APP_SHORTCUTS) as AppActionId[]) {
			const [group, label] = SHOWN[id];
			const row = rows.find((candidate) => candidate.label === label);
			expect(row, id).toMatchObject({
				group,
				label,
				keys: shortcutKeys(id),
				outsideTerminal: outsideTerminalKeys(id),
			});
		}
	});

	// F6 is a terminal program's (htop, Midnight Commander); Ctrl+F6 works from anywhere.
	it("shows Ctrl+F6, and F6 outside a terminal, for the zones", () => {
		const rows = mountRows();
		const next = rows.find((row) => row.label === "Next Area (rail, list, tabs, pane)");
		expect(next?.text).toMatch(/^Ctrl ?F6 ?\( ?F6 outside a terminal\)$/);
		expect([next?.keys, next?.outsideTerminal]).toEqual([["Ctrl", "F6"], ["F6"]]);
		const previous = rows.find((row) => row.label === "Previous Area");
		expect([previous?.keys, previous?.outsideTerminal]).toEqual([
			["Ctrl", "Shift", "F6"],
			["Shift", "F6"],
		]);
	});

	it("shows Ctrl+Shift+W as closing a pane, and no chord closing a tab", () => {
		const rows = mountRows();
		expect(rows.find((row) => row.label === "Close Pane")?.keys).toEqual(["Ctrl", "Shift", "W"]);
		expect(rows.some((row) => row.label === "Close Tab")).toBe(false);
		expect(rows.find((row) => row.label === "Focus Left")?.keys).toEqual(["Alt", "←"]);
		expect(rows.find((row) => row.label === "Go to Tab 2")?.keys).toEqual(["Ctrl", "Alt", "2"]);
		expect(rows.find((row) => row.label === "Back to the Pane")?.keys).toEqual(["Escape"]);
	});

	// The overlay lists these too, with the keys inside each area, and searches them (#639).
	it("links to the keyboard shortcuts overlay, naming its chord from the table", () => {
		mountRows();
		const overlay = useShortcutsOverlay();
		overlay.close();
		const link = root.querySelector<HTMLButtonElement>(".keybindings-overlay-link");
		expect(link?.tagName).toBe("BUTTON");
		expect([...(link?.querySelectorAll("kbd") ?? [])].map((k) => k.textContent)).toEqual(
			shortcutKeys("help.shortcuts"),
		);
		link?.click();
		expect(overlay.isOpen.value).toBe(true);
		overlay.close();
	});

	// The files panel waits behind file transfer's switch (#835, #836), and its chord with it.
	it("shows the files panel's chord only while file transfer is on", () => {
		readSwitchesFrom(() => false);
		expect(mountRows().some((row) => row.label === "Files Panel")).toBe(false);
		app?.unmount();
		root.remove();
		readSwitchesFrom((name) => name === "fileTransfer");
		expect(mountRows().find((row) => row.label === "Files Panel")).toMatchObject({
			group: "Files",
			keys: ["Ctrl", "Shift", "E"],
		});
	});

	// The page reads each action's name and chord from the table rather than writing them again:
	// over a table that names and binds every action otherwise, it shows what that table says.
	it("names the actions and shows their chords as the table does, whatever it says", async () => {
		vi.resetModules();
		vi.doMock("../../../utils/app-shortcuts.js", async (importOriginal) => {
			const table = await importOriginal<typeof import("../../../utils/app-shortcuts.js")>();
			table.readSwitchesFrom(() => true);
			const ids = Object.keys(table.APP_SHORTCUT_NAMES) as AppActionId[];
			return {
				...table,
				APP_SHORTCUT_NAMES: Object.fromEntries(ids.map((id) => [id, `Named ${id}`])),
				shortcutKeys: (id: AppActionId) => ["Bound", id],
			};
		});
		const { default: page } = await import("./KeybindingsCategory.vue");
		const rows = mountRows(page);
		for (const [id, [group]] of Object.entries(SHOWN)) {
			expect(
				rows.find((row) => row.label === `Named ${id}`),
				id,
			).toMatchObject({ group, keys: ["Bound", id] });
		}
		expect(rows.filter((row) => row.label.startsWith("Go to"))).toEqual([]);
	});

	// Settings › Keybindings listed Ctrl+T, Ctrl+W, Ctrl+\ and Ctrl+- that nothing handled (#631).
	it("shows no chord but the table's and the keys inside an area", () => {
		readSwitchesFrom(() => true);
		const handled = new Set(
			(Object.keys(APP_SHORTCUTS) as AppActionId[]).map((id) => shortcutKeys(id).join("+")),
		);
		const inAnArea = new Set(["Escape", "Ctrl+Shift+F", "Alt+C", "Alt+R", "Alt+W"]);
		const unhandled = mountRows()
			.filter((row) => !handled.has(row.keys.join("+")) && !inAnArea.has(row.keys.join("+")))
			.map((row) => `${row.label}: ${row.keys.join("+")}`);
		expect(unhandled).toEqual([]);
	});
});
