<template>
	<div class="theme-editor">
		<div class="theme-editor-header">
			<h3 class="theme-editor-title">
				{{ isNew ? "New Theme" : "Edit Theme" }}
			</h3>
			<button
				class="theme-editor-close"
				type="button"
				aria-label="Close editor"
				@click="handleCancel"
			>
				&#10005;
			</button>
		</div>

		<div class="theme-editor-body">
			<!-- Based on -->
			<div class="theme-editor-field">
				<label class="theme-editor-label" for="te-based-on">Based on</label>
				<select
					id="te-based-on"
					class="theme-editor-select"
					:value="basedOnName"
					@change="handleBasedOnChange"
				>
					<option
						v-for="t in themeStore.availableThemes"
						:key="t.name"
						:value="t.name"
					>
						{{ t.name }}
					</option>
				</select>
			</div>

			<!-- Name -->
			<div class="theme-editor-field">
				<label class="theme-editor-label" for="te-name">Name</label>
				<input
					id="te-name"
					v-model="draft.name"
					class="theme-editor-input"
					:class="{ 'theme-editor-input--error': nameError }"
					type="text"
					placeholder="my-custom-theme"
					autocomplete="off"
					spellcheck="false"
				/>
				<span v-if="nameError" class="theme-editor-error">{{ nameError }}</span>
			</div>

			<!-- Author -->
			<div class="theme-editor-field">
				<label class="theme-editor-label" for="te-author">Author</label>
				<input
					id="te-author"
					v-model="draft.author"
					class="theme-editor-input"
					type="text"
					placeholder="optional"
					autocomplete="off"
					spellcheck="false"
				/>
			</div>

			<!-- Type toggle -->
			<div class="theme-editor-field">
				<label class="theme-editor-label">Type</label>
				<div class="theme-editor-toggle">
					<button
						class="theme-editor-toggle-btn"
						:class="{ 'theme-editor-toggle-btn--active': draft.type === 'dark' }"
						type="button"
						@click="draft.type = 'dark'"
					>
						Dark
					</button>
					<button
						class="theme-editor-toggle-btn"
						:class="{ 'theme-editor-toggle-btn--active': draft.type === 'light' }"
						type="button"
						@click="draft.type = 'light'"
					>
						Light
					</button>
				</div>
			</div>

			<!-- Terminal Colors -->
			<div class="theme-editor-section">
				<h4 class="theme-editor-section-label">Terminal Colors</h4>
				<div class="theme-editor-colors">
					<div
						v-for="field in terminalColorFields"
						:key="field.key"
						class="theme-editor-color"
					>
						<label class="theme-editor-color-label" :for="`te-color-${field.key}`">
							{{ field.label }}
						</label>
						<div class="theme-editor-color-controls">
							<input
								:id="`te-color-${field.key}`"
								type="color"
								class="theme-editor-color-picker"
								:value="getColorValue(field.key)"
								@input="setColorValue(field.key, ($event.target as HTMLInputElement).value)"
							/>
							<input
								class="theme-editor-color-hex"
								type="text"
								:value="getColorValue(field.key)"
								maxlength="9"
								spellcheck="false"
								@change="setColorValue(field.key, ($event.target as HTMLInputElement).value)"
							/>
						</div>
					</div>
				</div>
			</div>

			<!-- UI Chrome Colors -->
			<div class="theme-editor-section">
				<h4 class="theme-editor-section-label">UI Chrome</h4>
				<div class="theme-editor-colors">
					<div
						v-for="field in uiColorFields"
						:key="field.key"
						class="theme-editor-color"
					>
						<label class="theme-editor-color-label" :for="`te-ui-${field.key}`">
							{{ field.label }}
						</label>
						<div class="theme-editor-color-controls">
							<input
								:id="`te-ui-${field.key}`"
								type="color"
								class="theme-editor-color-picker"
								:value="getUiValue(field.key)"
								@input="setUiValue(field.key, ($event.target as HTMLInputElement).value)"
							/>
							<input
								class="theme-editor-color-hex"
								type="text"
								:value="getUiValue(field.key)"
								maxlength="9"
								spellcheck="false"
								@change="setUiValue(field.key, ($event.target as HTMLInputElement).value)"
							/>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Actions -->
		<div class="theme-editor-actions">
			<button
				class="theme-editor-btn theme-editor-btn--secondary"
				type="button"
				@click="handleCancel"
			>
				Cancel
			</button>
			<button
				class="theme-editor-btn theme-editor-btn--secondary"
				type="button"
				@click="handleExport"
			>
				Export JSON
			</button>
			<button
				class="theme-editor-btn theme-editor-btn--primary"
				type="button"
				:disabled="!!nameError || saving"
				@click="handleSave"
			>
				{{ saving ? "Saving..." : "Save" }}
			</button>
		</div>

		<!-- Save error -->
		<div v-if="saveError" class="theme-editor-save-error">{{ saveError }}</div>
	</div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onUnmounted } from "vue";
