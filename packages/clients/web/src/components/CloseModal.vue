<template>
	<Teleport to="body">
		<div v-if="visible" class="close-overlay" @click.self="onCancel">
			<div
				class="close-dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Close Lasterm"
			>
				<div class="close-header">
					<h3 class="close-title">Close Lasterm</h3>
					<button
						class="close-x"
						type="button"
						aria-label="Cancel"
						:disabled="busy"
						@click="onCancel"
					>
						&times;
					</button>
				</div>

				<p class="close-message">
					Choose whether Lasterm keeps running in the tray or stops the local hub.
				</p>

				<label class="remember-row">
					<input v-model="remember" type="checkbox" :disabled="busy" />
					<span>Remember this choice</span>
				</label>

				<div class="close-actions">
					<button class="btn btn-secondary" type="button" :disabled="busy" @click="onCancel">
						Cancel
					</button>
					<button class="btn btn-secondary" type="button" :disabled="busy" @click="select('tray')">
						Minimize to tray
					</button>
					<button class="btn btn-danger" type="button" :disabled="busy" @click="select('quit')">
						Quit completely
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

export type CloseModalAction = "quit" | "tray";

const props = defineProps<{
	visible: boolean;
	busy?: boolean;
}>();

const emit = defineEmits<{
	select: [decision: { action: CloseModalAction; remember: boolean }];
	cancel: [];
}>();

const remember = ref(false);

function select(action: CloseModalAction): void {
	emit("select", { action, remember: remember.value });
}

function onCancel(): void {
	if (props.busy) return;
	emit("cancel");
}

watch(
	() => props.visible,
	(visible) => {
		if (visible) remember.value = false;
	},
);
</script>

<style scoped>
.close-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.close-dialog {
	width: 420px;
	max-width: calc(100vw - 48px);
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	box-shadow: var(--nt-shadow);
	padding: 0;
}

.close-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	border-bottom: 1px solid var(--nt-border);
}

.close-title {
	margin: 0;
	color: var(--nt-fg);
	font-size: 14px;
	font-weight: 600;
}

.close-x {
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 18px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 6px;
	border-radius: 4px;
}

.close-x:hover:not(:disabled) {
	color: var(--nt-fg);
	background: var(--nt-border);
}

.close-message {
	margin: 0;
	padding: 18px 20px 12px;
	color: var(--nt-text-secondary);
	font-size: 12px;
	line-height: 1.45;
}

.remember-row {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	margin: 0 20px 18px;
	color: var(--nt-fg);
	font-size: 12px;
	cursor: pointer;
}

.close-actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	padding: 16px 20px;
	border-top: 1px solid var(--nt-border);
}

.btn {
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition:
		background 0.12s,
		opacity 0.12s;
}

.btn:disabled {
	cursor: default;
	opacity: 0.65;
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.btn-danger {
	background: var(--nt-red, #e06c75);
	color: #fff;
}
</style>
