
<template>
	<Teleport to="body">
		<div v-if="show" class="dialog-overlay" @click.self="emit('close')">
			<div
				class="ssh-picker-dialog"
				@dragenter="onDragEnter"
				@dragover="onDragOver"
				@dragleave="onDragLeave"
				@drop="onDrop"
			>
				<!-- Drag overlay -->
				<div v-if="isDragging" class="ssh-picker-drop-overlay">
					<svg class="ssh-picker-drop-icon" width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
						<circle cx="12" cy="16" r="7" stroke="currentColor" stroke-width="2"/>
						<path d="M18 16h10M26 12v4M22 12v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
					</svg>
					<div class="ssh-picker-drop-hint">Drop key files to upload</div>
					<div class="ssh-picker-drop-note">Permissions will be set automatically (chmod 600)</div>
				</div>

				<!-- Header -->
				<div class="dialog-header">
					<span class="dialog-title">SSH Key Picker</span>
					<button class="dialog-close" title="Close" @click="emit('close')">
						<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
						</svg>
					</button>
				</div>

				<!-- Breadcrumb -->
				<div class="ssh-picker-breadcrumb">
					<button class="breadcrumb-seg" @click="navigateTo('')">~/.ssh</button>
					<template v-for="(seg, idx) in breadcrumbSegments" :key="idx">
						<span class="breadcrumb-sep">/</span>
						<button class="breadcrumb-seg" @click="navigateTo(breadcrumbSegments.slice(0, idx + 1).join('/'))">
							{{ seg }}
						</button>
					</template>
					<span v-if="breadcrumbSegments.length > 0" class="breadcrumb-sep">/</span>
				</div>

				<!-- Body -->
				<div class="ssh-picker-body">
					<div v-if="loading" class="ssh-picker-empty">Loading…</div>
					<div v-else-if="entries.length === 0" class="ssh-picker-empty">
						No SSH keys found. Drop key files here or click "+ Upload key" below.
					</div>
					<div v-else class="ssh-picker-list">
						<SshKeyCard
							v-for="entry in entries"
							:key="entry.name"
							:entry="entry"
							:selected="isSelected(entry)"
							@select="onSelect(entry)"
							@delete="onDelete(entry)"
						/>
					</div>
				</div>

				<!-- Footer -->
				<div class="ssh-picker-footer">
					<button class="ssh-picker-add-btn" :disabled="uploading" @click="fileInput?.click()">
						{{ uploading ? "Uploading…" : "+ Upload key" }}
					</button>
					<input
						ref="fileInput"
						type="file"
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
import { ref, computed, watch } from "vue";
import type { SshKeyEntry } from "@lasterm/shared";
import SshKeyCard from "./SshKeyCard.vue";
import { useFileDrop } from "../composables/useFileDrop.js";
import { useToastStore } from "../stores/toast.js";
import { useAuthStore } from "../stores/auth.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { hubFetch } from "../utils/hub-fetch.js";

const props = defineProps<{
	modelValue: string | undefined;
	show: boolean;
}>();

const emit = defineEmits<{
	"update:modelValue": [path: string];
	close: [];
}>();

const toastStore = useToastStore();
const authStore = useAuthStore();

const currentDir = ref("");
const entries = ref<SshKeyEntry[]>([]);
const loading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const breadcrumbSegments = computed(() =>
	currentDir.value ? currentDir.value.split("/").filter(Boolean) : [],
);

function authHeader(): Record<string, string> {
	return authStore.token ? { Authorization: `Bearer ${authStore.token}` } : {};
}

