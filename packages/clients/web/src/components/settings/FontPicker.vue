
<template>
	<Teleport to="body">
		<div v-if="show" class="dialog-overlay" @click.self="emit('close')">
			<div
				class="font-picker-dialog"
				@dragenter="onDragEnter"
				@dragover="onDragOver"
				@dragleave="onDragLeave"
				@drop="onDrop"
			>
				<!-- Drag overlay -->
				<div v-if="isDragging" class="font-picker-drop-overlay">
					<div class="font-picker-drop-hint">Drop font files to upload</div>
				</div>

				<!-- Header -->
				<div class="dialog-header">
					<span class="dialog-title">Font Picker</span>
					<button class="dialog-close" title="Close" @click="emit('close')">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						</svg>
					</button>
				</div>

				<!-- Error banner -->
				<div v-if="error" class="font-picker-error">{{ error }}</div>

				<div class="font-picker-tabs" role="tablist">
					<button
						type="button"
						role="tab"
						class="font-picker-tab"
						:class="{ active: tab === 'system' }"
						:aria-selected="tab === 'system'"
						@click="tab = 'system'"
					>
						System
					</button>
					<button
						type="button"
						role="tab"
						class="font-picker-tab"
						:class="{ active: tab === 'imported' }"
						:aria-selected="tab === 'imported'"
						@click="tab = 'imported'"
					>
						Imported
					</button>
				</div>

				<!-- Fonts installed where the hub runs (#100) -->
				<div v-if="tab === 'system'" class="font-picker-body">
					<div class="system-font-controls">
						<input
							v-model="query"
							type="search"
							class="system-font-search"
							placeholder="Search installed fonts"
							aria-label="Search installed fonts"
						/>
						<label class="system-font-mono">
							<input v-model="monospaceOnly" type="checkbox" />
							Monospace only
						</label>
					</div>
					<div v-if="systemError" class="font-picker-empty">{{ systemError }}</div>
					<div v-else-if="systemFonts === null" class="font-picker-empty">Looking for installed fonts…</div>
					<div v-else-if="shownSystemFonts.length === 0" class="font-picker-empty">
						No installed font matches.
					</div>
					<ul v-else class="system-font-list" role="listbox" aria-label="Installed fonts">
						<li v-for="font in shownSystemFonts" :key="font.family">
							<button
								type="button"
								role="option"
								class="system-font-item"
								:class="{ selected: modelValue === font.family }"
								:aria-selected="modelValue === font.family"
								@click="onSelect(font.family)"
							>
								<span class="system-font-name">{{ font.family }}</span>
								<span
									v-if="showSamples"
									class="system-font-sample"
									:style="{ fontFamily: cssString(font.family) }"
									>0Oo 1lI {}</span
								>
							</button>
						</li>
					</ul>
					<p class="system-font-note">Installed on the machine where the hub runs. Nothing is uploaded.</p>
				</div>

				<!-- Font list -->
				<div v-else class="font-picker-body">
					<div v-if="fonts.length === 0" class="font-picker-empty">
						No imported fonts. Drop font files here or click "+ Add font" below.
					</div>
					<div v-else class="font-picker-list">
						<FontCard
							v-for="font in fonts"
							:key="font.family"
							:family="font"
							:selected="modelValue === font.family"
							@select="onSelect(font.family)"
							@delete="onDelete(font.family)"
						/>
					</div>
				</div>

				<!-- Footer -->
				<div v-if="tab === 'imported'" class="font-picker-footer">
					<button class="font-picker-add-btn" :disabled="uploading" @click="fileInput?.click()">
						{{ uploading ? "Uploading…" : "+ Add font" }}
					</button>
					<input
						ref="fileInput"
						type="file"
						accept=".ttf,.otf,.woff,.woff2"
						multiple
						style="display: none"
						@change="onFileInputChange"
					/>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import FontCard from "./FontCard.vue";
import { useFileDrop } from "../../composables/useFileDrop.js";
import { useConfigStore } from "../../stores/config.js";
import { useAuthStore } from "../../stores/auth.js";
import { hubBaseUrl } from "../../utils/hub-url.js";
import { hubFetch } from "../../utils/hub-fetch.js";
import { cssString, filterSystemFonts } from "../../utils/system-fonts.js";
import { isTauriRuntime } from "../../utils/tauri-runtime.js";

const props = defineProps<{
	modelValue: string | undefined;
	show: boolean;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: string | undefined];
	close: [];
}>();

const configStore = useConfigStore();
const authStore = useAuthStore();
// storeToRefs keeps `fonts` reactive — plain destructuring would snapshot the
// value and the list would never update after an upload/delete refresh.
const { fonts, systemFonts } = storeToRefs(configStore);

const uploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const tab = ref<"system" | "imported">("system");
const query = ref("");
const monospaceOnly = ref(true);
const systemError = ref<string | null>(null);
const shownSystemFonts = computed(() =>
	filterSystemFonts(systemFonts.value ?? [], query.value, monospaceOnly.value),
);
// The desktop drives its own local hub, so every listed font is installed here
// and a sample costs nothing. In a browser a sample could download each font.
const showSamples = isTauriRuntime();

watch(
	() => props.show,
	(shown) => {
		if (!shown) return;
		tab.value = fonts.value.some((font) => font.family === props.modelValue) ? "imported" : "system";
		systemError.value = null;
		configStore.loadSystemFonts().catch((e: unknown) => {
			systemError.value = `Could not list the installed fonts: ${e instanceof Error ? e.message : String(e)}`;
		});
	},
	{ immediate: true },
);

function authHeader(): Record<string, string> {
	return authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {};
}

