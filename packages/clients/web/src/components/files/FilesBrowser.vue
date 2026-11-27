<template>
	<div
		class="files-browser"
		@keydown="onBrowserKeydown"
	>
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
				:class="{ 'files-follow--on': followShown }"
				:aria-pressed="followShown"
				:disabled="block !== null"
				:aria-describedby="block !== null ? followHintId : undefined"
				:title="followTitle"
				@click="toggleFollowing"
			>
				<FilesIcon name="follow" />
				<span>{{ followShown ? "Following" : "Follow" }}</span>
			</button>
			<span v-if="block !== null" :id="followHintId" hidden>{{ followTitle }}</span>
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

		<!-- Files dropped here go to the folder shown, or to the folder row under them (#837). -->
		<div
			class="files-list-wrap"
			:class="{
				'files-list-wrap--drop': dropHere === 'list',
				'files-list-wrap--refused': dropHere === 'refused',
			}"
			@dragenter="onListDragEnter"
			@dragover="onListDragOver"
			@dragleave="listDrop.onDragLeave"
			@drop="onListDrop"
		>
			<div v-if="tint !== null" class="files-tint" :style="tint" aria-hidden="true" />
			<p v-if="dropText !== null" class="files-drop-note" aria-hidden="true">{{ dropText }}</p>
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
					class="files-grid"
					role="grid"
					:aria-label="`Files in ${listing.path}`"
					:aria-rowcount="sorted.length + 1"
					:style="gridStyle"
				>
					<!-- Column headers: a click sorts, an edge resizes, a right click chooses the columns (#1209). -->
					<div
						class="files-head"
						role="row"
						aria-rowindex="1"
						title="Right-click to choose the columns"
						:style="{ paddingRight: `${ROW_PADDING + scrollbarWidth}px` }"
						@contextmenu="openColumnsMenu"
					>
						<span aria-hidden="true" />
						<div
							v-for="column in HEADED"
							v-show="column === 'name' || isShown(column)"
							:key="column"
							class="files-colhead"
							:class="`files-colhead--${column}`"
							role="columnheader"
							:aria-sort="sortState(column)"
						>
							<span
								v-if="column !== 'name'"
								class="files-resize"
								:class="{ 'files-resize--active': resizing === column }"
								role="separator"
								aria-orientation="vertical"
								tabindex="0"
								:data-resize="column"
								:aria-label="`Resize ${FILES_COLUMN_LABELS[column]} column`"
								:aria-valuemin="FILES_COLUMN_WIDTH_MIN"
								:aria-valuemax="roomFor(column)"
								:aria-valuenow="widths[column]"
								@pointerdown="startResize(column, $event)"
								@keydown="onResizeKey(column, $event)"
								@dblclick="resetWidth(column)"
							/>
							<button
								type="button"
								class="files-sort"
								:data-sort="column"
								@click="sortBy(column)"
							>
								<span class="files-sort__label">{{ FILES_COLUMN_LABELS[column] }}</span>
								<span class="files-sort__arrow" aria-hidden="true">{{
									sort.key !== column ? "" : sort.descending ? "▼" : "▲"
								}}</span>
							</button>
						</div>
					</div>
					<div
						ref="listEl"
						class="files-list"
						role="rowgroup"
						@scroll="onScroll"
						@keydown="onListKeydown"
					>
						<div class="files-list__space" :style="{ height: `${sorted.length * ROW_HEIGHT}px` }">
							<div
								v-for="row in visibleRows"
								:key="row.entry.name"
								class="files-row"
								:class="{
									'files-row--current': row.index === current,
									'files-row--drop': dropHere === 'row' && dropFolder === row.entry.name,
								}"
								:data-drop-folder="isFolderEntry(row.entry) ? row.entry.name : undefined"
								role="row"
								:aria-selected="row.index === current"
								:aria-rowindex="row.index + 2"
								:aria-label="entryLabel(row.entry, now)"
								:title="rowTitle(row.entry)"
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
								<span class="files-row__name" role="gridcell">{{ row.entry.name }}</span>
								<span v-show="isShown('size')" class="files-row__size" role="gridcell">{{ isFolderEntry(row.entry) ? "" : formatSize(row.entry.size) }}</span>
								<span v-show="isShown('modified')" class="files-row__modified" role="gridcell">{{ formatModified(row.entry.mtime, now) }}</span>
								<span v-show="isShown('mode')" class="files-row__mode" role="gridcell">{{ formatPermissions(row.entry) || "—" }}</span>
								<span
									v-show="isShown('owner')"
									class="files-row__owner"
									role="gridcell"
									:title="row.entry.owner !== null ? `Owner ${row.entry.owner}` : undefined"
									>{{ row.entry.owner ?? "—" }}</span
								>
							</div>
						</div>
					</div>
				</div>
			<FilesColumnsMenu
				v-if="menuAt !== null"
				:x="menuAt.x"
				:y="menuAt.y"
				:chosen="chosen"
				@toggle="toggleColumn"
				@reset="resetColumns"
				@close="closeColumnsMenu"
			/>
			<p v-if="listing !== null && listing.truncated > 0" class="files-note files-note--foot">
				{{ listing.truncated }} more not shown.
			</p>
		</div>

		<!-- A drop or a pick here, before any byte moves (#837). -->
		<UploadConfirm place="panel" @done="onUploadCardDone" />

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
			<template v-else>
				<button
					type="button"
					class="files-btn"
					:disabled="!writer || listing === null"
					:aria-describedby="writer ? undefined : readerNoteId"
					@click="startNaming"
				>
					<FilesIcon name="folder-plus" />
					New folder
				</button>
				<button
					type="button"
					class="files-btn"
					:disabled="!writer || listing === null"
					:aria-describedby="writer ? undefined : readerNoteId"
					@click="pick('files')"
				>
					<FilesIcon name="upload" />
					Upload files…
				</button>
				<button
					type="button"
					class="files-btn"
					:disabled="!writer || listing === null"
					:aria-describedby="writer ? undefined : readerNoteId"
					@click="pick('folder')"
				>
					<FilesIcon name="folder" />
					Upload folder…
				</button>
				<!-- Reading is anyone's: a reader downloads too (#840). -->
				<button
					type="button"
					class="files-btn"
					:disabled="downloadBlocked !== null || downloading"
					:title="downloadBlocked ?? undefined"
					:aria-describedby="downloadBlocked !== null ? downloadNoteId : undefined"
					@click="download"
				>
					<FilesIcon name="download" />
					Download…
				</button>
				<span :id="downloadNoteId" hidden>{{ downloadBlocked }}</span>
			</template>
			<p v-if="!writer" :id="readerNoteId" class="files-actions__note">
				Only the writer can upload or create folders here.
				<button type="button" class="files-link" @click="requestWrite">Request write</button>
			</p>
			<p v-if="createFailure !== null" class="files-actions__note files-actions__note--warn" role="alert">
				{{ createFailure }}
			</p>
			<p v-if="downloadFailure !== null" class="files-actions__note files-actions__note--warn" role="alert">
				{{ downloadFailure }}
			</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import {
	DEFAULT_FILES_COLUMN_WIDTHS,
	DEFAULT_FILES_COLUMNS,
	FILES_COLUMN_WIDTH_MAX,
	FILES_COLUMN_WIDTH_MIN,
	FILES_COLUMNS,
	type FilesColumn,
	type HostOs,
	isFilesColumnWidth,
	type LayoutConfig,
	parseFilesColumns,
} from "@lasterm/shared";
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { useAuthStore } from "../../stores/auth.js";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import {
	breadcrumbOf,
	entryLabel,
	type FileEntryView,
	formatAttributes,
	formatMode,
	formatModified,
	formatPermissions,
	formatSize,
	isFolderEntry,
	joinPath,
	columnRoom,
	FILES_COLUMN_LABELS,
	ROW_PADDING,
	ROW_ICON,
	ROW_GAP,
	shownColumns,
	sortEntries,
	type SortKey,
	parentPath,
	pathStyleOf,
	followBlock,
	followBlockText,
	statusLines,
	typeAheadIndex,
} from "../../utils/files-panel.js";
import { listMove } from "../../utils/focus-zones.js";
import { useUploadDrop } from "../../composables/useUploadDrop.js";
import { useTransfersStore } from "../../stores/transfers.js";
import { downloadHostFile } from "../../utils/host-download.js";
import { createHostFolder, type FileListingView, listHostFiles } from "../../utils/host-files.js";
import { hostConnectionFailure } from "../../utils/host-connection.js";
import { overlayText, refusalText } from "../../utils/upload-drop.js";
import FilesColumnsMenu from "./FilesColumnsMenu.vue";
import FilesIcon from "./FilesIcon.vue";
import UploadConfirm from "./UploadConfirm.vue";

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
	/** The host's menu offers Update agent (an SSH host served by an older agent). */
	agentUpdatable: boolean;
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
const configStore = useConfigStore();
const authStore = useAuthStore();

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
	if (followShown.value) return live.value?.cwd ?? undefined;
	return files.value.path ?? undefined;
});

