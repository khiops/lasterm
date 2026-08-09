<template>
	<div class="settings-category">
		<!-- Scope override banner (host/channel only) -->
		<div v-if="hasWallpaperOverride && scope !== 'global'" class="scope-override-banner">
			<span>This scope has background overrides.</span>
			<button class="scope-override-reset" type="button" @click="resetWallpaperOverride">
				Reset to inherited
			</button>
		</div>

		<!-- Wallpaper picker section -->
		<section class="settings-section">
			<h3 class="section-title">Wallpaper</h3>

			<SettingRow
				label="Mode"
				description="Choose whether this scope uses an image, a solid background, or desktop transparency."
				:scope="scope"
				:is-overridden="settingsStore.isOverridden(scope, 'terminal', 'backgroundMode')"
				:inherited-from="settingsStore.inheritedFrom(scope, 'terminal', 'backgroundMode')"
				@reset="settingsStore.resetSetting(scope, 'terminal', 'backgroundMode')"
			>
				<SettingControl
					type="select"
					:model-value="currentBackgroundMode"
					:options="backgroundModeOptions"
					@update:model-value="updateBackgroundMode"
				/>
			</SettingRow>

			<div
				class="wallpaper-grid"
				@dragenter="onDragEnter"
				@dragover="onDragOver"
				@dragleave="onDragLeave"
				@drop="onDrop"
			>
				<!-- Drag overlay -->
				<div v-if="isDragging" class="wallpaper-drop-overlay">
					<div class="wallpaper-drop-hint">Drop image to add</div>
				</div>

				<!-- Wallpaper thumbnails -->
				<div
					v-for="wp in wallpapers"
					:key="wp"
					class="wallpaper-thumb-wrapper"
				>
					<button
						class="wallpaper-thumb"
						:class="{ active: currentWallpaper === wp }"
						type="button"
						@click="selectWallpaper(wp)"
						>
						<img
							:src="wallpaperThumbnailSrc(wp)"
							:alt="wp"
							loading="lazy"
						/>
					</button>
					<button
						class="wallpaper-delete"
						type="button"
						title="Delete wallpaper"
						@click="deleteWallpaper(wp)"
					>
						&times;
					</button>
				</div>
			</div>

			<!-- Upload -->
			<input
				ref="fileInput"
				type="file"
				accept="image/*"
				style="display: none"
				@change="handleUpload"
			/>
			<button class="wallpaper-upload-btn" type="button" @click="triggerUpload">
				Upload wallpaper
			</button>
			<div v-if="uploadError" class="wallpaper-upload-error">
				{{ uploadError }}
				<button type="button" @click="uploadError = ''">&times;</button>
			</div>
		</section>

		<!-- Blur / Dim sliders -->
		<section class="settings-section">
			<h3 class="section-title">Effects</h3>

			<SettingRow
				v-if="showWindowEffectPicker"
				label="Window effect"
				:description="windowEffectDescription"
				:scope="scope"
				:is-overridden="settingsStore.isOverridden(scope, 'terminal', 'windowEffect')"
				:inherited-from="settingsStore.inheritedFrom(scope, 'terminal', 'windowEffect')"
				@reset="settingsStore.resetSetting(scope, 'terminal', 'windowEffect')"
			>
				<SettingControl
					type="select"
					:model-value="currentWindowEffect"
					:options="windowEffectOptions"
					@update:model-value="updateWindowEffect"
				/>
			</SettingRow>

			<SettingRow
				label="Blur"
				description="Background blur in pixels (0 = sharp)"
				:scope="scope"
				:is-overridden="settingsStore.isOverridden(scope, 'terminal', 'wallpaperBlur')"
				:inherited-from="settingsStore.inheritedFrom(scope, 'terminal', 'wallpaperBlur')"
				@reset="settingsStore.resetSetting(scope, 'terminal', 'wallpaperBlur')"
			>
				<SettingControl
					type="range"
					:model-value="currentBlur"
					:min="0"
					:max="20"
					:step="1"
					@update:model-value="updateBlur"
				/>
			</SettingRow>

			<SettingRow
				label="Dim"
				description="Background dimming percentage (0 = no dimming)"
				:scope="scope"
				:is-overridden="settingsStore.isOverridden(scope, 'terminal', 'wallpaperDim')"
				:inherited-from="settingsStore.inheritedFrom(scope, 'terminal', 'wallpaperDim')"
				@reset="settingsStore.resetSetting(scope, 'terminal', 'wallpaperDim')"
			>
				<SettingControl
					type="range"
					:model-value="currentDim"
					:min="0"
					:max="100"
					:step="5"
					@update:model-value="updateDim"
				/>
			</SettingRow>
		</section>
	</div>
