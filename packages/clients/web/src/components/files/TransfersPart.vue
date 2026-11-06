<template>
	<!-- Transfers (#836, #837): the window's, every upload of every terminal it shows, whatever
	     host the Files part above is on. Neutral: no banner, no border, no tint, a host on each
	     group and each row. -->
	<div class="transfers">
		<h3 class="transfers__heading">
			<button
				type="button"
				class="transfers__toggle"
				:aria-expanded="!collapsed"
				:aria-controls="bodyId"
				data-files-entry
				@click="filesPanel.setTransfersCollapsed(!collapsed)"
			>
				<FilesIcon :name="collapsed ? 'chevron-right' : 'chevron-down'" />
				<span>Transfers · all hosts</span>
				<span class="transfers__count" :class="{ 'transfers__count--warn': count.warn }">
					· {{ count.text }}
				</span>
			</button>
		</h3>
		<!-- The desktop holds a quit, or a restart, until these uploads end (#863): said here
		     whether or not Transfers is collapsed, with its Cancel. -->
		<p v-if="quitLine !== null" class="transfers__quit" role="status">
			<span>{{ quitLine }}</span>
			<span aria-hidden="true">·</span>
			<button type="button" class="transfers__link" @click="transfers.cancelQuitWhenFinished()">Cancel</button>
		</p>
		<div
			v-if="!collapsed"
			:id="bodyId"
			class="transfers__body"
			data-transfers-list
			@pointerenter="pointerInside = true"
			@pointerleave="pointerInside = false"
			@focusin="keyboardInside = true"
			@focusout="onFocusOut"
		>
			<div v-if="uploads.length > 0" class="transfers__tools">
				<div class="transfers__filter" role="radiogroup" aria-label="Show the uploads of">
					<button
						v-for="option in FILTERS"
						:key="option.value"
						type="button"
						role="radio"
						class="transfers__filter-option"
						:class="{ 'transfers__filter-option--on': transfers.filter === option.value }"
						:aria-checked="transfers.filter === option.value"
						@click="transfers.setFilter(option.value)"
					>
						{{ option.label }}
					</button>
				</div>
				<button v-if="finished > 0" type="button" class="transfers__link" @click="transfers.dismissFinished()">
					Clear finished
				</button>
			</div>
			<p v-if="groups.length === 0" class="transfers__empty">
				{{
					uploads.length === 0
						? "No uploads. Drop files on a terminal or on the folder above, or use Upload files…"
						: "No uploads from this terminal. Show All to see the others."
				}}
			</p>
			<ul v-else class="transfers__groups">
				<li v-for="group in groups" :key="group.hostId" class="transfers__group">
					<button
						type="button"
						class="transfers__host"
						:class="{ 'transfers__host--warn': !expanded(group) && summaryOf(group).warn }"
						:aria-expanded="expanded(group)"
						@click="toggleGroup(group)"
					>
						<FilesIcon :name="expanded(group) ? 'chevron-down' : 'chevron-right'" />
						<HostBadge v-if="hostOf(group.hostId)" :host="hostOf(group.hostId)!" :size="16" />
						<span class="transfers__host-name">
							{{ expanded(group) ? hostLabel(group.hostId) : summaryOf(group).text }}
						</span>
						<span v-if="expanded(group) && group.terminals.length === 1" class="transfers__host-terminal">
							{{ titleOf(group.terminals[0]!.channelId) }}
						</span>
						<span v-if="group.focused" class="transfers__this">this terminal</span>
					</button>
					<div v-if="expanded(group)" class="transfers__terminals">
						<div v-for="terminal in group.terminals" :key="terminal.channelId" class="transfers__terminal">
							<p
								v-if="group.terminals.length > 1 || transfers.originOf(terminal) !== 'shown'"
								class="transfers__terminal-name"
							>
								<span v-if="group.terminals.length > 1">{{ titleOf(terminal.channelId) }}</span>
								<span v-if="transfers.originOf(terminal) !== 'shown'" class="transfers__origin">
									{{ transfers.originOf(terminal) }}
								</span>
							</p>
							<TransferUpload
								v-for="upload in terminal.uploads"
								:key="upload.id"
								:upload="upload"
								:host="hostOf(upload.hostId)"
								:host-label="hostLabel(upload.hostId)"
								:may-control="mayControl(upload)"
							/>
						</div>
					</div>
				</li>
			</ul>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { DEFAULT_CHANNEL_NAME } from "@lasterm/shared";
import { computed, ref, shallowRef, useId, watch } from "vue";
import { useAuthStore } from "../../stores/auth.js";
import { useChannelsStore } from "../../stores/channels.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useTransfersStore } from "../../stores/transfers.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import {
	afterFocusMove,
	filterGroups,
	groupSummary,
	groupUploads,
	type HostGroup,
	inOrder,
	isActive,
	isExpanded,
	needsAttention,
	quitPendingText,
	stableOrder,
	type TransfersFilter,
	transfersCount,
	type UploadView,
} from "../../utils/transfers-view.js";
import { dropRole } from "../../utils/upload-drop.js";
import HostBadge from "../HostBadge.vue";
import FilesIcon from "./FilesIcon.vue";
import TransferUpload from "./TransferUpload.vue";

const props = defineProps<{
	/** The focused terminal, whose group comes first and expanded. */
	focusedChannelId: string | null;
}>();

const FILTERS: readonly { value: TransfersFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "terminal", label: "This terminal" },
];

const filesPanel = useFilesPanelStore();
const transfers = useTransfersStore();
const hostsStore = useHostsStore();
const channelsStore = useChannelsStore();
const writeLockStore = useWriteLockStore();
const authStore = useAuthStore();
const bodyId = useId();

const collapsed = computed(() => filesPanel.transfersCollapsed);
const uploads = computed(() => transfers.uploads);
// Collapsed, the header still counts what runs and fails; a failure turns it to the warning
// style and does not expand it.
const count = computed(() => transfersCount(uploads.value));
const quitLine = computed(() => quitPendingText(transfers.quitPending));
const finished = computed(
	() => uploads.value.filter((upload) => !isActive(upload.totals) && !needsAttention(upload.totals)).length,
);

// ─── The focus, and rows that never move under the pointer or the keyboard ──

const pointerInside = ref(false);
const keyboardInside = ref(false);
const inside = computed(() => pointerInside.value || keyboardInside.value);

/** The focus the list is laid out for: the focused terminal, held while someone is in the list. */
const shownFocus = ref<string | null>(props.focusedChannelId);
/** Groups expanded or collapsed by hand, by host. */
const byHand = ref<Map<string, boolean>>(new Map());

function applyFocus(channelId: string | null): void {
	if (channelId === shownFocus.value) return;
	// Moving the focus re-orders and re-expands; it removes nothing and stops nothing.
	byHand.value = afterFocusMove(byHand.value);
	shownFocus.value = channelId;
}

watch(
	() => props.focusedChannelId,
	(channelId) => {
		if (!inside.value) applyFocus(channelId);
	},
);

/** The order shown when someone came into the list: kept while they are in it. */
const frozen = shallowRef<{ groups: string[]; uploads: Map<string, string[]> } | null>(null);

const natural = computed(() =>
	filterGroups(groupUploads(uploads.value, shownFocus.value), transfers.filter, shownFocus.value),
);

const groups = computed<HostGroup[]>(() => {
	const next = natural.value;
	const held = frozen.value;
	if (held === null) return next;
	const ordered = inOrder(next, stableOrder(next.map((g) => g.hostId), held.groups), (g) => g.hostId);
	return ordered.map((group) => ({
		...group,
		terminals: group.terminals.map((terminal) => {
			const key = `${group.hostId}:${terminal.channelId}`;
			const order = stableOrder(
				terminal.uploads.map((u) => u.id),
				held.uploads.get(key) ?? null,
			);
			return { ...terminal, uploads: inOrder(terminal.uploads, order, (u) => u.id) };
		}),
	}));
});

watch(inside, (now) => {
	if (now) {
		frozen.value = {
			groups: groups.value.map((g) => g.hostId),
			uploads: new Map(
				groups.value.flatMap((g) =>
					g.terminals.map((t) => [`${g.hostId}:${t.channelId}`, t.uploads.map((u) => u.id)] as const),
				),
			),
		};
	} else {
		frozen.value = null;
		applyFocus(props.focusedChannelId);
	}
});

function onFocusOut(event: FocusEvent): void {
	const to = event.relatedTarget as Node | null;
	const body = event.currentTarget as HTMLElement | null;
	if (to !== null && body?.contains(to)) return;
	keyboardInside.value = false;
}

function expanded(group: HostGroup): boolean {
	return isExpanded(group, byHand.value);
}

function toggleGroup(group: HostGroup): void {
	const next = new Map(byHand.value);
	next.set(group.hostId, !expanded(group));
	byHand.value = next;
}

// The chip of a pane, or a toast's Show: that upload's group expanded.
watch(
	() => transfers.expandRequest,
	(request) => {
		if (request === null) return;
		const hostId = uploads.value.find((upload) => upload.channelId === request.channelId)?.hostId;
		if (hostId === undefined) return;
		const next = new Map(byHand.value);
		next.set(hostId, true);
		byHand.value = next;
	},
);

// ─── Names ───────────────────────────────────────────────────────────────────

function hostOf(hostId: string): Host | undefined {
	return hostsStore.hosts.find((host) => host.id === hostId);
}

function hostLabel(hostId: string): string {
	return hostOf(hostId)?.label ?? "Unknown host";
}

function summaryOf(group: HostGroup): { text: string; warn: boolean } {
	return groupSummary(
		hostLabel(group.hostId),
		group.terminals.flatMap((terminal) => terminal.uploads),
	);
}

function titleOf(channelId: string): string {
	return (
		channelsStore.channels.find((channel) => channel.id === channelId)?.displayTitle ??
		channelsStore.channelIndex.get(channelId)?.displayTitle ??
		DEFAULT_CHANNEL_NAME
	);
}

/**
 * Retry, Cancel and the conflicts' answers: for a window that may type into the terminal, or,
 * once the terminal ended, for the device that started the upload. Readers see the rows only.
 */
function mayControl(upload: UploadView): boolean {
	if (transfers.originOf(upload) === "terminal ended") return true;
	const holder = writeLockStore.locks.get(upload.channelId)?.holder;
	return dropRole(holder, authStore.clientId) !== "reader";
}
</script>

<style scoped>
.transfers {
	display: flex;
	flex-direction: column;
	min-height: 0;
	height: 100%;
}

.transfers__heading {
	margin: 0;
	flex-shrink: 0;
}

.transfers__toggle {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 6px 10px;
	border: none;
	background: transparent;
	color: var(--nt-sidebar-text, var(--nt-fg));
	font: inherit;
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	text-align: left;
	cursor: pointer;
}

.transfers__toggle:focus-visible,
.transfers__host:focus-visible,
.transfers__filter-option:focus-visible,
.transfers__link:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.transfers__count {
	font-weight: 400;
	text-transform: none;
	letter-spacing: 0;
	color: var(--nt-text-secondary);
}

.transfers__count--warn {
	color: var(--nt-badge-warning, var(--nt-badge));
	font-weight: 600;
}

.transfers__quit {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 4px;
	flex-shrink: 0;
	margin: 0 10px 6px;
	font-size: 12px;
	font-weight: 600;
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.transfers__body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 0 10px 8px;
}

.transfers__tools {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 2px 0 6px;
}

.transfers__filter {
	display: inline-flex;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	overflow: hidden;
}

.transfers__filter-option {
	padding: 2px 8px;
	border: none;
	background: transparent;
	color: var(--nt-sidebar-text, var(--nt-fg));
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

.transfers__filter-option--on {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.transfers__link {
	padding: 0;
	border: none;
	background: none;
	color: var(--nt-accent);
	font: inherit;
	font-size: 11px;
	font-weight: 600;
	cursor: pointer;
}

.transfers__empty {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--nt-text-secondary);
}

.transfers__groups {
	margin: 0;
	padding: 0;
	list-style: none;
}

.transfers__group + .transfers__group {
	border-top: 1px solid var(--nt-border);
}

.transfers__host {
	display: flex;
	align-items: center;
	gap: 6px;
	width: 100%;
	padding: 5px 0;
	border: none;
	background: transparent;
	color: var(--nt-sidebar-text, var(--nt-fg));
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	text-align: left;
	cursor: pointer;
}

.transfers__host--warn {
	color: var(--nt-badge-warning, var(--nt-badge));
}

.transfers__host-name,
.transfers__host-terminal {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.transfers__host-terminal {
	font-weight: 400;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.transfers__this {
	margin-left: auto;
	flex-shrink: 0;
	font-size: 10px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--nt-accent);
}

.transfers__terminals {
	padding: 0 0 6px 20px;
}

.transfers__terminal-name {
	display: flex;
	gap: 6px;
	margin: 4px 0 2px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.transfers__origin {
	font-style: italic;
}
</style>