const listing = ref<FileListingView | null>(null);
const failure = ref<{ code: string; message: string } | null>(null);
const loading = ref(false);
const current = ref(0);
const sort = computed(() => filesPanel.filesSort);
/** The listing in the order shown: folders first, then by the column sorted on. */
const sorted = computed(() => sortEntries(listing.value?.entries ?? [], sort.value));
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

/** Why Follow cannot work for this terminal for now: nothing it can report yet, or a session on another host (#1196). */
const block = computed(() =>
	followBlock({
		live: live.value,
		program: props.shell,
		hostOs: props.hostOs,
		agentUpdatable: props.agentUpdatable,
	}),
);
/** The toggle reads Following only while it can follow; the preference itself is kept. */
const followShown = computed(() => files.value.following && block.value === null);
const followHintId = `files-follow-hint-${props.channelId}`;
const followTitle = computed(() =>
	block.value === null
		? "Follow the terminal's directory"
		: followBlockText(block.value, props.hostLabel),
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
		agentUpdatable: props.agentUpdatable,
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
	// The entry the keyboard is on, to find again where a reload puts it in the order shown.
	const kept = changed ? undefined : sorted.value[current.value]?.name;
	listing.value = answer.value;
	const asked = focusName;
	const want = asked ?? kept ?? null;
	const named = want === null ? -1 : sorted.value.findIndex((entry) => entry.name === want);
	focusName = null;
	if (named !== -1) current.value = named;
	else if (changed || current.value >= answer.value.entries.length) current.value = 0;
	if (named !== -1 && asked !== null) void nextTick(() => focusRow(named));
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
	if (path === listing.value?.path && !followShown.value) return;
	if (followShown.value) emit("announce", "Not following the terminal");
	// Follow disabled for now: the preference stays, to follow with the first report.
	filesPanel.browse(props.channelId, path, block.value !== null && files.value.following);
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
	const entry = sorted.value[index];
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
	const entries = sorted.value;
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
	// In index order, so that a grid reader meets the rows as they run.
	return rows.sort((a, b) => a.index - b.index);
});

