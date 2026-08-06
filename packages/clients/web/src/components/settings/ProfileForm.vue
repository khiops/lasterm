<template>
	<div class="profile-form">
		<div class="form-header">
			<h3 class="form-title">{{ isEdit ? 'Edit Profile' : 'New Profile' }}</h3>
			<div class="form-header-actions">
				<button type="button" class="btn btn-ghost" @click="emit('cancel')">Cancel</button>
				<button
					type="button"
					class="btn btn-primary"
					:disabled="saving"
					@click="handleSave"
				>
					{{ saving ? 'Saving…' : 'Save' }}
				</button>
			</div>
		</div>

		<div v-if="errorMessage" class="form-error" role="alert">
			{{ errorMessage }}
		</div>

		<!-- ── Basic Info ─────────────────────────────────────────────────── -->
		<section class="form-section">
			<h4 class="section-title">Basic</h4>

			<div class="form-row">
				<label class="form-label" for="pf-name">Name <span class="required">*</span></label>
				<input
					id="pf-name"
					v-model="form.name"
					class="form-input"
					type="text"
					maxlength="100"
					placeholder="e.g. zsh default"
					autocomplete="off"
				/>
			</div>

			<div class="form-row">
				<label class="form-label" for="pf-shell">Shell <span class="required">*</span></label>
				<input
					id="pf-shell"
					v-model="form.shell"
					class="form-input"
					type="text"
					maxlength="512"
					placeholder="/bin/zsh"
					list="shell-suggestions"
					autocomplete="off"
				/>
				<datalist id="shell-suggestions">
					<option v-for="s in shellSuggestions" :key="s" :value="s" />
				</datalist>
			</div>

			<div class="form-row">
				<label class="form-label" for="pf-mode">Mode <span class="required">*</span></label>
				<select id="pf-mode" v-model="form.mode" class="form-select">
					<option value="shell">Shell (interactive)</option>
					<option value="process">Process (direct)</option>
				</select>
			</div>

			<div class="form-row">
				<label class="form-label" for="pf-os">Supported OS <span class="required">*</span></label>
				<select id="pf-os" v-model="form.supportedOs" class="form-select">
					<option value="any">Any</option>
					<option value="linux">Linux</option>
					<option value="darwin">macOS</option>
					<option value="windows">Windows</option>
				</select>
			</div>

			<div class="form-row">
				<label class="form-label" for="pf-cwd">Working Directory</label>
				<input
					id="pf-cwd"
					v-model="form.cwd"
					class="form-input"
					type="text"
					maxlength="1024"
					placeholder="/home/user"
					autocomplete="off"
				/>
			</div>

			<div class="form-row form-row-checkbox">
				<label class="form-label-inline">
					<input v-model="form.elevated" type="checkbox" class="form-checkbox" />
					Elevated (run as admin/sudo)
				</label>
			</div>
		</section>

		<!-- ── Arguments ─────────────────────────────────────────────────── -->
		<section class="form-section">
			<h4 class="section-title">Arguments</h4>
			<div class="args-list">
				<div v-for="(arg, i) in form.args" :key="i" class="arg-chip">
					<span class="arg-text">{{ arg }}</span>
					<button type="button" class="arg-remove" :aria-label="`Remove argument ${arg}`" @click="removeArg(i)">×</button>
				</div>
				<div class="arg-add-row">
					<input
						v-model="newArg"
						class="form-input arg-input"
						type="text"
						maxlength="1024"
						placeholder="Add argument…"
						@keydown.enter.prevent="addArg"
					/>
					<button type="button" class="btn btn-ghost btn-sm" @click="addArg">Add</button>
				</div>
			</div>
			<p class="field-hint">Press Enter or click Add. Max 64 arguments.</p>
		</section>

		<!-- ── Icon & Color ───────────────────────────────────────────────── -->
		<section class="form-section">
			<h4 class="section-title">Icon &amp; Color</h4>

			<div class="form-row">
				<label class="form-label" for="pf-icon-type">Icon Type</label>
				<select id="pf-icon-type" v-model="form.iconType" class="form-select">
					<option value="auto">Auto</option>
					<option value="emoji">Emoji</option>
					<option value="image">Image URL</option>
				</select>
			</div>

			<div v-if="form.iconType !== 'auto'" class="form-row">
				<label class="form-label" for="pf-icon-value">
					{{ form.iconType === 'emoji' ? 'Emoji' : 'Image URL' }}
				</label>
				<input
					id="pf-icon-value"
					v-model="form.iconValue"
					class="form-input"
					type="text"
					maxlength="256"
					:placeholder="form.iconType === 'emoji' ? '🐚' : 'https://…'"
					autocomplete="off"
				/>
			</div>

			<div class="form-row">
				<label class="form-label" for="pf-color">Color</label>
				<div class="color-row">
					<input
						id="pf-color"
						v-model="form.color"
						class="form-input color-hex"
						type="text"
						maxlength="7"
						placeholder="#3b82f6"
						pattern="^#[0-9a-fA-F]{6}$"
						autocomplete="off"
					/>
					<input
						type="color"
						class="color-picker"
						:value="form.color || '#3b82f6'"
						@input="form.color = ($event.target as HTMLInputElement).value"
					/>
				</div>
			</div>
		</section>

		<!-- ── Environment Variables ─────────────────────────────────────── -->
		<section class="form-section">
			<h4 class="section-title">Environment Variables</h4>
			<div class="env-list">
				<div v-for="(entry, i) in envEntries" :key="i" class="env-row">
					<input
						v-model="entry.key"
						class="form-input env-key"
						type="text"
						placeholder="KEY"
						autocomplete="off"
						@input="syncEnv"
					/>
					<span class="env-eq">=</span>
					<div class="env-value-wrap">
						<input
							v-model="entry.value"
							class="form-input env-value"
							:type="isSensitiveKey(entry.key) && !entry.revealed ? 'password' : 'text'"
							:placeholder="isSensitiveKey(entry.key) ? '••••••••' : 'value'"
							autocomplete="off"
							@input="syncEnv"
						/>
						<button
							v-if="isSensitiveKey(entry.key)"
							type="button"
							class="env-reveal"
							:title="entry.revealed ? 'Hide' : 'Reveal'"
							@click="entry.revealed = !entry.revealed"
						>
							{{ entry.revealed ? '🙈' : '👁' }}
						</button>
					</div>
					<button type="button" class="env-remove" aria-label="Remove variable" @click="removeEnvEntry(i)">×</button>
				</div>
			</div>
			<button type="button" class="btn btn-ghost btn-sm" @click="addEnvEntry">+ Add Variable</button>
			<p class="field-hint">Max 100 entries. Sensitive keys (password, secret, token, key, credential) are masked.</p>
		</section>

		<!-- ── Profile Overrides ─────────────────────────────────────────── -->
		<section class="form-section">
			<button
				type="button"
				class="collapsible-header"
				:aria-expanded="showOverrides"
				@click="showOverrides = !showOverrides"
			>
				<span class="section-title">Terminal Profile Overrides</span>
				<span class="collapsible-chevron">{{ showOverrides ? '▲' : '▼' }}</span>
			</button>

			<div v-if="showOverrides" class="collapsible-content">
				<p class="field-hint">These settings override the global terminal profile when this launch profile is used.</p>

				<div class="form-row">
					<label class="form-label" for="pf-font-family">Font Family</label>
					<input
						id="pf-font-family"
						v-model="form.profileOverrides.fontFamily"
						class="form-input"
						type="text"
						placeholder="Inherited"
						autocomplete="off"
					/>
				</div>

				<div class="form-row">
					<label class="form-label" for="pf-font-size">Font Size</label>
					<input
						id="pf-font-size"
						v-model.number="form.profileOverrides.fontSize"
						class="form-input"
						type="number"
						min="8"
						max="72"
						placeholder="Inherited"
					/>
				</div>

				<div class="form-row">
					<label class="form-label" for="pf-cursor-style">Cursor Style</label>
					<select id="pf-cursor-style" v-model="form.profileOverrides.cursorStyle" class="form-select">
						<option value="">Inherited</option>
						<option value="block">Block</option>
						<option value="underline">Underline</option>
						<option value="bar">Bar</option>
					</select>
				</div>

				<div class="form-row">
					<label class="form-label" for="pf-scrollback">Scrollback Lines</label>
					<input
						id="pf-scrollback"
						v-model.number="form.profileOverrides.scrollback"
						class="form-input"
						type="number"
						min="0"
						max="100000"
						placeholder="Inherited"
					/>
				</div>

				<div class="form-row">
					<label class="form-label" for="pf-env-mode">Environment Inheritance</label>
					<select id="pf-env-mode" v-model="form.profileOverrides.envMode" class="form-select">
						<option value="">Inherited</option>
						<option value="inherit">Inherit with blocklist</option>
						<option value="minimal">Minimal (secure)</option>
					</select>
				</div>
			</div>
		</section>

		<!-- ── Host Overrides ─────────────────────────────────────────────── -->
		<HostOverridesTable v-if="isEdit && props.profile" :profile-id="props.profile.id" />
	</div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from "vue";
