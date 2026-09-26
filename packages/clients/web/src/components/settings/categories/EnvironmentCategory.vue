<template>
	<div class="environment-category">
		<section class="settings-section settings-section--first">
			<h3 class="section-title">Environment</h3>

			<SettingRow
				label="Inherited environment"
				:scope="scope"
				:is-overridden="settingsStore.isOverridden(scope, 'terminal', 'envMode')"
				:inherited-from="settingsStore.inheritedFrom(scope, 'terminal', 'envMode')"
				description="What a terminal starts with, on its host: the environment of the lasterm agent running there, or only what programs need to run (HOME, PATH, the locale…). Either way the terminal says what it is: TERM, COLORTERM and TERM_PROGRAM are set."
				@reset="settingsStore.resetSetting(scope, 'terminal', 'envMode')"
			>
				<SettingControl
					type="select"
					:model-value="editor.mode.value"
					:options="editor.modeOptions.value"
					@update:model-value="onEnvModeChange"
				/>
			</SettingRow>

			<div class="env-editor">
				<p class="env-help">
					Remove a variable, change its value, or add one. Only these changes are stored,
					never the whole environment: a variable that appears on the host later still
					reaches new terminals unless it is removed here. A host changes what Global sets,
					a terminal both. A running terminal keeps what it was given — changes reach the
					next one, and the ones you restart. Values are stored in the clear: no place for
					secrets.
				</p>

				<p v-if="editor.customized.value" class="env-summary">
					This scope: {{ describeCounts(editor.counts.value) }}
				</p>

				<p v-if="editor.agent.value.status === 'loading'" class="env-notice">
					Asking the host for its variables…
				</p>
				<p
					v-else-if="editor.agent.value.status === 'unavailable'"
					class="env-notice env-notice--warning"
					role="status"
				>
					{{ editor.agent.value.message }}
					<button class="env-link" type="button" @click="editor.reload()">Try again</button>
				</p>
				<p v-else-if="editor.agent.value.status === 'ready'" class="env-notice">
					The variables a terminal on this host starts with, in
					{{ editor.mode.value === 'minimal' ? 'minimal' : 'inherited' }} mode, and what the
					scopes change.
				</p>

				<ul v-if="editor.rows.value.length > 0" class="env-rows">
					<li
						v-for="row in editor.rows.value"
						:key="`${row.state}:${row.name}`"
						class="env-row"
						:class="`env-row--${row.state}`"
					>
						<input
							v-if="row.state === 'added'"
							class="env-input env-input--name"
							type="text"
							:value="row.name"
							:aria-label="`Name of ${row.name}`"
							spellcheck="false"
							autocapitalize="off"
							autocomplete="off"
							@change="onRename(row.name, $event, row.value)"
						/>
						<span v-else class="env-name" :title="row.name">{{ row.name }}</span>

						<span class="env-equals">=</span>

						<span
							v-if="row.state === 'removed' || row.state === 'removed-above'"
							class="env-value env-value--struck"
							:title="row.value"
						>
							{{ row.value || "(not set)" }}
						</span>
						<input
							v-else
							class="env-input env-input--value"
							type="text"
							:value="row.value"
							:aria-label="`Value of ${row.name}`"
							:title="row.before !== undefined ? `Was: ${row.before}` : row.value"
							spellcheck="false"
							autocapitalize="off"
							autocomplete="off"
							@change="onValue(row.name, $event, row.value)"
						/>

						<span class="env-tag">{{ tag(row) }}</span>

						<button
							v-if="row.state === 'inherited'"
							class="env-action"
							type="button"
							:aria-label="`Remove ${row.name}`"
							title="Remove it from what terminals start with"
							@click="editor.remove(row.name)"
						>
							✕
						</button>
						<button
							v-else-if="row.state !== 'removed-above'"
							class="env-action"
							type="button"
							:aria-label="`Restore ${row.name}`"
							:title="row.state === 'added' ? 'Take it out' : 'Undo this change'"
							@click="editor.restore(row.name)"
						>
							↺
						</button>
					</li>
				</ul>

				<form class="env-add" @submit.prevent="onAdd">
					<input
						v-model="newName"
						class="env-input env-input--name"
						type="text"
						placeholder="NAME"
						aria-label="Name of a variable to add"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
					/>
					<span class="env-equals">=</span>
					<input
						v-model="newValue"
						class="env-input env-input--value"
						type="text"
						placeholder="value"
						aria-label="Value of a variable to add"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
					/>
					<button class="env-button" type="submit" :disabled="newName.trim() === ''">
						Add
					</button>
				</form>

				<form
					v-if="editor.agent.value.status !== 'ready'"
					class="env-add"
					@submit.prevent="onRemoveByName"
				>
					<input
						v-model="removedName"
						class="env-input env-input--name"
						type="text"
						placeholder="NAME"
						aria-label="Name of a variable to remove"
						spellcheck="false"
						autocapitalize="off"
						autocomplete="off"
					/>
					<button class="env-button" type="submit" :disabled="removedName.trim() === ''">
						Remove by name
					</button>
				</form>
			</div>
		</section>
	</div>