// ─── The columns: chosen, sized, sorted, and dropped by the width the rows get ─

const HEADED: readonly SortKey[] = ["name", ...FILES_COLUMNS];
const WIDTH_KEYS = {
	size: "filesSizeWidth",
	modified: "filesModifiedWidth",
	mode: "filesModeWidth",
	owner: "filesOwnerWidth",
} as const satisfies Record<FilesColumn, keyof LayoutConfig>;

/** The columns chosen, `[layout] files_columns`; narrow lists still drop some. */
const chosen = computed<readonly FilesColumn[]>(
	() =>
		parseFilesColumns(localChoice.value ?? configStore.uiConfig.layout?.filesColumns) ??
		FILES_COLUMNS,
);

/** The columns chosen where nothing saves them (no token): they last as long as this list does. */
const localChoice = ref<string | null>(null);

/** Widths being dragged, or set where nothing saves them (no token, for as long as this list lasts): they win over the saved ones. */
const dragged = ref<Partial<Record<FilesColumn, number>>>({});

const widths = computed<Record<FilesColumn, number>>(() => {
	const out = { ...DEFAULT_FILES_COLUMN_WIDTHS };
	for (const column of FILES_COLUMNS) {
		const saved = configStore.uiConfig.layout?.[WIDTH_KEYS[column]];
		out[column] = dragged.value[column] ?? (isFilesColumnWidth(saved) ? saved : out[column]);
	}
	return out;
});

