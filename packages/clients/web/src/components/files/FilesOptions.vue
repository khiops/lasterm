<template>
	<!-- Options (#836): the file transfer settings of the attached host, as they hold for its
	     terminal, each with where its value comes from. A change asks its scope first. -->
	<section class="files-options">
		<button
			type="button"
			class="files-options__toggle"
			:aria-expanded="expanded"
			:aria-controls="bodyId"
			@click="filesPanel.setOptionsExpanded(!expanded)"
		>
			<FilesIcon :name="expanded ? 'chevron-down' : 'chevron-right'" />
			<span v-if="expanded">Options <span class="files-options__for">for {{ hostLabel }}</span></span>
			<span v-else>{{ summary }}</span>
		</button>
		<div v-if="expanded" :id="bodyId" class="files-options__body">
			<div
				v-for="row in scopedRows"
				:key="row.key"
				class="files-option"
				:class="{ 'files-option--dim': row.dim !== null, 'files-option--changing': pending?.key === row.key }"
			>
				<div class="files-option__line">
					<div class="files-option__text">
						<label :id="`${bodyId}-${row.key}`" :for="`${bodyId}-${row.key}-control`" class="files-option__label">
							{{ row.label }}
						</label>
						<span class="files-option__source">
							<template v-if="pending?.key === row.key">changed, not saved</template>
							<template v-else>from {{ row.source }}</template>
							<template v-if="row.dim !== null"> · {{ row.dim }}</template>
						</span>
					</div>
					<select
						v-if="row.key === 'transferOnConflict'"
						:id="`${bodyId}-${row.key}-control`"
						:ref="(el) => setControl(row.key, el)"
						class="files-option__select"
						:value="shownValue(row.key)"
						@change="ask(row.key, ($event.target as HTMLSelectElement).value)"
					>
						<option v-for="(label, value) in CONFLICT_LABELS" :key="value" :value="value">{{ label }}</option>
					</select>
					<input
						v-else
						:id="`${bodyId}-${row.key}-control`"
						:ref="(el) => setControl(row.key, el)"
						class="files-option__switch"
						type="checkbox"
						role="switch"
						:checked="shownValue(row.key) === true"
						@change="ask(row.key, ($event.target as HTMLInputElement).checked)"
					/>
				</div>
				<!-- "Keep this for": nothing is written before a scope is chosen. Esc puts the control
				     back; the window leaves this Esc to it. -->
				<div
					v-if="pending?.key === row.key"
					ref="question"
					class="files-card files-scope"
					role="group"
					:aria-label="`Keep ${row.label}: ${optionValueText(pending.value)} for`"
					data-own-escape
					@keydown.esc.prevent.stop="cancel"
				>
					<p class="files-scope__ask">Keep "{{ optionValueText(pending.value) }}" for</p>
					<div class="files-scope__choices">
						<button
							v-for="choice in choices"
							:key="choice.scope"
							type="button"
							class="files-btn"
							:class="{ 'files-btn--primary': choice.scope === 'host' }"
							:disabled="saving"
							@click="choose(choice.scope)"
						>
							{{ choice.label }}
						</button>
						<button type="button" class="files-btn" :disabled="saving" @click="cancel">Cancel</button>
					</div>
					<p v-for="choice in choicesThatDrop" :key="choice.scope" class="files-scope__drops">
						{{ choice.drops }}
					</p>
				</div>
			</div>
			<div v-for="row in windowRows" :key="row.key" class="files-option">
				<div class="files-option__line">
					<div class="files-option__text">
						<label :for="`${bodyId}-${row.key}-control`" class="files-option__label">{{ row.label }}</label>
						<span class="files-option__source">everywhere only</span>
					</div>
					<input
						:id="`${bodyId}-${row.key}-control`"
						class="files-option__switch"
						type="checkbox"
						role="switch"
						:checked="row.value"
						@change="saveWindowOption(row.key, ($event.target as HTMLInputElement).checked)"
					/>
				</div>
			</div>
			<button type="button" class="files-link files-options__all" @click="openSettings">
				All file transfer settings…
			</button>
		</div>
	</section>
</template>

<script setup lang="ts">
import {
	type CascadeResponse,
	DEFAULT_PROFILE,
	DEFAULT_TRANSFER_CONFIG,
	planProfileWrite,
	type ProfileWriteScope,
	type TransferOnConflict,
} from "@lasterm/shared";
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useSettingsStore } from "../../stores/settings.js";
import { useToastStore } from "../../stores/toast.js";
import {
	CONFLICT_LABELS,
	optionSource,
	optionsSummary,
	optionValueText,
	type ScopedOptionKey,
	scopeChoices,
	sourceLabel,
} from "../../utils/files-panel.js";
import FilesIcon from "./FilesIcon.vue";

