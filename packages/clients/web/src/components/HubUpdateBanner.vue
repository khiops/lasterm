<template>
	<Teleport to="body">
		<Transition name="hub-update">
			<div v-if="hubUpdate.bannerVisible.value" class="hub-update-banner" role="status">
				<span class="hub-update-text">Lasterm was updated on the hub.</span>
				<button class="hub-update-reload" type="button" @click="hubUpdate.applyUpdate()">
					Reload
				</button>
			</div>
		</Transition>
	</Teleport>
</template>

<script setup lang="ts">
import { useHubUpdate } from '../composables/useHubUpdate.js';

/** Offered, never forced: a visible tab reloads when its user says so (#560). */
const hubUpdate = useHubUpdate();
</script>

<style scoped>
.hub-update-banner {
	position: fixed;
	top: 8px;
	left: 50%;
	transform: translateX(-50%);
	z-index: 9999;
	display: flex;
	align-items: center;
	gap: 12px;
	max-width: calc(100vw - 40px);
	padding: 8px 10px 8px 14px;
	border: 1px solid var(--nt-accent);
	border-radius: 6px;
	background: var(--nt-sidebar);
	color: var(--nt-fg);
	box-shadow: var(--nt-shadow);
	font-size: 13px;
	line-height: 1.4;
}

.hub-update-text {
	min-width: 0;
}

.hub-update-reload {
	flex-shrink: 0;
	padding: 3px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	background: var(--nt-accent);
	border: 1px solid var(--nt-accent);
	border-radius: 4px;
	color: var(--nt-accent-fg);
	cursor: pointer;
}

.hub-update-reload:hover {
	opacity: 0.85;
}

.hub-update-enter-active,
.hub-update-leave-active {
	transition: opacity 0.2s ease;
}

.hub-update-enter-from,
.hub-update-leave-to {
	opacity: 0;
}
</style>