</template>

<script setup lang="ts">
import { ref, toRef } from "vue";
import { type Scope, useSettingsStore } from "../../../stores/settings.js";
import SettingControl from "../SettingControl.vue";
import SettingRow from "../SettingRow.vue";
import { useEnvironmentEditor } from "./environmentEditor.js";
import { describeCounts, type EnvironmentRow } from "./environmentSettings.js";

const props = defineProps<{ scope: Scope }>();

const settingsStore = useSettingsStore();
const editor = useEnvironmentEditor(toRef(props, "scope"));

const newName = ref("");
const newValue = ref("");
const removedName = ref("");

const SOURCES = { agent: "host", global: "Global", host: "Host" } as const;

/** What a row says of itself, beside its value. */
function tag(row: EnvironmentRow): string {
	switch (row.state) {
		case "changed":
			return "changed";
		case "added":
			return "added";
		case "removed":
			return "removed";
		case "removed-above":
			return row.from === null ? "removed" : `removed at ${SOURCES[row.from]}`;
		default:
			return row.from === null || row.from === "agent" ? "" : `from ${SOURCES[row.from]}`;
	}
}

function inputValue(event: Event): string {
	return (event.target as HTMLInputElement).value;
}

function onValue(name: string, event: Event, shown: string): void {
	const value = inputValue(event);
	if (value !== shown) void editor.set(name, value);
}

function onRename(from: string, event: Event, value: string): void {
	const to = inputValue(event).trim();
	if (to === "") {
		(event.target as HTMLInputElement).value = from;
		return;
	}
	if (to !== from) void editor.rename(from, to, value);
}

function onAdd(): void {
	if (newName.value.trim() === "") return;
	void editor.set(newName.value, newValue.value);
	newName.value = "";
	newValue.value = "";
}

function onRemoveByName(): void {
	if (removedName.value.trim() === "") return;
	void editor.remove(removedName.value);
	removedName.value = "";
}

async function onEnvModeChange(value: unknown): Promise<void> {
	await editor.setMode(value === "minimal" ? "minimal" : "inherit");
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

.env-summary {
	margin: 0 0 10px;
	font-size: 12px;
	color: var(--nt-fg);
}

.env-notice {
	margin: 0 0 10px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	max-width: 62ch;
}

.env-notice--warning {
	color: var(--nt-yellow, var(--nt-fg));
}

.env-link {
	background: none;
	border: none;
	color: var(--nt-accent);
	cursor: pointer;
	font-size: 12px;
	padding: 0 0 0 4px;
	text-decoration: underline;
}

.env-rows {
	list-style: none;
	margin: 0 0 8px;
	padding: 0;
}

.env-row,
.env-add {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-bottom: 6px;
	min-width: 0;
}

.env-name {
	flex: 0 0 28%;
	font-size: 12px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
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
	min-width: 0;
	text-transform: none;
}

.env-input--value,
.env-value {
	flex: 1;
	min-width: 0;
}

.env-value {
	font-size: 12px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.env-row--removed .env-name,
.env-row--removed-above .env-name,
.env-value--struck {
	color: var(--nt-text-secondary);
	text-decoration: line-through;
}

.env-row--changed .env-input--value,
.env-row--added .env-input {
	border-color: var(--nt-accent);
}

.env-equals {
	color: var(--nt-text-secondary);
}

.env-tag {
	flex: 0 0 auto;
	font-size: 11px;
	color: var(--nt-text-secondary);
	white-space: nowrap;
}

.env-action,
.env-button {
	background: none;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-text-secondary);
	cursor: pointer;
	font-size: 12px;
	padding: 4px 8px;
}

.env-action:hover,
.env-button:hover:not(:disabled) {
	color: var(--nt-fg);
}

.env-button:disabled {
	cursor: default;
	opacity: 0.5;
}
</style>
