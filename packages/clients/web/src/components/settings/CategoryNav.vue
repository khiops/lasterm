<template>
	<nav ref="navEl" class="category-nav" aria-label="Settings categories">
		<button
			v-for="cat in visibleCategories"
			:key="cat.id"
			class="category-item"
			:class="{ active: modelValue === cat.id }"
			:data-category-id="cat.id"
			:tabindex="cat.id === modelValue ? 0 : -1"
			:aria-current="modelValue === cat.id ? 'page' : undefined"
			@click="emit('update:modelValue', cat.id)"
			@keydown="onKeydown($event, cat.id)"
		>
			{{ cat.label }}
		</button>
	</nav>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Scope } from "../../stores/settings.js";
import { listMove } from "../../utils/focus-zones.js";
import { getVisibleSettingsCategories } from "./settingsCategories.js";

const props = defineProps<{
	modelValue: string;
	scope: Scope;
	showDesktop?: boolean;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: string];
	/** → or Enter on a category: the keyboard goes into its detail (#637). */
	"enter-detail": [];
}>();

const navEl = ref<HTMLElement | null>(null);

const visibleCategories = computed(() =>
	getVisibleSettingsCategories(props.scope, props.showDesktop === true),
);

// Auto-select first visible category if the active one becomes hidden after scope change
watch(
	visibleCategories,
	(cats) => {
		if (cats.length > 0 && !cats.some((c) => c.id === props.modelValue)) {
			emit("update:modelValue", cats[0]!.id);
		}
	},
	{ immediate: true },
);

/** Give the keyboard to a category's item. */
function focusCategory(id: string): void {
	const items = navEl.value?.querySelectorAll<HTMLElement>("[data-category-id]") ?? [];
	[...items].find((item) => item.dataset.categoryId === id)?.focus();
}

/**
 * The menu from the keyboard (#637): one category takes Tab, and ↑ and ↓ move between them,
 * showing each one as they go; Home and End go to the first and the last. → or Enter goes into
 * the category's detail.
 */
function onKeydown(event: KeyboardEvent, id: string): void {
	if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
	if (event.key === "ArrowRight" || event.key === "Enter") {
		event.preventDefault();
		emit("enter-detail");
		return;
	}
	const ids = visibleCategories.value.map((cat) => cat.id);
	const next = listMove(ids.length, ids.indexOf(id), event.key, "vertical");
	if (next === null) return;
	event.preventDefault();
	const target = ids[next];
	if (target === undefined) return;
	emit("update:modelValue", target);
	void nextTick(() => focusCategory(target));
}
</script>

<style scoped>
.category-nav {
	width: 160px;
	min-width: 160px;
	border-right: 1px solid var(--nt-border);
	padding: 12px 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
	overflow-y: auto;
}

.category-item {
	display: block;
	width: 100%;
	padding: 8px 20px;
	font-size: 13px;
	color: var(--nt-text-secondary);
	background: transparent;
	border: none;
	text-align: left;
	cursor: pointer;
	transition:
		color 0.15s ease,
		background 0.15s ease;
	border-radius: 0;
}

.category-item:hover {
	color: var(--nt-fg);
	background: var(--nt-hover);
}

.category-item.active {
	color: var(--nt-fg);
	font-weight: 600;
	background: var(--nt-bg-surface);
}
</style>
