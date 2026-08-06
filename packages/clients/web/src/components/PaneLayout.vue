<template>
	<div ref="containerEl" :class="containerClass">
		<!-- Terminal leaf node -->
		<template v-if="node.type === 'terminal'">
			<div
				class="pane-drop-wrapper"
				@mousedown="onPaneFocus(node.paneId)"
				@dragover.prevent="onDragOver"
				@dragleave="onDragLeave"
				@drop="onDrop"
			>
				<TerminalPane
					:key="node.paneId ?? node.channelId"
					:channel-id="node.channelId"
					:pane-id="node.paneId"
					:host-id="hostId"
					:has-multiple-panes="props.hasMultiplePanes ?? false"
					@split-right="(chId: string) => emit('split', chId, 'vertical')"
					@split-down="(chId: string) => emit('split', chId, 'horizontal')"
					@close-pane="(chId: string) => emit('close-pane', chId)"
					@detach-pane="(chId: string) => emit('detach-pane', chId)"
					@channel-spawned="(tempId: string, realId: string) => emit('channel-spawned', tempId, realId)"
					@configure-command="(chId: string) => emit('configure-command', chId)"
					@search-all-panes="(q: string) => emit('search-all-panes', q)"
					@find-next-all="(chId: string) => emit('find-next-all', chId)"
					@find-previous-all="(chId: string) => emit('find-previous-all', chId)"
				/>
				<div v-if="showDropZones" class="drop-zones">
					<div
						class="drop-zone drop-zone-left"
						:class="{ active: activeZone === 'left' }"
					/>
					<div
						class="drop-zone drop-zone-right"
						:class="{ active: activeZone === 'right' }"
					/>
					<div
						class="drop-zone drop-zone-top"
						:class="{ active: activeZone === 'top' }"
					/>
					<div
						class="drop-zone drop-zone-bottom"
						:class="{ active: activeZone === 'bottom' }"
					/>
					<div
						class="drop-zone drop-zone-center"
						:class="{ active: activeZone === 'center' }"
					/>
				</div>
			</div>
		</template>

		<!-- Vacant leaf node — picker for empty pane slots -->
		<template v-else-if="node.type === 'vacant'">
			<div
				class="pane-drop-wrapper"
				@dragover.prevent="onDragOver"
				@dragleave="onDragLeave"
				@drop="onDrop"
			>
				<VacantPane
					:key="node.id"
					:vacant-id="node.id"
					:host-id="hostId"
					@select-channel="(vId: string, chId: string) => emit('fill-vacant', vId, chId)"
					@new-terminal="(vId: string) => emit('new-terminal-vacant', vId)"
					@rearrange="(vId: string) => emit('rearrange-vacant', vId)"
				/>
				<div v-if="showDropZones" class="drop-zones">
					<div
						class="drop-zone drop-zone-center"
						:class="{ active: true }"
					/>
				</div>
			</div>
		</template>

		<!-- Split node: two children with a splitter between them -->
		<template v-else>
			<!-- First child -->
			<PaneLayout
				:node="node.first"
				:node-path="firstChildPath"
				:host-id="hostId"
				:tab-id="tabId"
				:has-multiple-panes="props.hasMultiplePanes"
				:style="firstStyle"
				@split="(chId: string, dir: 'horizontal' | 'vertical') => emit('split', chId, dir)"
				@close-pane="(chId: string) => emit('close-pane', chId)"
				@detach-pane="(chId: string) => emit('detach-pane', chId)"
				@update-ratio="(path: NodePath, ratio: number) => emit('update-ratio', path, ratio)"
				@channel-spawned="(tempId: string, realId: string) => emit('channel-spawned', tempId, realId)"
				@fill-vacant="(vId: string, chId: string) => emit('fill-vacant', vId, chId)"
				@new-terminal-vacant="(vId: string) => emit('new-terminal-vacant', vId)"
				@rearrange-vacant="(vId: string) => emit('rearrange-vacant', vId)"
				@drop-pane="(sourceChId: string, targetPId: string, tTabId: string, zone: DropZone) => emit('drop-pane', sourceChId, targetPId, tTabId, zone)"
				@focus-pane="(tId: string, pId: string) => emit('focus-pane', tId, pId)"
				@configure-command="(chId: string) => emit('configure-command', chId)"
				@search-all-panes="(q: string) => emit('search-all-panes', q)"
				@find-next-all="(chId: string) => emit('find-next-all', chId)"
				@find-previous-all="(chId: string) => emit('find-previous-all', chId)"
			/>

			<!-- Drag handle between the two panes -->
			<PaneSplitter
				:direction="node.direction"
				:node-path="effectivePath"
				:container-el="containerEl"
				@update-ratio="(path: NodePath, ratio: number) => emit('update-ratio', path, ratio)"
			/>

			<!-- Second child -->
			<PaneLayout
				:node="node.second"
				:node-path="secondChildPath"
				:host-id="hostId"
				:tab-id="tabId"
				:has-multiple-panes="props.hasMultiplePanes"
				:style="secondStyle"
				@split="(chId: string, dir: 'horizontal' | 'vertical') => emit('split', chId, dir)"
				@close-pane="(chId: string) => emit('close-pane', chId)"
				@detach-pane="(chId: string) => emit('detach-pane', chId)"
				@update-ratio="(path: NodePath, ratio: number) => emit('update-ratio', path, ratio)"
				@channel-spawned="(tempId: string, realId: string) => emit('channel-spawned', tempId, realId)"
				@fill-vacant="(vId: string, chId: string) => emit('fill-vacant', vId, chId)"
				@new-terminal-vacant="(vId: string) => emit('new-terminal-vacant', vId)"
				@rearrange-vacant="(vId: string) => emit('rearrange-vacant', vId)"
				@drop-pane="(sourceChId: string, targetPId: string, tTabId: string, zone: DropZone) => emit('drop-pane', sourceChId, targetPId, tTabId, zone)"
				@focus-pane="(tId: string, pId: string) => emit('focus-pane', tId, pId)"
				@configure-command="(chId: string) => emit('configure-command', chId)"
				@search-all-panes="(q: string) => emit('search-all-panes', q)"
				@find-next-all="(chId: string) => emit('find-next-all', chId)"
				@find-previous-all="(chId: string) => emit('find-previous-all', chId)"
			/>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { DropZone, NodePath, PaneNode } from "../composables/useLayout.js";