const props = defineProps<{
	hostId: string | null;
	channelId: string | null;
	hostLabel: string;
	/** Verify applies to this host: it is reached over SSH commands, offering no SFTP. */
	verifyApplies: boolean;
	/** Why it does not, when it does not. */
	verifyReason: string;
}>();

const configStore = useConfigStore();
const filesPanel = useFilesPanelStore();
const settingsStore = useSettingsStore();
const bodyId = useId();

const expanded = computed(() => filesPanel.optionsExpanded);

/** A change made on a row, which waits for its scope. */
const pending = ref<{ key: ScopedOptionKey; value: unknown } | null>(null);
const saving = ref(false);

// ─── The cascade, read for the attached terminal ─────────────────────────────

const cascade = ref<CascadeResponse | null>(null);
let sequence = 0;

async function readLayers(): Promise<void> {
	const mine = ++sequence;
	const read = await configStore.readCascade({ hostId: props.hostId, channelId: props.channelId });
	if (mine === sequence) cascade.value = read;
}

watch(
	() => [props.hostId, props.channelId] as const,
	() => {
		pending.value = null;
		void readLayers();
	},
	{ immediate: true },
);

// A value changed in Settings, in another window or through the API arrives as CONFIG_CHANGED,
// which every window turns into this event; a write made here raises it too.
let unsubscribe: (() => void) | null = null;
onMounted(() => {
	unsubscribe = configStore.onProfileChange((event) => {
		if (
			event.scope === "global" ||
			(event.scope === "host" && event.hostId === props.hostId) ||
			(event.scope === "channel" && event.channelId === props.channelId)
		) {
			void readLayers();
		}
	});
});
onUnmounted(() => unsubscribe?.());

function effective(key: ScopedOptionKey): unknown {
	return cascade.value?.terminal.resolved[key] ?? DEFAULT_PROFILE[key];
}

// ─── The rows ────────────────────────────────────────────────────────────────

const LABELS: Readonly<Record<ScopedOptionKey, string>> = {
	transferOnConflict: "When a file already exists",
	transferConfirmDrop: "Show the destination before a dropped upload",
	transferFollowCwd: "Follow the terminal's directory",
	transferVerify: "Verify uploads by SHA-256",
};

const scopedRows = computed(() => {
	const layers = {
		global: cascade.value?.terminal.global,
		host: cascade.value?.terminal.host,
		channel: cascade.value?.terminal.channel,
	};
	return (Object.keys(LABELS) as ScopedOptionKey[]).map((key) => ({
		key,
		label: LABELS[key],
		source: sourceLabel(optionSource(layers, key), props.hostLabel),
		dim: key === "transferVerify" && !props.verifyApplies ? props.verifyReason : null,
	}));
});

const transfer = computed(() => ({ ...DEFAULT_TRANSFER_CONFIG, ...configStore.uiConfig.transfer }));

const windowRows = computed(() => [
	{ key: "showHidden" as const, label: "Show hidden files", value: transfer.value.showHidden },
	{
		key: "openOnDrag" as const,
		label: "Open this panel when a file is dragged over a terminal",
		value: transfer.value.openOnDrag,
	},
]);

const summary = computed(() =>
	optionsSummary({
		onConflict: effective("transferOnConflict") as TransferOnConflict,
		followCwd: effective("transferFollowCwd") === true,
		verify: effective("transferVerify") === true,
		verifyApplies: props.verifyApplies,
	}),
);

// ─── A change asks its scope ─────────────────────────────────────────────────

const question = ref<HTMLElement[] | HTMLElement | null>(null);
const controls = new Map<ScopedOptionKey, HTMLElement>();

function setControl(key: ScopedOptionKey, el: unknown): void {
	if (el instanceof HTMLElement) controls.set(key, el);
	else controls.delete(key);
}

function shownValue(key: ScopedOptionKey): unknown {
	return pending.value?.key === key ? pending.value.value : effective(key);
}