async function loadEntries(): Promise<void> {
	loading.value = true;
	try {
		const params = currentDir.value ? `?dir=${encodeURIComponent(currentDir.value)}` : "";
		const resp = await hubFetch(`${hubBaseUrl()}/api/ssh-keys${params}`, { headers: authHeader() });
		if (!resp.ok) {
			const msg = await resp.text().catch(() => resp.statusText);
			toastStore.show("error", `Failed to load SSH keys: ${msg}`);
			return;
		}
		const data = (await resp.json()) as { path: string; entries: SshKeyEntry[] };
		entries.value = data.entries;
	} catch (e) {
		toastStore.show("error", `Failed to load SSH keys: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		loading.value = false;
	}
}

function navigateTo(dir: string): void {
	currentDir.value = dir;
}

watch(() => props.show, (visible) => {
	if (visible) {
		currentDir.value = "";
		void loadEntries();
	}
});

watch(currentDir, () => {
	void loadEntries();
});

function isSelected(entry: SshKeyEntry): boolean {
	if (entry.type !== "key") return false;
	const tildeDir = currentDir.value ? `~/.ssh/${currentDir.value}/${entry.name}` : `~/.ssh/${entry.name}`;
	return props.modelValue === tildeDir;
}

function onSelect(entry: SshKeyEntry): void {
	if (entry.type === "directory") {
		const newDir = currentDir.value ? `${currentDir.value}/${entry.name}` : entry.name;
		navigateTo(newDir);
	} else {
		const tildePath = currentDir.value
			? `~/.ssh/${currentDir.value}/${entry.name}`
			: `~/.ssh/${entry.name}`;
		emit("update:modelValue", tildePath);
		emit("close");
	}
}

async function onDelete(entry: SshKeyEntry): Promise<void> {
	try {
		const deleteParams = new URLSearchParams({ name: entry.name });
		if (currentDir.value) deleteParams.set("dir", currentDir.value);
		const resp = await hubFetch(`${hubBaseUrl()}/api/ssh-keys?${deleteParams.toString()}`, {
			method: "DELETE",
			headers: authHeader(),
		});
		if (!resp.ok) {
			const msg = await resp.text().catch(() => resp.statusText);
			toastStore.show("error", `Failed to delete "${entry.name}": ${msg}`);
			return;
		}
	} catch (e) {
		toastStore.show("error", `Failed to delete "${entry.name}": ${e instanceof Error ? e.message : String(e)}`);
		return;
	}
	await loadEntries();
}

async function uploadFiles(files: File[]): Promise<void> {
	uploading.value = true;
	for (const file of files) {
		try {
			const fd = new FormData();
			fd.append("file", file);
			if (currentDir.value) fd.append("dir", currentDir.value);
			const resp = await hubFetch(`${hubBaseUrl()}/api/ssh-keys`, {
				method: "POST",
				headers: authHeader(),
				body: fd,
			});
			if (!resp.ok) {
				const msg = await resp.text().catch(() => resp.statusText);
				toastStore.show("error", `Failed to upload "${file.name}": ${msg}`);
				break;
			}
		} catch (e) {
			toastStore.show("error", `Failed to upload "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
			break;
		}
	}
	await loadEntries();
	uploading.value = false;
}

const { isDragging, onDragEnter, onDragOver, onDragLeave, onDrop } = useFileDrop(uploadFiles);

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

.ssh-picker-dialog {
	position: relative;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	width: 100%;
	max-width: 560px;
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
}

.ssh-picker-drop-overlay {
	position: absolute;
	inset: 0;
	background: rgba(var(--nt-accent-rgb, 99 102 241), 0.12);
	border: 2px dashed var(--nt-accent);
	border-radius: 8px;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 6px;
	z-index: 10;
	pointer-events: none;
}

.ssh-picker-drop-icon {
	color: var(--nt-accent);
}

.ssh-picker-drop-hint {
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-accent);
}

.ssh-picker-drop-note {
	font-size: 11px;
	color: var(--nt-fg-muted);
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
}

.ssh-picker-breadcrumb {
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 8px 16px;
	border-bottom: 1px solid var(--nt-border);
	flex-shrink: 0;
	flex-wrap: wrap;
}

.breadcrumb-seg {
	font-size: 12px;
	font-family: ui-monospace, "SFMono-Regular", monospace;
	color: var(--nt-accent);
	background: transparent;
	border: none;
	padding: 2px 4px;
	border-radius: 3px;
	cursor: pointer;
	transition: background 0.15s ease;
}

.breadcrumb-seg:hover {
	background: rgba(var(--nt-accent-rgb, 99 102 241), 0.1);
}

.breadcrumb-sep {
	font-size: 12px;
	color: var(--nt-fg-muted);
	user-select: none;
}

.ssh-picker-body {
	padding: 12px 16px;
	overflow-y: auto;
	max-height: 380px;
}

.ssh-picker-empty {
	padding: 24px 0;
	text-align: center;
	color: var(--nt-fg-muted);
	font-size: 13px;
	font-style: italic;
}

.ssh-picker-list {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.ssh-picker-footer {
	padding: 12px 16px;
	border-top: 1px solid var(--nt-border);
	flex-shrink: 0;
}

.ssh-picker-add-btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	background: rgba(var(--nt-fg-rgb), 0.06);
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-fg);
	cursor: pointer;
	transition: background 0.15s ease;
}

.ssh-picker-add-btn:hover:not(:disabled) {
	background: rgba(var(--nt-fg-rgb), 0.12);
}

.ssh-picker-add-btn:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
</style>
