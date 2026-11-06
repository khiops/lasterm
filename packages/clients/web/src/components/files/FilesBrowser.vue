<template>
	<div class="files-browser" @keydown="onBrowserKeydown">
		<!-- The path bar: Up, the folders down to this one (F2 or Ctrl+L edits it as text),
		     Refresh, and the Following toggle. -->
		<div class="files-pathbar">
			<button
				type="button"
				class="files-tool"
				:disabled="parent === null"
				aria-label="Up one folder"
				title="Up (Backspace)"
				@click="goUp"
			>
				<FilesIcon name="up" />
			</button>
			<input
				v-if="editingPath"
				ref="pathInput"
				v-model="pathText"
				class="files-path-input"
				type="text"
				aria-label="Path"
				spellcheck="false"
				autocomplete="off"
				@keydown.enter.prevent="submitPath"
				@keydown.esc.prevent="stopEditing"
				@blur="stopEditing"
			/>
			<nav v-else class="files-crumbs" aria-label="Path" @dblclick="startEditing">
				<ol ref="crumbsList">
					<li v-for="(crumb, i) in crumbs" :key="crumb.path">
						<span v-if="i > 0" class="files-crumbs__sep" aria-hidden="true">›</span>
						<button
							type="button"
							class="files-crumb"
							:aria-current="i === crumbs.length - 1 ? 'location' : undefined"
							@click="browseTo(crumb.path)"
						>
							{{ crumb.label }}
						</button>
					</li>
				</ol>
			</nav>
			<button
				type="button"
				class="files-tool"
				aria-label="Refresh"
				title="Refresh"
				@click="reload"
			>
				<FilesIcon name="refresh" />
			</button>
			<button
				type="button"
				class="files-follow"
				:class="{ 'files-follow--on': files.following }"
				:aria-pressed="files.following"
				title="Follow the terminal's directory"
				@click="toggleFollowing"
			>
				<FilesIcon name="follow" />
				<span>{{ files.following ? "Following" : "Follow" }}</span>
			</button>
		</div>

		<div v-if="lines.length > 0" class="files-status">
			<p
				v-for="line in lines"
				:key="line.id"
				class="files-status__line"
				:class="{ 'files-status__line--warn': line.tone === 'warn' }"
			>
				<span>{{ line.path === undefined ? line.text : `${line.text} ` }}</span>
				<code v-if="line.path !== undefined" class="files-status__path">{{ line.path }}</code>
				<button
					v-if="line.goThere"
					type="button"
					class="files-link"
					@click="goThere"
				>
					Go there
				</button>
			</p>
		</div>

		<div class="files-list-wrap">
			<div v-if="tint !== null" class="files-tint" :style="tint" aria-hidden="true" />
			<p v-if="loading && listing === null" class="files-note">Loading…</p>
			<div v-else-if="failure !== null" class="files-card files-card--error" role="alert">
				<p class="files-card__text">{{ failureText }}</p>
				<div class="files-card__actions">
					<button
						v-if="failure.code === 'HOST_NOT_CONNECTED'"
						type="button"
						class="files-btn files-btn--primary"
						@click="connect"
					>
						Connect
					</button>
					<button type="button" class="files-btn" @click="reload">Retry</button>
				</div>
			</div>
			<p v-else-if="listing !== null && listing.entries.length === 0" class="files-note">
				This folder is empty.{{ showHidden ? "" : " Hidden files are not shown." }}
			</p>
			<div
				v-else-if="listing !== null"
				ref="listEl"
				class="files-list"
				role="listbox"
				:aria-label="`Files in ${listing.path}`"
				@scroll="onScroll"
				@keydown="onListKeydown"
			>
				<div class="files-list__space" :style="{ height: `${listing.entries.length * ROW_HEIGHT}px` }">
					<div
						v-for="row in visibleRows"
						:key="row.entry.name"
						class="files-row"
						:class="{ 'files-row--current': row.index === current }"
						role="option"
						:aria-selected="row.index === current"
						:aria-setsize="listing.entries.length"
						:aria-posinset="row.index + 1"
						:aria-label="entryLabel(row.entry, now)"
						:tabindex="row.index === current ? 0 : -1"
						:data-index="row.index"
						data-zone-item
						:style="{ transform: `translateY(${row.index * ROW_HEIGHT}px)` }"
						@click="current = row.index"
						@dblclick="openRow(row.index)"
						@focus="current = row.index"
					>
						<FilesIcon
							:name="isFolderEntry(row.entry) ? 'folder' : row.entry.kind === 'symlink' ? 'link' : 'file'"
						/>
						<span class="files-row__name">{{ row.entry.name }}</span>
						<span class="files-row__size">{{ isFolderEntry(row.entry) ? "" : formatSize(row.entry.size) }}</span>
						<span class="files-row__modified">{{ formatModified(row.entry.mtime, now) }}</span>
					</div>
				</div>
			</div>
			<p v-if="listing !== null && listing.truncated > 0" class="files-note files-note--foot">
				{{ listing.truncated }} more not shown.
			</p>
		</div>

		<!-- What writes on the host is the writer's: a reader sees why, in words. -->
		<div class="files-actions">
			<template v-if="naming">
				<input
					ref="nameInput"
					v-model="newName"
					class="files-path-input"
					type="text"
					aria-label="New folder name"
					placeholder="Folder name"
					spellcheck="false"
					autocomplete="off"
					@keydown.enter.prevent="createFolder"
					@keydown.esc.prevent="stopNaming"
				/>
				<button type="button" class="files-btn files-btn--primary" :disabled="creating" @click="createFolder">
					Create
				</button>
				<button type="button" class="files-btn" @click="stopNaming">Cancel</button>
			</template>
			<button
				v-else
				type="button"
				class="files-btn"
				:disabled="!writer || listing === null"
				:aria-describedby="writer ? undefined : readerNoteId"
				@click="startNaming"
			>
				<FilesIcon name="folder-plus" />
				New folder
			</button>
			<p v-if="!writer" :id="readerNoteId" class="files-actions__note">
				Only the writer can create folders here.
				<button type="button" class="files-link" @click="requestWrite">Request write</button>
			</p>
			<p v-if="createFailure !== null" class="files-actions__note files-actions__note--warn" role="alert">
				{{ createFailure }}
			</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { HostOs } from "@lasterm/shared";
