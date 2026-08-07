
<template>
	<div
		class="font-card"
		:class="{ 'font-card--selected': selected }"
		@click="emit('select')"
	>
		<div class="font-card-header">
			<span class="font-card-name" :style="{ fontFamily: `'${family.family}'` }">
				{{ family.family }}
			</span>
			<button
				v-if="!confirmDelete"
				class="font-card-delete"
				title="Delete font"
				@click.stop="confirmDelete = true"
			>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
					<path d="M2 3h10M5 3V2h4v1M3 3l.8 9h6.4L11 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</button>
			<div v-else class="font-card-confirm" @click.stop>
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

.font-card:hover .font-card-delete {
	opacity: 1;
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