/**
 * The list's client width as last measured: what its rows get, a vertical scrollbar left out.
 * Null before any measurement, and while no list shows (an empty folder, an error).
 */
const listWidth = ref<number | null>(null);
/** The width the list's vertical scrollbar takes, which the header leaves free too. */
const scrollbarWidth = ref(0);
let widthObserver: ResizeObserver | null = null;

// The list comes and goes with the listing: the observer follows it.
watch(
	listEl,
	(el) => {
		widthObserver?.disconnect();
		widthObserver = null;
		listWidth.value = null;
		scrollbarWidth.value = 0;
		if (el === null || typeof ResizeObserver === "undefined") return;
		widthObserver = new ResizeObserver(() => {
			listWidth.value = el.clientWidth;
			scrollbarWidth.value = el.offsetWidth - el.clientWidth;
		});
		widthObserver.observe(el);
	},
	{ flush: "post" },
);

onUnmounted(() => widthObserver?.disconnect());

/** The columns shown while an edge is dragged: they stay as the drag found them until it ends. */
const frozen = ref<readonly FilesColumn[] | null>(null);

/** The columns shown: the chosen ones the width keeps, at the widths they have. */
const shown = computed(
	() => frozen.value ?? shownColumns(chosen.value, widths.value, listWidth.value),
);

function isShown(column: SortKey): boolean {
	return column === "name" || shown.value.includes(column);
}

/** One template for the header and every row, so the cells line up. */
const gridStyle = computed(() => ({
	"--files-cols": `${ROW_ICON}px minmax(0, 1fr) ${shown.value
		.map((column) => `${widths.value[column]}px`)
		.join(" ")}`.trim(),
	"--files-pad": `${ROW_PADDING}px`,
	"--files-gap": `${ROW_GAP}px`,
}));

