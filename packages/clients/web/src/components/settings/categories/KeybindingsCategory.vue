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
				</span>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
interface Keybinding {
	label: string;
	keys: string[];
}

interface KeybindingGroup {
	name: string;
	bindings: Keybinding[];
}

const keybindingGroups: KeybindingGroup[] = [
	{
		name: "General",
		bindings: [
			{ label: "Command Palette", keys: ["Ctrl", "P"] },
			{ label: "Settings", keys: ["Gear icon in sidebar"] },
		],
	},
	{
		name: "Tabs",
		bindings: [
			{ label: "New Channel", keys: ["Ctrl", "T"] },
			{ label: "Close Tab", keys: ["Ctrl", "W"] },
		],
	},
	{
		name: "Panes",
		bindings: [
			{ label: "Split Right", keys: ["Ctrl", "\\"] },
			{ label: "Split Down", keys: ["Ctrl", "-"] },
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
	gap: 4px;
	flex-shrink: 0;
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