import type { LaunchProfile, LaunchProfileMode, SupportedOs, IconType } from "@lasterm/shared";
import type { TerminalProfile } from "@lasterm/shared";
import HostOverridesTable from "./HostOverridesTable.vue";
import { useProfilesStore } from "../../stores/profiles.js";

// ── Props & emits ───────────────────────────────────────────────────────────

const props = defineProps<{
	profile?: LaunchProfile;
}>();

const emit = defineEmits<{
	saved: [profile: LaunchProfile];
	cancel: [];
}>();

const isEdit = computed(() => props.profile !== undefined);

// ── Form state ──────────────────────────────────────────────────────────────

interface FormState {
	name: string;
	shell: string;
	args: string[];
	cwd: string;
	mode: LaunchProfileMode;
	supportedOs: SupportedOs;
	elevated: boolean;
	iconType: IconType;
	iconValue: string;
	color: string;
	profileOverrides: Partial<TerminalProfile> & { cursorStyle?: string; envMode?: string };
}

function buildInitialForm(p?: LaunchProfile): FormState {
	return {
		name: p?.name ?? "",
		shell: p?.shell ?? "",
		args: p?.args ? [...p.args] : [],
		cwd: p?.cwd ?? "",
		mode: p?.mode ?? "shell",
		supportedOs: p?.supportedOs ?? "any",
		elevated: p?.elevated ?? false,
		iconType: p?.iconType ?? "auto",
		iconValue: p?.iconValue ?? "",
		color: p?.color ?? "",
		profileOverrides: {
			...(p?.profileOverrides?.fontFamily !== undefined && { fontFamily: p.profileOverrides.fontFamily }),
			...(p?.profileOverrides?.fontSize !== undefined && { fontSize: p.profileOverrides.fontSize }),
			...(p?.profileOverrides?.cursorStyle !== undefined && { cursorStyle: p.profileOverrides.cursorStyle }),
			...(p?.profileOverrides?.scrollback !== undefined && { scrollback: p.profileOverrides.scrollback }),
			...(p?.profileOverrides?.envMode !== undefined && { envMode: p.profileOverrides.envMode }),
		},
	};
}

