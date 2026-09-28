<template>
	<div ref="tablistEl" class="scope-tabs" role="tablist" aria-label="Settings scope" @keydown="onKeydown">
		<button
			role="tab"
			class="scope-tab"
			data-scope="global"
			:class="{ active: modelValue === 'global' }"
			:aria-selected="modelValue === 'global'"
			:tabindex="modelValue === 'global' ? 0 : -1"
			@click="emit('update:modelValue', 'global')"
		>
			Global
		</button>
		<button
			v-if="showHost"
			role="tab"
			class="scope-tab"
			data-scope="host"
			:class="{ active: modelValue === 'host' }"
			:aria-selected="modelValue === 'host'"
			:tabindex="modelValue === 'host' ? 0 : -1"
			@click="emit('update:modelValue', 'host')"
		>
			Host: {{ hostName ?? "—" }}
		</button>
		<button
			v-if="showChannel"
			role="tab"
			class="scope-tab"
			data-scope="channel"
			:class="{ active: modelValue === 'channel' }"
			:aria-selected="modelValue === 'channel'"
			:tabindex="modelValue === 'channel' ? 0 : -1"
			@click="emit('update:modelValue', 'channel')"
		>
			Channel: {{ channelName ?? "—" }}
		</button>
	</div>
</template>

<script setup lang="ts">
import { nextTick, ref } from "vue";
import type { Scope } from "../../stores/settings.js";
import { listMove } from "../../utils/focus-zones.js";

const props = defineProps<{
	modelValue: Scope;
	hostName?: string;
	channelName?: string;
	showHost: boolean;
	showChannel: boolean;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: Scope];
}>();

const tablistEl = ref<HTMLElement | null>(null);

/**
 * A tablist from the keyboard (#637): the selected scope takes Tab, and ← and → move to the
 * scope beside it and select it; Home and End go to the first and the last.
 */
function onKeydown(event: KeyboardEvent): void {
	if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
	const scopes: Scope[] = [
		"global",
		...(props.showHost ? (["host"] as const) : []),
		...(props.showChannel ? (["channel"] as const) : []),
	];
	const next = listMove(scopes.length, scopes.indexOf(props.modelValue), event.key, "horizontal");
	if (next === null) return;
	event.preventDefault();
	const scope = scopes[next];
	if (scope === undefined) return;
	emit("update:modelValue", scope);
	void nextTick(() => {
		const tabs = tablistEl.value?.querySelectorAll<HTMLElement>("[data-scope]") ?? [];
		[...tabs].find((tab) => tab.dataset.scope === scope)?.focus();
	});
}
</script>

<style scoped>
.scope-tabs {
	display: flex;
	gap: 0;
	border-bottom: 1px solid var(--nt-border);
	flex-shrink: 0;
	padding: 0 20px;
}

.scope-tab {
	position: relative;
	padding: 10px 16px;
	font-size: 12px;
	font-weight: 500;
	color: var(--nt-text-secondary);
	background: transparent;
	border: none;
	cursor: pointer;
	white-space: nowrap;
	transition: color 0.15s ease;
}

.scope-tab:hover {
	color: var(--nt-fg);
}

.scope-tab.active {
	color: var(--nt-accent);
}

.scope-tab.active::after {
	content: "";
	position: absolute;
	bottom: -1px;
	left: 0;
	right: 0;
	height: 2px;
	background: var(--nt-accent);
	border-radius: 1px 1px 0 0;
}
</style>