</template>

<script setup lang="ts">
import type { BackgroundMode, WindowEffect } from "@lasterm/shared";
import { computed, onMounted, ref } from "vue";
import { useFileDrop } from "../../../composables/useFileDrop.js";
import {
	isTauriRuntime,
	usePlatformInfo,
} from "../../../composables/useWindowEffects.js";
import { assetTokenReady, hubBaseUrl, namedPublicAssetUrl } from "../../../utils/hub-url.js";
import { hubFetch } from "../../../utils/hub-fetch.js";
import { useAuthStore } from "../../../stores/auth.js";
import { useSettingsStore } from "../../../stores/settings.js";
import type { Scope } from "../../../stores/settings.js";
import SettingRow from "../SettingRow.vue";
import SettingControl from "../SettingControl.vue";
import {
	uploadWallpaperFiles,
	WALLPAPER_ACCEPTED_EXTENSIONS,
} from "./wallpaperUpload.js";
import {
	backgroundModeOptions as getBackgroundModeOptions,
	normalizeSettingsBackgroundMode,
	normalizeSettingsWindowEffect,
	shouldShowWindowEffectPicker,
	WALLPAPER_OVERRIDE_KEYS,
	windowEffectDescription as getWindowEffectDescription,
	windowEffectSettingsOptions,
} from "./wallpaperSettings.js";

const props = defineProps<{
	scope: Scope;
}>();

const settingsStore = useSettingsStore();
const authStore = useAuthStore();

const wallpapers = ref<string[]>([]);
const uploadError = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const platformInfo = usePlatformInfo();
const runsInTauri = computed(() => isTauriRuntime());

/**
 * Builds a signed thumbnail src for a wallpaper filename.
 * Reads `assetTokenReady` so Vue re-renders thumbnails when the asset token
 * arrives (pairing path: token is null at first render, set after pairing).
 */
function wallpaperThumbnailSrc(filename: string): string {
	// Establish reactive dependency on the token — forces re-render when it flips.
	void assetTokenReady.value;
	return namedPublicAssetUrl("wallpapers", filename);
}

// ─── Computed ──────────────────────────────────────────────────────────

const currentBackgroundMode = computed<BackgroundMode>(() => {
	const value = settingsStore.getValue(props.scope, "terminal", "backgroundMode");
	return normalizeSettingsBackgroundMode(value);
});

const currentWallpaper = computed(() => {
	return (settingsStore.getValue(props.scope, "terminal", "wallpaper") as string) ?? "";
});

const currentBlur = computed(() => {
	return (settingsStore.getValue(props.scope, "terminal", "wallpaperBlur") as number) ?? 0;
});

const currentDim = computed(() => {
	return (settingsStore.getValue(props.scope, "terminal", "wallpaperDim") as number) ?? 0;
});

const currentWindowEffect = computed<WindowEffect>(() => {
	const value = settingsStore.getValue(props.scope, "terminal", "windowEffect");
	return normalizeSettingsWindowEffect(value);
});

const backgroundModeOptions = computed(() => getBackgroundModeOptions(runsInTauri.value));

const windowEffectOptions = computed(() => windowEffectSettingsOptions(platformInfo.value));

const showWindowEffectPicker = computed(
	() => shouldShowWindowEffectPicker(runsInTauri.value, platformInfo.value),
);

const windowEffectDescription = computed(() => getWindowEffectDescription(platformInfo.value));

const hasWallpaperOverride = computed(() => {
	if (props.scope === "global") return false;
	return WALLPAPER_OVERRIDE_KEYS.some((key) =>
		settingsStore.isOverridden(props.scope, "terminal", key),
	);
});

// ─── Methods ───────────────────────────────────────────────────────────

async function loadWallpapers(): Promise<void> {
	try {
		const resp = await hubFetch(`${hubBaseUrl()}/api/wallpapers`, {
			headers: { Authorization: `Bearer ${authStore.token ?? ""}` },
		});
		if (resp.ok) {
			const data = await resp.json();
			wallpapers.value = data.wallpapers;
		}
	} catch {
		// Silent fail — empty grid
	}
}

async function selectWallpaper(filename: string): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "wallpaper", filename);
}

async function clearWallpaper(): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "wallpaper", "");
}

async function updateBackgroundMode(value: unknown): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "backgroundMode", value as BackgroundMode);
}

async function updateWindowEffect(value: unknown): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "windowEffect", value as WindowEffect);
}

function triggerUpload(): void {
	uploadError.value = "";
	fileInput.value?.click();
}

async function handleUpload(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const files = Array.from(input.files ?? []);
	input.value = "";
	await uploadFiles(files);
}

