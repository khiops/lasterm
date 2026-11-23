<template>
	<Teleport to="body">
		<div v-if="visible" class="confirm-overlay" @click.self="$emit('cancel')">
			<div class="confirm-dialog">
				<h3 class="confirm-title">{{ title }}</h3>
				<p class="confirm-message">{{ message }}</p>

				<div v-if="showRemember" class="confirm-remember">
					<label class="confirm-remember-label">
						<input type="checkbox" v-model="rememberHost" />
						Remember for this host
					</label>
					<label class="confirm-remember-label">
						<input type="checkbox" v-model="rememberGlobal" />
						Remember globally
					</label>
				</div>

				<div class="confirm-actions">
					<button class="btn btn-secondary" @click="$emit('cancel')">
						{{ cancelLabel }}
					</button>
					<button class="btn btn-danger" @click="onConfirm">
						{{ confirmLabel }}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";

const props = withDefaults(
	defineProps<{
		visible: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string;
		showRemember?: boolean;
	}>(),
	{
		confirmLabel: "Confirm",
		cancelLabel: "Cancel",
		showRemember: false,
	},
);

const emit = defineEmits<{
	confirm: [remember: { host: boolean; global: boolean }];
	cancel: [];
}>();

const rememberHost = ref(false);
const rememberGlobal = ref(false);

function onConfirm(): void {
	emit("confirm", { host: rememberHost.value, global: rememberGlobal.value });
	rememberHost.value = false;
	rememberGlobal.value = false;
}

// Reset when dialog opens
watch(
	() => props.visible,
	(v) => {
		if (v) {
			rememberHost.value = false;
			rememberGlobal.value = false;
		}
	},
);
</script>

<style scoped>
.confirm-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.confirm-dialog {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 20px;
	min-width: 340px;
	max-width: 440px;
	box-shadow: var(--nt-shadow);
}

.confirm-title {
	margin: 0 0 8px;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.confirm-message {
	margin: 0 0 16px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	line-height: 1.4;
}

.confirm-remember {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin-bottom: 16px;
}

.confirm-remember-label {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 12px;
	color: var(--nt-fg);
	cursor: pointer;
}

.confirm-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
}

.btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition: box-shadow 0.12s;
}

.btn:hover {
	box-shadow: inset 0 0 0 1px currentColor;
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.btn-danger {
	background: var(--nt-danger);
	color: var(--nt-danger-fg);
}
</style>
