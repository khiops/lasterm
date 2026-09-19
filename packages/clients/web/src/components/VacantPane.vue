<template>
	<div class="vacant-pane">
		<div class="vacant-header">Empty Pane</div>
		<div class="vacant-options">
			<button class="vacant-btn vacant-btn-new" @click="emit('new-terminal', vacantId)">
				+ New Terminal
			</button>
			<div v-if="detachedChannels.length > 0" class="vacant-divider" />
			<button
				v-for="ch in detachedChannels"
				:key="ch.id"
				class="vacant-channel"
				@click="emit('select-channel', vacantId, ch.id)"
			>
				{{ ch.displayTitle || "Terminal" }}
			</button>
		</div>
		<button class="vacant-close" @click="emit('rearrange', vacantId)">
			Close Pane
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import { DISPLAYED_CHANNELS_KEY, pickableChannels } from "../composables/displayedChannels.js";
import { useChannelsStore } from "../stores/channels.js";

const props = defineProps<{
	vacantId: string;
	hostId: string | null;
}>();

const emit = defineEmits<{
	(e: "select-channel", vacantId: string, channelId: string): void;
	(e: "new-terminal", vacantId: string): void;
	(e: "rearrange", vacantId: string): void;
}>();

const channelsStore = useChannelsStore();

/** Channels a pane shows already, in any tab (provided by App.vue). */
const displayed = inject(
	DISPLAYED_CHANNELS_KEY,
	computed(() => new Set<string>()),
);

/** Offering a shown channel put the same terminal twice in one tab. */
const detachedChannels = computed(() =>
	pickableChannels(
		channelsStore.channels,
		channelsStore.channelHostMap,
		props.hostId,
		displayed.value,
	),
);
</script>

<style scoped>
.vacant-pane {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	width: 100%;
	height: 100%;
	gap: 16px;
	background: var(--nt-bg-surface, var(--nt-bg));
	border: 1px dashed var(--nt-border);
}

.vacant-header {
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-text-secondary);
	letter-spacing: 0.04em;
}

.vacant-options {
	display: flex;
	flex-direction: column;
	align-items: stretch;
	gap: 4px;
	min-width: 180px;
	max-width: 260px;
}

.vacant-btn {
	padding: 8px 14px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: var(--nt-fg);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	text-align: left;
	transition: background 0.12s;
}

.vacant-btn:hover {
	background: var(--nt-tab-hover);
}

.vacant-btn-new {
	font-weight: 600;
	color: var(--nt-accent, var(--nt-fg));
}

.vacant-divider {
	height: 1px;
	background: var(--nt-border);
	margin: 4px 0;
}

.vacant-channel {
	padding: 6px 14px;
	border: none;
	border-radius: 4px;
	background: transparent;
	color: var(--nt-fg);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	text-align: left;
	transition: background 0.12s;
}

.vacant-channel:hover {
	background: var(--nt-tab-hover);
}

.vacant-close {
	padding: 6px 14px;
	border: 1px solid var(--nt-danger, #e55);
	border-radius: 4px;
	background: transparent;
	color: var(--nt-danger, #e55);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
}

.vacant-close:hover {
	background: var(--nt-danger, #e55);
	color: var(--nt-bg, #fff);
}
</style>
