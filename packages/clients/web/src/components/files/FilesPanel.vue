<template>
	<!-- The files panel (#836): Files on top, the attached terminal's host in its colours;
	     Transfers below, the window's, neutral. A landmark of its own, and an F6 zone. -->
	<aside
		:id="FILES_PANEL_ID"
		ref="panelEl"
		class="files-panel"
		:class="[`files-panel--${form}`, `files-panel--${side}`]"
		:style="panelStyle"
		:aria-label="hostLabel === '' ? 'Files' : `Files on ${hostLabel}`"
		data-focus-zone="files"
	>
		<!-- Said once: a retarget to another host, following turned on or off. -->
		<div class="files-announce" role="status" aria-live="polite">{{ announcement }}</div>

		<section
			class="files-part"
			:class="{ 'files-part--retarget': highlight }"
			:style="borderStyle"
			data-files-part="files"
			role="region"
			aria-label="Files"
		>
			<header class="files-header">
				<HostBadge v-if="host" :host="host" :size="18" :status="hostStatus" />
				<div class="files-header__names">
					<span class="files-header__host">{{ hostLabel === "" ? "Files" : hostLabel }}</span>
					<span v-if="title !== ''" class="files-header__title">{{ title }}</span>
				</div>
				<button
					v-if="filesPanel.pinned && !attachedOnScreen"
					type="button"
					class="files-link"
					@click="emit('show-terminal')"
				>
					Show terminal
				</button>
				<button
					type="button"
					class="files-header__btn"
					:class="{ 'files-header__btn--on': filesPanel.pinned }"
					:aria-pressed="filesPanel.pinned"
					:disabled="channelId === null"
					aria-label="Pin to this terminal"
					:title="filesPanel.pinned ? 'Pinned: stays on this terminal' : 'Pin to this terminal'"
					@click="filesPanel.togglePin()"
				>
					<FilesIcon name="pin" />
				</button>
				<button
					type="button"
					class="files-header__btn"
					aria-label="Close the files panel"
					:title="`Close (${shortcutLabel('files.toggle')})`"
					@click="emit('close')"
				>
					<FilesIcon name="close" />
				</button>
			</header>
			<EnvironmentBanner
				v-if="bannerText"
				:text="bannerText"
				:bg-color="visualProfile.banner.bgColor"
				:text-color="visualProfile.banner.textColor"
			/>
			<template v-if="channelId !== null">
				<FilesBrowser
					:key="channelId"
					:channel-id="channelId"
					:host-id="hostId"
					:host-label="hostLabel"
					:host-os="host?.os ?? null"
					:writer="writer"
					:follow-by-default="resolvedProfile.transferFollowCwd !== false"
					:show-hidden="showHidden"
					:sftp-unavailable="sftpUnavailable"
					:shell="shell"
					:tint="tintStyle"
					@announce="announce"
				/>
				<FilesOptions
					:host-id="hostId"
					:channel-id="channelId"
					:host-label="hostLabel"
					:verify-applies="sftpUnavailable"
					:verify-reason="verifyReason"
				/>
			</template>
			<p v-else class="files-empty">No terminal. Select one to see its files.</p>
		</section>

		<!-- The split: Transfers takes at most 70 % of the panel. Arrows move it when focused,
		     a double click puts it back. -->
		<div
			v-if="!filesPanel.transfersCollapsed"
			class="files-split"
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize Files and Transfers"
			tabindex="0"
			:aria-valuenow="Math.round(filesPanel.transfersShare * 100)"
			:aria-valuemin="Math.round(TRANSFERS_SHARE_MIN * 100)"
			:aria-valuemax="Math.round(TRANSFERS_SHARE_MAX * 100)"
			:aria-valuetext="`Transfers: ${Math.round(filesPanel.transfersShare * 100)} % of the panel`"
			@pointerdown="onSplitDown"
			@keydown="onSplitKey"
			@dblclick="filesPanel.resetTransfersShare()"
		/>
		<section
			class="files-transfers"
			:class="{ 'files-transfers--collapsed': filesPanel.transfersCollapsed }"
			:style="transfersStyle"
			data-files-part="transfers"
			role="region"
			aria-label="Transfers, all hosts"
		>
			<TransfersPart :focused-channel-id="filesPanel.focusedChannelId" />
		</section>
	</aside>
</template>

<script setup lang="ts">
import { DEFAULT_CHANNEL_NAME } from "@lasterm/shared";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useResolvedProfile } from "../../composables/useResolvedProfile.js";
import { useVisualProfile } from "../../composables/useVisualProfile.js";
import { useChannelsStore } from "../../stores/channels.js";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import { shortcutLabel } from "../../utils/app-shortcuts.js";
import {
	FILES_PANEL_ID,
	type FilesPanelForm,
	TRANSFERS_SHARE_MAX,
	TRANSFERS_SHARE_MIN,
} from "../../utils/files-panel.js";
import EnvironmentBanner from "../EnvironmentBanner.vue";
import HostBadge from "../HostBadge.vue";
import FilesBrowser from "./FilesBrowser.vue";
import FilesIcon from "./FilesIcon.vue";
import FilesOptions from "./FilesOptions.vue";
import TransfersPart from "./TransfersPart.vue";

