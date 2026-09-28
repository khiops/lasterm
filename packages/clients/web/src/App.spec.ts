import { describe, expect, it } from "vitest";
import SOURCE from "./App.vue?raw";
import { APP_SHORTCUTS, type AppActionId } from "./utils/app-shortcuts.js";
import { CONFIRMATIONS } from "./utils/confirmations.js";

/**
 * App.vue cannot be mounted here, so these read what it does with an ended
 * terminal. What that means — delete or keep, what the migration writes — is
 * tested in utils/exit-action.spec.ts.
 */

/** A function's body, from its declaration to its closing brace at column 0. */
function body(signature: RegExp): string {
	const text = SOURCE.replace(/\r\n/g, "\n");
	const found = new RegExp(`${signature.source}[\\s\\S]*?\\n}\\n`).exec(text)?.[0];
	if (found === undefined) throw new Error(`${signature.source} moved`);
	return found;
}

// "Delete this dead terminal?" is no longer asked: the overlay's options, and
// the setting, answer it (#574).
describe("closing an ended terminal asks nothing", () => {
	it("closes its pane at once, deleting it or keeping it as it was told", () => {
		const onClosePane = body(/function onClosePane\(/);
		expect(onClosePane).not.toContain("confirmDialog");
		expect(onClosePane).toContain("layout.closePane(channelId);");
		// The overlay says whether to keep it; elsewhere the setting does.
		expect(onClosePane).toContain(
			"const keep = ended?.keep ?? endedPrefs(configStore.uiConfig.panes).keepEnded;",
		);
		expect(onClosePane).toContain(
			"for (const id of endedToDelete([channelId], keep)) void channelsStore.deleteChannel(id);",
		);
		// A live terminal keeps running when its pane goes.
		expect(onClosePane).toMatch(/if \(!hasEnded\) return;/);
	});

	it("closes a tab over ended terminals as the keep setting says", () => {
		const onCloseTab = body(/function onCloseTab\(/);
		expect(onCloseTab).not.toContain("confirmDialog");
		expect(onCloseTab).toContain("layout.closeTab(index);");
		expect(onCloseTab).toContain("const keep = endedPrefs(configStore.uiConfig.panes).keepEnded;");
		expect(onCloseTab).toContain(
			"for (const id of endedToDelete(deadIds, keep)) void channelsStore.deleteChannel(id);",
		);
	});

	it("no longer knows the old question, nor lists it among the confirmations", () => {
		expect(SOURCE).not.toContain("ConfirmCloseDeadTab");
		expect(SOURCE).not.toContain("'Close and delete'");
		expect(CONFIRMATIONS.map((entry) => entry.key)).not.toContain("ConfirmCloseDeadTab");
	});
});

describe("the old answer becomes the setting", () => {
	// Once the UI config is read, whichever way the app started.
	it("is carried over after every load of the UI config at startup", () => {
		const text = SOURCE.replace(/\r\n/g, "\n");
		const loads = [
			...text.matchAll(/await configStore\.loadUiConfig\(\);\n\s*void migrateDeadTabChoice\(\);/g),
		];
		expect(loads).toHaveLength(2);
		expect(body(/async function migrateDeadTabChoice\(/)).toContain(
			"(values) => configStore.saveUiSettings('panes', values),",
		);
	});
});

// "Always do this" on one overlay reaches the overlays already waiting only
// on screen (#586): every pane of the tab shown, not only the one selected.
describe("the panes on screen", () => {
	it("are those of the tab shown, told to every pane", () => {
		expect(SOURCE.replace(/\s+/g, " ")).toContain(
			"provide( CHANNELS_ON_SCREEN_KEY, computed(() => channelsOnScreen(layout.layouts.value, layout.activeTab.value?.id ?? null)), );",
		);
		// The tab shown is the active one: the others are kept, hidden.
		expect(SOURCE).toContain('v-show="idx === layout.activeTabIndex.value"');
	});
});

// The empty pane is a host picker, and a new tab follows [tabs] scope (#625).
// What the picker does is tested in useHostPicker.spec.ts; what a new tab
// opens, in useLayout.spec.ts.
describe("an empty pane's host, and a new tab", () => {
	it("spawns an empty pane's terminal on the host its picker chose, not the host in view", () => {
		const onNewTerminalVacant = body(/function onNewTerminalVacant\(/);
		expect(onNewTerminalVacant).toContain("vacantId: string, hostId: string");
		expect(onNewTerminalVacant).toContain("channelsStore.registerPendingSpawn(tempId, hostId);");
		expect(onNewTerminalVacant).not.toContain("activeHostId");
		expect(SOURCE).toContain('@add-host="onAddHostFromPane"');
	});

	it("brings the chosen host into view where the tab would leave a per-host bar", () => {
		expect(body(/function followFilledPane\(/)).toContain("hostToBringIntoView({");
		expect(body(/function onFillVacant\(/)).toContain("followFilledPane(");
	});

	it("gives the tab bar's + to the new-tab rule", () => {
		expect(SOURCE).toContain('@add-tab="onNewTab"');
		const onNewTab = body(/function onNewTab\(/);
		expect(onNewTab).toContain("newTabOpens(configStore.uiConfig.tabs) === 'picker'");
		expect(onNewTab).toContain("layout.openVacantTab();");
		expect(onNewTab).toContain("onAddTab();");
	});

	it("opens the palette's host in a new tab, brought into view with a per-host bar", () => {
		const text = SOURCE.replace(/\r\n/g, "\n");
		const wiring = /commandPalette\.onOpenHost\.value = [\s\S]*?\n\};\n/.exec(text)?.[0];
		expect(wiring, "the palette's onOpenHost moved").toBeDefined();
		expect(wiring).toContain("openPendingTab(hostId);");
		expect(wiring).toContain(
			"if (configStore.uiConfig.tabs?.scope === 'perHost') hostsStore.selectHost(hostId);",
		);
	});
});

// Ctrl+K opened the palette and still reached the shell as ^K (#624), and the
// shortcuts listed for tabs and panes did nothing (#631). What the chords are,
// and that a terminal keeps them from its PTY, is tested in
// utils/app-shortcuts.spec.ts and utils/terminal-keys.spec.ts.
describe("the window's shortcuts", () => {
	const flat = (text: string): string => text.replace(/\s+/g, " ");

	it("runs an app shortcut's action on its chord, and takes the chord", () => {
		expect(flat(body(/function onGlobalKeydown\(/))).toContain(
			"const shortcut = appShortcutOf(event); if (shortcut !== null) { event.preventDefault(); runAppAction(shortcut); return; }",
		);
		// Before an element's own handler can stop it.
		expect(SOURCE).toContain(
			"window.addEventListener('keydown', onGlobalKeydown, { capture: true });",
		);
	});

	// The tab bar's "+" and ×, and a pane's split, are these same handlers.
	it("runs each action of the table as the tab bar and the panes do", () => {
		const runAppAction = flat(body(/function runAppAction\(/));
		const actions: Record<AppActionId, string> = {
			"palette.open": "commandPalette.toggle();",
			"tab.new": "onNewTab();",
			"tab.close": "if (tab !== null) onCloseTab(layout.activeTabIndex.value);",
			"pane.splitRight": "if (pane !== null) onSplit(pane, 'vertical');",
			"pane.splitDown": "if (pane !== null) onSplit(pane, 'horizontal');",
		};
		for (const id of Object.keys(APP_SHORTCUTS) as AppActionId[]) {
			expect(runAppAction).toContain(`case '${id}': ${actions[id]} break;`);
		}
		// The split is the focused pane's, in the tab shown.
		expect(runAppAction).toContain(
			"const tab = layout.activeTab.value; const pane = tab === null ? null : layout.getActiveChannelId(tab.id);",
		);
		expect(SOURCE).toContain('@add-tab="onNewTab"');
		expect(SOURCE).toContain('@close-tab="onCloseTab"');
		expect(SOURCE).toContain('@split="onSplit"');
	});

	it("runs the palette's rows for those actions the same way", () => {
		const text = flat(SOURCE);
		for (const [row, id] of [
			["action:new-channel", "tab.new"],
			["action:close-tab", "tab.close"],
			["action:split-right", "pane.splitRight"],
			["action:split-down", "pane.splitDown"],
		]) {
			expect(text).toContain(`case '${row}': runAppAction('${id}'); break;`);
		}
	});

	it("no longer takes Ctrl+K from the shell", () => {
		const onGlobalKeydown = body(/function onGlobalKeydown\(/);
		expect(onGlobalKeydown).not.toMatch(/event\.key === ['"]k['"]/i);
		expect(onGlobalKeydown).not.toContain("commandPalette.toggle()");
	});
});
