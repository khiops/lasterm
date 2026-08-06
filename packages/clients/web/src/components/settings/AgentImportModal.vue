<template>
	<Teleport to="body">
		<div v-if="show" class="dialog-overlay" @click.self="emit('close')">
			<div class="agent-import-dialog" role="dialog" aria-modal="true" aria-label="Import agent">
				<div class="dialog-header">
					<span class="dialog-title">Import Agent</span>
					<button class="dialog-close" type="button" title="Close" @click="emit('close')">
						&#10005;
					</button>
				</div>

				<div class="dialog-body">
					<div v-if="importableTargets.length === 0" class="modal-empty">
						No built remote targets are available.
					</div>

					<div class="selector-grid">
						<label class="field-label">
							<span>OS</span>
							<select v-model="selectedOs" :disabled="importableTargets.length === 0">
								<option v-for="os in osOptions" :key="os" :value="os">
									{{ formatOs(os) }}
								</option>
							</select>
						</label>
						<label class="field-label">
							<span>Arch</span>
							<select v-model="selectedArch" :disabled="archOptions.length === 0">
								<option v-for="arch in archOptions" :key="arch" :value="arch">
									{{ arch }}
								</option>
							</select>
						</label>
						<label class="field-label">
							<span>Version</span>
							<select v-model="selectedVersion" :disabled="versionOptions.length === 0">
								<option v-for="version in versionOptions" :key="version" :value="version">
									{{ version }}
								</option>
							</select>
						</label>
					</div>

					<div class="drop-grid">
						<div
							class="drop-zone"
							:class="{ 'drop-zone--dragging': isBinaryDragging }"
							@click="binaryInput?.click()"
							@dragenter="onBinaryDragEnter"
							@dragover="onBinaryDragOver"
							@dragleave="onBinaryDragLeave"
							@drop="onBinaryDrop"
						>
							<span class="drop-title">Agent binary</span>
							<span class="drop-filename">{{ binary?.name ?? "Choose or drop binary" }}</span>
							<input
								ref="binaryInput"
								type="file"
								class="hidden-input"
								@change="onBinaryInputChange"
							/>
						</div>

						<div
							class="drop-zone"
							:class="{ 'drop-zone--dragging': isManifestDragging }"
							@click="manifestInput?.click()"
							@dragenter="onManifestDragEnter"
							@dragover="onManifestDragOver"
							@dragleave="onManifestDragLeave"
							@drop="onManifestDrop"
						>
							<span class="drop-title">SHA256SUMS manifest</span>
							<span class="drop-filename">
								{{ manifest?.name ?? `Choose or drop SHA256SUMS-${selectedVersion || "version"}.txt` }}
							</span>
							<input
								ref="manifestInput"
								type="file"
								accept=".txt"
								class="hidden-input"
								@change="onManifestInputChange"
							/>
						</div>
					</div>

					<div v-if="nativePickerAvailable" class="native-picker-row">
						<button
							class="modal-button modal-button--secondary"
							type="button"
							:disabled="pickingNativeFiles"
							@click="pickNativeFiles"
						>
							{{ pickingNativeFiles ? "Opening..." : "Choose with native picker..." }}
						</button>
					</div>

					<label class="attestation">
						<input v-model="attested" type="checkbox" />
						<span>
							This verifies the file's integrity against the checksum you provide — it does NOT
							prove the binary's authenticity. Only import a binary (and SHA256SUMS) you
							obtained from a trusted source.
						</span>
					</label>

					<div
						v-if="importResult"
						class="import-result"
						:class="importResult.verified ? 'import-result--success' : 'import-result--error'"
					>
						<strong>{{ importResult.verified ? "Verified" : (importResult.code ?? "Rejected") }}</strong>
						<span>
							{{
								importResult.message ??
								(importResult.verified
									? `Imported ${importResult.version ?? selectedVersion}.`
									: "The hub rejected this import.")
							}}
						</span>
					</div>
				</div>

				<div class="dialog-footer">
					<button class="modal-button modal-button--secondary" type="button" @click="emit('close')">
						Close
					</button>
					<button class="modal-button" type="button" :disabled="submitDisabled" @click="submit">
						{{ submitting ? "Importing..." : "Import" }}
					</button>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import type { HostArch, HostOs } from "@lasterm/shared";
import { computed, ref, watch } from "vue";
import { useFileDrop } from "../../composables/useFileDrop.js";
import { type AgentImportResult, useAgentManagerStore } from "../../stores/agent-manager.js";
import { pickDesktopAgentImportFiles } from "../../utils/desktop-agent-picker.js";
import { isTauriRuntime } from "../../utils/hub-url.js";

