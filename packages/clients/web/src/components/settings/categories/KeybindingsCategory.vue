<template>
	<div class="keybindings-category">
		<p class="keybindings-description">
			Keyboard shortcuts available in lasterm. Editing is not supported in
			this version.
		</p>
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
// The app's shortcuts are shown from the table the window and the terminals read (#631, #637).
import {
	outsideTerminalKeys,
	shortcutKeys,
	TAB_NUMBERS,
} from "../../../utils/app-shortcuts.js";

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

const keybindingGroups: KeybindingGroup[] = [
	{
		name: "General",
		bindings: [
			{ label: "Command Palette", keys: shortcutKeys("palette.open") },
			{ label: "Settings", keys: ["Gear icon in sidebar"] },
		],
	},
	{
		name: "Focus",
		bindings: [
			{
				label: "Next Area (rail, list, tabs, pane)",
				keys: shortcutKeys("zone.next"),
				outsideTerminal: outsideTerminalKeys("zone.next"),
			},
			{
				label: "Previous Area",
				keys: shortcutKeys("zone.previous"),
				outsideTerminal: outsideTerminalKeys("zone.previous"),
			},
			{ label: "Back to the Pane", keys: ["Escape"] },
		],
	},
	{
		name: "Tabs",
		bindings: [
			{ label: "New Channel", keys: shortcutKeys("tab.new") },
			{ label: "Next Tab", keys: shortcutKeys("tab.next") },
			{ label: "Previous Tab", keys: shortcutKeys("tab.previous") },
			...TAB_NUMBERS.map((n) => ({
				label: n === 9 ? "Go to Last Tab" : `Go to Tab ${n}`,
				keys: shortcutKeys(`tab.goTo${n}`),
			})),
		],
	},
	{
		name: "Panes",
		bindings: [
			{ label: "Split Right", keys: shortcutKeys("pane.splitRight") },
			{ label: "Split Down", keys: shortcutKeys("pane.splitDown") },
			{ label: "Close Pane", keys: shortcutKeys("pane.close") },
			{ label: "Focus Left", keys: shortcutKeys("pane.focusLeft") },
			{ label: "Focus Right", keys: shortcutKeys("pane.focusRight") },
			{ label: "Focus Up", keys: shortcutKeys("pane.focusUp") },
			{ label: "Focus Down", keys: shortcutKeys("pane.focusDown") },
			{ label: "Resize Left", keys: shortcutKeys("pane.resizeLeft") },
			{ label: "Resize Right", keys: shortcutKeys("pane.resizeRight") },
			{ label: "Resize Up", keys: shortcutKeys("pane.resizeUp") },
			{ label: "Resize Down", keys: shortcutKeys("pane.resizeDown") },
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
