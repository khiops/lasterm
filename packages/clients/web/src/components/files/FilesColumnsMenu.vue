<template>
	<div
		ref="menu"
		class="files-menu"
		role="menu"
		aria-label="Columns"
		data-own-escape
		:style="{ left: `${x}px`, top: `${y}px` }"
		@keydown="onKeydown"
		@pointerdown.stop
		@contextmenu.prevent
	>
		<button
			v-for="column in FILES_COLUMNS"
			:key="column"
			type="button"
			class="files-menu__item"
			role="menuitemcheckbox"
			:aria-checked="chosen.includes(column)"
			tabindex="-1"
			@click="emit('toggle', column)"
		>
			<span class="files-menu__check" aria-hidden="true">{{ chosen.includes(column) ? "✓" : "" }}</span>
			{{ FILES_COLUMN_LABELS[column] }}
		</button>
		<hr class="files-menu__rule" />
		<button type="button" class="files-menu__item" role="menuitem" tabindex="-1" @click="emit('reset')">
			<span class="files-menu__check" aria-hidden="true" />
			Reset columns
		</button>
		<p class="files-menu__note">A narrow panel shows fewer.</p>
	</div>
</template>

<script setup lang="ts">
import { FILES_COLUMNS, type FilesColumn } from "@lasterm/shared";
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { FILES_COLUMN_LABELS } from "../../utils/files-panel.js";

/**
 * The columns the files list shows (#1209): one checkbox per column after Name, and Reset. It
 * opens at the pointer or on the header that asked, and closes on Escape or a press elsewhere.
 */
defineProps<{ x: number; y: number; chosen: readonly FilesColumn[] }>();

const emit = defineEmits<{
	(e: "toggle", column: FilesColumn): void;
	(e: "reset"): void;
	/** `refocus`: the menu was left by the keyboard, which goes back to the header. */
	(e: "close", refocus: boolean): void;
}>();

const menu = ref<HTMLElement | null>(null);

function items(): HTMLElement[] {
	return [...(menu.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
}

function onKeydown(event: KeyboardEvent): void {
	const all = items();
	const at = all.indexOf(document.activeElement as HTMLElement);
	let to: number | null = null;
	if (event.key === "ArrowDown") to = (at + 1) % all.length;
	else if (event.key === "ArrowUp") to = (at <= 0 ? all.length : at) - 1;
	else if (event.key === "Home") to = 0;
	else if (event.key === "End") to = all.length - 1;
	else if (event.key === "Escape" || event.key === "Tab") {
		event.preventDefault();
		event.stopPropagation();
		emit("close", true);
		return;
	}
	if (to !== null) {
		event.preventDefault();
		all[to]?.focus();
	}
}

function onOutside(event: Event): void {
	if (!menu.value?.contains(event.target as Node)) emit("close", false);
}

onMounted(() => {
	document.addEventListener("pointerdown", onOutside, true);
	void nextTick(() => items()[0]?.focus());
});

onUnmounted(() => document.removeEventListener("pointerdown", onOutside, true));
</script>

<style scoped>
.files-menu {
	position: absolute;
	z-index: 4;
	min-width: 150px;
	padding: 4px 0;
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	box-shadow: var(--nt-shadow);
	font-size: 12px;
	max-height: calc(100% - 8px);
	overflow-y: auto;
}

.files-menu__item {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 4px 10px 4px 6px;
	border: none;
	background: none;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}

.files-menu__item:hover,
.files-menu__item:focus-visible {
	background: var(--nt-hover);
	outline: none;
}

.files-menu__item:focus-visible {
	box-shadow: inset 0 0 0 2px var(--nt-accent);
}

.files-menu__check {
	display: inline-block;
	width: 14px;
	text-align: center;
}

.files-menu__rule {
	margin: 4px 0;
	border: none;
	border-top: 1px solid var(--nt-border);
}

.files-menu__note {
	margin: 0;
	padding: 2px 10px 2px 26px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}
</style>
