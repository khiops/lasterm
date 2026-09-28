import { describe, expect, it } from "vitest";
import SOURCE from "./App.vue?raw";
import PANE_LAYOUT from "./components/PaneLayout.vue?raw";
import { APP_SHORTCUTS, type AppActionId, paneMoveOf, tabNumberOf } from "./utils/app-shortcuts.js";
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

// Ctrl+K opened the palette and still reached the shell as ^K (#624), and the
// shortcuts listed for tabs and panes did nothing (#631). What the chords are,
// and that a terminal keeps them from its PTY, is tested in
// utils/app-shortcuts.spec.ts and utils/terminal-keys.spec.ts.
describe("the window's shortcuts", () => {
	const flat = (text: string): string => text.replace(/\s+/g, " ");

	it("runs an app shortcut's action on its chord, and takes the chord", () => {
		const onGlobalKeydown = flat(body(/function onGlobalKeydown\(/));
		expect(onGlobalKeydown).toContain(
			"const shortcut = appShortcutOf(event); if (shortcut !== null) { event.preventDefault();",
		);
		expect(onGlobalKeydown).toContain("runAppAction(shortcut); return; }");
		// Before an element's own handler can stop it.
		expect(SOURCE).toContain(
			"window.addEventListener('keydown', onGlobalKeydown, { capture: true });",
		);
	});

	// F6 behind Settings would leave the keyboard behind the dialog (#637).
	it("takes a chord that moves the keyboard, but does not run it, while a modal dialog has it", () => {
		expect(flat(body(/function onGlobalKeydown\(/))).toContain(
			"event.preventDefault(); // A modal dialog keeps the keyboard: nothing takes it behind the dialog (#637). if (movesKeyboard(shortcut) && isInModalDialog(event.target)) return; runAppAction(shortcut);",
		);
		expect(flat(body(/function isInModalDialog\(/))).toContain(
			"target.closest('[aria-modal=\"true\"]') !== null",
		);
	});

	// The tab bar's "+", a pane's split and its "Close Pane" are these same handlers.
	it("runs each action of the table as the tab bar and the panes do", () => {
		const runAppAction = flat(body(/function runAppAction\(/));
		const actions: Partial<Record<AppActionId, string>> = {
			"palette.open": "commandPalette.toggle();",
			"tab.new": "onAddTab();",
			"tab.next": "switchTab('next');",
			"tab.previous": "switchTab('previous');",
			"pane.splitRight": "if (terminal !== null) onSplit(terminal, 'vertical');",
			"pane.splitDown": "if (terminal !== null) onSplit(terminal, 'horizontal');",
			"pane.close": "closeFocusedPane();",
			"zone.next": "cycleFocusZone(1);",
			"zone.previous": "cycleFocusZone(-1);",
		};
		for (const id of Object.keys(APP_SHORTCUTS) as AppActionId[]) {
			const action = actions[id];
			if (action !== undefined) {
				expect(runAppAction).toContain(`case '${id}': ${action} break;`);
			} else {
				// Ctrl+Alt+digit, Alt+arrows and Alt+Shift+arrows, read from their id.
				expect(tabNumberOf(id) !== null || paneMoveOf(id) !== null, id).toBe(true);
			}
		}
		expect(runAppAction).toContain(
			"const tabNumber = tabNumberOf(action); if (tabNumber !== null) { switchTab({ goTo: tabNumber }); return; }",
		);
		expect(runAppAction).toContain(
			"if (paneMove.move === 'focus') moveFocusToPane(paneMove.direction); else resizeFocusedPane(paneMove.direction);",
		);
		// The split is the focused pane's, and only a terminal's: an empty pane has none.
		expect(runAppAction).toContain(
			"const pane = focusedPane(); const terminal = pane?.leaf.node.type === 'terminal' ? pane.leaf.node.channelId : null;",
		);
		expect(SOURCE).toContain('@add-tab="onAddTab"');
		expect(SOURCE).toContain('@close-tab="onCloseTab"');
		expect(SOURCE).toContain('@split="onSplit"');
	});

	it("runs the palette's rows for those actions the same way", () => {
		const text = flat(SOURCE);
		for (const [row, id] of [
			["action:new-channel", "tab.new"],
			["action:close-pane", "pane.close"],
			["action:split-right", "pane.splitRight"],
			["action:split-down", "pane.splitDown"],
		]) {
			expect(text).toContain(`case '${row}': runAppAction('${id}'); break;`);
		}
		// No chord closes a whole tab any more; the palette's row still does, as its × does.
		expect(text).toContain(
			"case 'action:close-tab': if (layout.activeTab.value !== null) onCloseTab(layout.activeTabIndex.value); break;",
		);
	});

	it("no longer takes Ctrl+K from the shell", () => {
		const onGlobalKeydown = body(/function onGlobalKeydown\(/);
		expect(onGlobalKeydown).not.toMatch(/event\.key === ['"]k['"]/i);
		expect(onGlobalKeydown).not.toContain("commandPalette.toggle()");
	});
});

// Which pane and which divider the keys reach is tested in utils/pane-geometry.spec.ts, the
// tabs in utils/tab-switch.spec.ts, and the zones' order in utils/focus-zones.spec.ts (#637).
describe("the keyboard among tabs, panes and zones", () => {
	const flat = (text: string): string => text.replace(/\s+/g, " ");

	// Windows Terminal's: the tab closes with its last pane.
	it("closes the focused pane as its own Close Pane does, and the tab with its last pane", () => {
		const closeFocusedPane = flat(body(/function closeFocusedPane\(/));
		expect(closeFocusedPane).toContain(
			"if (root === null || root === undefined || root.type !== 'split') { onCloseTab(layout.activeTabIndex.value); }",
		);
		// A terminal keeps running, or an ended one goes as the setting says (onClosePane); an
		// empty pane gives its room to its neighbour, as its own "Close Pane" does.
		expect(closeFocusedPane).toContain(
			"if (pane.leaf.node.type === 'terminal') onClosePane(pane.leaf.node.channelId); else onRearrangeVacant(pane.leaf.node.id);",
		);
		expect(SOURCE).toContain('@close-pane="onClosePane"');
		expect(SOURCE).toContain('@rearrange-vacant="onRearrangeVacant"');
		// The pane closed had the keyboard: it goes to the one that takes its place.
		expect(closeFocusedPane).toContain("void nextTick(focusActivePane);");
	});

	it("moves a divider through the layout, which keeps it where the mouse can drag it", () => {
		expect(flat(body(/function resizeFocusedPane\(/))).toContain(
			"const change = resizeTowards(pane.root, pane.leaf.id, direction); if (change !== null) layout.updateRatio(change.path, change.ratio);",
		);
	});

	it("switches among the tabs the bar shows, and takes the keyboard into the pane", () => {
		const switchTab = flat(body(/function switchTab\(/));
		expect(switchTab).toContain("layout.tabsInView(),");
		expect(switchTab).toContain("layout.setActiveTab(index); void nextTick(focusActivePane);");
	});

	it("marks the panes' zone, and each pane, for F6, Esc and Alt+arrows", () => {
		expect(SOURCE).toContain('<div class="pane-area" data-focus-zone="pane">');
		expect(PANE_LAYOUT).toContain(':data-pane-id="node.paneId"');
		expect(PANE_LAYOUT).toContain(':data-pane-id="node.id"');
		// Esc on the rail, the list or the tab bar goes back to the pane.
		expect(flat(body(/function onGlobalKeydown\(/))).toContain(
			"if (zone !== null && zone !== 'pane' && focusActivePane()) { event.preventDefault(); return; }",
		);
	});

	it("opens a terminal from the list on Enter, and takes the keyboard into it", () => {
		expect(SOURCE).toContain('@open-channel="onOpenChannelFromList"');
		expect(flat(body(/function onOpenChannelFromList\(/))).toContain("onSelectChannel(channelId);");
	});
});