const form = reactive<FormState>(buildInitialForm(props.profile));

// Reset form when profile prop changes
watch(
	() => props.profile,
	(p) => {
		const next = buildInitialForm(p);
		Object.assign(form, next);
		syncEnvFromProfile(p);
	},
	{ immediate: false },
);

// ── Args handling ───────────────────────────────────────────────────────────

const newArg = ref("");

function addArg(): void {
	const trimmed = newArg.value.trim();
	if (trimmed === "" || form.args.length >= 64) return;
	form.args.push(trimmed);
	newArg.value = "";
}

function removeArg(index: number): void {
	form.args.splice(index, 1);
}

// ── Env handling ────────────────────────────────────────────────────────────

interface EnvEntry {
	key: string;
	value: string;
	revealed: boolean;
}

const SENSITIVE_PATTERNS = /password|secret|token|key|credential/i;

function isSensitiveKey(key: string): boolean {
	return SENSITIVE_PATTERNS.test(key);
}

const envEntries = ref<EnvEntry[]>([]);

function syncEnvFromProfile(p?: LaunchProfile): void {
	if (!p?.env) {
		envEntries.value = [];
		return;
	}
	envEntries.value = Object.entries(p.env).map(([key, value]) => ({
		key,
		value,
		revealed: false,
	}));
}

// Initialize env entries from profile
syncEnvFromProfile(props.profile);

function addEnvEntry(): void {
	if (envEntries.value.length >= 100) return;
	envEntries.value.push({ key: "", value: "", revealed: false });
}

function removeEnvEntry(index: number): void {
	envEntries.value.splice(index, 1);
	syncEnv();
}

function syncEnv(): void {
	// Rebuild form env from entries (no-op — we read envEntries on save)
}

function buildEnvRecord(): Record<string, string> | undefined {
	const entries = envEntries.value.filter((e) => e.key.trim() !== "");
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries.map((e) => [e.key.trim(), e.value]));
}

