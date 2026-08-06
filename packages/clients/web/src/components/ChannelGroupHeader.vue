<template>
	<div
		class="group-header"
		:class="{ 'group-header--collapsed': group.collapsed }"
		@click="emit('toggle')"
		@contextmenu.prevent="onContextMenu"
	>
		<!-- Chevron rotates on expand/collapse -->
		<span class="group-header__chevron" aria-hidden="true">&#x276F;</span>

		<!-- Editable group name -->
		<span
			v-if="!editing"
			class="group-header__name"
			@dblclick.stop="startEdit"
		>{{ group.name }}</span>
		<input
			v-else
			ref="inputEl"
			v-model="editValue"
			class="group-header__input"
			maxlength="40"
			@blur="commitEdit"
			@keydown.enter.prevent="commitEdit"
			@keydown.escape.prevent="cancelEdit"
			@click.stop
		/>

		<!-- Channel count badge -->
		<span class="group-header__count">{{ count }}</span>
	</div>

	<!-- Context menu -->
	<Teleport to="body">
		<div
			v-if="contextMenuVisible"
			class="group-context-menu"
			:style="{ top: `${contextMenuY}px`, left: `${contextMenuX}px` }"
			@click.stop
		>
			<button class="group-context-menu__item" @click="onRename">Rename</button>
			<button v-if="hasDeadChannels" class="group-context-menu__item" @click="onPurgeDead">
				Clean Up Dead Terminals
			</button>
			<div class="group-context-menu__sep"></div>
			<button class="group-context-menu__item group-context-menu__item--danger" @click="onDelete">
				Delete group
			</button>
		</div>
		<div
			v-if="contextMenuVisible"
			class="group-context-menu__backdrop"
			@click="contextMenuVisible = false"
			@contextmenu.prevent="contextMenuVisible = false"
		></div>
	</Teleport>
</template>

<script setup lang="ts">
import { ref, nextTick, onUnmounted } from "vue";
import type { ChannelGroup } from "@lasterm/shared";

const props = defineProps<{
	group: ChannelGroup;
	count: number;
	hasDeadChannels?: boolean;
}>();

const emit = defineEmits<{
	toggle: [];
	rename: [groupId: string, name: string];
	delete: [groupId: string];
	purgeDead: [groupId: string];
}>();

// -------------------------------------------------------------------------
// Inline rename
// -------------------------------------------------------------------------

const editing = ref(false);
const editValue = ref("");
const inputEl = ref<HTMLInputElement | null>(null);

function startEdit(): void {
	editValue.value = props.group.name;
	editing.value = true;
	void nextTick(() => inputEl.value?.select());
}

function commitEdit(): void {
	const trimmed = editValue.value.trim();
	if (trimmed.length > 0 && trimmed !== props.group.name) {
		emit("rename", props.group.id, trimmed);
	}
	editing.value = false;
}

function cancelEdit(): void {
	editing.value = false;
}

// -------------------------------------------------------------------------
// Context menu
// -------------------------------------------------------------------------

const contextMenuVisible = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

function onContextMenu(event: MouseEvent): void {
	contextMenuX.value = event.clientX;
	contextMenuY.value = event.clientY;
	contextMenuVisible.value = true;
}

function onRename(): void {
	contextMenuVisible.value = false;
	startEdit();
}

function onDelete(): void {
	contextMenuVisible.value = false;
	emit("delete", props.group.id);
}

function onPurgeDead(): void {
	contextMenuVisible.value = false;
	emit("purgeDead", props.group.id);
}

function onKeydown(e: KeyboardEvent): void {
	if (e.key === "Escape") contextMenuVisible.value = false;
}

window.addEventListener("keydown", onKeydown);
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<style scoped>
.group-header {
	display: flex;
	align-items: center;
	gap: 5px;
	padding: 4px 8px 4px 8px;
	margin-top: 8px;
	cursor: pointer;
	user-select: none;
	color: var(--nt-sidebar-text);
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	border-radius: 4px;
	transition: color 0.1s, background 0.1s;
}

.group-header:hover {
	color: var(--nt-text-muted);
	background: var(--nt-bg);
}

/* Chevron: points right when collapsed, down when expanded */
.group-header__chevron {
	font-size: 9px;
	display: inline-block;
	transition: transform 0.15s ease;
	/* Default (not collapsed): rotate to point down */
	transform: rotate(90deg);
	color: var(--nt-text-secondary);
}

.group-header--collapsed .group-header__chevron {
	transform: rotate(0deg);
}

.group-header__name {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.group-header__input {
	flex: 1;
	background: var(--nt-border);
	border: 1px solid var(--nt-accent);
	border-radius: 3px;
	color: var(--nt-fg);
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.08em;
	padding: 1px 4px;
	outline: none;
}

.group-header__count {
	font-size: 10px;
	color: var(--nt-text-secondary);
	min-width: 12px;
	text-align: right;
}

/* Context menu */
.group-context-menu__backdrop {
	position: fixed;
	inset: 0;
	z-index: 999;
}

.group-context-menu {
	position: fixed;
	z-index: 1000;
	background: var(--nt-border);
	border: 1px solid var(--nt-tab-hover);
	border-radius: 6px;
	padding: 4px;
	min-width: 140px;
	box-shadow: var(--nt-shadow);
}

.group-context-menu__item {
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
	text-transform: none;
	letter-spacing: normal;
	font-weight: normal;
}

.group-context-menu__item:hover {
	background: var(--nt-tab-hover);
}

.group-context-menu__item--danger {
	color: var(--nt-badge);
}

.group-context-menu__item--danger:hover {
	background: rgba(var(--nt-badge-rgb), 0.15);
}

.group-context-menu__sep {
	height: 1px;
	background: var(--nt-tab-hover);
	margin: 4px 0;
}
</style>