import { computed, nextTick, onUnmounted, ref, useId, watch } from "vue";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import {
	breadcrumbOf,
	entryLabel,
	formatModified,
	formatSize,
	isFolderEntry,
	joinPath,
	parentPath,
	pathStyleOf,
	statusLines,
	typeAheadIndex,
} from "../../utils/files-panel.js";
import { listMove } from "../../utils/focus-zones.js";
import { createHostFolder, type FileListingView, listHostFiles } from "../../utils/host-files.js";
import { hostConnectionFailure } from "../../utils/host-connection.js";
import FilesIcon from "./FilesIcon.vue";

/**
 * The Files part's browser (#836): the attached terminal's host folder, following the terminal's
 * directory or not, with its path bar, its status line, the list, and a new folder.
 */
const props = defineProps<{
	channelId: string;
	hostId: string | null;
	hostLabel: string;
	hostOs: HostOs | null;
	/** This window holds the terminal's write lock: it may write on the host. */
	writer: boolean;
	/** `transfer_follow_cwd`, for a terminal the panel has not shown yet. */
	followByDefault: boolean;
	/** `[transfer] show_hidden`. */
	showHidden: boolean;
	sftpUnavailable: boolean;
	/** The terminal's shell or foreground program, for what the status line can say of it. */
	shell: string | undefined;
	/** The host's tint, over the list only. */
	tint: Record<string, string> | null;
}>();

const emit = defineEmits<{
	/** Something worth hearing once: following on or off. */
	(e: "announce", text: string): void;
}>();

const filesPanel = useFilesPanelStore();
const hostsStore = useHostsStore();
const writeLockStore = useWriteLockStore();

/** The height of a row, in pixels: the list draws only the rows in view. */
const ROW_HEIGHT = 24;
/** Rows drawn above and below the view. */
const OVERSCAN = 8;
/** Rows assumed in view before the list has been measured. */
const UNMEASURED_ROWS = 40;

const files = computed(() => filesPanel.terminalFiles(props.channelId, props.followByDefault));
const live = computed(() => filesPanel.liveCwdFor(props.channelId));

/**
 * The folder to list: the terminal's directory while following it and it is known, the folder
 * browsed otherwise; none for where the hub opens it, the host's fallback folder or the home.
 */
const wanted = computed<string | undefined>(() => {
	if (files.value.following) return live.value?.cwd ?? undefined;
	return files.value.path ?? undefined;
});

const listing = ref<FileListingView | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);
const loading = ref(false);
const current = ref(0);
const now = ref(new Date());
let sequence = 0;
/** The folder to put the keyboard on once the next listing arrives: the one just left by Up. */
let focusName: string | null = null;

