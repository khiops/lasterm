<template>
	<Teleport to="body">
		<div
			v-if="prompt"
			class="apd-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="apd-title"
		>
			<div class="apd-card">
				<h3 id="apd-title" class="apd-title">{{ dialogTitle }}</h3>
				<p class="apd-message">{{ prompt.message }}</p>

				<input
					ref="inputRef"
					v-model="inputValue"
					type="password"
					class="apd-input"
					:placeholder="inputPlaceholder"
					:data-prompt-id="prompt.promptId"
					autocomplete="off"
					@keydown.enter="handleSubmit"
					@keydown.escape="handleCancel"
				/>

				<label
					v-if="prompt?.promptType === 'passphrase'"
					class="apd-remember"
				>
					<input
						v-model="prompt.rememberSession"
						type="checkbox"
						class="apd-remember-checkbox"
					/>
					<span>Remember for this session</span>
				</label>

				<div class="apd-actions">
					<button
						class="apd-btn apd-cancel"
						:data-prompt-id="prompt.promptId"
						@click="handleCancel"
					>Cancel</button>
					<button
						class="apd-btn apd-submit"
						:data-prompt-id="prompt.promptId"
						@click="handleSubmit"
					>Submit</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAuthPromptStore } from "../stores/auth-prompt.js";

const authPromptStore = useAuthPromptStore();
const prompt = computed(() => authPromptStore.currentPrompt);

const inputValue = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

const dialogTitle = computed(() => {
	switch (prompt.value?.promptType) {
		case "passphrase":
			return "SSH Key Passphrase";
		case "elevation":
			return "Elevation Required";
		default:
			return "SSH Password";
	}
});

const inputPlaceholder = computed(() => {
	switch (prompt.value?.promptType) {
		case "passphrase":
			return "Enter key passphrase…";
		case "elevation":
			return "Enter your password…";
		default:
			return "Enter SSH password…";
	}
});

watch(
	prompt,
	(newPrompt) => {
		if (newPrompt) {
			inputValue.value = "";
			nextTick(() => {
				inputRef.value?.focus();
			});
		}
	},
	{ immediate: true },
);

function promptIdFromEvent(event: Event): string | undefined {
	return (event.currentTarget as HTMLElement | null)?.dataset.promptId;
}

function handleSubmit(event: Event): void {
	if (!prompt.value) return;
	authPromptStore.respond(inputValue.value, promptIdFromEvent(event));
	inputValue.value = "";
}

function handleCancel(event: Event): void {
	if (!prompt.value) return;
	authPromptStore.dismiss(promptIdFromEvent(event));
	inputValue.value = "";
}
</script>

<style scoped>
.apd-backdrop {
	position: fixed;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(0, 0, 0, 0.45);
	z-index: 10100;
}

.apd-card {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 10px;
	padding: 24px 28px;
	width: 360px;
	max-width: calc(100vw - 48px);
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
	gap: 12px;
	animation: apd-slide-in 0.2s ease-out;
}

@keyframes apd-slide-in {
	from {
		transform: translateY(-12px);
		opacity: 0;
	}
	to {
		transform: translateY(0);
		opacity: 1;
	}
}

.apd-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.apd-message {
	margin: 0;
	font-size: 12px;
	color: var(--nt-text-muted);
	line-height: 1.5;
}

.apd-input {
	width: 100%;
	height: 34px;
	padding: 0 10px;
	background: var(--nt-tab-bar);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-fg);
	font-size: 13px;
	outline: none;
	box-sizing: border-box;
	transition: border-color 0.15s;
}

.apd-input:focus {
	border-color: var(--nt-accent);
}

.apd-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 4px;
}

.apd-btn {
	height: 32px;
	padding: 0 14px;
	border-radius: 6px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	border: 1px solid transparent;
	transition: background 0.12s, opacity 0.12s;
}

.apd-cancel {
	background: var(--nt-border);
	border-color: var(--nt-tab-hover);
	color: var(--nt-text-muted);
}

.apd-cancel:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.apd-submit {
	background: var(--nt-accent);
	color: var(--nt-bg);
}

.apd-submit:hover {
	opacity: 0.85;
}

.apd-remember {
	display: flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	user-select: none;
}

.apd-remember-checkbox {
	width: 14px;
	height: 14px;
	cursor: pointer;
	accent-color: var(--nt-accent);
	flex-shrink: 0;
}

.apd-remember span {
	font-size: 12px;
	color: var(--nt-text-muted);
}
</style>
