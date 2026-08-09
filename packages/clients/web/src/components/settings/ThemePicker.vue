<template>
	<div class="theme-picker">
		<div class="theme-picker-toolbar">
			<div class="theme-picker-search">
				<input
					v-model="searchQuery"
					class="theme-picker-input"
					type="text"
					placeholder="Search themes..."
					autocomplete="off"
					spellcheck="false"
				/>
			</div>
			<div class="theme-picker-actions">
				<button
					class="theme-picker-btn"
					type="button"
					title="Create new theme"
					@click="$emit('create-theme')"
				>
					+ New
				</button>
				<button
					class="theme-picker-btn"
					type="button"
					title="Import theme from JSON file"
					@click="triggerImport"
				>
					Import
				</button>
			</div>
		</div>

		<!-- Hidden file input for import -->
		<input
			ref="fileInput"
			type="file"
			accept=".json"
			style="display: none"
			@change="handleImport"
		/>

		<!-- Import error -->
		<div v-if="importError" class="theme-picker-import-error">
			{{ importError }}
			<button
				class="theme-picker-import-error-close"
				type="button"
				@click="importError = ''"
			>
				&#10005;
			</button>
		</div>

		<div class="theme-picker-sections">
			<template v-for="section in sections" :key="section.label">
				<div v-if="section.themes.length > 0" class="theme-picker-section">
					<h3 class="theme-picker-section-label">{{ section.label }}</h3>
					<div class="theme-picker-grid">
						<ThemeCard
							v-for="theme in section.themes"
							:key="theme.name"
							:theme="theme"
							:is-active="(props.activeThemeName ?? themeStore.currentTheme?.name) === theme.name"
							:is-custom="!BUNDLED_THEME_NAMES.has(theme.name)"
							@preview="themeStore.previewHover($event)"
							@preview-clear="themeStore.clearPreview()"
							@select="$emit('select', $event)"
							@edit="$emit('edit-theme', $event)"
						/>
					</div>
				</div>
			</template>

			<div v-if="filteredThemes.length === 0" class="theme-picker-empty">
				No themes match "{{ searchQuery }}"
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import type { LastermTheme } from "@lasterm/shared";
import { BUNDLED_THEME_NAMES, validateTheme } from "@lasterm/shared";
import { hubBaseUrl } from "../../utils/hub-url.js";
import { hubFetch } from "../../utils/hub-fetch.js";
import { useThemeStore } from "../../stores/theme.js";
import { useAuthStore } from "../../stores/auth.js";
import ThemeCard from "./ThemeCard.vue";

const props = defineProps<{
	activeThemeName?: string;
}>();

defineEmits<{
	"create-theme": [];
	"edit-theme": [theme: LastermTheme];
	"select": [theme: LastermTheme];
}>();

const themeStore = useThemeStore();
const authStore = useAuthStore();
const searchQuery = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const importError = ref("");

function triggerImport() {
	importError.value = "";
	fileInput.value?.click();
}

async function handleImport(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;

	try {
		const text = await file.text();
		const parsed: unknown = JSON.parse(text);
		const result = validateTheme(parsed);

		if (!result.valid) {
			importError.value = `Invalid theme: ${result.errors.join("; ")}`;
			input.value = "";
			return;
		}

		const response = await hubFetch(`${hubBaseUrl()}/api/themes`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${authStore.token ?? ""}`,
			},
			body: text,
		});

		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			importError.value = body?.message ?? `Import failed (${response.status})`;
			input.value = "";
			return;
		}

		importError.value = "";
		await themeStore.loadThemes();
	} catch {
		importError.value = "Failed to read or parse the JSON file";
	}

	input.value = "";
}

const filteredThemes = computed(() => {
	const query = searchQuery.value.toLowerCase().trim();
	if (query === "") return themeStore.availableThemes;
	return themeStore.availableThemes.filter((t: LastermTheme) =>
		t.name.toLowerCase().includes(query),
	);
});

const sections = computed(() => {
	const dark: LastermTheme[] = [];
	const light: LastermTheme[] = [];
	const custom: LastermTheme[] = [];

	for (const theme of filteredThemes.value) {
		if (!BUNDLED_THEME_NAMES.has(theme.name)) {
			custom.push(theme);
		} else if (theme.type === "dark") {
			dark.push(theme);
		} else {
			light.push(theme);
		}
	}

	return [
		{ label: "Dark Themes", themes: dark },
		{ label: "Light Themes", themes: light },
		{ label: "Custom Themes", themes: custom },
	];
});

onMounted(() => {
	void themeStore.loadThemes();
});
</script>

<style scoped>
.theme-picker {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.theme-picker-toolbar {
	display: flex;
	gap: 8px;
	align-items: center;
	padding: 0 4px;
}

.theme-picker-search {
	flex: 1;
}

.theme-picker-input {
	width: 100%;
	padding: 8px 12px;
	background: var(--nt-input-bg);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-fg);
	font-size: 13px;
	font-family: inherit;
	outline: none;
	caret-color: var(--nt-accent);
}

.theme-picker-input:focus {
	border-color: var(--nt-accent);
}

.theme-picker-input::placeholder {
	color: var(--nt-text-secondary);
}

.theme-picker-actions {
	display: flex;
	gap: 4px;
	flex-shrink: 0;
}

.theme-picker-btn {
	padding: 6px 12px;
	background: var(--nt-bg-surface);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-fg);
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	cursor: pointer;
	white-space: nowrap;
}

.theme-picker-btn:hover {
	background: var(--nt-hover);
	border-color: var(--nt-accent);
}

.theme-picker-import-error {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 12px;
	background: rgba(var(--nt-danger-rgb, 224, 108, 117), 0.08);
	border: 1px solid var(--nt-danger);
	border-radius: 6px;
	color: var(--nt-danger);
	font-size: 12px;
}

.theme-picker-import-error-close {
	margin-left: auto;
	background: transparent;
	border: none;
	color: inherit;
	cursor: pointer;
	font-size: 12px;
	padding: 0 2px;
	line-height: 1;
}

.theme-picker-sections {
	display: flex;
	flex-direction: column;
	gap: 20px;
}

.theme-picker-section-label {
	margin: 0 0 8px 4px;
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: var(--nt-text-secondary);
}

.theme-picker-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
	gap: 10px;
	justify-items: center;
}

.theme-picker-empty {
	padding: 24px 0;
	text-align: center;
	color: var(--nt-text-secondary);
	font-size: 13px;
	font-style: italic;
}
</style>
