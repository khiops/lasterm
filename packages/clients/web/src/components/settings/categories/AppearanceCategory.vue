<template>
	<div class="appearance-category">
		<!-- Theme Picker / Editor -->
		<ThemeEditor
			v-if="editorMode === 'editor'"
			v-bind="editorProps"
			@saved="handleEditorSaved"
			@close="editorMode = 'picker'"
		/>
		<template v-else>
			<!-- Scope override banner (host/channel only) -->
			<div v-if="hasScopeOverride" class="scope-override-banner">
				<span class="scope-override-text">
					Theme overridden at {{ scope }} level
				</span>
				<button
					class="scope-override-reset"
					type="button"
					@click="resetThemeOverride"
				>
					Reset to inherited
				</button>
			</div>

			<ThemePicker
				v-bind="activeThemeForScope !== undefined ? { activeThemeName: activeThemeForScope } : {}"
				@create-theme="openNewTheme"
				@edit-theme="openEditTheme"
				@select="onThemeSelect"
			/>

			<!-- Auto-Switch (global scope only) -->
			<section v-if="scope === 'global'" class="settings-section">
				<h3 class="section-title">Auto-Switch</h3>
				<SettingRow
					label="Follow OS dark mode"
					:scope="scope"
					:is-overridden="true"
				>
					<SettingControl
						type="toggle"
						:model-value="autoSwitch.enabled.value"
						@update:model-value="onAutoSwitchToggle"
					/>
				</SettingRow>
				<template v-if="autoSwitch.enabled.value">
					<SettingRow
						label="Dark theme"
						:scope="scope"
						:is-overridden="true"
					>
						<SettingControl
							type="select"
							:model-value="autoSwitch.darkThemeName.value"
							:options="darkThemeOptions"
							@update:model-value="onAutoSwitchDarkChange"
						/>
					</SettingRow>
					<SettingRow
						label="Light theme"
						:scope="scope"
						:is-overridden="true"
					>
						<SettingControl
							type="select"
							:model-value="autoSwitch.lightThemeName.value"
							:options="lightThemeOptions"
							@update:model-value="onAutoSwitchLightChange"
						/>
					</SettingRow>
				</template>
			</section>

			<!-- Opacity (global scope only) -->
			<section v-if="scope === 'global'" class="settings-section">
				<h3 class="section-title">Opacity</h3>
				<SettingRow
					v-for="(label, key) in opacityLabels"
					:key="key"
					:label="label"
					:scope="scope"
					:is-overridden="true"
				>
					<SettingControl
						type="range"
						:model-value="opacity[key]"
						:min="20"
						:max="100"
						:step="1"
						@update:model-value="(v: unknown) => onOpacityInput(key, v as number)"
					/>
				</SettingRow>
			</section>

			<!-- Scrollbar (global scope only) -->
			<section v-if="scope === 'global'" class="settings-section">
				<h3 class="section-title">Scrollbar</h3>
				<SettingRow
					label="Style"
					:scope="scope"
					:is-overridden="true"
				>
					<SettingControl
						type="select"
						:model-value="scrollbarStyle"
						:options="scrollbarOptions"
						@update:model-value="onScrollbarChange"
					/>
				</SettingRow>
			</section>
		</template>
	</div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch } from "vue";
import type { AppearanceConfig, LastermTheme } from "@lasterm/shared";
import ThemePicker from "../ThemePicker.vue";
import ThemeEditor from "../ThemeEditor.vue";
import SettingRow from "../SettingRow.vue";
import SettingControl from "../SettingControl.vue";
import { useAutoSwitch } from "../../../composables/useAutoSwitch.js";
import { useThemeStore } from "../../../stores/theme.js";
import { useSettingsStore } from "../../../stores/settings.js";
import type { Scope } from "../../../stores/settings.js";

const props = defineProps<{
	scope: Scope;
}>();

const themeStore = useThemeStore();
const settingsStore = useSettingsStore();
const autoSwitch = useAutoSwitch();

// ── Editor state ──────────────────────────────────────────────────────

const editorMode = ref<"picker" | "editor">("picker");
const editingTheme = ref<LastermTheme | undefined>(undefined);
const baseTheme = ref<LastermTheme | undefined>(undefined);