async function uploadFiles(files: File[]): Promise<void> {
	tab.value = "imported";
	uploading.value = true;
	error.value = null;

	for (const file of files) {
		try {
			const fd = new FormData();
			fd.append("file", file);
			const resp = await hubFetch(`${hubBaseUrl()}/api/fonts`, {
				method: "POST",
				headers: authHeader(),
				body: fd,
			});
			if (!resp.ok) {
				const msg = await resp.text().catch(() => resp.statusText);
				error.value = `Failed to upload "${file.name}": ${msg}`;
				break;
			}
		} catch (e) {
			error.value = `Failed to upload "${file.name}": ${e instanceof Error ? e.message : String(e)}`;
			break;
		}
	}

	await configStore.loadFonts();
	uploading.value = false;
}

const { isDragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop(
	uploadFiles,
	new Set([".ttf", ".otf", ".woff", ".woff2"]),
);

async function onDelete(family: string): Promise<void> {
	error.value = null;
	try {
		const resp = await hubFetch(`${hubBaseUrl()}/api/fonts/${encodeURIComponent(family)}`, {
			method: "DELETE",
			headers: authHeader(),
		});
		if (!resp.ok) {
			const msg = await resp.text().catch(() => resp.statusText);
			error.value = `Failed to delete "${family}": ${msg}`;
			return;
		}
	} catch (e) {
		error.value = `Failed to delete "${family}": ${e instanceof Error ? e.message : String(e)}`;
		return;
	}

	await configStore.loadFonts();

	if (props.modelValue === family) {
		emit("update:modelValue", undefined);
	}
}

function onSelect(family: string): void {
	emit("update:modelValue", family);
	emit("close");
}

async function onFileInputChange(event: Event): Promise<void> {
	const target = event.target as HTMLInputElement;
	if (!target.files || target.files.length === 0) return;
	const files = Array.from(target.files);
	target.value = "";
	await uploadFiles(files);
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

.font-picker-dialog {
	position: relative;
	background: var(--nt-bg);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	width: 100%;
	max-width: 480px;
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
}

.font-picker-drop-overlay {
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

.font-picker-drop-hint {
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-accent);
}

.dialog-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	border-bottom: 1px solid var(--nt-border);
	flex-shrink: 0;
}

.dialog-title {
	font-size: 15px;
	font-weight: 600;
	color: var(--nt-fg);
}

.dialog-close {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	padding: 0;
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	color: var(--nt-fg-muted);
	cursor: pointer;
	transition: color 0.15s ease, border-color 0.15s ease;
}

.dialog-close:hover {
	color: var(--nt-fg);
	border-color: var(--nt-border);
	background: var(--nt-hover);
}

.font-picker-error {
	padding: 8px 16px;
	font-size: 12px;
	color: var(--nt-danger);
	background: rgba(var(--nt-danger-rgb, 220, 50, 50), 0.08);
	border-bottom: 1px solid var(--nt-border);
}

.font-picker-body {
	padding: 12px 16px;
	overflow-y: auto;
	max-height: 360px;
}

.font-picker-tabs {
	display: flex;
	gap: 4px;
	padding: 8px 16px 0;
	border-bottom: 1px solid var(--nt-border);
}

.font-picker-tab {
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	background: transparent;
	border: none;
	border-bottom: 2px solid transparent;
	color: var(--nt-fg-muted);
	cursor: pointer;
}

.font-picker-tab:hover {
	color: var(--nt-fg);
}

.font-picker-tab.active {
	color: var(--nt-fg);
	border-bottom-color: var(--nt-accent);
}

.system-font-controls {
	position: sticky;
	top: -12px;
	display: flex;
	align-items: center;
	gap: 12px;
	margin: -12px -16px 8px;
	padding: 12px 16px 8px;
	background: var(--nt-bg);
}

.system-font-search {
	flex: 1;
	min-width: 0;
	padding: 5px 8px;
	font-size: 12px;
	font-family: inherit;
	color: var(--nt-fg);
	background: var(--nt-bg-surface);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
}

.system-font-search:focus {
	outline: none;
	border-color: var(--nt-accent);
}

.system-font-mono {
	display: flex;
	align-items: center;
	gap: 4px;
	font-size: 12px;
	color: var(--nt-fg-muted);
	white-space: nowrap;
	cursor: pointer;
}

.system-font-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
	padding: 0;
	list-style: none;
}

.system-font-item {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
	width: 100%;
	padding: 6px 8px;
	font-family: inherit;
	font-size: 13px;
	text-align: left;
	color: var(--nt-fg);
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	cursor: pointer;
}

.system-font-item:hover {
	background: var(--nt-hover);
}

.system-font-item.selected {
	border-color: var(--nt-accent);
}

.system-font-name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.system-font-sample {
	flex-shrink: 0;
	font-size: 14px;
	color: var(--nt-fg-muted);
}

.system-font-note {
	margin: 10px 0 0;
	font-size: 11px;
	color: var(--nt-fg-muted);
}

.font-picker-empty {
	padding: 24px 0;
	text-align: center;
	color: var(--nt-fg-muted);
	font-size: 13px;
	font-style: italic;
}

.font-picker-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.font-picker-footer {
	padding: 12px 16px;
	border-top: 1px solid var(--nt-border);
	flex-shrink: 0;
}

.font-picker-add-btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	background: var(--nt-bg-surface);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-fg);
	cursor: pointer;
	transition: background 0.15s ease;
}

.font-picker-add-btn:hover:not(:disabled) {
	background: var(--nt-hover);
	border-color: var(--nt-accent);
}

.font-picker-add-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