import type { LastermTheme, LastermThemeColors, LastermThemeUi } from "@lasterm/shared";
import { THEME_NAME_REGEX } from "@lasterm/shared";
import { useThemeStore } from "../../stores/theme.js";
import { useAuthStore } from "../../stores/auth.js";
import { hubBaseUrl } from "../../utils/hub-url.js";
import { hubFetch } from "../../utils/hub-fetch.js";

const props = defineProps<{
	theme?: LastermTheme;
	baseTheme?: LastermTheme;
}>();

const emit = defineEmits<{
	saved: [theme: LastermTheme];
	close: [];
}>();

const themeStore = useThemeStore();
const authStore = useAuthStore();

const isNew = computed(() => props.theme === undefined);

// ── Draft state ─────────────────────────────────────────────────────

function getSourceTheme(): LastermTheme {
	const fallback = themeStore.availableThemes[0];
	if (fallback === undefined) {
		throw new Error("No themes available to base editor on");
	}
	return props.theme ?? props.baseTheme ?? fallback;
}

function cloneTheme(t: LastermTheme): {
	name: string;
	author: string;
	type: "dark" | "light";
	colors: LastermThemeColors;
	ui: LastermThemeUi;
} {
	return {
		name: t.name,
		author: t.author ?? "",
		type: t.type,
		colors: { ...t.colors },
		ui: { ...t.ui },
	};
}

const source = getSourceTheme();
const draft = reactive(cloneTheme(source));
const basedOnName = ref(source.name);
const originalTheme = themeStore.currentTheme ?? source;
const saving = ref(false);
const saveError = ref("");

// ── Name validation ─────────────────────────────────────────────────

const nameError = computed(() => {
	if (draft.name === "") return "Name is required";
	if (!THEME_NAME_REGEX.test(draft.name))
		return "Lowercase alphanumeric and hyphens only (a-z, 0-9, -)";
	return "";
});

// ── "Based on" change ───────────────────────────────────────────────

function handleBasedOnChange(event: Event) {
	const name = (event.target as HTMLSelectElement).value;
	const base = themeStore.availableThemes.find((t: LastermTheme) => t.name === name);
	if (!base) return;
	basedOnName.value = name;
	const cloned = cloneTheme(base);
	draft.colors = cloned.colors;
	draft.ui = cloned.ui;
	draft.type = cloned.type;
	if (isNew.value) {
		draft.name = `${name}-custom`;
	}
}

// ── Color field definitions ─────────────────────────────────────────

const terminalColorFields = [
	{ key: "foreground", label: "Foreground" },
	{ key: "background", label: "Background" },
	{ key: "cursor", label: "Cursor" },
	{ key: "cursorAccent", label: "Cursor Accent" },
	{ key: "selectionBackground", label: "Selection BG" },
	{ key: "selectionForeground", label: "Selection FG" },
	{ key: "black", label: "Black" },
	{ key: "red", label: "Red" },
	{ key: "green", label: "Green" },
	{ key: "yellow", label: "Yellow" },
	{ key: "blue", label: "Blue" },
	{ key: "magenta", label: "Magenta" },
	{ key: "cyan", label: "Cyan" },
	{ key: "white", label: "White" },
	{ key: "brightBlack", label: "Bright Black" },
	{ key: "brightRed", label: "Bright Red" },
	{ key: "brightGreen", label: "Bright Green" },
	{ key: "brightYellow", label: "Bright Yellow" },
	{ key: "brightBlue", label: "Bright Blue" },
	{ key: "brightMagenta", label: "Bright Magenta" },
	{ key: "brightCyan", label: "Bright Cyan" },
	{ key: "brightWhite", label: "Bright White" },
] as const;