const props = defineProps<{
	form: FilesPanelForm;
	side: "left" | "right";
	/** Its width, docked or floating; a sheet takes the terminal area's. */
	width: number;
	/** The terminal it is attached to is in the tab shown. */
	attachedOnScreen: boolean;
}>();

const emit = defineEmits<{
	(e: "close"): void;
	/** Show the tab of the terminal the panel is pinned to. */
	(e: "show-terminal"): void;
}>();

const filesPanel = useFilesPanelStore();
const channelsStore = useChannelsStore();
const hostsStore = useHostsStore();
const configStore = useConfigStore();
const writeLockStore = useWriteLockStore();

const channelId = computed(() => filesPanel.attachedChannelId);
const hostId = computed(() =>
	channelId.value === null ? null : (channelsStore.channelHostMap.get(channelId.value) ?? null),
);
const host = computed(() => hostsStore.hosts.find((candidate) => candidate.id === hostId.value));
const hostLabel = computed(() => host.value?.label ?? "");
const hostStatus = computed(() => (hostId.value === null ? null : hostsStore.getHostStatus(hostId.value)));
const channel = computed(() => channelsStore.channels.find((candidate) => candidate.id === channelId.value));
const title = computed(() => {
	if (channelId.value === null) return "";
	return (
		channel.value?.displayTitle ??
		channelsStore.channelIndex.get(channelId.value)?.displayTitle ??
		DEFAULT_CHANNEL_NAME
	);
});
const shell = computed(() => channel.value?.processTitle ?? channel.value?.shell);
const writer = computed(() => channelId.value !== null && writeLockStore.isWriter(channelId.value));
const showHidden = computed(() => configStore.uiConfig.transfer?.showHidden === true);
const sftpUnavailable = computed(
	() =>
		hostId.value !== null && host.value?.type !== "local" && hostsStore.isSftpUnavailable(hostId.value),
);
const verifyReason = computed(() =>
	host.value?.type === "local"
		? "only over SSH commands: this host's files are the hub's own"
		: "only over SSH commands: this host has SFTP",
);

const { profile: resolvedProfile } = useResolvedProfile(hostId, channelId);

// The host's identity on the Files part only: banner, border on its outer edges, tint over the
// list. Transfers is the window's, and wears none of it.
const groupName = computed(() => (host.value ? hostsStore.getHostGroupName(host.value) : null));
const { profile: visualProfile, bannerText, borderStyle, tintStyle } = useVisualProfile(host, groupName);

// ─── Saying it, once ─────────────────────────────────────────────────────────

const announcement = ref("");

function announce(text: string): void {
	// Emptied first, so that the same words said again are heard again.
	announcement.value = "";
	void nextTick(() => {
		announcement.value = text;
	});
}

// A focus move to a pane on another host moves the panel there: its header shows it for a moment
// (an accent ring, none under reduced motion), and a screen reader hears it once.
const highlight = ref(false);
let highlightTimer: ReturnType<typeof setTimeout> | null = null;

watch(hostId, (now, before) => {
	if (now === null || before === null || before === undefined || now === before) return;
	highlight.value = false;
	if (highlightTimer !== null) clearTimeout(highlightTimer);
	void nextTick(() => {
		highlight.value = true;
		highlightTimer = setTimeout(() => {
			highlight.value = false;
		}, 600);
	});
	announce(`Files on ${hostLabel.value}`);
});

onUnmounted(() => {
	if (highlightTimer !== null) clearTimeout(highlightTimer);
	stopDrag();
});

// ─── Size, and the split ─────────────────────────────────────────────────────

const panelEl = ref<HTMLElement | null>(null);

const panelStyle = computed(() => (props.form === "sheet" ? {} : { width: `${props.width}px` }));
const transfersStyle = computed(() =>
	filesPanel.transfersCollapsed ? {} : { flexBasis: `${filesPanel.transfersShare * 100}%` },
);

const SPLIT_STEP = 0.05;

function onSplitKey(event: KeyboardEvent): void {
	const share = filesPanel.transfersShare;
	const to =
		event.key === "ArrowUp"
			? share + SPLIT_STEP
			: event.key === "ArrowDown"
				? share - SPLIT_STEP
				: event.key === "Home"
					? TRANSFERS_SHARE_MIN
					: event.key === "End"
						? TRANSFERS_SHARE_MAX
						: null;
	if (to === null) return;
	event.preventDefault();
	filesPanel.setTransfersShare(to);
}

let dragging = false;

