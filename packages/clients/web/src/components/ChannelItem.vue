<template>
	<div
		class="channel-item"
		:class="{
			'channel-item--selected': isSelected,
			'channel-item--dead': channel.status === 'dead',
		}"
		:title="displayLabel"
		@click="emit('select')"
		@contextmenu.prevent="onContextMenu"
	>
		<span class="channel-item__status" :class="`channel-item__status--${channel.status}`"></span>
		<input
			v-if="isEditing"
			ref="editInput"
			v-model="editValue"
			class="channel-rename-input"
			@keydown.enter="commitRename"
			@keydown.escape="cancelRename"
			@blur="commitRename"
		/>
		<span v-else class="channel-item__label" @dblclick="startRename">{{ displayLabel }}</span>
		<span v-if="channel.isWelcome" class="channel-item__welcome-star" title="Welcome Tab">&#x2605;</span>
		<span
			v-if="hasActivity && !isSelected"
			class="channel-item__activity-dot"
			aria-label="New activity"
		></span>
		<span
			v-if="bellCount > 0"
			class="channel-item__bell-badge"
		>{{ bellCount }}</span>
		<span v-if="isUnread" class="channel-item__unread" aria-label="Unread output"></span>
	</div>

	<!-- Context menu -->
	<Teleport to="body">
		<div
			v-if="contextMenuVisible"
			ref="menuEl"
			class="channel-context-menu"
			:style="{ top: `${contextMenuY}px`, left: `${contextMenuX}px` }"
			@click.stop
		>
			<button class="channel-context-menu__item" @click="onAction('openNewTab')">Open in New Tab</button>
			<button class="channel-context-menu__item" @click="onAction('openCurrentTab')">Open in Current Tab</button>

			<div class="channel-context-menu__sep"></div>

			<button class="channel-context-menu__item" @click="onAction('rename')">Rename</button>
			<button class="channel-context-menu__item" @click="onAction('configureCommand')">Configure Command</button>
			<button class="channel-context-menu__item" @click="onAction('setWelcome')">
				{{ channel.isWelcome ? "Unset Welcome Tab" : "Set as Welcome Tab" }}
			</button>

			<div v-if="channel.status === 'dead'" class="channel-context-menu__sep"></div>
			<button
				v-if="channel.status === 'dead'"
				class="channel-context-menu__item"
				@click="onAction('restart')"
			>Restart</button>

			<div v-if="availableGroups.length > 0 || channel.groupId != null" class="channel-context-menu__sep"></div>
			<button v-if="channel.groupId != null" class="channel-context-menu__item" @click="onMoveToGroup(null)">
				Move to General
			</button>
			<button
				v-for="group in availableGroups"
				:key="group.id"
				class="channel-context-menu__item"
				@click="onMoveToGroup(group.id)"
			>
				Move to {{ group.name }}
			</button>

			<div class="channel-context-menu__sep"></div>
			<button
				v-if="channel.status !== 'dead'"
				class="channel-context-menu__item channel-context-menu__item--danger"
				@click="onAction('destroy')"
			>Kill Terminal</button>
			<button
				v-if="channel.status === 'dead'"
				class="channel-context-menu__item channel-context-menu__item--danger"
				@click="onAction('delete')"
			>Delete</button>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { DEFAULT_CHANNEL_NAME } from "@lasterm/shared";
import type { Channel, ChannelGroup } from "@lasterm/shared";
import { useRename } from "../composables/useRename.js";
import { useNotificationStore } from "../stores/notifications.js";

const props = defineProps<{
	channel: Channel;
	/** 1-based display index within its group, used as fallback label. */
	index: number;
	isSelected: boolean;
	isUnread: boolean;
	availableGroups: ChannelGroup[];
}>();

const emit = defineEmits<{
	select: [];
	closeChannel: [channelId: string];
	moveToGroup: [channelId: string, groupId: string | null];
	rename: [channelId: string, title: string];
	openNewTab: [channelId: string];
	openCurrentTab: [channelId: string];
	triggerRename: [channelId: string];
	configureCommand: [channelId: string];
	setWelcome: [channelId: string];
	restart: [channelId: string];
	destroy: [channelId: string];
	delete: [channelId: string];
}>();

const notificationStore = useNotificationStore();

const bellCount = computed(() => notificationStore.bellCounts.get(props.channel.id) ?? 0);
const hasActivity = computed(() => notificationStore.activityDots.get(props.channel.id) ?? false);

const displayLabel = computed(
	() => props.channel.displayTitle ?? DEFAULT_CHANNEL_NAME,
);

// -------------------------------------------------------------------------
// Inline rename
// -------------------------------------------------------------------------

const { isEditing, editValue, editInput, startRename: startRenameRaw, commitRename, cancelRename } = useRename({
	onCommit: (newValue) => emit("rename", props.channel.id, newValue),
});