const uiColorFields = [
	{ key: "tabBar", label: "Tab Bar" },
	{ key: "tabActive", label: "Tab Active" },
	{ key: "tabInactive", label: "Tab Inactive" },
	{ key: "tabHover", label: "Tab Hover" },
	{ key: "sidebar", label: "Sidebar" },
	{ key: "sidebarText", label: "Sidebar Text" },
	{ key: "sidebarActive", label: "Sidebar Active" },
	{ key: "hostRail", label: "Host Rail" },
	{ key: "border", label: "Border" },
	{ key: "accent", label: "Accent" },
	{ key: "badge", label: "Badge" },
	{ key: "scrollbarThumb", label: "Scrollbar Thumb" },
	{ key: "scrollbarTrack", label: "Scrollbar Track" },
	{ key: "searchHighlight", label: "Search Highlight" },
	{ key: "searchHighlightActive", label: "Search Active" },
	{ key: "badgeInfo", label: "Badge Info" },
	{ key: "badgeWarning", label: "Badge Warning" },
	{ key: "badgeSuccess", label: "Badge Success" },
	{ key: "badgeDanger", label: "Badge Danger" },
] as const;

// ── Color getters/setters ───────────────────────────────────────────

function getColorValue(key: string): string {
	const colors = draft.colors as Record<string, string | undefined>;
	return colors[key] ?? "#000000";
}

function setColorValue(key: string, value: string) {
	const colors = draft.colors as Record<string, string | undefined>;
	colors[key] = value;
}

function getUiValue(key: string): string {
	const ui = draft.ui as Record<string, string>;
	return ui[key] ?? "#000000";
}

function setUiValue(key: string, value: string) {
	const ui = draft.ui as Record<string, string>;
	ui[key] = value;
}

// ── Live preview ────────────────────────────────────────────────────

function buildThemeFromDraft(): LastermTheme {
	return {
		name: draft.name,
		...(draft.author !== "" && { author: draft.author }),
		type: draft.type,
		colors: { ...draft.colors },
		ui: { ...draft.ui },
	};
}

let previewRaf: number | null = null;
watch(
	() => ({ ...draft.colors, ...draft.ui, type: draft.type }),
	() => {
		if (previewRaf !== null) cancelAnimationFrame(previewRaf);
		previewRaf = requestAnimationFrame(() => {
			themeStore.applyTheme(buildThemeFromDraft());
			previewRaf = null;
		});
	},
	{ deep: true },
);

// ── Cancel: restore original theme ──────────────────────────────────

function handleCancel() {
	if (originalTheme) {
		themeStore.applyTheme(originalTheme);
	}
	emit("close");
}

// Restore theme on unmount if not saved
onUnmounted(() => {
	if (originalTheme) {
		themeStore.applyTheme(originalTheme);
	}
});

// ── Export ───────────────────────────────────────────────────────────

function handleExport() {
	const theme = buildThemeFromDraft();
	const json = JSON.stringify(theme, null, 2);
	const blob = new Blob([json], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `${theme.name || "theme"}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

// ── Save ────────────────────────────────────────────────────────────

async function handleSave() {
	if (nameError.value) return;
	saving.value = true;
	saveError.value = "";

	const theme = buildThemeFromDraft();

	try {
		const method = isNew.value ? "POST" : "PUT";
		const url = isNew.value
			? `${hubBaseUrl()}/api/themes`
			: `${hubBaseUrl()}/api/themes/${encodeURIComponent(theme.name)}`;

		const response = await hubFetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authStore.token ?? ""}`,
			},
			body: JSON.stringify(theme),
		});

		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			saveError.value = body?.message ?? `Save failed (${response.status})`;
			return;
		}

		// Reload themes so the new/updated theme appears in the picker
		await themeStore.loadThemes();
		// Set as current theme
		await themeStore.setTheme(theme);
		emit("saved", theme);
	} catch (err) {
		saveError.value = err instanceof Error ? err.message : "Network error";
	} finally {
		saving.value = false;
	}
}
</script>

<style scoped>
.theme-editor {
	display: flex;
	flex-direction: column;
	height: 100%;
}

