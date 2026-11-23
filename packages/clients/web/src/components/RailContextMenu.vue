<template>
	<Teleport to="body">
		<div
			v-if="visible"
			ref="menuEl"
			class="ctx-menu"
			:style="{ left: `${x}px`, top: `${y}px` }"
			@click.stop
		>
			<button class="ctx-item" @click="onAddHost">
				Add new host
			</button>
			<button class="ctx-item" @click="onAddGroup">
				Add new group
			</button>
			<button class="ctx-item" @click="onOpenRecordings">
				Recordings…
			</button>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

defineProps<{
	visible: boolean;
	x: number;
	y: number;
}>();

const emit = defineEmits<{
	(e: "close"): void;
	(e: "add-host"): void;
	(e: "add-group"): void;
	(e: "open-recordings"): void;
}>();

const menuEl = ref<HTMLElement | null>(null);

// ── Click-outside close ──────────────────────────────────────────────────

function onClickOutside(event: MouseEvent): void {
	if (menuEl.value && !menuEl.value.contains(event.target as Node)) {
		emit("close");
	}
}

onMounted(() => {
	document.addEventListener("mousedown", onClickOutside, true);
});

onUnmounted(() => {
	document.removeEventListener("mousedown", onClickOutside, true);
});

// ── Action handlers ──────────────────────────────────────────────────────

function onOpenRecordings(): void {
	emit("open-recordings");
	emit("close");
}

function onAddHost(): void {
	emit("add-host");
	emit("close");
}

function onAddGroup(): void {
	emit("add-group");
	emit("close");
}
</script>

<style scoped>
.ctx-menu {
	position: fixed;
	z-index: 9999;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	padding: 4px 0;
	min-width: 180px;
	box-shadow: var(--nt-shadow);
}

.ctx-item {
	display: block;
	width: 100%;
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	color: var(--nt-fg);
	background: transparent;
	border: none;
	cursor: pointer;
	text-align: left;
	transition: background 0.08s;
}

.ctx-item:hover:not(:disabled) {
	background: var(--nt-tab-hover);
}
</style>