/** Build props conditionally to satisfy exactOptionalPropertyTypes. */
const editorProps = computed(() => {
	const p: Record<string, LastermTheme> = {};
	if (editingTheme.value !== undefined) {
		p.theme = editingTheme.value;
	}
	if (baseTheme.value !== undefined) {
		p.baseTheme = baseTheme.value;
	}
	return p;
});

function openNewTheme() {
	editingTheme.value = undefined;
	baseTheme.value = undefined;
	editorMode.value = "editor";
}

function openEditTheme(theme: LastermTheme) {
	editingTheme.value = theme;
	baseTheme.value = undefined;
	editorMode.value = "editor";
}

function handleEditorSaved(_theme: LastermTheme) {
	editorMode.value = "picker";
	editingTheme.value = undefined;
	baseTheme.value = undefined;
}

// ── Scope override detection ──────────────────────────────────────────

const hasScopeOverride = computed(() => {
	if (props.scope === "global") return false;
	return settingsStore.isOverridden(props.scope, "terminal", "theme");
});

async function resetThemeOverride(): Promise<void> {
	await settingsStore.resetSetting(props.scope, "terminal", "theme");
	// Apply the inherited theme following the cascade: channel → host → global
	if (props.scope === "channel") {
		const hostThemeName = settingsStore.getValue("host", "terminal", "theme") as string | undefined;
		if (hostThemeName) {
			const hostTheme = themeStore.availableThemes.find((t) => t.name === hostThemeName);
			if (hostTheme) {
				themeStore.setScopeOverride(hostTheme);
				themeStore.applyTheme(hostTheme);
				return;
			}
		}
	}
	// Host scope reset, or no host override — fall back to global
	themeStore.setScopeOverride(null);
	if (themeStore.currentTheme !== null) {
		themeStore.applyTheme(themeStore.currentTheme);
	}
}

// ── Active theme for current scope ────────────────────────────────────

const activeThemeForScope = computed(() => {
	if (props.scope === "global") {
		return themeStore.currentTheme?.name;
	}
	// Show THIS scope's own value if set
	const ownValue = settingsStore.getValue(props.scope, "terminal", "theme") as string | undefined;
	if (ownValue) return ownValue;
	// Otherwise show inherited: channel inherits from host, then global
	if (props.scope === "channel") {
		const hostValue = settingsStore.getValue("host", "terminal", "theme") as string | undefined;
		if (hostValue) return hostValue;
	}
	return themeStore.currentTheme?.name;
});

// ── Theme selection (scope-aware) ──────────────────────────────────────

async function onThemeSelect(theme: LastermTheme): Promise<void> {
	// Always apply immediately for visual feedback
	themeStore.applyTheme(theme);

	if (props.scope === "global") {
		themeStore.setScopeOverride(null);
		await themeStore.setTheme(theme);
	} else if (props.scope === "host" || props.scope === "channel") {
		themeStore.setScopeOverride(theme);
		await settingsStore.updateSetting(props.scope, "terminal", "theme", theme.name);
	}
}

// ── Auto-switch ───────────────────────────────────────────────────────

const darkThemeOptions = computed(() =>
	themeStore.availableThemes
		.filter((t) => t.type === "dark")
		.map((t) => ({ label: t.name, value: t.name })),
);

const lightThemeOptions = computed(() =>
	themeStore.availableThemes
		.filter((t) => t.type === "light")
		.map((t) => ({ label: t.name, value: t.name })),
);

// Sync auto-switch state from appearance config
// Set theme names BEFORE enabled — the enabled watcher is flush:sync
// and calls start() immediately, which reads darkThemeName/lightThemeName.
watch(
	() => themeStore.appearance,
	(cfg) => {
		autoSwitch.darkThemeName.value = cfg.autoSwitch.darkTheme;
		autoSwitch.lightThemeName.value = cfg.autoSwitch.lightTheme;
		autoSwitch.enabled.value = cfg.autoSwitch.enabled;
	},
	{ immediate: true },
);

function onAutoSwitchToggle(value: unknown) {
	const checked = Boolean(value);
	autoSwitch.enabled.value = checked;
	themeStore.updateAppearance({
		autoSwitch: {
			enabled: checked,
			darkTheme: autoSwitch.darkThemeName.value,
			lightTheme: autoSwitch.lightThemeName.value,
		},
	});
}

