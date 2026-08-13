
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

				<!-- Font list -->
				<div class="font-picker-body">
					<div v-if="fonts.length === 0" class="font-picker-empty">
						No custom fonts installed. Drop font files here or click "+ Add font" below.
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
				<div class="font-picker-footer">
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
import { ref } from "vue";
import { storeToRefs } from "pinia";
import FontCard from "./FontCard.vue";
import { useFileDrop } from "../../composables/useFileDrop.js";
import { useConfigStore } from "../../stores/config.js";
import { useAuthStore } from "../../stores/auth.js";
import { hubBaseUrl } from "../../utils/hub-url.js";
import { hubFetch } from "../../utils/hub-fetch.js";

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
const { fonts } = storeToRefs(configStore);

const uploading = ref(false);
const error = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function authHeader(): Record<string, string> {
	return authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {};
}

async function uploadFiles(files: File[]): Promise<void> {
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
