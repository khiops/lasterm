<template>
	<div class="channel-sidebar">
		<!-- Header: host label + new channel button -->
		<div class="sidebar-header">
			<span class="sidebar-header__label" :title="hostLabel">{{ hostLabel }}</span>
			<button
				v-if="hasDeadChannels"
				class="sidebar-header__clear-btn"
				title="Delete all dead channels"
				aria-label="Delete all dead channels"
				@click="emit('purge-dead')"
			>
				<span aria-hidden="true">&#x1F5D1;</span>
			</button>
			<button
				class="sidebar-header__new-btn"
				:disabled="activeHostId === null"
				:title="activeHostId === null ? 'Select a host first' : 'New channel'"
				aria-label="New channel"
				@click="onNewChannel"
			>
				<span class="sidebar-header__new-icon" aria-hidden="true">+</span>
			</button>
		</div>

		<!-- Channel list, grouped -->
		<div class="sidebar-list" @contextmenu.self.prevent="emit('sidebar-context-menu', $event)">
			<!-- Loading state -->
			<div v-if="channelsStore.loading" class="sidebar-state">Loading…</div>

			<!-- Error state -->
			<div v-else-if="channelsStore.error" class="sidebar-state sidebar-state--error">
				{{ channelsStore.error }}
			</div>

			<!-- Empty state: no host selected -->
			<div v-else-if="activeHostId === null" class="sidebar-state">
				Select a host to view channels.
			</div>

			<!-- Empty state: host has no channels yet -->
			<div
				v-else-if="channelsStore.channels.length === 0"
				class="sidebar-state"
			>
				No channels yet — click + to start one.
			</div>

			<!-- Populated channel list -->
			<template v-else>
				<!-- Groups defined by user (draggable) -->
				<template
					v-for="group in channelsStore.groups.filter((g) => g.hostId === activeHostId || g.hostId === '')"
					:key="group.id"
				>
					<div
						class="group-drag-zone"
						:class="{
							'group-drag-zone--drag': dragGroupId === group.id,
							'group-drag-zone--over-top': dragOverId === group.id && dragPosition === 'top',
							'group-drag-zone--over-bottom': dragOverId === group.id && dragPosition === 'bottom',
						}"
						draggable="true"
						@dragstart="onGroupDragStart($event, group.id)"
						@dragend="onGroupDragEnd"
						@dragover.prevent="onGroupDragOver($event, group.id)"
						@dragleave="onGroupDragLeave(group.id)"
						@drop.prevent="onGroupDrop($event, group.id)"
					>
						<ChannelGroupHeader
							:group="group"
							:count="(channelsStore.channelsByGroup.get(group.id) ?? []).length"
							:has-dead-channels="groupHasDeadChannels(group.id)"
							@toggle="channelsStore.toggleGroupCollapsed(group.id)"
							@rename="channelsStore.renameGroup"
							@delete="channelsStore.removeGroup"
							@purge-dead="onPurgeDeadInGroup"
						/>
					</div>
					<template v-if="!group.collapsed">
						<ChannelItem
							v-for="(ch, idx) in channelsStore.channelsByGroup.get(group.id) ?? []"
							:key="ch.id"
							:channel="ch"
							:index="idx + 1"
							:is-selected="ch.id === channelsStore.selectedChannelId"
							:is-unread="channelsStore.unreadChannels.has(ch.id)"
							:available-groups="otherGroups(group.id)"
							@select="emit('select-channel', ch.id)"
							@close-channel="onCloseChannel"
							@move-to-group="channelsStore.moveChannelToGroup"
							@rename="onRenameChannel"
							@open-new-tab="emit('open-new-tab', $event)"
							@open-current-tab="emit('open-current-tab', $event)"
							@configure-command="emit('configure-command', $event)"
							@set-welcome="emit('set-welcome', $event)"
							@restart="onRestartChannel"
							@destroy="onDestroyChannel"
							@delete="(id) => emit('delete-channel', id)"
						/>
					</template>
				</template>

				<!-- "General" group — ungrouped channels, NOT draggable / NOT a drop target -->
				<ChannelGroupHeader
					:group="generalGroup"
					:count="(channelsStore.channelsByGroup.get(null) ?? []).length"
					:has-dead-channels="groupHasDeadChannels(null)"
					@toggle="toggleGeneral"
					@rename="() => {}"
					@delete="() => {}"
					@purge-dead="onPurgeDeadInGroup"
				/>
				<template v-if="!generalCollapsed">
					<ChannelItem
						v-for="(ch, idx) in channelsStore.channelsByGroup.get(null) ?? []"
						:key="ch.id"
						:channel="ch"
						:index="idx + 1"
						:is-selected="ch.id === channelsStore.selectedChannelId"
						:is-unread="channelsStore.unreadChannels.has(ch.id)"
						:available-groups="channelsStore.groups.filter((g) => g.hostId === activeHostId || g.hostId === '')"
						@select="emit('select-channel', ch.id)"
						@close-channel="onCloseChannel"
						@move-to-group="channelsStore.moveChannelToGroup"
						@rename="onRenameChannel"
						@open-new-tab="emit('open-new-tab', $event)"
						@open-current-tab="emit('open-current-tab', $event)"
						@configure-command="emit('configure-command', $event)"
						@set-welcome="emit('set-welcome', $event)"
						@restart="onRestartChannel"
						@destroy="onDestroyChannel"
						@delete="(id) => emit('delete-channel', id)"
					/>
				</template>
			</template>
		</div>

		<!-- Footer: add group button -->
		<div v-if="activeHostId !== null" class="sidebar-footer">
			<button
				class="sidebar-footer__add-group"
				title="Add channel group"
				@click="onAddGroup"
			>
				+ Add group
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChannelGroup } from "@lasterm/shared";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useConfigStore } from "../stores/config.js";
import ChannelGroupHeader from "./ChannelGroupHeader.vue";
import ChannelItem from "./ChannelItem.vue";