function onAutoSwitchDarkChange(value: unknown) {
	const name = String(value);
	autoSwitch.darkThemeName.value = name;
	autoSwitch.applyCurrentPreference();
	themeStore.updateAppearance({
		autoSwitch: {
			enabled: autoSwitch.enabled.value,
			darkTheme: name,
			lightTheme: autoSwitch.lightThemeName.value,
		},
	});
}

function onAutoSwitchLightChange(value: unknown) {
	const name = String(value);
	autoSwitch.lightThemeName.value = name;
	autoSwitch.applyCurrentPreference();
	themeStore.updateAppearance({
		autoSwitch: {
			enabled: autoSwitch.enabled.value,
			darkTheme: autoSwitch.darkThemeName.value,
			lightTheme: name,
		},
	});
}

// ── Opacity ───────────────────────────────────────────────────────────

const opacityLabels: Record<keyof AppearanceConfig["opacity"], string> = {
	terminal: "Terminal",
	sidebar: "Sidebar",
	hostRail: "Host rail",
	tabBar: "Tab bar",
};

const opacity = reactive({
	terminal: 100,
	sidebar: 100,
	hostRail: 100,
	tabBar: 100,
});

// Sync from appearance config
watch(
	() => themeStore.appearance.opacity,
	(val) => {
		opacity.terminal = val.terminal;
		opacity.sidebar = val.sidebar;
		opacity.hostRail = val.hostRail;
		opacity.tabBar = val.tabBar;
	},
	{ immediate: true },
);

let opacityDebounce: ReturnType<typeof setTimeout> | null = null;
let opacityRaf: number | null = null;

function onOpacityInput(
	key: keyof AppearanceConfig["opacity"],
	value: number,
) {
	opacity[key] = value;

	// Apply immediately for visual feedback (coalesced via rAF)
	if (opacityRaf !== null) cancelAnimationFrame(opacityRaf);
	opacityRaf = requestAnimationFrame(() => {
		themeStore.applyOpacity({ ...opacity });
		opacityRaf = null;
	});

	// Debounce the API persist
	if (opacityDebounce !== null) clearTimeout(opacityDebounce);
	opacityDebounce = setTimeout(() => {
		themeStore.updateAppearance({ opacity: { ...opacity } });
		opacityDebounce = null;
	}, 500);
}

// ── Scrollbar ─────────────────────────────────────────────────────────

const scrollbarOptions = [
	{ label: "Thin (6px)", value: "thin" },
	{ label: "Wide (14px)", value: "wide" },
	{ label: "Hidden", value: "hidden" },
];

const scrollbarStyle = ref<AppearanceConfig["scrollbar"]["style"]>("thin");

watch(
	() => themeStore.appearance.scrollbar,
	(val) => {
		scrollbarStyle.value = val.style;
	},
	{ immediate: true },
);

function onScrollbarChange(value: unknown) {
	const style = String(value) as AppearanceConfig["scrollbar"]["style"];
	scrollbarStyle.value = style;
	themeStore.updateAppearance({
		scrollbar: {
			...themeStore.appearance.scrollbar,
			style,
		},
	});
}
</script>

<style scoped>
.appearance-category {
	display: flex;
	flex-direction: column;
}

.settings-section {
	margin-top: 24px;
	padding-top: 16px;
	border-top: 1px solid var(--nt-border);
}

.section-title {
	margin: 0 0 12px 0;
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.scope-override-banner {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 8px 12px;
	margin-bottom: 12px;
	background: rgba(var(--nt-accent-rgb), 0.1);
	border: 1px solid rgba(var(--nt-accent-rgb), 0.3);
	border-radius: 6px;
}

.scope-override-text {
	font-size: 12px;
	color: var(--nt-fg);
}

.scope-override-reset {
	padding: 4px 10px;
	background: transparent;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-fg);
	font-size: 11px;
	font-family: inherit;
	font-weight: 600;
	cursor: pointer;
	white-space: nowrap;
}

.scope-override-reset:hover {
	background: var(--nt-hover);
	border-color: var(--nt-accent);
	color: var(--nt-accent);
}
</style>
