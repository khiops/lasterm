<template>
	<Teleport to="body">
		<div v-if="visible" class="dialog-overlay" @click.self="$emit('close')">
			<div class="dialog-content">
				<h3 class="dialog-title">Configure Command</h3>

				<div class="field">
					<label class="field-label">Program</label>
					<input
						v-model="form.shell"
						class="field-input"
						placeholder="/bin/bash"
					/>
				</div>

				<div class="field">
					<label class="field-label">Arguments</label>
					<input
						v-model="argsString"
						class="field-input"
						placeholder="--flag value"
					/>
				</div>

				<div class="field">
					<label class="field-label">Working Directory</label>
					<input
						v-model="form.cwd"
						class="field-input"
						placeholder="~/"
					/>
				</div>

				<div class="field">
					<label class="field-label">Icon</label>
					<select v-model="form.icon" class="field-select">
						<option value="">None</option>
						<option value="terminal">Terminal</option>
						<option value="cpu">CPU</option>
						<option value="database">Database</option>
						<option value="code">Code</option>
						<option value="log">Log</option>
					</select>
				</div>

				<div class="field field--checkbox">
					<label class="field-label">
						<input type="checkbox" v-model="form.directProcess" />
						Direct Process (show exit overlay when process ends)
					</label>
				</div>

				<div v-if="restartError" class="field-error">{{ restartError }}</div>

				<div class="dialog-actions">
					<button class="btn btn-secondary" @click="$emit('close')">
						Cancel
					</button>
					<button class="btn btn-primary" :disabled="!form.shell?.trim()" @click="onApply">
						Apply
					</button>
					<button class="btn btn-accent" :disabled="!form.shell?.trim()" @click="onApplyRestart">
						Apply &amp; Restart
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useChannelsStore } from "../stores/channels.js";

const props = defineProps<{
	visible: boolean;
	channelId: string | null;
}>();

const emit = defineEmits<{
	(e: "close"): void;
	(e: "applied"): void;
}>();

const channelsStore = useChannelsStore();

const restartError = ref<string | null>(null);

const form = ref({
	shell: "",
	args: [] as string[],
	cwd: "",
	icon: "",
	directProcess: false,
});

const argsString = computed({
	get: () => form.value.args.join(" "),
	set: (val: string) => {
		form.value.args = val.split(/\s+/).filter(Boolean);
	},
});

// Load current channel config when dialog opens
watch(
	() => props.visible,
	(visible) => {
		if (visible && props.channelId) {
			restartError.value = null;
			const ch = channelsStore.channels.find((c) => c.id === props.channelId);
			if (ch) {
				form.value = {
					shell: ch.shell || "",
					args: ch.args ? [...ch.args] : [],
					cwd: ch.cwd || "",
					icon: ch.icon || "",
					directProcess: ch.directProcess || false,
				};
			}
		}
	},
);

async function onApply(): Promise<void> {
	if (!props.channelId) return;
	await channelsStore.updateChannelConfig(props.channelId, {
		icon: form.value.icon || null,
		shell: form.value.shell || null,
		args: form.value.args,
		cwd: form.value.cwd || null,
		direct_process: form.value.directProcess,
	});
	emit("applied");
	emit("close");
}

async function onApplyRestart(): Promise<void> {
	if (!props.channelId) return;
	restartError.value = null;
	const configOk = await channelsStore.updateChannelConfig(props.channelId, {
		icon: form.value.icon || null,
		shell: form.value.shell || null,
		args: form.value.args,
		cwd: form.value.cwd || null,
		direct_process: form.value.directProcess,
	});
	if (!configOk) {
		restartError.value = "Failed to save configuration";
		return;
	}
	const restartOk = await channelsStore.restartChannel(props.channelId);
	if (!restartOk) {
		// Why, as the store kept it for the pane. None when nothing failed: the
		// person cancelled the password or passphrase its host asked for, and
		// the dialog stays as it was (#815).
		restartError.value = channelsStore.restartFailures.get(props.channelId)?.reason ?? null;
		return;
	}
	emit("applied");
	emit("close");
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

.dialog-content {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 20px;
	min-width: 380px;
	max-width: 480px;
	box-shadow: var(--nt-shadow);
}

.dialog-title {
	margin: 0 0 16px;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.field {
	margin-bottom: 12px;
}

.field--checkbox {
	margin-top: 4px;
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

.field--checkbox .field-label {
	display: flex;
	align-items: center;
	gap: 8px;
	text-transform: none;
	font-weight: 400;
	font-size: 12px;
	color: var(--nt-fg);
	cursor: pointer;
}

.field-input,
.field-select {
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

.field-input:focus,
.field-select:focus {
	border-color: var(--nt-accent);
}

.field-error {
	font-size: 12px;
	color: var(--nt-badge);
	margin-top: 8px;
	padding: 6px 8px;
	background: rgba(255, 80, 80, 0.1);
	border-radius: 4px;
}

.dialog-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	margin-top: 16px;
}

.btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.12s, opacity 0.12s;
}

.btn:hover {
	opacity: 0.85;
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.btn-primary {
	background: var(--nt-accent);
	color: #fff;
}

.btn-accent {
	background: var(--nt-green);
	color: #fff;
}
</style>