async function uploadFiles(files: File[]): Promise<void> {
	await uploadWallpaperFiles(files, {
		token: authStore.token,
		loadWallpapers,
		selectWallpaper,
		setUploadError(message) {
			uploadError.value = message;
		},
	});
}

const { isDragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop(
	uploadFiles,
	WALLPAPER_ACCEPTED_EXTENSIONS,
);

async function deleteWallpaper(filename: string): Promise<void> {
	try {
		await hubFetch(`${hubBaseUrl()}/api/wallpapers/${encodeURIComponent(filename)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${authStore.token ?? ""}` },
		});
		await loadWallpapers();
		// If the deleted wallpaper was selected, clear it
		if (currentWallpaper.value === filename) {
			await clearWallpaper();
		}
	} catch {
		// Silent fail
	}
}

async function updateBlur(value: unknown): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "wallpaperBlur", value as number);
}

async function updateDim(value: unknown): Promise<void> {
	await settingsStore.updateSetting(props.scope, "terminal", "wallpaperDim", value as number);
}

async function resetWallpaperOverride(): Promise<void> {
	for (const key of WALLPAPER_OVERRIDE_KEYS) {
		await settingsStore.resetSetting(props.scope, "terminal", key);
	}
}

onMounted(loadWallpapers);
</script>

<style scoped>
.settings-category {
	padding: 0 16px 24px;
}

.scope-override-banner {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 8px 12px;
	margin-bottom: 12px;
	border: 1px solid var(--nt-accent);
	border-radius: 6px;
	background: rgba(var(--nt-accent-rgb, 100, 100, 255), 0.1);
	font-size: 13px;
}

.scope-override-reset {
	padding: 4px 10px;
	background: transparent;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-text);
	cursor: pointer;
	font-size: 12px;
	white-space: nowrap;
}

.scope-override-reset:hover {
	background: var(--nt-hover);
	border-color: var(--nt-accent);
	color: var(--nt-accent);
}

.settings-section {
	margin-top: 24px;
	padding-top: 16px;
	border-top: 1px solid var(--nt-border);
}

.settings-section:first-child {
	margin-top: 0;
	padding-top: 0;
	border-top: none;
}

.section-title {
	margin: 0 0 12px;
	font-size: 13px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--nt-text-muted);
}

.wallpaper-grid {
	position: relative;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
	gap: 8px;
	margin-bottom: 12px;
}

.wallpaper-drop-overlay {
	position: absolute;
	inset: 0;
	background: rgba(var(--nt-accent-rgb, 99, 102, 241), 0.12);
	border: 2px dashed var(--nt-accent);
	border-radius: 8px;
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10;
	pointer-events: none;
}

.wallpaper-drop-hint {
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-accent);
}

.wallpaper-thumb-wrapper {
	position: relative;
}

.wallpaper-thumb {
	width: 100%;
	aspect-ratio: 16 / 9;
	border: 2px solid var(--nt-border);
	border-radius: 6px;
	overflow: hidden;
	cursor: pointer;
	background: var(--nt-bg);
	padding: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: border-color 0.15s;
}

.wallpaper-thumb:hover {
	border-color: var(--nt-text-muted);
}

.wallpaper-thumb.active {
	border-color: var(--nt-accent);
	box-shadow: 0 0 0 1px var(--nt-accent);
}

.wallpaper-thumb img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.wallpaper-delete {
	position: absolute;
	top: 4px;
	right: 4px;
	width: 20px;
	height: 20px;
	padding: 0;
	background: var(--nt-overlay-heavy);
	color: var(--nt-bright-white);
	border: none;
	border-radius: 50%;
	cursor: pointer;
	font-size: 14px;
	line-height: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	opacity: 0;
	transition: opacity 0.15s;
}

.wallpaper-thumb-wrapper:hover .wallpaper-delete {
	opacity: 1;
}

.wallpaper-upload-btn {
	padding: 6px 14px;
	background: transparent;
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-text);
	cursor: pointer;
	font-size: 13px;
}

.wallpaper-upload-btn:hover {
	background: var(--nt-hover);
	border-color: var(--nt-accent);
	color: var(--nt-accent);
}

.wallpaper-upload-error {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 8px;
	padding: 6px 10px;
	background: rgba(var(--nt-danger-rgb, 255, 80, 80), 0.1);
	border: 1px solid rgba(var(--nt-danger-rgb, 255, 80, 80), 0.3);
	border-radius: 4px;
	font-size: 12px;
	color: var(--nt-danger);
}

.wallpaper-upload-error button {
	background: none;
	border: none;
	color: inherit;
	cursor: pointer;
	padding: 0 2px;
	font-size: 14px;
}
</style>