const props = defineProps<{
	show: boolean;
}>();

const emit = defineEmits<{
	close: [];
}>();

const store = useAgentManagerStore();

const selectedOs = ref<HostOs | "">("");
const selectedArch = ref<HostArch | "">("");
const selectedVersion = ref("");
const binary = ref<File | null>(null);
const manifest = ref<File | null>(null);
const attested = ref(false);
const submitting = ref(false);
const pickingNativeFiles = ref(false);
const importResult = ref<AgentImportResult | null>(null);
const binaryInput = ref<HTMLInputElement | null>(null);
const manifestInput = ref<HTMLInputElement | null>(null);
const nativePickerAvailable = isTauriRuntime();

const importableTargets = computed(() =>
	store.targets.filter(
		(target) =>
			target.triple !== null &&
			target.status !== "bundled" &&
			target.status !== "error" &&
			target.status !== "unsupported",
	),
);

const osOptions = computed(() => {
	const values = new Set(importableTargets.value.map((target) => target.os));
	return Array.from(values);
});

const archOptions = computed(() => {
	if (!selectedOs.value) return [];
	const values = new Set(
		importableTargets.value
			.filter((target) => target.os === selectedOs.value)
			.map((target) => target.arch),
	);
	return Array.from(values);
});

const selectedTarget = computed(() =>
	importableTargets.value.find(
		(target) => target.os === selectedOs.value && target.arch === selectedArch.value,
	),
);

const versionOptions = computed(() => {
	const values = new Set<string>();
	if (selectedTarget.value?.expectedVersion) values.add(selectedTarget.value.expectedVersion);
	if (store.hubVersion) values.add(store.hubVersion);
	return Array.from(values);
});

const submitDisabled = computed(
	() =>
		submitting.value ||
		pickingNativeFiles.value ||
		!binary.value ||
		!manifest.value ||
		!attested.value ||
		!selectedOs.value ||
		!selectedArch.value ||
		!selectedVersion.value,
);

watch(
	() => props.show,
	(visible) => {
		if (!visible) return;
		binary.value = null;
		manifest.value = null;
		attested.value = false;
		importResult.value = null;
		if (store.targets.length === 0) void store.loadTargets();
		selectFirstAvailableTarget();
	},
);

watch(importableTargets, () => {
	if (props.show) selectFirstAvailableTarget();
});

watch(selectedOs, () => {
	if (!archOptions.value.includes(selectedArch.value as HostArch)) {
		selectedArch.value = archOptions.value[0] ?? "";
	}
});

watch(versionOptions, () => {
	if (!versionOptions.value.includes(selectedVersion.value)) {
		selectedVersion.value = versionOptions.value[0] ?? "";
	}
});

function selectFirstAvailableTarget(): void {
	if (importableTargets.value.length === 0) {
		selectedOs.value = "";
		selectedArch.value = "";
		selectedVersion.value = "";
		return;
	}

	if (!selectedTarget.value) {
		const first = importableTargets.value[0];
		if (!first) return;
		selectedOs.value = first.os;
		selectedArch.value = first.arch;
	}

	if (!versionOptions.value.includes(selectedVersion.value)) {
		selectedVersion.value = versionOptions.value[0] ?? "";
	}
}

function assignBinary(files: File[]): void {
	binary.value = files[0] ?? null;
	importResult.value = null;
}

function assignManifest(files: File[]): void {
	manifest.value = files[0] ?? null;
	importResult.value = null;
}

const {
	isDragging: isBinaryDragging,
	onDragEnter: onBinaryDragEnter,
	onDragOver: onBinaryDragOver,
	onDragLeave: onBinaryDragLeave,
	onDrop: onBinaryDrop,
} = useFileDrop(assignBinary);

const {
	isDragging: isManifestDragging,
	onDragEnter: onManifestDragEnter,
	onDragOver: onManifestDragOver,
	onDragLeave: onManifestDragLeave,
	onDrop: onManifestDrop,
} = useFileDrop(assignManifest, new Set([".txt"]));

function onBinaryInputChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	assignBinary(Array.from(input.files ?? []));
	input.value = "";
}

function onManifestInputChange(event: Event): void {
	const input = event.target as HTMLInputElement;
	assignManifest(Array.from(input.files ?? []));
	input.value = "";
}

async function pickNativeFiles(): Promise<void> {
	if (!nativePickerAvailable) return;

	pickingNativeFiles.value = true;
	importResult.value = null;
	try {
		const picked = await pickDesktopAgentImportFiles();
		if (picked === null) return;
		if (picked.binary) binary.value = picked.binary;
		if (picked.manifest) manifest.value = picked.manifest;
	} catch (error) {
		importResult.value = {
			code: "PICK_FAILED",
			message: error instanceof Error ? error.message : String(error),
			verified: false,
		};
	} finally {
		pickingNativeFiles.value = false;
	}
}