function onSplitMove(event: PointerEvent): void {
	const rect = panelEl.value?.getBoundingClientRect();
	if (!dragging || rect === undefined || rect.height <= 0) return;
	filesPanel.setTransfersShare((rect.bottom - event.clientY) / rect.height);
}

function stopDrag(): void {
	dragging = false;
	document.removeEventListener("pointermove", onSplitMove);
	document.removeEventListener("pointerup", stopDrag);
	document.body.style.userSelect = "";
}

function onSplitDown(event: PointerEvent): void {
	event.preventDefault();
	dragging = true;
	document.addEventListener("pointermove", onSplitMove);
	document.addEventListener("pointerup", stopDrag);
	document.body.style.userSelect = "none";
}
</script>

<style scoped>
/* The terminal list's ground, so the panel follows its opacity under Mica, Acrylic, a
   see-through window or a wallpaper. Floating, it takes the exit card's opaque ground. */
.files-panel {
	position: relative;
	display: flex;
	flex-direction: column;
	min-height: 0;
	flex-shrink: 0;
	background: rgba(var(--nt-sidebar-rgb), var(--nt-sidebar-alpha));
	color: var(--nt-sidebar-text, var(--nt-fg));
	font-size: 12px;
	overflow: hidden;
	z-index: 5;
}

.files-panel--docked.files-panel--right {
	border-left: 1px solid var(--nt-border);
}

.files-panel--docked.files-panel--left {
	border-right: 1px solid var(--nt-border);
}

/* Floating over the right of the pane area, below the pane header, so that its folder button
   and lock stay in view: no room taken, no terminal resized. */
.files-panel--overlay {
	position: absolute;
	top: 29px;
	bottom: 0;
	background: rgb(var(--nt-bg-rgb));
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	z-index: 30;
}

.files-panel--overlay.files-panel--right {
	right: 0;
}

.files-panel--overlay.files-panel--left {
	left: 0;
}

/* A phone's width: the whole terminal area. */
.files-panel--sheet {
	position: absolute;
	inset: 0;
	width: auto;
	background: rgb(var(--nt-bg-rgb));
	z-index: 30;
}

.files-panel--sheet .files-header__title {
	display: none;
}

.files-announce {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}

.files-part {
	position: relative;
	display: flex;
	flex-direction: column;
	flex: 1 1 0;
	min-height: 0;
}

/* A retarget to another host: an accent ring that fades out. */
.files-part--retarget .files-header {
	animation: files-retarget 600ms ease-out;
}

@keyframes files-retarget {
	from {
		box-shadow: inset 0 0 0 2px var(--nt-accent);
	}
	to {
		box-shadow: inset 0 0 0 2px transparent;
	}
}

@media (prefers-reduced-motion: reduce) {
	.files-part--retarget .files-header {
		animation: none;
	}
}

.files-header {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-shrink: 0;
	min-height: 32px;
	padding: 4px 6px 4px 10px;
	border-bottom: 1px solid var(--nt-border);
}

.files-header__names {
	flex: 1;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: 8px;
	overflow: hidden;
	white-space: nowrap;
}

.files-header__host {
	font-size: 13px;
	font-weight: 600;
}

.files-header__title {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.files-header__btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 24px;
	height: 24px;
	flex-shrink: 0;
	padding: 0;
	border: 1px solid transparent;
	border-radius: 4px;
	background: transparent;
	color: var(--nt-text-secondary);
	cursor: pointer;
}

.files-header__btn:hover:not(:disabled) {
	color: var(--nt-fg);
	border-color: var(--nt-border);
}

.files-header__btn--on {
	color: var(--nt-accent);
}

.files-header__btn:disabled {
	opacity: 0.4;
	cursor: default;
}

.files-header__btn:focus-visible,
.files-link:focus-visible,
.files-split:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.files-link {
	flex-shrink: 0;
	padding: 0;
	border: none;
	background: none;
	color: var(--nt-accent);
	font: inherit;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
}

.files-empty {
	margin: 0;
	padding: 16px 10px;
	color: var(--nt-text-secondary);
	font-size: 12px;
}

.files-split {
	flex-shrink: 0;
	height: 6px;
	margin: -2px 0;
	position: relative;
	z-index: 2;
	cursor: row-resize;
	background: transparent;
}

.files-split::after {
	content: "";
	position: absolute;
	left: 50%;
	top: 2px;
	width: 32px;
	height: 2px;
	margin-left: -16px;
	border-radius: 1px;
	background: var(--nt-border);
}

.files-split:hover,
.files-split:active {
	background: rgba(var(--nt-accent-rgb), 0.3);
}

.files-transfers {
	display: flex;
	flex-direction: column;
	flex: 0 0 auto;
	min-height: 0;
	border-top: 1px solid var(--nt-border);
}

.files-transfers--collapsed {
	flex: 0 0 auto;
}
</style>