const style = computed(() => pathStyleOf(props.hostOs, listing.value?.path ?? wanted.value ?? null));
const shownPath = computed(() => listing.value?.path ?? wanted.value ?? null);
const crumbs = computed(() =>
	shownPath.value === null ? [] : breadcrumbOf(shownPath.value, style.value),
);
const parent = computed(() =>
	shownPath.value === null ? null : parentPath(shownPath.value, style.value),
);

const lines = computed(() =>
	statusLines({
		following: files.value.following,
		live: live.value,
		shown: listing.value?.path ?? null,
		start: listing.value?.start,
		fallbackProblem: listing.value?.fallbackProblem,
		hostLabel: props.hostLabel,
		shell: props.shell,
		sftpUnavailable: props.sftpUnavailable,
	}),
);

const failureText = computed(() => {
	const failed = failure.value;
	if (failed === null) return "";
	if (failed.code === "HOST_NOT_CONNECTED") return `${props.hostLabel} is not connected.`;
	if (failed.code === "NOT_FOUND" && files.value.following && live.value?.cwd != null) {
		return "The terminal's directory no longer exists.";
	}
	return failed.message;
});

async function load(): Promise<void> {
	const mine = ++sequence;
	loading.value = true;
	const answer = await listHostFiles(props.channelId, wanted.value, props.showHidden);
	if (mine !== sequence) return;
	loading.value = false;
	now.value = new Date();
	if (!answer.ok) {
		failure.value = { code: answer.code, message: answer.message };
		listing.value = null;
		return;
	}
	failure.value = null;
	const changed = listing.value?.path !== answer.value.path;
	listing.value = answer.value;
	const named =
		focusName === null ? -1 : answer.value.entries.findIndex((entry) => entry.name === focusName);
	focusName = null;
	if (named !== -1) current.value = named;
	else if (changed || current.value >= answer.value.entries.length) current.value = 0;
	if (named !== -1) void nextTick(() => focusRow(named));
}

watch(
	() => [props.channelId, wanted.value, props.showHidden] as const,
	() => void load(),
	{ immediate: true },
);

function reload(): void {
	void load();
}

// ─── Moving around ───────────────────────────────────────────────────────────

/** Any move in the panel pauses following: the folder is remembered for the terminal. */
function browseTo(path: string): void {
	if (path === listing.value?.path && !files.value.following) return;
	if (files.value.following) emit("announce", "Not following the terminal");
	filesPanel.browse(props.channelId, path);
}

function goUp(): void {
	const from = shownPath.value;
	const to = parent.value;
	if (from === null || to === null) return;
	const crumb = crumbs.value.at(-1);
	focusName = crumb === undefined ? null : crumb.label.replace(/\\$/, "");
	browseTo(to);
}

function openRow(index: number): void {
	const entry = listing.value?.entries[index];
	if (entry === undefined || listing.value === null || !isFolderEntry(entry)) return;
	browseTo(joinPath(listing.value.path, entry.name, style.value));
}

function goThere(): void {
	filesPanel.follow(props.channelId);
	emit("announce", "Following the terminal");
}

function toggleFollowing(): void {
	if (files.value.following) {
		const at = listing.value?.path;
		if (at === undefined) filesPanel.browse(props.channelId, wanted.value ?? "");
		else filesPanel.browse(props.channelId, at);
		emit("announce", "Not following the terminal");
	} else {
		goThere();
	}
}

// A path longer than the bar shows its end: the folder listed, and the ones just above it.
const crumbsList = ref<HTMLElement | null>(null);
watch(
	[crumbs, crumbsList],
	() => {
		const list = crumbsList.value;
		if (list !== null) list.scrollLeft = list.scrollWidth;
	},
	{ flush: "post" },
);

// ─── The path as text ────────────────────────────────────────────────────────

const editingPath = ref(false);
const pathText = ref("");
const pathInput = ref<HTMLInputElement | null>(null);

function startEditing(): void {
	pathText.value = shownPath.value ?? "";
	editingPath.value = true;
	void nextTick(() => {
		pathInput.value?.focus();
		pathInput.value?.select();
	});
}

function stopEditing(): void {
	editingPath.value = false;
}

function submitPath(): void {
	const path = pathText.value.trim();
	editingPath.value = false;
	if (path !== "") browseTo(path);
	void nextTick(() => focusRow(current.value));
}

// ─── The list ────────────────────────────────────────────────────────────────

const listEl = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewHeight = ref(0);