/** A row's tooltip: what the width or the choice hides of it, the group always; none when there is nothing. */
function rowTitle(entry: FileEntryView): string | undefined {
	const lines: string[] = [];
	if (!isShown("size") && !isFolderEntry(entry) && entry.size !== null) {
		lines.push(`Size ${formatSize(entry.size)}`);
	}
	if (!isShown("modified")) {
		const modified = formatModified(entry.mtime, now.value);
		if (modified !== "") lines.push(`Modified ${modified}`);
	}
	if (!isShown("mode")) {
		if (entry.mode !== null) lines.push(`Permissions ${formatMode(entry.mode)}`);
		else if (entry.attributes !== null) lines.push(`Attributes ${formatAttributes(entry.attributes)}`);
	}
	if (!isShown("owner") && entry.owner !== null) lines.push(`Owner ${entry.owner}`);
	if (entry.group !== null) lines.push(`Group ${entry.group}`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

// ─── Sorting, by a click on a header ─────────────────────────────────────────

function sortState(column: SortKey): "ascending" | "descending" | "none" {
	if (sort.value.key !== column) return "none";
	return sort.value.descending ? "descending" : "ascending";
}

/** Sort by the column, or reverse it; the row with the keyboard stays the same entry. */
function sortBy(column: SortKey): void {
	const kept = sorted.value[current.value]?.name;
	filesPanel.sortFilesBy(column);
	const at = kept === undefined ? -1 : sorted.value.findIndex((entry) => entry.name === kept);
	if (at !== -1) current.value = at;
	// The kept row stays in view, wherever the new order puts it.
	if (at !== -1) focusRow(at, false);
	else onScroll();
}

// ─── Resizing, by an edge or the keyboard ────────────────────────────────────

const resizing = ref<FilesColumn | null>(null);

function clampWidth(width: number): number {
	return Math.min(FILES_COLUMN_WIDTH_MAX, Math.max(FILES_COLUMN_WIDTH_MIN, Math.round(width)));
}

/** Keep widths and the columns chosen as `[layout]`, as the panels' widths are kept. */
function commitLayout(values: Partial<LayoutConfig>): void {
	if (authStore.token === null) return;
	void configStore.saveUiSettings("layout", values);
}

/** The values for these widths, kept for this window alone where nothing saves (no token). */
function widthValues(toKeep: Partial<Record<FilesColumn, number>>): Partial<LayoutConfig> {
	const values: Partial<LayoutConfig> = {};
	for (const column of FILES_COLUMNS) {
		const width = toKeep[column];
		if (width === undefined) continue;
		values[WIDTH_KEYS[column]] = width;
		if (authStore.token !== null) delete dragged.value[column];
		else dragged.value[column] = width;
	}
	return values;
}

/** Keep these widths; where nothing saves (no token), they last for this window only. */
function commitWidths(toKeep: Partial<Record<FilesColumn, number>>): void {
	commitLayout(widthValues(toKeep));
}

/** The most `column` can be now: the room that keeps it shown, with Name at its least. */
function roomFor(column: FilesColumn): number {
	return columnRoom(
		listWidth.value,
		shown.value.filter((other) => other !== column).map((other) => widths.value[other]),
		FILES_COLUMN_WIDTH_MIN,
		FILES_COLUMN_WIDTH_MAX,
	);
}

/** The values for these columns, kept for this window alone where nothing saves (no token). */
function choiceValues(csv: string): Partial<LayoutConfig> {
	localChoice.value = authStore.token === null ? csv : null;
	return { filesColumns: csv };
}

/** The edge of a header on its left: dragging it left widens the column, right narrows it. */
function startResize(column: FilesColumn, event: PointerEvent): void {
	if (event.button !== 0 || resizing.value !== null) return;
	event.preventDefault();
	const handle = event.currentTarget as HTMLElement;
	try {
		handle.setPointerCapture(event.pointerId);
	} catch {
		// A pointer that is no longer active: the drag goes on by the events it already sends.
	}
	const from = event.clientX;
	const start = widths.value[column];
	resizing.value = column;
	const room = roomFor(column);
	frozen.value = [...shown.value];
	const before = dragged.value[column];
	const move = (e: PointerEvent): void => {
		if (e.pointerId !== event.pointerId) return;
		dragged.value[column] = Math.min(room, clampWidth(start + from - e.clientX));
	};
	const finish = (keep: boolean): void => {
		handle.removeEventListener("pointermove", move);
		handle.removeEventListener("pointerup", end);
		handle.removeEventListener("pointercancel", cancel);
		handle.removeEventListener("lostpointercapture", cancel);
		resizing.value = null;
		frozen.value = null;
		const width = widths.value[column];
		// Unchanged or interrupted: nothing to keep, and no write.
		if (!keep || width === start) {
			if (before === undefined) delete dragged.value[column];
			else dragged.value[column] = before;
			return;
		}
		commitWidths({ [column]: width });
	};
	const end = (e: PointerEvent): void => {
		if (e.pointerId === event.pointerId) finish(true);
	};
	const cancel = (): void => finish(false);
	handle.addEventListener("pointermove", move);
	handle.addEventListener("pointerup", end);
	handle.addEventListener("pointercancel", cancel);
	handle.addEventListener("lostpointercapture", cancel);
}

/** A double click on an edge: the column's default width, as far as the room keeps it shown. */
function resetWidth(column: FilesColumn): void {
	const to = Math.min(roomFor(column), DEFAULT_FILES_COLUMN_WIDTHS[column]);
	if (to !== widths.value[column]) commitWidths({ [column]: to });
}

/** The edge from the keyboard: Left widens, Right narrows, Shift for larger steps; Home, End: least, most. */
function onResizeKey(column: FilesColumn, event: KeyboardEvent): void {
	if (event.ctrlKey || event.altKey || event.metaKey) return;
	const step = event.shiftKey ? 32 : 8;
	const now = widths.value[column];
	let to: number | null = null;
	if (event.key === "ArrowLeft") to = now + step;
	else if (event.key === "ArrowRight") to = now - step;
	else if (event.key === "Home") to = FILES_COLUMN_WIDTH_MIN;
	else if (event.key === "End") to = FILES_COLUMN_WIDTH_MAX;
	if (to === null) return;
	event.preventDefault();
	event.stopPropagation();
	const next = Math.min(roomFor(column), clampWidth(to));
	if (next !== now) commitWidths({ [column]: next });
}

// ─── The columns chosen, from the headers' menu ──────────────────────────────

const menuAt = ref<{ x: number; y: number } | null>(null);
/** Where the keyboard goes back to when the menu is left by it. */
let menuOrigin: HTMLElement | null = null;
/** The header row it was opened on, for the keyboard to go back to when the origin is gone. */
let menuHead: HTMLElement | null = null;

function openColumnsMenu(event: MouseEvent): void {
	event.preventDefault();
	const wrap = (event.currentTarget as HTMLElement).closest(".files-list-wrap");
	if (wrap === null) return;
	const box = wrap.getBoundingClientRect();
	menuHead = event.currentTarget as HTMLElement;
	menuOrigin = (event.target as HTMLElement).closest<HTMLElement>("button, [role=separator]");
	menuAt.value = {
		x: Math.max(0, Math.min(event.clientX - box.left, box.width - 170)),
		y: Math.max(0, Math.min(event.clientY - box.top, box.height - 140)),
	};
}

function closeColumnsMenu(refocus: boolean): void {
	menuAt.value = null;
	if (!refocus) return;
	// The header it came from, unless the choice just hid it: then the Name header.
	const hidden = menuOrigin?.closest<HTMLElement>("[role=columnheader]")?.style.display === "none";
	const back = menuOrigin === null || hidden ? menuHead?.querySelector<HTMLElement>(".files-sort") : menuOrigin;
	void nextTick(() => back?.focus());
}

function toggleColumn(column: FilesColumn): void {
	const kept = FILES_COLUMNS.filter((c) =>
		c === column ? !chosen.value.includes(c) : chosen.value.includes(c),
	);
	commitLayout(choiceValues(kept.join(",")));
}

function resetColumns(): void {
	commitLayout({
		...choiceValues(DEFAULT_FILES_COLUMNS),
		...widthValues({ ...DEFAULT_FILES_COLUMN_WIDTHS }),
	});
	closeColumnsMenu(true);
}

function onScroll(): void {
	scrollTop.value = listEl.value?.scrollTop ?? 0;
	viewHeight.value = listEl.value?.clientHeight ?? 0;
}

function focusRow(index: number, focus = true): void {
	const list = listEl.value;
	if (list === null) return;
	current.value = index;
	const top = index * ROW_HEIGHT;
	if (top < list.scrollTop) list.scrollTop = top;
	else if (top + ROW_HEIGHT > list.scrollTop + list.clientHeight) {
		list.scrollTop = top + ROW_HEIGHT - list.clientHeight;
	}
	onScroll();
	if (focus) void nextTick(() => list.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus());
}

let typed = "";
let typedTimer: ReturnType<typeof setTimeout> | null = null;

function onListKeydown(event: KeyboardEvent): void {
	const entries = sorted.value;
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

// ─── Uploads: a drop on the list or a folder row, and the pickers (#837) ─────

const transfers = useTransfersStore();
/** The folder row under the drag, or none: the folder shown. */
const dropFolder = ref<string | null>(null);

const listDrop = useUploadDrop(() => ({
	kind: dropFolder.value === null ? "panel" : "folder",
	// Nothing listed, nothing to drop into.
	channelId: listing.value === null ? null : props.channelId,
	paneId: null,
	dir:
		listing.value === null
			? null
			: dropFolder.value === null
				? listing.value.path
				: joinPath(listing.value.path, dropFolder.value, style.value),
	folder: dropFolder.value,
}));

function folderUnder(event: DragEvent): string | null {
	const target = event.target instanceof Element ? event.target : null;
	return target?.closest("[data-drop-folder]")?.getAttribute("data-drop-folder") ?? null;
}

function onListDragEnter(event: DragEvent): void {
	dropFolder.value = folderUnder(event);
	listDrop.onDragEnter(event);
}

function onListDragOver(event: DragEvent): void {
	dropFolder.value = folderUnder(event);
	listDrop.onDragOver(event);
}

function onListDrop(event: DragEvent): void {
	dropFolder.value = folderUnder(event);
	listDrop.onDrop(event);
	dropFolder.value = null;
}

/** What the list shows of a drag over it: the list, a row, or a refusal. */
const dropHere = computed<"list" | "row" | "refused" | null>(() => {
	const hover = transfers.dropHover;
	if (hover === null || hover.place !== "panel" || hover.channelId !== props.channelId) return null;
	if (hover.decision.kind === "refuse") return "refused";
	return hover.folder === null ? "list" : "row";
});

const dropText = computed(() => {
	const hover = transfers.dropHover;
	if (dropHere.value === null || hover === null) return null;
	if (hover.decision.kind === "refuse") return refusalText(hover.decision.reason, props.hostLabel);
	return overlayText({
		count: hover.count,
		hostLabel: props.hostLabel,
		dir: hover.dir,
		origin: hover.folder === null ? "panel" : "folder",
	});
});

/** "Upload files…", "Upload folder…": to the folder shown. */
function pick(kind: "files" | "folder"): void {
	const at = listing.value?.path;
	if (at === undefined) return;
	void transfers.pickAndUpload(kind, { channelId: props.channelId, paneId: null, dir: at, place: "panel" });
}

const downloadNoteId = useId();
const downloading = ref(false);
const downloadFailure = ref<string | null>(null);

/** Why "Download…" cannot act on the selected row, or null when it can (#840). */
const downloadBlocked = computed<string | null>(() => {
	const entry = sorted.value[current.value];
	if (listing.value === null || entry === undefined) return "Select a file to download";
	if (entry.kind === "symlink") return "Links are not followed — open the folder the link points to";
	if (entry.kind === "directory") return "Downloading folders is not available yet";
	if (entry.kind !== "file") return "Select a file to download";
	return null;
});

/** Whether this browser or desktop runs on Windows, for the names its files may hold. */
function onWindows(): boolean {
	const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
	return /win/i.test(data?.platform ?? navigator.platform ?? "");
}

/** "Download…": the selected file, through the desktop's dialog or the browser's downloads. */
async function download(): Promise<void> {
	const shown = listing.value;
	const entry = sorted.value[current.value];
	if (shown === null || shown === undefined || entry === undefined || downloadBlocked.value !== null) return;
	downloading.value = true;
	downloadFailure.value = null;
	try {
		const started = await downloadHostFile({
			channelId: props.channelId,
			hostId: props.hostId,
			path: joinPath(shown.path, entry.name, style.value),
			name: entry.name,
			windows: onWindows(),
		});
		if (started.kind === "failed") downloadFailure.value = started.message;
	} finally {
		downloading.value = false;
	}
}

/** The confirmation went: the keyboard goes back to the list. */
function onUploadCardDone(): void {
	void nextTick(() => focusRow(current.value));
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
	--files-cols: 14px minmax(0, 1fr);
	--files-pad: 10px;
	--files-gap: 8px;
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
.files-follow:hover:not(:disabled) {
	border-color: var(--nt-border);
}

.files-tool:disabled,
.files-follow:disabled {
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

/* A drag over the list (#837): its edge says where the files go, or that they cannot. */
.files-list-wrap--drop {
	box-shadow: inset 0 0 0 2px var(--nt-accent);
}

.files-list-wrap--refused {
	box-shadow: inset 0 0 0 2px var(--nt-border);
}

.files-row--drop {
	box-shadow: inset 0 0 0 2px var(--nt-accent);
}

.files-drop-note {
	position: absolute;
	left: 8px;
	right: 8px;
	bottom: 8px;
	z-index: 3;
	margin: 0;
	padding: 6px 8px;
	border-radius: 4px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	font-size: 12px;
	overflow-wrap: anywhere;
	pointer-events: none;
}

.files-grid {
	position: relative;
	flex: 1;
	min-height: 0;
	display: flex;
	flex-direction: column;
}

/* The header and every row share one template, from the columns shown and their widths. */
.files-head,
.files-row {
	display: grid;
	grid-template-columns: var(--files-cols);
	align-items: center;
	column-gap: var(--files-gap, 8px);
	padding: 0 var(--files-pad, 10px);
	font-size: 12px;
}

.files-head {
	flex-shrink: 0;
	height: 24px;
	border-bottom: 1px solid var(--nt-border);
	color: var(--nt-text-secondary);
	font-size: 11px;
	user-select: none;
}

.files-colhead {
	position: relative;
	min-width: 0;
	height: 100%;
}

.files-sort {
	display: flex;
	align-items: center;
	gap: 2px;
	width: 100%;
	height: 100%;
	padding: 0;
	border: none;
	background: none;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
}

.files-sort:hover {
	color: var(--nt-text-strong);
}

.files-sort:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.files-colhead[aria-sort="ascending"] .files-sort,
.files-colhead[aria-sort="descending"] .files-sort {
	color: var(--nt-text-strong);
	font-weight: 600;
}

.files-sort__label {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.files-sort__arrow {
	flex-shrink: 0;
	font-size: 8px;
}

/* Size and Modified read from the right, as their values do. */
.files-colhead--size .files-sort,
.files-colhead--modified .files-sort {
	flex-direction: row-reverse;
	justify-content: flex-start;
	text-align: right;
}

/* The edge a column is dragged by: on its left, over the gap, a wider target than its line. */
.files-resize {
	position: absolute;
	top: 0;
	bottom: 0;
	left: -7px;
	width: 7px;
	z-index: 1;
	cursor: col-resize;
	touch-action: none;
	outline: none;
}

.files-resize::after {
	content: "";
	position: absolute;
	top: 4px;
	bottom: 4px;
	right: 3px;
	width: 1px;
	background: var(--nt-border);
}

.files-resize:hover::after,
.files-resize--active::after,
.files-resize:focus-visible::after {
	right: 2px;
	width: 3px;
	border-radius: 1px;
	background: var(--nt-accent);
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
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.files-row__size,
.files-row__modified,
.files-row__mode,
.files-row__owner {
	min-width: 0;
	overflow: hidden;
	color: var(--nt-text-secondary);
	font-size: 11px;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.files-row__size,
.files-row__modified {
	text-align: right;
}

/* As `ls -l` spells them, ten characters, or PowerShell's Mode, six. */
.files-row__mode {
	font-family: ui-monospace, monospace;
	white-space: pre;
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