.theme-editor-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding-bottom: 12px;
	border-bottom: 1px solid var(--nt-border);
	margin-bottom: 16px;
}

.theme-editor-title {
	margin: 0;
	font-size: 14px;
	font-weight: 700;
	color: var(--nt-fg);
}

.theme-editor-close {
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 14px;
	cursor: pointer;
	padding: 4px;
	line-height: 1;
	border-radius: 4px;
}

.theme-editor-close:hover {
	color: var(--nt-fg);
	background: var(--nt-hover);
}

.theme-editor-body {
	flex: 1;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding-bottom: 16px;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-scrollbar-thumb) var(--nt-scrollbar-track);
}

.theme-editor-body::-webkit-scrollbar {
	width: 6px;
}

.theme-editor-body::-webkit-scrollbar-track {
	background: var(--nt-scrollbar-track);
}

.theme-editor-body::-webkit-scrollbar-thumb {
	background: var(--nt-scrollbar-thumb);
	border-radius: 3px;
}

.theme-editor-field {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.theme-editor-label {
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--nt-text-secondary);
}

.theme-editor-input {
	padding: 6px 10px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	font-size: 13px;
	font-family: inherit;
	outline: none;
	caret-color: var(--nt-accent);
}

.theme-editor-input:focus {
	border-color: var(--nt-accent);
}

.theme-editor-input--error {
	border-color: var(--nt-danger);
}

.theme-editor-error {
	font-size: 11px;
	color: var(--nt-danger);
}

.theme-editor-select {
	padding: 6px 10px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	font-size: 13px;
	font-family: inherit;
	outline: none;
	cursor: pointer;
}

.theme-editor-select:focus {
	border-color: var(--nt-accent);
}

.theme-editor-toggle {
	display: flex;
	gap: 0;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	overflow: hidden;
	width: fit-content;
}

.theme-editor-toggle-btn {
	padding: 5px 16px;
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
}

.theme-editor-toggle-btn--active {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.theme-editor-section {
	margin-top: 4px;
}

.theme-editor-section-label {
	margin: 0 0 10px 0;
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--nt-text-secondary);
}

.theme-editor-colors {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px 16px;
}

.theme-editor-color {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
}

.theme-editor-color-label {
	font-size: 12px;
	color: var(--nt-fg);
	white-space: nowrap;
	flex-shrink: 0;
	min-width: 80px;
}

.theme-editor-color-controls {
	display: flex;
	align-items: center;
	gap: 4px;
}

.theme-editor-color-picker {
	width: 24px;
	height: 24px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	padding: 0;
	cursor: pointer;
	background: transparent;
	flex-shrink: 0;
}

.theme-editor-color-picker::-webkit-color-swatch-wrapper {
	padding: 2px;
}

.theme-editor-color-picker::-webkit-color-swatch {
	border: none;
	border-radius: 2px;
}

.theme-editor-color-hex {
	width: 76px;
	padding: 3px 6px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 3px;
	color: var(--nt-fg);
	font-size: 11px;
	font-family: monospace;
	outline: none;
	text-transform: uppercase;
}

.theme-editor-color-hex:focus {
	border-color: var(--nt-accent);
}

.theme-editor-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding-top: 12px;
	border-top: 1px solid var(--nt-border);
	flex-shrink: 0;
}

.theme-editor-btn {
	padding: 6px 16px;
	border-radius: 4px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	cursor: pointer;
	border: 1px solid var(--nt-border);
}

.theme-editor-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

.theme-editor-btn--secondary {
	background: transparent;
	color: var(--nt-fg);
}

.theme-editor-btn--secondary:hover:not(:disabled) {
	background: var(--nt-hover);
}

.theme-editor-btn--primary {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
	border-color: var(--nt-accent);
}

.theme-editor-btn--primary:hover:not(:disabled) {
	filter: brightness(1.1);
}

.theme-editor-save-error {
	margin-top: 8px;
	padding: 6px 10px;
	background: rgba(var(--nt-danger-rgb, 224, 108, 117), 0.08);
	border: 1px solid var(--nt-danger);
	border-radius: 4px;
	color: var(--nt-danger);
	font-size: 12px;
	text-align: center;
}
</style>