const emit = defineEmits<{
	"select-channel": [channelId: string];
	"open-new-tab": [channelId: string];
	"open-current-tab": [channelId: string];
	"configure-command": [channelId: string];
	"set-welcome": [channelId: string];
	"sidebar-context-menu": [event: MouseEvent];
	"add-channel-group": [];
	"purge-dead": [];
	"delete-channel": [channelId: string];
	"new-channel": [];
}>();

const channelsStore = useChannelsStore();
const hostsStore = useHostsStore();
const configStore = useConfigStore();

const activeHostId = computed(() => channelsStore.activeHostId);

const hostLabel = computed(() => {
	const id = activeHostId.value;
	if (id === null) return "No host selected";
	const host = hostsStore.hosts.find((h) => h.id === id);
	return host?.label ?? id;
});

// -------------------------------------------------------------------------
// Synthetic "General" group for ungrouped channels
// -------------------------------------------------------------------------

const generalCollapsed = computed(() => channelsStore.generalCollapsed);

const hasDeadChannels = computed(() =>
	channelsStore.channels.some((c) => c.status === "dead"),
);

/** Pseudo-group object for the ungrouped bucket. Not persisted to API. */
const generalGroup = computed<ChannelGroup>(() => ({
	id: "__general__",
	hostId: activeHostId.value ?? "",
	name: configStore.uiConfig?.channels?.defaultGroupName ?? "General",
	sortOrder: -1,
	collapsed: generalCollapsed.value,
	createdAt: "",
}));

function toggleGeneral(): void {
	channelsStore.toggleGeneralCollapsed();
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/** Whether a group contains at least one dead channel. */
function groupHasDeadChannels(groupId: string | null): boolean {
	const channels = channelsStore.channelsByGroup.get(groupId) ?? [];
	return channels.some((c) => c.status === "dead");
}

/** Groups available for "Move to" context-menu, excluding the one the channel is already in. */
function otherGroups(currentGroupId: string): ChannelGroup[] {
	return channelsStore.groups.filter(
		(g) =>
			g.id !== currentGroupId &&
			(g.hostId === activeHostId.value || g.hostId === ""),
	);
}

// -------------------------------------------------------------------------
// Drag-and-drop reorder for group headers
// -------------------------------------------------------------------------

/** ID of the group currently being dragged. */
const dragGroupId = ref<string | null>(null);

/** ID of the group the drag is hovering over (drop target). */
const dragOverId = ref<string | null>(null);

/** Whether the drop indicator is above ("top") or below ("bottom") the target. */
const dragPosition = ref<"top" | "bottom">("top");

function onGroupDragStart(event: DragEvent, groupId: string): void {
	dragGroupId.value = groupId;
	event.dataTransfer?.setData("text/plain", groupId);
	// Slight delay so the ghost image captures un-faded state
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
	}
}

function onGroupDragEnd(): void {
	dragGroupId.value = null;
	dragOverId.value = null;
}

function onGroupDragOver(event: DragEvent, groupId: string): void {
	if (dragGroupId.value === null || dragGroupId.value === groupId) return;
	dragOverId.value = groupId;
	// Determine whether to show the indicator above or below the midpoint
	const el = (event.currentTarget as HTMLElement);
	const rect = el.getBoundingClientRect();
	dragPosition.value = event.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
}

function onGroupDragLeave(groupId: string): void {
	if (dragOverId.value === groupId) {
		dragOverId.value = null;
	}
}

function onGroupDrop(event: DragEvent, targetGroupId: string): void {
	const sourceId = event.dataTransfer?.getData("text/plain") ?? dragGroupId.value;
	dragGroupId.value = null;
	dragOverId.value = null;

	if (!sourceId || sourceId === targetGroupId || activeHostId.value === null) return;

	const hostId = activeHostId.value;
	const visibleGroups = channelsStore.groups.filter(
		(g) => g.hostId === hostId || g.hostId === "",
	);

	// Build the new order by inserting source before or after target
	const without = visibleGroups.filter((g) => g.id !== sourceId);
	const targetIdx = without.findIndex((g) => g.id === targetGroupId);
	if (targetIdx === -1) return;

	const insertAt = dragPosition.value === "top" ? targetIdx : targetIdx + 1;
	const source = visibleGroups.find((g) => g.id === sourceId);
	if (!source) return;

	without.splice(insertAt, 0, source);
	const newOrder = without.map((g) => g.id);

	void channelsStore.reorderGroups(hostId, newOrder);
}

