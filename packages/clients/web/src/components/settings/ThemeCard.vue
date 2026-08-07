<template>
	<button
		class="theme-card"
		:class="{ 'theme-card--active': isActive }"
		:style="cardStyle"
		type="button"
		:title="theme.name"
		@mouseenter="$emit('preview', theme)"
		@mouseleave="$emit('preview-clear')"
		@click="$emit('select', theme)"
	>
		<span class="theme-card-name">{{ theme.name }}</span>
		<div class="theme-card-swatches">
			<span
				v-for="color in swatchColors"
				:key="color"
				class="theme-card-swatch"
				:style="{ backgroundColor: color }"
			></span>
		</div>
		<span v-if="isActive" class="theme-card-check" aria-label="Active theme">
			&#10003;
		</span>
		<button
			v-if="isCustom"
			class="theme-card-edit"
			type="button"
			title="Edit theme"
			@click.stop="$emit('edit', theme)"
		>
			&#9998;
		</button>
	</button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { LastermTheme } from "@lasterm/shared";

const props = defineProps<{
	theme: LastermTheme;
	isActive: boolean;
	isCustom?: boolean;
}>();

defineEmits<{
	preview: [theme: LastermTheme];
	"preview-clear": [];
	select: [theme: LastermTheme];
	edit: [theme: LastermTheme];
}>();

const cardStyle = computed(() => ({
	backgroundColor: props.theme.colors.background,
	color: props.theme.colors.foreground,
	borderColor: props.isActive ? props.theme.ui.accent : props.theme.ui.border,
}));

const swatchColors = computed(() => [
	props.theme.colors.black,
	props.theme.colors.red,
	props.theme.colors.green,
	props.theme.colors.yellow,
	props.theme.colors.blue,
	props.theme.colors.magenta,
	props.theme.colors.cyan,
	props.theme.colors.white,
]);
</script>

<style scoped>
.theme-card {
	position: relative;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	width: 120px;
	padding: 12px 8px;
	border: 2px solid;
	border-radius: 8px;
	cursor: pointer;
	font-family: inherit;
	font-size: 12px;
	text-align: center;
	user-select: none;
	transition: border-color 0.12s, box-shadow 0.12s;
}

.theme-card:hover {
	box-shadow: var(--nt-shadow);
}

.theme-card--active {
	box-shadow: 0 0 0 1px currentColor;
}

.theme-card-name {
	font-weight: 600;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 100%;
	line-height: 1.2;
}

.theme-card-swatches {
	display: flex;
	gap: 3px;
}

.theme-card-swatch {
	width: 10px;
	height: 10px;
	border-radius: 2px;
	flex-shrink: 0;
}

.theme-card-check {
	position: absolute;
	top: 4px;
	right: 6px;
	font-size: 11px;
	line-height: 1;
}

.theme-card-edit {
	position: absolute;
	top: 4px;
	left: 6px;
	font-size: 11px;
	line-height: 1;
	background: transparent;
	border: none;
	color: inherit;
	cursor: pointer;
	padding: 2px;
	border-radius: 3px;
	opacity: 0;
	transition: opacity 0.12s;
}

.theme-card:hover .theme-card-edit {
	opacity: 0.7;
}

.theme-card-edit:hover {
	opacity: 1 !important;
	background: var(--nt-hover);
}
</style>