import { countPanes } from "../composables/useLayout.js";
import PaneSplitter from "./PaneSplitter.vue";
import TerminalPane from "./TerminalPane.vue";
import VacantPane from "./VacantPane.vue";

// Vue 3 supports recursive components — the component references itself by name.
// The component name is inferred from the filename: "PaneLayout".

const props = defineProps<{
	node: PaneNode;
	/**
	 * Path from the root to this node. Used to pass the correct path to the
	 * PaneSplitter so ratio updates reference the right split node.
	 * Defaults to [] (root).
	 */
	nodePath?: NodePath;
	/** Current host ID — passed to VacantPane for channel filtering. */
	hostId?: string | null;
	/** The tab's ULID — needed for cross-tab DnD and focus-pane events. */
	tabId?: string | null;
	/** Whether the current tab has multiple panes (SC-12, for search scope toggle). */
	hasMultiplePanes?: boolean;
}>();

const emit = defineEmits<{
	(e: "split", channelId: string, direction: "horizontal" | "vertical"): void;
	(e: "close-pane", channelId: string): void;
	(e: "detach-pane", channelId: string): void;
	(e: "update-ratio", nodePath: NodePath, ratio: number): void;
	(e: "channel-spawned", tempId: string, realId: string): void;
	(e: "fill-vacant", vacantId: string, channelId: string): void;
	(e: "new-terminal-vacant", vacantId: string): void;
	(e: "rearrange-vacant", vacantId: string): void;
	(e: "drop-pane", sourceChannelId: string, targetPaneId: string, targetTabId: string, zone: DropZone): void;
	(e: "focus-pane", tabId: string, paneId: string): void;
	(e: "configure-command", channelId: string): void;
	(e: "search-all-panes", query: string): void;
	(e: "find-next-all", currentChannelId: string): void;
	(e: "find-previous-all", currentChannelId: string): void;
}>();

const containerEl = ref<HTMLElement | null>(null);

const effectivePath = computed<NodePath>(() => props.nodePath ?? []);

const firstChildPath = computed<NodePath>(() => [...effectivePath.value, "first"]);
const secondChildPath = computed<NodePath>(() => [...effectivePath.value, "second"]);

const hostId = computed<string | null>(() => props.hostId ?? null);
const tabId = computed<string | null>(() => props.tabId ?? null);

const containerClass = computed(() => {
	if (props.node.type === "terminal" || props.node.type === "vacant")
		return "pane-layout pane-layout--terminal";
	return [
		"pane-layout",
		"pane-layout--split",
		props.node.direction === "vertical"
			? "pane-layout--split-vertical"
			: "pane-layout--split-horizontal",
	];
});

const firstStyle = computed(() => {
	if (props.node.type !== "split") return {};
	const r = props.node.ratio;
	return props.node.direction === "vertical"
		? { flexBasis: `${r * 100}%`, flexGrow: 0, flexShrink: 0, minWidth: 0 }
		: { flexBasis: `${r * 100}%`, flexGrow: 0, flexShrink: 0, minHeight: 0 };
});

const secondStyle = computed(() => {
	if (props.node.type !== "split") return {};
	const r = props.node.ratio;
	return props.node.direction === "vertical"
		? { flexBasis: `${(1 - r) * 100}%`, flexGrow: 0, flexShrink: 0, minWidth: 0 }
		: { flexBasis: `${(1 - r) * 100}%`, flexGrow: 0, flexShrink: 0, minHeight: 0 };
});