// ── Profile overrides ───────────────────────────────────────────────────────

const showOverrides = ref(false);

// ── Shell suggestions ────────────────────────────────────────────────────────

const shellSuggestions = computed<string[]>(() => {
	const defaults = ["/bin/bash", "/bin/zsh", "/bin/sh", "/bin/fish", "/usr/bin/fish", "/bin/tcsh"];
	return defaults;
});

// ── Error state ──────────────────────────────────────────────────────────────

const errorMessage = ref<string | null>(null);
const saving = ref(false);

// ── Save ─────────────────────────────────────────────────────────────────────

const profilesStore = useProfilesStore();

async function handleSave(): Promise<void> {
	errorMessage.value = null;

	// Validate
	if (form.name.trim() === "") {
		errorMessage.value = "Name is required.";
		return;
	}
	if (form.shell.trim() === "") {
		errorMessage.value = "Shell is required.";
		return;
	}

	saving.value = true;
	try {
		// Build profile overrides (omit undefined/empty values)
		const overrides: Partial<TerminalProfile> = {};
		if (form.profileOverrides.fontFamily?.trim()) {
			overrides.fontFamily = form.profileOverrides.fontFamily.trim();
		}
		if (form.profileOverrides.fontSize != null && form.profileOverrides.fontSize > 0) {
			overrides.fontSize = form.profileOverrides.fontSize;
		}
		if (form.profileOverrides.cursorStyle) {
			overrides.cursorStyle = form.profileOverrides.cursorStyle;
		}
		if (form.profileOverrides.scrollback != null && form.profileOverrides.scrollback >= 0) {
			overrides.scrollback = form.profileOverrides.scrollback;
		}
		if (form.profileOverrides.envMode) {
			overrides.envMode = form.profileOverrides.envMode as 'minimal' | 'inherit';
		}

		const envRecord = buildEnvRecord();
		const data: Partial<LaunchProfile> = {
			name: form.name.trim(),
			shell: form.shell.trim(),
			...(form.args.length > 0 && { args: [...form.args] }),
			...(form.cwd.trim() !== "" && { cwd: form.cwd.trim() }),
			mode: form.mode,
			supportedOs: form.supportedOs,
			elevated: form.elevated,
			iconType: form.iconType,
			...(form.iconValue.trim() !== "" && { iconValue: form.iconValue.trim() }),
			...(form.color.trim() !== "" && { color: form.color.trim() }),
			...(envRecord !== undefined && { env: envRecord }),
			...(Object.keys(overrides).length > 0 && { profileOverrides: overrides }),
		};

		let saved: LaunchProfile;
		if (isEdit.value && props.profile) {
			saved = await profilesStore.updateProfile(props.profile.id, data);
		} else {
			saved = await profilesStore.createProfile(data);
		}
		emit("saved", saved);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("409") || msg.toLowerCase().includes("duplicate")) {
			errorMessage.value = "A profile with this name already exists.";
		} else {
			errorMessage.value = msg;
		}
	} finally {
		saving.value = false;
	}
}
</script>

<style scoped>
.profile-form {
	display: flex;
	flex-direction: column;
	gap: 0;
}

.form-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 20px;
	padding-bottom: 12px;
	border-bottom: 1px solid var(--nt-border);
}

.form-title {
	margin: 0;
	font-size: 15px;
	font-weight: 700;
	color: var(--nt-fg);
}

.form-header-actions {
	display: flex;
	gap: 8px;
}

.form-error {
	padding: 10px 14px;
	margin-bottom: 16px;
	background: rgba(var(--nt-danger-rgb, 239, 68, 68), 0.1);
	border: 1px solid rgba(var(--nt-danger-rgb, 239, 68, 68), 0.3);
	border-radius: 6px;
	font-size: 13px;
	color: var(--nt-danger);
}

.form-section {
	margin-bottom: 20px;
	padding-bottom: 4px;
}

