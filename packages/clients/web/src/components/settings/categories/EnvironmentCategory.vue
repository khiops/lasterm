<template>
	<div class="environment-category">
		<section class="settings-section settings-section--first">
			<h3 class="section-title">Environment</h3>

			<SettingRow
				label="Inherited environment"
				:scope="scope"
				:is-overridden="settingsStore.isOverridden(scope, 'terminal', 'envMode')"
				:inherited-from="settingsStore.inheritedFrom(scope, 'terminal', 'envMode')"
				description="Whether a terminal starts with the environment the hub runs in, or with a minimal one."
				@reset="settingsStore.resetSetting(scope, 'terminal', 'envMode')"
			>
				<SettingControl
					type="select"
					:model-value="envMode"
					:options="envModeOptions"
					@update:model-value="onEnvModeChange"
				/>
			</SettingRow>

			<div class="env-editor">
				<p class="env-help">
					Variables the terminals of this scope are started with. A host adds to what
					Global sets, a channel to both; the same name set here wins. They take effect
					on the next terminal, and are stored in the clear — no place for secrets.
				</p>

				<div v-for="(entry, index) in entries" :key="index" class="env-row">
					<input
						v-model="entry.name"
						class="env-input env-input--name"
						type="text"
						placeholder="NAME"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						@change="commit"
					/>
					<span class="env-equals">=</span>
					<input
						v-model="entry.value"
						class="env-input env-input--value"
						type="text"
						placeholder="value"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
						@change="commit"
					/>
					<button
						class="env-remove"
						type="button"
						:aria-label="`Remove ${entry.name || 'variable'}`"
						@click="remove(index)"
					>
						✕
					</button>
				</div>

				<button class="env-add" type="button" @click="add">+ Add variable</button>

				<div v-if="inherited.length > 0" class="env-inherited">
					<h4 class="env-inherited-title">Inherited</h4>
					<p v-for="entry in inherited" :key="entry.name" class="env-inherited-row">
						<span class="env-inherited-name">{{ entry.name }}</span>
						<span class="env-equals">=</span>
						<span class="env-inherited-value">{{ entry.value }}</span>
					</p>
				</div>
			</div>
		</section>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { type Scope, useSettingsStore } from "../../../stores/settings.js";
import SettingControl from "../SettingControl.vue";
import SettingRow from "../SettingRow.vue";
import {
	type EnvironmentEntry,
	inheritedEntries,
	toEntries,
	toMap,
} from "./environmentSettings.js";

const props = defineProps<{ scope: Scope }>();

const settingsStore = useSettingsStore();

const envModeOptions = [
	{ value: "inherit", label: "Inherit the hub's environment" },
	{ value: "minimal", label: "Minimal" },
];

const envMode = computed(
	() => (settingsStore.getValue(props.scope, "terminal", "envMode") as string) ?? "inherit",
);

/** What this scope holds, as rows. Edited here, written back on change. */
const entries = ref<EnvironmentEntry[]>([]);

/** What the scopes above give a terminal here, and this one does not set. */
const inherited = computed(() =>
	inheritedEntries(
		settingsStore.cascade?.terminal.resolved.env,
		settingsStore.getValue(props.scope, "terminal", "env"),
	),
);

watch(
	// A scope change, or a cascade that has just arrived, replaces the rows:
	// what is on screen belongs to the scope whose name is above it.
	() => [props.scope, settingsStore.getValue(props.scope, "terminal", "env")],
	([, own]) => {
		entries.value = toEntries(own);
	},
	{ immediate: true, deep: true },
);

function add(): void {
	entries.value = [...entries.value, { name: "", value: "" }];
}

function remove(index: number): void {
	entries.value = entries.value.filter((_, at) => at !== index);
	void commit();
}

async function commit(): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "env", toMap(entries.value));
}

async function onEnvModeChange(value: unknown): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "envMode", value);
}
</script>

<style scoped>
.env-editor {
	padding: 12px 0 4px;
}

.env-help {
	margin: 0 0 12px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	max-width: 62ch;
}

.env-row {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 6px;
}

.env-input {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	font-family: inherit;
	font-size: 12px;
	padding: 5px 8px;
}

.env-input--name {
	flex: 0 0 28%;
	text-transform: none;
}

.env-input--value {
	flex: 1;
	min-width: 0;
}

.env-equals {
	color: var(--nt-text-secondary);
}

.env-remove,
.env-add {
	background: none;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-text-secondary);
	cursor: pointer;
	font-size: 12px;
	padding: 4px 8px;
}

.env-remove:hover,
.env-add:hover {
	color: var(--nt-fg);
}

.env-add {
	margin-top: 4px;
}

.env-inherited {
	margin-top: 18px;
	border-top: 1px solid var(--nt-border);
	padding-top: 12px;
}

.env-inherited-title {
	margin: 0 0 8px;
	font-size: 11px;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--nt-text-secondary);
}

.env-inherited-row {
	display: flex;
	gap: 6px;
	margin: 0 0 4px;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.env-inherited-name {
	flex: 0 0 28%;
}

.env-inherited-value {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>
