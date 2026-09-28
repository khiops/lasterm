
<template>
	<div class="font-card" :class="{ 'font-card--selected': selected }">
		<!-- Choosing the font: a button the size of the card, under its delete control, which a
		     click anywhere else on the card reaches and the keyboard too (#637). -->
		<button
			type="button"
			class="font-card-select"
			:aria-label="family.family"
			:aria-pressed="selected"
			@click="emit('select')"
		></button>
		<div class="font-card-header">
			<span class="font-card-name" :style="{ fontFamily: `'${family.family}'` }">
				{{ family.family }}
			</span>
			<button
				v-if="!confirmDelete"
				type="button"
				class="font-card-delete"
				title="Delete font"
				:aria-label="`Delete ${family.family}`"
				@click.stop="confirmDelete = true"
			>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
					<path d="M2 3h10M5 3V2h4v1M3 3l.8 9h6.4L11 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<div v-else class="font-card-confirm">
				<span class="font-card-confirm-label">Delete?</span>
				<button class="font-card-confirm-btn font-card-confirm-btn--danger" @click.stop="emit('delete')">Delete</button>
				<button class="font-card-confirm-btn" @click.stop="confirmDelete = false">Cancel</button>
			</div>
		</div>
		<div class="font-card-preview" :style="{ fontFamily: `'${family.family}'` }">
			{{ previewText ?? DEFAULT_PREVIEW }}
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import type { FontFamily } from "@lasterm/shared";

const DEFAULT_PREVIEW = "$ ls -la ~/.config 0123456789";

const props = defineProps<{
	family: FontFamily;
	selected: boolean;
	previewText?: string;
}>();

const emit = defineEmits<{
	select: [];
	delete: [];
}>();

const confirmDelete = ref(false);
</script>

<style scoped>
.font-card {
	position: relative;
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 10px 12px;
	background: var(--nt-bg-raised);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	cursor: pointer;
	transition: border-color 0.15s ease;
}

.font-card:hover {
	border-color: var(--nt-fg-muted);
}

.font-card--selected {
	border-color: var(--nt-accent);
	box-shadow: 0 0 0 1px var(--nt-accent);
}

.font-card-select {
	position: absolute;
	inset: 0;
	width: 100%;
	height: 100%;
	margin: 0;
	padding: 0;
	border: none;
	border-radius: inherit;
	background: transparent;
	cursor: pointer;
}

.font-card-select:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

/* The name and the preview let clicks through to the card's button; the delete control does not. */
.font-card-header,
.font-card-preview {
	pointer-events: none;
}

.font-card-delete,
.font-card-confirm {
	position: relative;
	z-index: 1;
	pointer-events: auto;
}

.font-card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.font-card-name {
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	flex: 1;
}

.font-card-delete {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	padding: 0;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	color: var(--nt-fg-muted);
	cursor: pointer;
	opacity: 0;
	transition: opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

/* Shown with the card under the mouse, and whenever the keyboard is on the card or on it. */
.font-card:hover .font-card-delete,
.font-card:focus-within .font-card-delete {
	opacity: 1;
}

.font-card-delete:focus-visible,
.font-card-confirm-btn:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.font-card-delete:hover {
	color: var(--nt-danger);
	border-color: var(--nt-danger);
	background: rgba(var(--nt-danger-rgb, 220, 50, 50), 0.08);
}

.font-card-confirm {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}

.font-card-confirm-label {
	font-size: 11px;
	color: var(--nt-fg-muted);
}

.font-card-confirm-btn {
	padding: 2px 8px;
	font-size: 11px;
	font-family: inherit;
	background: var(--nt-bg-surface);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	cursor: pointer;
}

.font-card-confirm-btn:hover {
	background: var(--nt-hover);
}

.font-card-confirm-btn--danger {
	background: rgba(var(--nt-danger-rgb, 220, 50, 50), 0.12);
	border-color: var(--nt-danger);
	color: var(--nt-danger);
}

.font-card-confirm-btn--danger:hover {
	background: var(--nt-danger);
	color: var(--nt-danger-fg);
}

.font-card-preview {
	font-size: 12px;
	color: var(--nt-fg-muted);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	line-height: 1.5;
}
</style>