function startRename(): void {
	startRenameRaw(displayLabel.value);
}

// -------------------------------------------------------------------------
// Context menu
// -------------------------------------------------------------------------

const contextMenuVisible = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);
const menuEl = ref<HTMLElement | null>(null);

function onContextMenu(event: MouseEvent): void {
	contextMenuX.value = event.clientX;
	contextMenuY.value = event.clientY;
	contextMenuVisible.value = true;
}

type ContextAction =
	| "openNewTab"
	| "openCurrentTab"
	| "rename"
	| "configureCommand"
	| "setWelcome"
	| "restart"
	| "destroy"
	| "delete";

function onAction(action: ContextAction): void {
	contextMenuVisible.value = false;
	if (action === "rename") {
		startRename();
		emit("triggerRename", props.channel.id);
		return;
	}
	(emit as (event: string, ...args: unknown[]) => void)(action, props.channel.id);
}

function onMoveToGroup(groupId: string | null): void {
	contextMenuVisible.value = false;
	emit("moveToGroup", props.channel.id, groupId);
}

// Close on click-outside (same pattern as TabContextMenu)
function onClickOutside(event: MouseEvent): void {
	if (menuEl.value && !menuEl.value.contains(event.target as Node)) {
		contextMenuVisible.value = false;
	}
}

// Close on Escape
function onKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") contextMenuVisible.value = false;
}

onMounted(() => {
	document.addEventListener("mousedown", onClickOutside, true);
	window.addEventListener("keydown", onKeydown);
});

onUnmounted(() => {
	document.removeEventListener("mousedown", onClickOutside, true);
	window.removeEventListener("keydown", onKeydown);
});
</script>

<style scoped>
.channel-item {
	display: flex;
	align-items: center;
	gap: 7px;
	padding: 5px 10px 5px 20px;
	cursor: pointer;
	font-size: 13px;
	color: var(--nt-sidebar-text);
	border-radius: 4px;
	margin: 0 4px;
	transition: background 0.1s, color 0.1s;
	user-select: none;
	position: relative;
}

.channel-item:hover {
	background: var(--nt-border);
	color: var(--nt-fg);
}

.channel-item--selected {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.channel-item--dead {
	opacity: 0.45;
}

/* Status dot */
.channel-item__status {
	flex-shrink: 0;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--nt-tab-hover);
}

.channel-item__status--live {
	background: var(--nt-green);
}

.channel-item__status--born {
	background: var(--nt-yellow);
	animation: pulse 1.4s ease-in-out infinite;
}

.channel-item__status--orphan {
	background: var(--nt-text-secondary);
}

.channel-item__status--dead {
	background: var(--nt-tab-hover);
}

@keyframes pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.4; }
}

.channel-item__label {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.channel-rename-input {
	flex: 1;
	background: transparent;
	border: none;
	border-bottom: 1px solid var(--nt-tab-hover);
	color: inherit;
	font: inherit;
	outline: none;
	width: 100%;
	padding: 0;
}

/* Welcome tab star */
.channel-item__welcome-star {
	flex-shrink: 0;
	font-size: 10px;
	color: var(--nt-accent);
	line-height: 1;
}

/* Activity dot */
.channel-item__activity-dot {
	flex-shrink: 0;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--nt-blue, #3b82f6);
}

/* Bell badge */
.channel-item__bell-badge {
	flex-shrink: 0;
	min-width: 16px;
	height: 16px;
	padding: 0 4px;
	border-radius: 8px;
	background: var(--nt-badge);
	color: var(--nt-bright-white, #fff);
	font-size: 10px;
	font-weight: 700;
	line-height: 16px;
	text-align: center;
}

/* Unread indicator dot */
.channel-item__unread {
	flex-shrink: 0;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--nt-accent);
}

/* Context menu */
.channel-context-menu {
	position: fixed;
	z-index: 1000;
	background: var(--nt-border);
	border: 1px solid var(--nt-tab-hover);
	border-radius: 6px;
	padding: 4px;
	min-width: 160px;
	box-shadow: var(--nt-shadow);
}

.channel-context-menu__item {
	display: block;
	width: 100%;
	padding: 6px 10px;
	text-align: left;
	background: none;
	border: none;
	border-radius: 4px;
	color: var(--nt-fg);
	font-size: 13px;
	cursor: pointer;
	transition: background 0.1s;
}

.channel-context-menu__item:hover {
	background: var(--nt-tab-hover);
}

.channel-context-menu__sep {
	height: 1px;
	background: var(--nt-tab-hover);
	margin: 4px 0;
}

.channel-context-menu__item--danger {
	color: var(--nt-badge);
}

.channel-context-menu__item--danger:hover {
	background: var(--nt-badge);
	color: var(--nt-fg);
}
</style>
