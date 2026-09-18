<template>
	<Teleport to="body">
		<div
			v-if="visible"
			ref="menuEl"
			class="ctx-menu"
			:style="{ left: `${x}px`, top: `${y}px` }"
			@click.stop
		>
			<!-- Rename -->
			<button
				class="ctx-item"
				:disabled="!tab"
				@click="onRename"
			>Rename</button>

			<!-- Reset Title to Dynamic -->
			<button
				class="ctx-item"
				:disabled="!tab || !isCustomTitle"
				@click="onResetTitle"
			>Reset Title to Dynamic</button>

			<div class="ctx-sep" />

			<!-- Configure Command -->
			<button
				class="ctx-item"
				:disabled="!tab"
				@click="onConfigureCommand"
			>Configure Command</button>

			<!-- Welcome tab toggle -->
			<button
				class="ctx-item"
				:disabled="!tab"
				@click="onSetWelcome"
			>{{ isWelcome ? "Unset Welcome Tab" : "Set as Welcome Tab" }}</button>

			<div class="ctx-sep" />

			<!-- Splits -->
			<button
				class="ctx-item"
				:disabled="!tab"
				@click="onSplitRight"
			>Split Right</button>

			<button
				class="ctx-item"
				:disabled="!tab"
				@click="onSplitDown"
			>Split Down</button>

			<div class="ctx-sep" />

			<!-- Close actions -->
			<button
				class="ctx-item"
				:disabled="!tab"
				@click="onClose"
			>Close</button>

			<button
				class="ctx-item"
				:disabled="tabCount <= 1"
				@click="onCloseOthers"
			>Close Others</button>

			<button
				class="ctx-item"
				:disabled="tabIndex >= tabCount - 1"
				@click="onCloseToRight"
			>Close to the Right</button>

			<button
				class="ctx-item"
				@click="onCloseAll"
			>Close All</button>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import type { Tab } from "../composables/useLayout.js";

const props = defineProps<{
	visible: boolean;
	x: number;
	y: number;
	tab: Tab | null;
	/** The channelId of the active pane in the tab (resolved by parent). */
	activeChannelId: string | null;
	tabIndex: number;
	tabCount: number;
	isWelcome: boolean;
	isCustomTitle: boolean;
}>();

const emit = defineEmits<{
	close: [];
	rename: [channelId: string];
	"reset-title": [channelId: string];
	"close-tab": [index: number];
	"close-others": [index: number];
	"close-to-right": [index: number];
	"close-all": [];
	"split-right": [channelId: string];
	"split-down": [channelId: string];
	"set-welcome": [channelId: string];
	"configure-command": [channelId: string];
}>();

const menuEl = ref<HTMLElement | null>(null);

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

// ── Action handlers ─────────────────────────────────────────────────────

function onRename(): void {
	if (props.tab && props.activeChannelId !== null) {
		emit("rename", props.activeChannelId);
	}
	emit("close");
}

function onResetTitle(): void {
	if (props.tab && props.activeChannelId !== null) {
		emit("reset-title", props.activeChannelId);
	}
	emit("close");
}

function onSetWelcome(): void {
	if (props.tab && props.activeChannelId !== null) {
		emit("set-welcome", props.activeChannelId);
	}
	emit("close");
}

function onConfigureCommand(): void {
	if (props.tab && props.activeChannelId !== null) {
		emit("configure-command", props.activeChannelId);
	}
	emit("close");
}

function onSplitRight(): void {
	if (props.tab && props.activeChannelId !== null) {
		emit("split-right", props.activeChannelId);
	}
	emit("close");
}

function onSplitDown(): void {
	if (props.tab && props.activeChannelId !== null) {
		emit("split-down", props.activeChannelId);
	}
	emit("close");
}

function onClose(): void {
	emit("close-tab", props.tabIndex);
	emit("close");
}

function onCloseOthers(): void {
	emit("close-others", props.tabIndex);
	emit("close");
}

function onCloseToRight(): void {
	emit("close-to-right", props.tabIndex);
	emit("close");
}

function onCloseAll(): void {
	emit("close-all");
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
	min-width: 200px;
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

.ctx-item:disabled {
	opacity: 0.4;
	pointer-events: none;
}

.ctx-sep {
	border-top: 1px solid var(--nt-border);
	margin: 4px 0;
}
</style>
