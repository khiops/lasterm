<template>
	<Teleport to="body">
		<div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
			<div class="dialog-content group-action-dialog">
				<div class="dialog-header">
					<h3 class="dialog-title">{{ title }}</h3>
					<button class="dialog-close" @click="$emit('close')">
						&times;
					</button>
				</div>
				<div class="dialog-body">
					<p class="confirm-message">{{ message }}</p>
					<div v-if="inputLabel" class="field">
						<label class="field-label">{{ inputLabel }}</label>
						<input
							ref="inputRef"
							v-model="inputVal"
							type="text"
							class="field-input"
							:placeholder="inputPlaceholder"
							maxlength="32"
							@keydown.enter="onConfirm"
						/>
					</div>
				</div>
				<div class="dialog-actions">
					<span v-if="error" class="action-error" role="alert">{{ error }}</span>
					<button class="btn btn-secondary" @click="$emit('close')">
						Cancel
					</button>
					<button
						:class="['btn', confirmDanger ? 'btn-danger' : 'btn-primary']"
						:disabled="inputLabel ? !inputVal.trim() : false"
						@click="onConfirm"
					>
						{{ confirmLabel }}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

const props = withDefaults(
	defineProps<{
		visible: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		confirmDanger?: boolean;
		inputLabel?: string;
		inputValue?: string;
		inputPlaceholder?: string;
		/**
		 * Why the last confirm did not go through, as the hub said it (#734).
		 * The parent keeps the dialog open while it is set.
		 */
		error?: string | null;
	}>(),
	{
		confirmLabel: "Confirm",
		confirmDanger: false,
		error: null,
	},
);

const emit = defineEmits<{
	close: [];
	confirm: [value?: string];
}>();

const inputVal = ref(props.inputValue ?? "");
const inputRef = ref<HTMLInputElement | null>(null);

// Reset inputVal when inputValue prop changes (e.g. dialog reopens with new group)
watch(
	() => props.inputValue,
	(v) => {
		inputVal.value = v ?? "";
	},
);

// Auto-focus the input when the dialog becomes visible
watch(
	() => props.visible,
	async (v) => {
		if (v && props.inputLabel) {
			await nextTick();
			inputRef.value?.focus();
			inputRef.value?.select();
		}
	},
	{ immediate: true },
);

function onConfirm(): void {
	if (props.inputLabel && !inputVal.value.trim()) return;
	emit("confirm", props.inputLabel ? inputVal.value.trim() : undefined);
}
</script>

<style scoped>
.dialog-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.dialog-content.group-action-dialog {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	min-width: 340px;
	max-width: 380px;
	width: 100%;
	box-shadow: var(--nt-shadow);
}

.dialog-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px 0;
}

.dialog-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.dialog-close {
	background: none;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 18px;
	cursor: pointer;
	padding: 0 4px;
	line-height: 1;
}

.dialog-close:hover {
	color: var(--nt-fg);
}

.dialog-body {
	padding: 16px 20px;
}

.confirm-message {
	font-size: 13px;
	color: var(--nt-fg);
	margin: 0 0 8px;
}

.field {
	margin-bottom: 0;
}

.field-label {
	display: block;
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	margin-bottom: 4px;
}

.field-input {
	width: 100%;
	padding: 6px 8px;
	font-size: 12px;
	font-family: inherit;
	background: var(--nt-tab-bar);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	outline: none;
	transition: border-color 0.15s;
}

.field-input:focus {
	border-color: var(--nt-accent);
}

.dialog-actions {
	display: flex;
	align-items: center;
	gap: 8px;
	justify-content: flex-end;
	padding: 12px 20px 16px;
	border-top: 1px solid var(--nt-border);
}

/* Why the hub refused the last confirm (#734), beside the buttons that retry it. */
.action-error {
	flex: 1;
	min-width: 0;
	font-size: 12px;
	color: var(--nt-red, #e06c75);
	overflow-wrap: anywhere;
}

.btn {
	padding: 6px 14px;
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

.btn:hover {
	opacity: 0.85;
}

.btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.btn-primary {
	background: var(--nt-accent);
	color: #fff;
}

.btn-danger {
	background: var(--nt-red, #e06c75);
	color: #fff;
}
</style>