.section-title {
	margin: 0 0 12px 0;
	font-size: 11px;
	font-weight: 700;
	color: var(--nt-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.06em;
}

.form-row {
	display: flex;
	align-items: center;
	gap: 12px;
	margin-bottom: 10px;
}

.form-row-checkbox {
	align-items: center;
}

.form-label {
	width: 120px;
	min-width: 120px;
	font-size: 13px;
	font-weight: 500;
	color: var(--nt-fg);
}

.form-label-inline {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 13px;
	color: var(--nt-fg);
	cursor: pointer;
}

.required {
	color: var(--nt-danger);
}

.form-input {
	flex: 1;
	padding: 6px 10px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 5px;
	color: var(--nt-fg);
	font-size: 13px;
	font-family: inherit;
	outline: none;
	transition: border-color 0.15s ease;
}

.form-input:focus {
	border-color: var(--nt-accent);
}

.form-select {
	flex: 1;
	padding: 6px 10px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 5px;
	color: var(--nt-fg);
	font-size: 13px;
	font-family: inherit;
	cursor: pointer;
	outline: none;
}

.form-select:focus {
	border-color: var(--nt-accent);
}

.form-checkbox {
	width: 14px;
	height: 14px;
	cursor: pointer;
	accent-color: var(--nt-accent);
}

.field-hint {
	margin: 4px 0 0;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

/* ── Args ─────────────────────────────────────────────────────────────────── */

.args-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-bottom: 8px;
}

.arg-chip {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 3px 8px;
	background: var(--nt-bg-surface);
	border-radius: 12px;
	font-size: 12px;
	font-family: var(--nt-font-mono, monospace);
	color: var(--nt-fg);
}

.arg-remove {
	background: none;
	border: none;
	cursor: pointer;
	color: var(--nt-text-secondary);
	font-size: 14px;
	line-height: 1;
	padding: 0 2px;
}

.arg-remove:hover {
	color: var(--nt-danger);
}

.arg-add-row {
	display: flex;
	align-items: center;
	gap: 8px;
	width: 100%;
}

.arg-input {
	flex: 1;
}

/* ── Color ────────────────────────────────────────────────────────────────── */

.color-row {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 1;
}

.color-hex {
	flex: 1;
}

.color-picker {
	width: 36px;
	height: 32px;
	padding: 2px;
	border: 1px solid var(--nt-border);
	border-radius: 5px;
	background: none;
	cursor: pointer;
}

/* ── Env ──────────────────────────────────────────────────────────────────── */

.env-list {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin-bottom: 8px;
}

.env-row {
	display: flex;
	align-items: center;
	gap: 6px;
}

.env-key {
	width: 120px;
	min-width: 120px;
	flex: 0 0 120px;
	font-family: var(--nt-font-mono, monospace);
	font-size: 12px;
}

.env-eq {
	color: var(--nt-text-secondary);
	font-weight: 600;
	flex-shrink: 0;
}

.env-value-wrap {
	flex: 1;
	position: relative;
	display: flex;
	align-items: center;
}

.env-value {
	flex: 1;
	font-family: var(--nt-font-mono, monospace);
	font-size: 12px;
}

.env-reveal {
	position: absolute;
	right: 6px;
	background: none;
	border: none;
	cursor: pointer;
	font-size: 14px;
	padding: 0;
	opacity: 0.7;
}

.env-reveal:hover {
	opacity: 1;
}

.env-remove {
	background: none;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 16px;
	cursor: pointer;
	padding: 0 4px;
	line-height: 1;
	flex-shrink: 0;
}

.env-remove:hover {
	color: var(--nt-danger);
}

/* ── Collapsible overrides ────────────────────────────────────────────────── */

.collapsible-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	width: 100%;
	background: none;
	border: none;
	cursor: pointer;
	padding: 0 0 12px 0;
	color: var(--nt-fg);
}

.collapsible-header:hover .section-title {
	color: var(--nt-fg);
}

.collapsible-chevron {
	font-size: 10px;
	color: var(--nt-text-secondary);
}

.collapsible-content {
	padding-top: 4px;
}

/* ── Buttons ──────────────────────────────────────────────────────────────── */

.btn {
	padding: 6px 14px;
	border-radius: 5px;
	font-size: 13px;
	font-family: inherit;
	font-weight: 500;
	cursor: pointer;
	border: 1px solid transparent;
	transition:
		background 0.15s ease,
		border-color 0.15s ease,
		opacity 0.15s ease;
}

.btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.btn-primary {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
	border-color: var(--nt-accent);
}

.btn-primary:hover:not(:disabled) {
	filter: brightness(1.1);
}

.btn-ghost {
	background: transparent;
	color: var(--nt-fg);
	border-color: var(--nt-border);
}

.btn-ghost:hover:not(:disabled) {
	background: var(--nt-hover);
}

.btn-sm {
	padding: 4px 10px;
	font-size: 12px;
}
</style>
