<template>
	<div class="keybindings-category">
		<p class="keybindings-description">
			Keyboard shortcuts available in lasterm. Editing is not supported in
			this version.
		</p>
		<!-- The overlay lists these too, with the keys inside each area, and searches them (#639). -->
		<button type="button" class="keybindings-overlay-link" @click="shortcutsOverlay.open()">
			Search all keyboard shortcuts
			<span class="keybinding-keys">
				<kbd v-for="k in shortcutKeys('help.shortcuts')" :key="k">{{ k }}</kbd>
			</span>
		</button>
		<div
			v-for="group in keybindingGroups"
			:key="group.name"
			class="keybinding-group"
		>
			<h3 class="keybinding-group-title">{{ group.name }}</h3>
			<div
				v-for="binding in group.bindings"
				:key="binding.label"
				class="keybinding-row"
			>
				<span class="keybinding-label">{{ binding.label }}</span>
				<span class="keybinding-keys">
					<kbd v-for="k in binding.keys" :key="k">{{ k }}</kbd>
					<span v-if="binding.outsideTerminal" class="keybinding-alias">
						(<kbd v-for="k in binding.outsideTerminal" :key="k">{{ k }}</kbd>
						outside a terminal)
					</span>
				</span>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
// The app's shortcuts are shown from the table the window and the terminals read (#631, #637),
// under the names it gives them (#639).
import { useShortcutsOverlay } from "../../../composables/useShortcutsOverlay.js";
import {
	APP_SHORTCUT_NAMES,
	type AppActionId,
	outsideTerminalKeys,
	shortcutKeys,
	TAB_NUMBERS,
} from "../../../utils/app-shortcuts.js";

const shortcutsOverlay = useShortcutsOverlay();

interface Keybinding {
	label: string;
	keys: string[];
	/** The keys that do the same where the keyboard is not in a terminal (F6), if any. */
	outsideTerminal?: string[] | null;
}

interface KeybindingGroup {
	name: string;
	bindings: Keybinding[];
}

/** An action of the table: its name and its keys, and those outside a terminal, if any. */
function fromTable(id: AppActionId): Keybinding {
	return {
		label: APP_SHORTCUT_NAMES[id],
		keys: shortcutKeys(id),
		outsideTerminal: outsideTerminalKeys(id),
	};
}

const keybindingGroups: KeybindingGroup[] = [
	{
		name: "General",
		bindings: [fromTable("palette.open"), fromTable("settings.open"), fromTable("help.shortcuts")],
	},
	{
		name: "Focus",
		bindings: [
			fromTable("zone.next"),
			fromTable("zone.previous"),
			{ label: "Back to the Pane", keys: ["Escape"] },
		],
	},
	{
		name: "Tabs",
		bindings: [
			fromTable("tab.new"),
			fromTable("tab.next"),
			fromTable("tab.previous"),
			...TAB_NUMBERS.map((n) => ({
				label: APP_SHORTCUT_NAMES[`tab.goTo${n}`],
				keys: shortcutKeys(`tab.goTo${n}`),
			})),
		],
	},
	{
		name: "Panes",
		bindings: [
			fromTable("pane.splitRight"),
			fromTable("pane.splitDown"),
			fromTable("pane.close"),
			fromTable("pane.focusLeft"),
			fromTable("pane.focusRight"),
			fromTable("pane.focusUp"),
			fromTable("pane.focusDown"),
			fromTable("pane.resizeLeft"),
			fromTable("pane.resizeRight"),
			fromTable("pane.resizeUp"),
			fromTable("pane.resizeDown"),
		],
	},
	{
		name: "Search",
		bindings: [
			{ label: "Find in Terminal", keys: ["Ctrl", "Shift", "F"] },
			{ label: "Toggle Case Sensitive", keys: ["Alt", "C"] },
			{ label: "Toggle Regex", keys: ["Alt", "R"] },
			{ label: "Toggle Whole Word", keys: ["Alt", "W"] },
		],
	},
	{
		name: "Terminal",
		bindings: [
			{ label: "Close Settings / Overlay", keys: ["Escape"] },
		],
	},
];
</script>

<style scoped>
.keybindings-category {
	display: flex;
	flex-direction: column;
	gap: 20px;
}

.keybindings-description {
	margin: 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
	line-height: 1.5;
}

.keybindings-overlay-link {
	align-self: flex-start;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	margin-top: -8px;
	padding: 4px 8px;
	background: transparent;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-accent);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
}

.keybindings-overlay-link:hover {
	background: var(--nt-hover);
}

.keybinding-group {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.keybinding-group-title {
	margin: 0 0 8px;
	font-size: 12px;
	font-weight: 600;
	color: var(--nt-fg);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.keybinding-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 6px 8px;
	border-radius: 4px;
}

.keybinding-row:hover {
	background: var(--nt-border);
}

.keybinding-label {
	font-size: 13px;
	color: var(--nt-fg);
}

.keybinding-keys {
	display: flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
}

.keybinding-alias {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

kbd {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 22px;
	height: 22px;
	padding: 0 6px;
	background: var(--nt-host-rail);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-text-secondary);
	font-size: 11px;
	font-family: ui-monospace, monospace;
	line-height: 1;
}
</style>