const visibleRows = computed(() => {
	const entries = listing.value?.entries ?? [];
	const inView =
		viewHeight.value > 0 ? Math.ceil(viewHeight.value / ROW_HEIGHT) : UNMEASURED_ROWS;
	const first = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
	const last = Math.min(entries.length, first + inView + 2 * OVERSCAN);
	const rows = [];
	for (let index = first; index < last; index++) {
		const entry = entries[index];
		if (entry !== undefined) rows.push({ index, entry });
	}
	// The row with the keyboard stays drawn, wherever the list is scrolled.
	const kept = entries[current.value];
	if (kept !== undefined && (current.value < first || current.value >= last)) {
		rows.push({ index: current.value, entry: kept });
	}
	return rows;
});

function onScroll(): void {
	scrollTop.value = listEl.value?.scrollTop ?? 0;
	viewHeight.value = listEl.value?.clientHeight ?? 0;
}

function focusRow(index: number): void {
	const list = listEl.value;
	if (list === null) return;
	current.value = index;
	const top = index * ROW_HEIGHT;
	if (top < list.scrollTop) list.scrollTop = top;
	else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) {
		list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
	}
	onScroll();
	void nextTick(() => list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus());
}

let typed = "";
let typedTimer: ReturnType<typeof setTimeout> | null = null;

function onListKeydown(event: KeyboardEvent): void {
	const entries = listing.value?.entries ?? [];
	if (event.ctrlKey || event.altKey || event.metaKey) return;
	const page = Math.max(1, Math.floor((listEl.value?.clientHeight ?? 0) / ROW_HEIGHT) - 1) || 10;
	let to: number | null = null;
	if (event.key === "PageDown") to = Math.min(entries.length - 1, current.value + page);
	else if (event.key === "PageUp") to = Math.max(0, current.value - page);
	else to = listMove(entries.length, current.value, event.key, "vertical");
	if (to !== null) {
		event.preventDefault();
		focusRow(to);
		return;
	}
	if (event.key === "Enter") {
		event.preventDefault();
		openRow(current.value);
		return;
	}
	if (event.key === "Backspace") {
		event.preventDefault();
		goUp();
		return;
	}
	if (event.key.length === 1 && event.key !== " ") {
		typed += event.key;
		if (typedTimer !== null) clearTimeout(typedTimer);
		typedTimer = setTimeout(() => {
			typed = "";
		}, 700);
		const found = typeAheadIndex(
			entries.map((entry) => entry.name),
			current.value,
			typed,
		);
		if (found !== null) {
			event.preventDefault();
			focusRow(found);
		}
	}
}

/** F2 or Ctrl+L anywhere in the browser edits the path as text. */
function onBrowserKeydown(event: KeyboardEvent): void {
	const editKey =
		(event.key === "F2" && !event.ctrlKey && !event.altKey && !event.shiftKey) ||
		(event.key.toLowerCase() === "l" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey);
	if (editKey && !editingPath.value) {
		event.preventDefault();
		startEditing();
	}
}

onUnmounted(() => {
	if (typedTimer !== null) clearTimeout(typedTimer);
});

// ─── A new folder, the writer's ──────────────────────────────────────────────

const naming = ref(false);
const newName = ref("");
const creating = ref(false);
const createFailure = ref<string | null>(null);
const nameInput = ref<HTMLInputElement | null>(null);
const readerNoteId = useId();

function startNaming(): void {
	createFailure.value = null;
	newName.value = "";
	naming.value = true;
	void nextTick(() => nameInput.value?.focus());
}

function stopNaming(): void {
	naming.value = false;
	createFailure.value = null;
}

async function createFolder(): Promise<void> {
	const name = newName.value.trim();
	const at = listing.value?.path;
	if (name === "" || at === undefined || creating.value) return;
	creating.value = true;
	const answer = await createHostFolder(props.channelId, joinPath(at, name, style.value));
	creating.value = false;
	if (!answer.ok) {
		createFailure.value = answer.message;
		return;
	}
	naming.value = false;
	focusName = name;
	await load();
}

function requestWrite(): void {
	writeLockStore.claim(props.channelId);
}

async function connect(): Promise<void> {
	if (props.hostId === null) return;
	const answer = await hostsStore.connectHost(props.hostId);
	if (!answer.ok) {
		failure.value = { code: "HOST_NOT_CONNECTED", message: hostConnectionFailure(answer) };
		return;
	}
	reload();
}

defineExpose({ reload });
</script>

<style scoped>
.files-browser {
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex: 1;
	container-type: inline-size;
}

