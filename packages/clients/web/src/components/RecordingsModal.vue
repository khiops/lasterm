<template>
	<Teleport to="body">
		<div class="rec-overlay" @click.self="emit('close')">
			<div
				ref="root"
				class="rec-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="rec-title"
				@keydown="onKeydown"
			>
				<header class="rec-head">
					<h3 id="rec-title" class="rec-title">Recordings</h3>
					<span class="rec-usage" :class="{ 'rec-usage--full': full }">
						{{ full ? "Full: " : "" }}{{ size(recordings.usedBytes) }} of {{ size(recordings.capBytes) }}
					</span>
				</header>
				<p class="rec-note">
					A recording holds everything the terminal printed, secrets included. It stays on this computer.
				</p>

				<ul v-if="recordings.rows.length > 0" class="rec-list">
					<li v-for="row in recordings.rows" :key="row.id" class="rec-row">
						<div class="rec-row__main">
							<span class="rec-row__title">
								<span v-if="row.ended_at === null" class="rec-row__live" aria-label="Recording now" />
								{{ row.title || "Terminal" }}
							</span>
							<span class="rec-row__meta">
								{{ row.host_label }} · {{ started(row.started_at) }} · {{ duration(row.duration_ms) }} · {{ size(row.bytes) }}
							</span>
						</div>
						<div class="rec-row__actions">
							<button class="btn btn-secondary" @click="replay(row)">Replay</button>
							<button class="btn btn-primary" @click="save(row)">Save…</button>
							<button class="btn btn-secondary" @click="askDiscard(row)">Discard</button>
						</div>
					</li>
				</ul>
				<p v-else class="rec-empty">
					No recording is waiting. Start one from a terminal's menu, or open a .cast file.
				</p>

				<footer class="rec-foot">
					<button class="btn btn-secondary" @click="fileInput?.click()">Open a .cast file…</button>
					<input ref="fileInput" type="file" accept=".cast" class="rec-file" @change="onFile" />
					<span v-if="fileError" class="rec-file-error" role="alert">{{ fileError }}</span>
					<button class="btn btn-secondary rec-close" @click="emit('close')">Close</button>
				</footer>
			</div>
		</div>

		<ConfirmDialog
			:visible="discarding !== null"
			title="Discard this recording?"
			:message="`“${discarding?.title || 'Terminal'}” on ${discarding?.host_label ?? ''} will be deleted from this computer. This cannot be undone.`"
			confirm-label="Discard"
			@confirm="confirmDiscard"
			@cancel="discarding = null"
		/>
		<CastPlayer v-if="playing" :text="playing.text" :title="playing.title" @close="playing = null" />
	</Teleport>
</template>

<script setup lang="ts">
import { CAST_FILE_MAX_BYTES } from "@lasterm/shared";
import { computed, onMounted, ref } from "vue";
import { useModalFocus } from "../composables/useModalFocus.js";
import { type RecordingRow, useRecordingsStore } from "../stores/recordings.js";
import { useToastStore } from "../stores/toast.js";
import CastPlayer from "./CastPlayer.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const emit = defineEmits<{ close: [] }>();

const recordings = useRecordingsStore();
const root = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const fileError = ref<string | null>(null);
const discarding = ref<RecordingRow | null>(null);
const playing = ref<{ text: string; title: string } | null>(null);

const full = computed(() => recordings.capBytes > 0 && recordings.usedBytes >= recordings.capBytes);

const { onKeydown } = useModalFocus({
	open: () => playing.value === null && discarding.value === null,
	root,
	close: () => emit("close"),
});

onMounted(() => void recordings.refresh());

function size(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s} s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function started(iso: string): string {
	return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

async function replay(row: RecordingRow): Promise<void> {
	try {
		playing.value = { text: await recordings.castText(row.id), title: row.title || "Terminal" };
	} catch {
		useToastStore().show("error", "The recording could not be read.");
	}
}

/** The save dialog opens in this click, before any request. */
function save(row: RecordingRow): void {
	void recordings.save({ id: row.id, title: row.title, startedAt: row.started_at }, row.ended_at === null);
}

function askDiscard(row: RecordingRow): void {
	discarding.value = row;
}

async function confirmDiscard(): Promise<void> {
	const row = discarding.value;
	discarding.value = null;
	if (row && !(await recordings.discard(row.id))) {
		useToastStore().show("error", "The recording could not be discarded.");
	}
}

async function onFile(event: Event): Promise<void> {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = "";
	fileError.value = null;
	if (!file) return;
	if (file.size > CAST_FILE_MAX_BYTES) {
		fileError.value = "This file is larger than 1 GiB";
		return;
	}
	playing.value = { text: await file.text(), title: file.name };
}
</script>

<style scoped>
.rec-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay-heavy);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 9000;
}

.rec-dialog {
	display: flex;
	flex-direction: column;
	gap: 12px;
	width: min(640px, calc(100vw - 32px));
	max-height: calc(100vh - 64px);
	padding: 20px;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	box-shadow: var(--nt-shadow);
}

.rec-head {
	display: flex;
	align-items: baseline;
	gap: 12px;
}

.rec-title {
	flex: 1;
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.rec-usage {
	font-size: 11px;
	color: var(--nt-text-secondary);
	font-variant-numeric: tabular-nums;
}

.rec-usage--full {
	color: var(--nt-red, #e06c75);
	font-weight: 600;
}

.rec-note {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--nt-text-secondary);
}

.rec-list {
	list-style: none;
	margin: 0;
	padding: 0;
	overflow-y: auto;
	border-top: 1px solid var(--nt-border);
}

.rec-row {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 0;
	border-bottom: 1px solid var(--nt-border);
}

.rec-row__main {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.rec-row__title {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 13px;
	color: var(--nt-fg);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.rec-row__live {
	flex-shrink: 0;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--nt-red, #e06c75);
}

.rec-row__meta {
	font-size: 11px;
	color: var(--nt-text-secondary);
	font-variant-numeric: tabular-nums;
}

.rec-row__actions {
	display: flex;
	gap: 6px;
	flex-shrink: 0;
}

.rec-empty {
	margin: 8px 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.rec-foot {
	display: flex;
	align-items: center;
	gap: 8px;
}

.rec-file {
	display: none;
}

.rec-file-error {
	font-size: 12px;
	color: var(--nt-red, #e06c75);
}

.rec-close {
	margin-left: auto;
}

.btn {
	padding: 6px 12px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.12s, opacity 0.12s;
}

.btn:hover {
	opacity: 0.85;
}

.btn:focus-visible {
	outline: 2px solid var(--nt-accent, var(--nt-blue, #3b82f6));
	outline-offset: 2px;
}

.btn-secondary {
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
}

.btn-primary {
	background: var(--nt-accent, var(--nt-blue, #3b82f6));
	color: #fff;
}

@media (max-width: 520px) {
	.rec-row {
		flex-direction: column;
		align-items: stretch;
	}
}
</style>
