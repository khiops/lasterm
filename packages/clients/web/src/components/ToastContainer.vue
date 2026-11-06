<template>
	<Teleport to="body">
		<TransitionGroup name="toast" tag="div" class="toast-container" aria-live="polite" aria-atomic="false">
			<div
				v-for="msg in toastStore.messages"
				:key="msg.id"
				class="toast-item"
				:class="`toast-item--${msg.level}`"
				role="alert"
			>
				<span class="toast-icon" aria-hidden="true">
					{{ msg.level === 'error' ? '✕' : msg.level === 'warning' ? '⚠' : 'ℹ' }}
				</span>
				<span class="toast-text">{{ msg.text }}</span>
				<button
					v-if="msg.action"
					class="toast-action"
					type="button"
					@click="toastStore.act(msg.id)"
				>
					{{ msg.action.label }}
				</button>
				<button
					class="toast-close"
					type="button"
					aria-label="Dismiss"
					@click="toastStore.dismiss(msg.id)"
				>
					&#10005;
				</button>
			</div>
		</TransitionGroup>
	</Teleport>
</template>

<script setup lang="ts">
import { useToastStore } from '../stores/toast.js';

const toastStore = useToastStore();
</script>

<style scoped>
.toast-container {
	position: fixed;
	bottom: 20px;
	right: 20px;
	z-index: 9999;
	display: flex;
	flex-direction: column;
	gap: 8px;
	max-width: 420px;
	pointer-events: none;
}

/* A toast is drawn as the exit card is (TerminalPane.vue): on the theme's own
   opaque ground, in the text the theme makes read on it (`--nt-text-strong`,
   4.5:1 on `--nt-bg`), so neither a wallpaper nor the window's material shows
   through, in a light theme or a dark one (#830). Its level shows in its border
   and its icon, in the level's colour made to read on that same ground. Every
   variable named here, and every pair of colours, is checked in every bundled
   theme by ToastContainer.spec.ts. */
.toast-item {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	padding: 10px 12px;
	border-radius: 6px;
	font-size: 13px;
	line-height: 1.4;
	pointer-events: all;
	box-shadow: var(--nt-shadow);
	border: 1px solid var(--nt-border);
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	word-break: break-word;
}

.toast-item--error {
	border-color: var(--nt-status-error);
}

.toast-item--error .toast-icon {
	color: var(--nt-status-error);
}

.toast-item--warning {
	border-color: var(--nt-status-warning);
}

.toast-item--warning .toast-icon {
	color: var(--nt-status-warning);
}

.toast-item--info {
	border-color: var(--nt-status-info);
}

.toast-item--info .toast-icon {
	color: var(--nt-status-info);
}

.toast-icon {
	flex-shrink: 0;
	font-size: 12px;
	line-height: 1.4;
}

.toast-text {
	flex: 1;
	min-width: 0;
}

/* At full strength: dimmed, it fell under what a control must read at on
   Solarized Light. Hover marks its edge and leaves the colours alone. */
.toast-close {
	flex-shrink: 0;
	background: none;
	border: 1px solid transparent;
	border-radius: 3px;
	cursor: pointer;
	font-size: 11px;
	color: inherit;
	padding: 0 2px;
	line-height: 1.4;
}

.toast-close:hover {
	border-color: currentColor;
}

/* A toast's one action ("Show"): at the toast's own colours, as its close button. */
.toast-action {
	flex-shrink: 0;
	background: none;
	border: 1px solid currentColor;
	border-radius: 3px;
	cursor: pointer;
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	color: inherit;
	padding: 0 6px;
	line-height: 1.4;
}

/* TransitionGroup animations */
.toast-enter-active {
	transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-leave-active {
	transition: opacity 0.15s ease, transform 0.15s ease;
}

.toast-enter-from {
	opacity: 0;
	transform: translateX(20px);
}

.toast-leave-to {
	opacity: 0;
	transform: translateX(20px);
}

.toast-move {
	transition: transform 0.2s ease;
}
</style>