// -------------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------------

function onNewChannel(): void {
	if (activeHostId.value === null) return;
	emit("new-channel");
}

function onCloseChannel(channelId: string): void {
	channelsStore.removeChannel(channelId);
}

function onRenameChannel(channelId: string, title: string): void {
	channelsStore.renameChannel(channelId, title);
}

function onRestartChannel(channelId: string): void {
	channelsStore.restartChannel(channelId);
}

function onDestroyChannel(channelId: string): void {
	channelsStore.removeChannel(channelId);
}

function onPurgeDeadInGroup(groupId: string): void {
	const lookupKey = groupId === "__general__" ? null : groupId;
	const dead = (channelsStore.channelsByGroup.get(lookupKey) ?? [])
		.filter((c) => c.status === "dead");
	for (const ch of dead) {
		void channelsStore.deleteChannel(ch.id);
	}
}

function onAddGroup(): void {
	emit("add-channel-group");
}
</script>

<style scoped>
.channel-sidebar {
	display: flex;
	flex-direction: column;
	overflow: hidden;
	height: 100%;
}

/* Header */
.sidebar-header {
	display: flex;
	align-items: center;
	padding: 10px 8px 8px;
	gap: 6px;
	flex-shrink: 0;
	border-bottom: 1px solid var(--nt-border);
}

.sidebar-header__label {
	flex: 1;
	font-size: 12px;
	font-weight: 600;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	user-select: none;
}

.sidebar-header__new-btn {
	flex-shrink: 0;
	width: 22px;
	height: 22px;
	border-radius: 4px;
	border: none;
	background: transparent;
	color: var(--nt-text-secondary);
	font-size: 18px;
	line-height: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	transition: background 0.1s, color 0.1s;
	padding: 0;
}

.sidebar-header__new-btn:not(:disabled):hover {
	background: var(--nt-border);
	color: var(--nt-accent);
}

.sidebar-header__new-btn:disabled {
	cursor: not-allowed;
	opacity: 0.35;
}

.sidebar-header__new-icon {
	display: block;
	line-height: 1;
	margin-top: -1px;
}

.sidebar-header__clear-btn {
	flex-shrink: 0;
	width: 22px;
	height: 22px;
	border-radius: 4px;
	border: none;
	background: transparent;
	color: var(--nt-text-secondary);
	font-size: 14px;
	line-height: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	transition: background 0.1s, color 0.1s;
	padding: 0;
}

.sidebar-header__clear-btn:hover {
	background: var(--nt-border);
	color: var(--nt-badge);
}

/* Scrollable list */
.sidebar-list {
	flex: 1;
	overflow-y: auto;
	overflow-x: hidden;
	padding: 4px 0;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-border) transparent;
}

.sidebar-list::-webkit-scrollbar {
	width: 4px;
}

.sidebar-list::-webkit-scrollbar-track {
	background: transparent;
}

.sidebar-list::-webkit-scrollbar-thumb {
	background: var(--nt-border);
	border-radius: 2px;
}

/* State messages */
.sidebar-state {
	padding: 8px 12px;
	font-size: 12px;
	color: var(--nt-tab-hover);
	font-style: italic;
}

.sidebar-state--error {
	color: var(--nt-badge);
	font-style: normal;
}

/* Drag-and-drop zones */
.group-drag-zone {
	position: relative;
	transition: opacity 0.15s;
}

.group-drag-zone--drag {
	opacity: 0.5;
}

.group-drag-zone--over-top::before,
.group-drag-zone--over-bottom::after {
	content: "";
	display: block;
	height: 2px;
	background: var(--nt-accent);
	border-radius: 1px;
	margin: 0 8px;
}

.group-drag-zone--over-top::before {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	margin: 0 8px;
}

.group-drag-zone--over-bottom::after {
	position: absolute;
	bottom: 0;
	left: 0;
	right: 0;
	margin: 0 8px;
}

/* Footer */
.sidebar-footer {
	flex-shrink: 0;
	padding: 6px 8px;
	border-top: 1px solid var(--nt-border);
}

.sidebar-footer__add-group {
	width: 100%;
	padding: 5px 8px;
	background: none;
	border: 1px dashed var(--nt-tab-hover);
	border-radius: 4px;
	color: var(--nt-text-secondary);
	font-size: 11px;
	cursor: pointer;
	transition: border-color 0.1s, color 0.1s;
	text-align: center;
}

.sidebar-footer__add-group:hover {
	border-color: var(--nt-accent);
	color: var(--nt-accent);
}
</style>