async function submit(): Promise<void> {
	if (submitDisabled.value || !binary.value || !manifest.value) return;

	submitting.value = true;
	importResult.value = null;
	try {
		importResult.value = await store.importAgent({
			binary: binary.value,
			manifest: manifest.value,
			os: selectedOs.value as HostOs,
			arch: selectedArch.value as HostArch,
			version: selectedVersion.value,
			attested: true,
		});
	} catch (error) {
		importResult.value = {
			code: "IMPORT_FAILED",
			message: error instanceof Error ? error.message : String(error),
			verified: false,
		};
	} finally {
		submitting.value = false;
	}
}

function formatOs(os: HostOs): string {
	if (os === "darwin") return "macOS";
	if (os === "windows") return "Windows";
	return "Linux";
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

.agent-import-dialog {
	position: relative;
	background: var(--nt-bg);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	padding: 0;
	width: min(620px, calc(100vw - 32px));
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
	max-height: calc(100vh - 48px);
}

.dialog-header,
.dialog-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	flex-shrink: 0;
}

.dialog-header {
	border-bottom: 1px solid var(--nt-border);
}

.dialog-footer {
	border-top: 1px solid var(--nt-border);
	gap: 8px;
	justify-content: flex-end;
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
	transition:
		color 0.15s ease,
		border-color 0.15s ease;
}

.dialog-close:hover {
	color: var(--nt-fg);
	border-color: var(--nt-border);
	background: var(--nt-hover);
}

.dialog-body {
	padding: 16px 20px;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.modal-empty {
	padding: 9px 11px;
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	color: var(--nt-text-secondary);
	font-size: 12px;
	background: var(--nt-bg-surface);
}

.selector-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 10px;
}

.field-label {
	display: flex;
	flex-direction: column;
	gap: 5px;
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-secondary);
}

.field-label select {
	width: 100%;
	min-width: 0;
	padding: 6px 8px;
	border-radius: 6px;
	border: 1px solid var(--nt-border);
	background: var(--nt-bg-surface);
	color: var(--nt-fg);
	font-family: inherit;
	font-size: 12px;
}

.drop-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 10px;
}

.drop-zone {
	min-height: 104px;
	border: 1px dashed var(--nt-border);
	border-radius: 8px;
	background: var(--nt-bg-surface);
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 8px;
	padding: 12px;
	cursor: pointer;
	text-align: center;
	transition:
		border-color 0.15s ease,
		background 0.15s ease;
}

.drop-zone:hover,
.drop-zone--dragging {
	border-color: var(--nt-accent);
	background: rgba(var(--nt-accent-rgb, 97, 175, 239), 0.12);
}

.drop-title {
	font-size: 12px;
	font-weight: 700;
	color: var(--nt-fg);
}

.drop-filename {
	max-width: 100%;
	font-size: 12px;
	color: var(--nt-text-secondary);
	overflow-wrap: anywhere;
}

.hidden-input {
	display: none;
}

.native-picker-row {
	display: flex;
	justify-content: flex-start;
}

.attestation {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	font-size: 12px;
	line-height: 1.45;
	color: var(--nt-fg);
	padding: 10px;
	border: 1px solid var(--nt-border);
	border-radius: 6px;
	background: rgba(var(--nt-fg-rgb, 171, 178, 191), 0.04);
}

.attestation input {
	margin-top: 2px;
	flex-shrink: 0;
}

.import-result {
	display: flex;
	flex-direction: column;
	gap: 3px;
	padding: 9px 11px;
	border-radius: 6px;
	font-size: 12px;
	line-height: 1.4;
}

.import-result--success {
	border: 1px solid var(--nt-green, #98c379);
	color: var(--nt-green, #98c379);
	background: rgba(152, 195, 121, 0.12);
}

.import-result--error {
	border: 1px solid var(--nt-red, #e06c75);
	color: var(--nt-red, #e06c75);
	background: rgba(224, 108, 117, 0.12);
}

.modal-button {
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 600;
	background: var(--nt-accent);
	border: 1px solid var(--nt-accent);
	border-radius: 6px;
	color: var(--nt-bg);
	cursor: pointer;
}

.modal-button--secondary {
	background: rgba(var(--nt-fg-rgb, 171, 178, 191), 0.06);
	border-color: var(--nt-border);
	color: var(--nt-fg);
}

.modal-button:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}

@media (max-width: 620px) {
	.selector-grid,
	.drop-grid {
		grid-template-columns: 1fr;
	}
}
</style>
