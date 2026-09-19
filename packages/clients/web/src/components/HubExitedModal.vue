<template>
	<Teleport to="body">
		<div v-if="code !== undefined" class="hub-exit-overlay">
			<div class="hub-exit-dialog" role="alertdialog" aria-modal="true" aria-label="The hub stopped">
				<h3 class="hub-exit-title">The hub stopped</h3>
				<p class="hub-exit-message">{{ hubExitMessage(code) }}</p>
				<p v-if="error" class="hub-exit-error">{{ error }}</p>
				<div class="hub-exit-actions">
					<button class="btn btn-danger" type="button" :disabled="busy" @click="quit">Quit Lasterm</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { hubExitMessage } from "../utils/hub-exit.js";

/** `undefined` while the hub runs; its exit code (or null) once it has died. */
defineProps<{ code: number | null | undefined }>();

const busy = ref(false);
const error = ref<string | null>(null);

async function quit(): Promise<void> {
	busy.value = true;
	error.value = null;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("quit_after_hub_exit");
	} catch (err) {
		error.value = `Lasterm could not quit: ${err instanceof Error ? err.message : String(err)}`;
		busy.value = false;
	}
}
</script>

<style scoped>
.hub-exit-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10001;
}

.hub-exit-dialog {
	width: 440px;
	max-width: calc(100vw - 48px);
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	box-shadow: var(--nt-shadow);
	padding: 16px 20px;
}

.hub-exit-title {
	margin: 0 0 12px;
	color: var(--nt-fg);
	font-size: 14px;
	font-weight: 600;
}

.hub-exit-message,
.hub-exit-error {
	margin: 0 0 12px;
	font-size: 12px;
	line-height: 1.45;
	color: var(--nt-text-secondary);
}

.hub-exit-error {
	color: var(--nt-red, #e06c75);
}

.hub-exit-actions {
	display: flex;
	justify-content: flex-end;
}

.btn {
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
}

.btn:disabled {
	cursor: default;
	opacity: 0.65;
}

.btn-danger {
	background: var(--nt-red, #e06c75);
	color: #fff;
}
</style>
