<template>
	<div v-if="!isDead" class="wl-indicator" :class="stateClass" :title="tooltip">
		<span class="wl-dot" aria-hidden="true" />
		<span class="wl-label">{{ label }}</span>

		<button
			v-if="isReader && channelId && !isDead"
			class="wl-action-btn"
			@click="handleClaim"
			title="Request write access"
		>
			Request Write
		</button>

		<button
			v-if="isReader && channelId && !isDead"
			class="wl-action-btn wl-force"
			@click="handleForce"
			title="Force-take write lock immediately"
		>
			Force Take
		</button>

		<button
			v-if="isCurrentWriter && channelId && !isDead"
			class="wl-action-btn wl-release"
			@click="handleRelease"
			title="Release your write lock"
		>
			Release
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useWriteLockStore } from "../stores/writelock.js";
import { useAuthStore } from "../stores/auth.js";

const props = defineProps<{
	channelId: string | null;
	isDead?: boolean;
}>();

const writeLockStore = useWriteLockStore();
const authStore = useAuthStore();

const lockState = computed(() => {
	if (!props.channelId) return null;
	return writeLockStore.locks.get(props.channelId) ?? null;
});

const isCurrentWriter = computed(() => {
	if (!props.channelId) return false;
	return writeLockStore.isWriter(props.channelId);
});

const isReader = computed(() => {
	if (!props.channelId) return false;
	// Reader = authenticated but not the current writer
	return authStore.clientId !== null && !isCurrentWriter.value;
});

const hasHolder = computed(() => lockState.value?.holder !== null && lockState.value?.holder !== undefined);

// Kept for the writer that just left, whose window may come back within the
// hub's grace (#846): nobody writes meanwhile, and taking it is still possible.
const isReserved = computed(() => !hasHolder.value && lockState.value?.reserved === true);

const stateClass = computed(() => {
	if (isCurrentWriter.value) return "state-writer";
	if (hasHolder.value) return "state-reader";
	if (isReserved.value) return "state-reserved";
	return "state-free";
});

const label = computed(() => {
	if (isCurrentWriter.value) return "Writer";
	if (hasHolder.value) return "Reader";
	if (isReserved.value) return "Writer reconnecting";
	return "No lock";
});

const tooltip = computed(() => {
	const holder = lockState.value?.holder;
	if (isCurrentWriter.value) return "You have write access";
	if (holder) return `Client ${holder} holds write access`;
	if (isReserved.value) {
		return "The writer's window is reconnecting: write access is kept for it a few seconds, then handed on";
	}
	return "No client holds write access";
});

function handleClaim(): void {
	if (props.channelId) writeLockStore.claim(props.channelId);
}

function handleForce(): void {
	if (props.channelId) writeLockStore.forceTake(props.channelId);
}

function handleRelease(): void {
	if (props.channelId) writeLockStore.release(props.channelId);
}
</script>

<style scoped>
.wl-indicator {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 3px 8px;
	border-radius: 4px;
	font-size: 11px;
	font-weight: 500;
	user-select: none;
	background: rgba(0, 0, 0, 0.2);
}

.wl-dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	flex-shrink: 0;
}

.state-writer .wl-dot {
	background: var(--nt-green);
	box-shadow: 0 0 6px var(--nt-green);
}

.state-writer .wl-label {
	color: var(--nt-green);
}

.state-reader .wl-dot {
	background: var(--nt-text-secondary);
}

.state-reader .wl-label {
	color: var(--nt-text-muted);
}

.state-free .wl-dot {
	background: var(--nt-tab-hover);
}

.state-free .wl-label {
	color: var(--nt-text-secondary);
}

.state-reserved .wl-dot {
	background: var(--nt-yellow);
}

.state-reserved .wl-label {
	color: var(--nt-text-secondary);
}

.wl-action-btn {
	height: 18px;
	padding: 0 6px;
	background: var(--nt-border);
	border: 1px solid var(--nt-tab-hover);
	border-radius: 3px;
	color: var(--nt-text-muted);
	font-size: 10px;
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
	white-space: nowrap;
	line-height: 1;
}

.wl-action-btn:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.wl-force {
	border-color: var(--nt-badge);
	color: var(--nt-badge);
}

.wl-force:hover {
	background: rgba(var(--nt-badge-rgb), 0.15);
	color: var(--nt-badge);
}

.wl-release {
	border-color: var(--nt-yellow);
	color: var(--nt-yellow);
}

.wl-release:hover {
	background: rgba(var(--nt-yellow-rgb), 0.15);
	color: var(--nt-yellow);
}
</style>
