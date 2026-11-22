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
				<div class="rec-head">
					<h3 id="rec-title" class="rec-title">Recordings</h3>
					<span class="rec-usage" :class="{ 'rec-usage--full': full }">
						{{ full ? "Full: " : "" }}{{ size(recordings.usedBytes) }} of {{ size(recordings.capBytes) }}
					</span>
				</div>
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
						<div v-if="discarding === row.id" class="rec-row__actions rec-row__confirm" role="group" :aria-label="`Discard ${row.title || 'Terminal'}?`">
							<span class="rec-row__ask">Delete it from this computer? This cannot be undone.</span>
							<button ref="confirmButton" class="btn btn-danger" @click="confirmDiscard(row)">Discard</button>
							<button class="btn btn-secondary" @click="discarding = null">Keep</button>
						</div>
						<div v-else class="rec-row__actions">
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

		<CastPlayer v-if="playing" :chunks="playing.chunks" :title="playing.title" @close="playing = null" />
	</Teleport>
</template>

<script setup lang="ts">
import { CAST_FILE_MAX_BYTES } from "@lasterm/shared";
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useModalFocus } from "../composables/useModalFocus.js";
import { type RecordingRow, useRecordingsStore } from "../stores/recordings.js";
import { useToastStore } from "../stores/toast.js";
import { fileChunks } from "../utils/cast-parse.js";
import CastPlayer from "./CastPlayer.vue";

const emit = defineEmits<{ close: [] }>();

const recordings = useRecordingsStore();
const root = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const fileError = ref<string | null>(null);
/** The row asking whether to discard it, inline: no dialog over the dialog. */
const discarding = ref<string | null>(null);
const confirmButton = ref<HTMLButtonElement[] | HTMLButtonElement | null>(null);
const playing = ref<{ chunks: () => AsyncIterable<string>; title: string } | null>(null);
const opened = ref(false);
let returnTo: Element | null = null;

const full = computed(() => recordings.capBytes > 0 && recordings.usedBytes >= recordings.capBytes);

const { onKeydown } = useModalFocus({
	open: () => opened.value,
	root,
	close: () => {
		if (playing.value === null) emit("close");
	},
});

onMounted(() => {
	returnTo = document.activeElement;
	opened.value = true;
	void recordings.refresh();
});

onUnmounted(() => {
	if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
});

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

/** The player reads the export part by part, with GETs only: replaying never stops a recording. */
function replay(row: RecordingRow): void {
	playing.value = { chunks: () => recordings.castParts(row.id), title: row.title || "Terminal" };
}

/** The save dialog opens in this click, before any request. */
function save(row: RecordingRow): void {
	void recordings.save({ id: row.id, title: row.title, startedAt: row.started_at }, row.ended_at === null);
}

function askDiscard(row: RecordingRow): void {
	discarding.value = row.id;
	void nextTick(() => {
		const button = Array.isArray(confirmButton.value) ? confirmButton.value[0] : confirmButton.value;
		button?.focus();
	});
}

async function confirmDiscard(row: RecordingRow): Promise<void> {
	discarding.value = null;
	if (!(await recordings.discard(row.id))) {
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
	playing.value = { chunks: () => fileChunks(file), title: file.name };
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
	color: var(--nt-status-error);
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
	background: var(--nt-status-error);
}

.rec-row__meta {
	font-size: 11px;
	color: var(--nt-text-secondary);
	font-variant-numeric: tabular-nums;
}

.rec-row__actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}

.rec-row__ask {
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.btn-danger {
	background: var(--nt-danger);
	color: var(--nt-danger-fg);
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
	color: var(--nt-status-error);
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
	transition: box-shadow 0.12s;
}

/* An edge in the text's own colour: dimming the button would take its text below AA. */
.btn:hover {
	box-shadow: inset 0 0 0 1px currentColor;
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
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
}

@media (max-width: 520px) {
	.rec-row {
		flex-direction: column;
		align-items: stretch;
	}
}
</style>