// ---------------------------------------------------------------------------
// Drop zone logic (only active on leaf nodes: terminal or vacant)
// ---------------------------------------------------------------------------

const showDropZones = ref(false);
const activeZone = ref<DropZone | null>(null);
let dragEnterCount = 0;

/** Get the paneId for the current leaf node. */
function getLeafPaneId(): string | null {
	if (props.node.type === "terminal") return props.node.paneId;
	if (props.node.type === "vacant") return props.node.id;
	return null;
}

/** Emit focus-pane when a terminal pane receives a mousedown event. */
function onPaneFocus(paneId: string): void {
	const tId = tabId.value;
	if (tId !== null) {
		emit("focus-pane", tId, paneId);
	}
}

function getDropZone(event: DragEvent, element: HTMLElement): DropZone {
	const rect = element.getBoundingClientRect();
	const x = (event.clientX - rect.left) / rect.width;
	const y = (event.clientY - rect.top) / rect.height;

	if (x < 0.25) return "left";
	if (x > 0.75) return "right";
	if (y < 0.25) return "top";
	if (y > 0.75) return "bottom";
	return "center";
}

function onDragOver(event: DragEvent): void {
	if (!event.dataTransfer?.types.includes("text/x-lasterm-pane")) return;

	showDropZones.value = true;

	const el = (event.currentTarget as HTMLElement) ?? null;
	if (el === null) return;

	// For vacant nodes, only center zone is valid
	if (props.node.type === "vacant") {
		activeZone.value = "center";
		return;
	}

	activeZone.value = getDropZone(event, el);
}

function onDragLeave(event: DragEvent): void {
	// Only hide when actually leaving the wrapper element
	const el = event.currentTarget as HTMLElement;
	const related = event.relatedTarget as Node | null;
	if (related && el.contains(related)) return;

	showDropZones.value = false;
	activeZone.value = null;
}

function onDrop(event: DragEvent): void {
	showDropZones.value = false;
	activeZone.value = null;
	dragEnterCount = 0;

	if (!event.dataTransfer) return;
	const raw = event.dataTransfer.getData("text/x-lasterm-pane");
	if (!raw) return;

	let data: { channelId: string; paneId: string; hostId: string | null };
	try {
		data = JSON.parse(raw) as typeof data;
	} catch {
		return;
	}

	const targetPaneId = getLeafPaneId();
	if (targetPaneId === null) return;

	// Don't drop on self
	if (data.paneId === targetPaneId) return;

	// Same host validation
	if (data.hostId !== null && hostId.value !== null && data.hostId !== hostId.value) return;

	const targetTab = tabId.value;
	if (targetTab === null) return;

	// Determine the zone
	const el = (event.currentTarget as HTMLElement) ?? null;
	let zone: DropZone = "center";
	if (props.node.type === "vacant") {
		zone = "center";
	} else if (el !== null) {
		zone = getDropZone(event, el);
	}

	// Check max panes (4) for non-center drops (which add a pane)
	if (zone !== "center") {
		// Find the root layout for this tab to count panes
		// The parent handles validation, but we can check here too
		// For safety, we emit and let the handler in App.vue validate
	}

	emit("drop-pane", data.channelId, targetPaneId, targetTab, zone);
}
</script>

<style scoped>
.pane-layout {
	overflow: hidden;
}

.pane-layout--terminal {
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
}

.pane-layout--split {
	display: flex;
	width: 100%;
	height: 100%;
}

.pane-layout--split-vertical {
	flex-direction: row;
}

.pane-layout--split-horizontal {
	flex-direction: column;
}

.pane-drop-wrapper {
	position: relative;
	width: 100%;
	height: 100%;
	display: flex;
	flex-direction: column;
}

.drop-zones {
	position: absolute;
	inset: 0;
	z-index: 100;
	pointer-events: none;
}

.drop-zone {
	position: absolute;
	pointer-events: all;
	opacity: 0;
	transition: opacity 0.15s;
}

.drop-zone.active {
	background: rgba(var(--nt-accent-rgb, 100, 149, 237), 0.2);
	border: 2px dashed var(--nt-accent, #6495ed);
	opacity: 1;
}

.drop-zone-left {
	left: 0;
	top: 0;
	width: 25%;
	height: 100%;
}

.drop-zone-right {
	right: 0;
	top: 0;
	width: 25%;
	height: 100%;
}

.drop-zone-top {
	left: 0;
	top: 0;
	width: 100%;
	height: 25%;
}

.drop-zone-bottom {
	left: 0;
	bottom: 0;
	width: 100%;
	height: 25%;
}

.drop-zone-center {
	left: 25%;
	top: 25%;
	width: 50%;
	height: 50%;
}
</style>