const target = computed(() => ({ hostId: props.hostId, channelId: props.channelId }));
const layers = computed(() => ({
	host: cascade.value?.terminal.host,
	channel: cascade.value?.terminal.channel,
}));

const choices = computed(() =>
	pending.value === null
		? []
		: scopeChoices(pending.value.key, pending.value.value, target.value, layers.value, props.hostLabel),
);
const choicesThatDrop = computed(() => choices.value.filter((choice) => choice.drops !== null));

/** A control changed: the question comes right under its row, with the keyboard in it. */
function ask(key: ScopedOptionKey, value: unknown): void {
	if (value === effective(key) && pending.value?.key !== key) return;
	pending.value = value === effective(key) ? null : { key, value };
	if (pending.value === null) return;
	void nextTick(() => {
		const group = Array.isArray(question.value) ? question.value[0] : question.value;
		group?.querySelector<HTMLElement>("button")?.focus();
	});
}

/** Cancel, or Esc: nothing written, the control shows the value again, the keyboard on it. */
function cancel(): void {
	const key = pending.value?.key;
	pending.value = null;
	if (key !== undefined) void nextTick(() => controls.get(key)?.focus());
}

async function choose(scope: ProfileWriteScope): Promise<void> {
	const change = pending.value;
	if (change === null || saving.value) return;
	const plan = planProfileWrite(change.key, change.value, scope, target.value, layers.value);
	if (plan === null) return;
	saving.value = true;
	const ok = await configStore.saveProfileWrite(plan);
	saving.value = false;
	if (!ok) useToastStore().show("error", `Could not save "${LABELS[change.key]}".`);
	await readLayers();
	pending.value = null;
	void nextTick(() => controls.get(change.key)?.focus());
}

/** The window's own options are global only, and apply at once. */
function saveWindowOption(key: "showHidden" | "openOnDrag", value: boolean): void {
	void configStore.saveUiSettings("transfer", { [key]: value }).then((ok) => {
		if (!ok) useToastStore().show("error", "Could not save the files panel's option.");
	});
}

function openSettings(): void {
	settingsStore.openAt({
		category: "transfer",
		scope: "host",
		hostId: props.hostId,
		channelId: props.channelId,
	});
}
</script>

<style scoped>
.files-options {
	border-top: 1px solid var(--nt-border);
	flex-shrink: 0;
	max-height: 45%;
	overflow-y: auto;
}

.files-options__toggle {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 6px 10px;
	border: none;
	background: transparent;
	color: var(--nt-sidebar-text, var(--nt-fg));
	font: inherit;
	font-size: 11px;
	text-align: left;
	cursor: pointer;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.files-options__toggle:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.files-options__for {
	color: var(--nt-text-secondary);
}

.files-options__body {
	padding: 0 10px 8px;
}

.files-option {
	padding: 5px 0;
	border-top: 1px solid var(--nt-border);
}

.files-option--dim .files-option__line {
	opacity: 0.6;
}

.files-option--changing .files-option__line {
	border-left: 2px solid var(--nt-accent);
	padding-left: 6px;
}

.files-option__line {
	display: flex;
	align-items: center;
	gap: 8px;
}

.files-option__text {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.files-option__label {
	font-size: 12px;
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.files-option__source {
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.files-option__select {
	flex-shrink: 0;
	max-width: 110px;
	padding: 2px 4px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	font: inherit;
	font-size: 12px;
}

.files-option__switch {
	flex-shrink: 0;
	margin: 0;
	accent-color: var(--nt-accent);
	cursor: pointer;
}

.files-option__select:focus-visible,
.files-option__switch:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

/* What asks sits on the exit card's opaque ground, whatever the panel's opacity. */
.files-card {
	margin: 6px 0 2px;
	padding: 8px 10px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
}

.files-scope__ask {
	margin: 0 0 6px;
	font-size: 12px;
}

.files-scope__choices {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.files-scope__drops {
	margin: 6px 0 0;
	font-size: 11px;
}

.files-btn {
	padding: 3px 10px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: var(--nt-text-strong);
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.files-btn--primary {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.files-btn:focus-visible,
.files-link:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

.files-btn:disabled {
	opacity: 0.6;
	cursor: default;
}

.files-link {
	padding: 0;
	border: none;
	background: none;
	color: var(--nt-accent);
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
}

.files-options__all {
	margin-top: 8px;
}
</style>