.files-pathbar {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 6px 8px 4px;
}

.files-tool,
.files-follow {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	flex-shrink: 0;
	height: 24px;
	padding: 0 6px;
	border: 1px solid transparent;
	border-radius: 4px;
	background: transparent;
	color: var(--nt-sidebar-text, var(--nt-fg));
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.files-tool:hover:not(:disabled),
.files-follow:hover {
	border-color: var(--nt-border);
}

.files-tool:disabled {
	opacity: 0.45;
	cursor: default;
}

.files-follow--on {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.files-crumbs {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	height: 24px;
}

.files-crumbs ol {
	display: flex;
	align-items: center;
	height: 100%;
	margin: 0;
	padding: 0 4px;
	list-style: none;
	overflow-x: auto;
	scrollbar-width: none;
	white-space: nowrap;
}

.files-crumbs li {
	display: inline-flex;
	align-items: center;
}

.files-crumbs__sep {
	padding: 0 2px;
	color: var(--nt-text-secondary);
}

.files-crumb {
	padding: 0 3px;
	border: none;
	background: none;
	color: var(--nt-text-secondary);
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.files-crumb[aria-current="location"] {
	color: var(--nt-sidebar-text, var(--nt-fg));
	font-weight: 600;
}

.files-crumb:hover {
	text-decoration: underline;
}

.files-path-input {
	flex: 1;
	min-width: 0;
	height: 24px;
	padding: 0 6px;
	border: 1px solid var(--nt-accent);
	border-radius: 4px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	font: inherit;
	font-size: 12px;
}

.files-status {
	padding: 0 10px 4px;
}

.files-status__line {
	margin: 0;
	font-size: 11px;
	line-height: 1.5;
	color: var(--nt-text-secondary);
	overflow-wrap: anywhere;
}

.files-status__line--warn {
	color: var(--nt-badge-warning, var(--nt-text-secondary));
}

.files-status__path {
	margin-right: 4px;
	font-family: ui-monospace, monospace;
}

.files-link {
	padding: 0;
	border: none;
	background: none;
	color: var(--nt-accent);
	font: inherit;
	font-weight: 600;
	cursor: pointer;
}

.files-link:hover {
	text-decoration: underline;
}

.files-list-wrap {
	position: relative;
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
	border-top: 1px solid var(--nt-border);
}

/* The host's tint, over the list and under nothing that takes a click. */
.files-tint {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 1;
}

.files-list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	outline: none;
}

.files-list__space {
	position: relative;
}

.files-row {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	height: 24px;
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 10px;
	font-size: 12px;
	color: var(--nt-sidebar-text, var(--nt-fg));
	cursor: default;
	outline: none;
}

.files-row:hover {
	background: var(--nt-hover);
}

.files-row--current {
	background: var(--nt-hover);
}

.files-row:focus-visible {
	box-shadow: inset 0 0 0 2px var(--nt-accent);
}

.files-row__name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.files-row__size,
.files-row__modified {
	flex-shrink: 0;
	color: var(--nt-text-secondary);
	font-size: 11px;
	text-align: right;
}

.files-row__size {
	width: 52px;
}

.files-row__modified {
	width: 58px;
}

/* A narrow panel drops the date first, then the size. */
@container (max-width: 260px) {
	.files-row__modified {
		display: none;
	}
}

@container (max-width: 200px) {
	.files-row__size {
		display: none;
	}
}

.files-note {
	margin: 0;
	padding: 12px 10px;
	font-size: 12px;
	color: var(--nt-text-secondary);
}

.files-note--foot {
	padding: 4px 10px;
	font-size: 11px;
}

/* What asks or warns sits on the exit card's opaque ground, whatever the panel's opacity. */
.files-card {
	margin: 10px;
	padding: 10px 12px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
}

.files-card__text {
	margin: 0 0 8px;
	font-size: 12px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.files-card__actions {
	display: flex;
	gap: 6px;
}

.files-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 3px 10px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.files-btn--primary {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.files-btn:disabled {
	opacity: 0.5;
	cursor: default;
}

.files-btn:focus-visible,
.files-tool:focus-visible,
.files-follow:focus-visible,
.files-crumb:focus-visible,
.files-link:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.files-actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	padding: 6px 8px;
	border-top: 1px solid var(--nt-border);
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.files-actions__note {
	flex-basis: 100%;
	margin: 0;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.files-actions__note--warn {
	color: var(--nt-badge, var(--nt-text-secondary));
}
</style>
