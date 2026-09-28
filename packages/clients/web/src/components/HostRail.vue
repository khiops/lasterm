<template>
	<div
		class="host-rail"
		:class="{ 'host-rail--grid': grid }"
		:style="railStyle"
	>
		<div
			class="rail-hosts"
			@dragover.prevent
			@contextmenu.prevent="onRailContextMenu"
		>
			<!-- Rows, read left to right then down: the local host alone first,
			     then each section's hosts, `columns` to a row (#623). -->
			<template v-for="row in rows" :key="row.key">
				<div v-if="row.kind === 'hosts'" class="rail-row">
					<div
						v-for="host in row.hosts"
						:key="host.id"
						class="badge-wrapper"
						:class="{
							selected: host.id === hostsStore.selectedHostId,
							'drop-target': dropTargetHostId === host.id,
						}"
						:data-host-id="host.id"
						:title="getTooltip(host)"
						:draggable="row.section !== null"
						@click="hostsStore.selectHost(host.id)"
						@contextmenu.prevent="
							emit('host-context-menu', {
								hostId: host.id,
								event: $event,
							})
						"
						@dragstart="onDragStart($event, host, row.section)"
						@dragenter.prevent
						@dragover.prevent="onDragOver($event, host.id, row.section)"
						@dragleave="onHostDragLeave($event)"
						@dragend="onHostDragEnd"
						@drop.prevent="onDrop($event, host, row.section)"
					>
						<!-- One column: the pill at the rail's edge. A grid rings the badge
						     instead, since a pill cannot point at an inner column. -->
						<span
							v-if="!grid && host.id === hostsStore.selectedHostId"
							class="selection-pill"
						></span>
						<div
							class="badge"
							:class="{
								'badge--ring': grid && host.id === hostsStore.selectedHostId,
							}"
							:style="{
								backgroundColor: host.color || getColorFromLabel(host.label),
							}"
						>
							<img
								v-if="host.iconType === 'image' && host.iconValue"
								:src="host.iconValue"
								class="host-icon-img"
							/>
							<span v-else class="badge-initials">{{
								host.iconType === 'emoji' && host.iconValue
									? host.iconValue
									: getInitials(host.label)
							}}</span>
							<span
								class="status-dot"
								:class="[`status-dot--${hostsStore.getHostStatus(host.id)}`, { 'status-dot--older-agent': agentIsOlder(host.id) }]"
								:title="agentIsOlder(host.id) ? olderAgentHint(host.id) : undefined"
							></span>
						</div>
						<span
							v-if="notificationStore.getBellCountForHost(host.id) > 0"
							class="host-bell-badge"
						>{{ notificationStore.getBellCountForHost(host.id) }}</span>
						<!-- Where a dropped badge lands: before this one, in reading order. -->
						<span
							v-if="dropTargetHostId === host.id"
							class="drop-mark"
							:class="grid ? 'drop-mark--vertical' : 'drop-mark--horizontal'"
						></span>
					</div>
				</div>

				<div
					v-else-if="row.kind === 'group'"
					class="group-header"
					:class="{ 'drop-target': dropTargetGroup === row.section.id }"
					:title="`${row.section.name} (${row.section.hosts.length} hosts)`"
					draggable="true"
					@click="toggleGroup(row.section.id)"
					@contextmenu.prevent="
						emit('group-context-menu', {
							groupId: row.section.id,
							groupName: row.section.name,
							event: $event,
						})
					"
					@dragstart="onGroupDragStart($event, row.section.id)"
					@dragenter.prevent
					@dragover.prevent="onGroupDragOver($event, row.section.id)"
					@dragleave="onGroupHeaderDragLeave"
					@drop.prevent="onUnifiedGroupDrop($event, row.section.id)"
					@dragend="onGroupDragEnd"
				>
					<span v-if="grid" class="group-hairline" aria-hidden="true"></span>
					<span
						class="group-chevron"
						:class="{ collapsed: row.section.collapsed }"
						>&#x25B8;</span
					>
					<span class="group-label">{{ row.section.name }}</span>
					<span
						v-if="grid || row.section.collapsed"
						class="group-count"
					>{{ row.section.hosts.length }}</span>
					<span v-if="grid" class="group-hairline" aria-hidden="true"></span>
				</div>

				<!-- Ungrouped section header (drop target to move host to ungrouped) -->
				<div
					v-else-if="row.kind === 'ungrouped'"
					class="group-header ungrouped-header"
					:class="{ 'drop-target': dropTargetGroup === 'ungrouped' }"
					@dragenter.prevent
					@dragover.prevent="onGroupHeaderDragOver($event, 'ungrouped')"
					@dragleave="onGroupHeaderDragLeave"
					@drop.prevent="onGroupHeaderDrop($event, null)"
				>
					<span v-if="grid" class="group-hairline" aria-hidden="true"></span>
					<span class="group-label">Ungrouped</span>
					<span v-if="grid" class="group-count">{{ row.section.hosts.length }}</span>
					<span v-if="grid" class="group-hairline" aria-hidden="true"></span>
				</div>

				<div v-else class="rail-separator"></div>
			</template>
		</div>

		<!-- The footer's buttons fill the same rows as the badges. -->
		<div class="rail-footer">
			<div
				v-for="actions in footerRows"
				:key="actions.join()"
				class="rail-row"
			>
				<template v-for="action in actions" :key="action">
					<button
						v-if="action === 'palette'"
						class="rail-icon-btn"
						title="Command palette (Ctrl+Shift+P)"
						aria-label="Open command palette"
						@click="$emit('toggle-palette')"
					>
						<svg
							class="rail-icon-svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<circle cx="11" cy="11" r="8" />
							<line x1="21" y1="21" x2="16.65" y2="16.65" />
						</svg>
					</button>
					<button
						v-else-if="action === 'settings'"
						class="rail-icon-btn"
						title="Settings"
						aria-label="Open settings panel"
						@click="$emit('toggle-settings')"
					>
						<svg
							class="rail-icon-svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
							<circle cx="12" cy="12" r="3" />
						</svg>
					</button>
					<button
						v-else
						class="add-host-btn"
						title="Add host"
						aria-label="Add new host"
						@click="$emit('add-host')"
					>
						<span class="add-icon">+</span>
					</button>
				</template>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useHostsStore } from "../stores/hosts.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useChannelsStore } from "../stores/channels.js";
import {
	useHostGroups,
	type HostGroupSection,
	type HostSection,
	type UngroupedSection,
} from "../composables/useHostGroups.js";
import {
	getInitials,
	getColorFromLabel,
} from "../composables/useHostIcon.js";
import {
	chunkIntoRows,
	HOST_RAIL_BADGE_GEOMETRY,
	HOST_RAIL_GAP,
	HOST_RAIL_PADDING,
	type Host,
	type HostRailBadgeSize,
	moveBefore,
} from "@lasterm/shared";

const props = withDefaults(
	defineProps<{
		/** Badges to a row; more than one makes the rail a grid (#623). */
		columns?: number;
		badgeSize?: HostRailBadgeSize;
	}>(),
	{ columns: 1, badgeSize: "medium" },
);

const emit = defineEmits<{
	"toggle-settings": [];
	"toggle-palette": [];
	"add-host": [];
	"add-group": [];
	"rail-context-menu": [payload: { x: number; y: number }];
	"host-context-menu": [payload: { hostId: string; event: MouseEvent }];
	"group-context-menu": [
		payload: { groupId: string; groupName: string; event: MouseEvent },
	];
}>();

const hostsStore = useHostsStore();
const notificationStore = useNotificationStore();
const channelsStore = useChannelsStore();
const { sections, localHost, toggleGroup, reorderGroups } = useHostGroups();

const grid = computed(() => props.columns > 1);

/** The badge size's geometry, for the stylesheet. */
const railStyle = computed(() => {
	const size = HOST_RAIL_BADGE_GEOMETRY[props.badgeSize];
	return {
		"--rail-badge": `${size.badge}px`,
		"--rail-initials": `${size.initials}px`,
		"--rail-dot": `${size.dot}px`,
		"--rail-squircle": `${size.squircle}px`,
		"--rail-pill": `${size.pill}px`,
		"--rail-gap": `${HOST_RAIL_GAP}px`,
		"--rail-padding": `${HOST_RAIL_PADDING}px`,
	};
});

/**
 * What the rail shows, top to bottom. A row of hosts belongs to its section,
 * which a drop on one of its badges reorders; the local host's row has none.
 */
type RailRow =
	| { kind: "hosts"; key: string; hosts: Host[]; section: HostSection | null }
	| { kind: "group"; key: string; section: HostGroupSection }
	| { kind: "ungrouped"; key: string; section: UngroupedSection }
	| { kind: "separator"; key: string };

const rows = computed<RailRow[]>(() => {
	const result: RailRow[] = [];
	const local = localHost.value;
	if (local) {
		result.push({ kind: "hosts", key: `hosts:${local.id}`, hosts: [local], section: null });
		if (sections.value.length > 0) result.push({ kind: "separator", key: "separator:local" });
	}
	for (const section of sections.value) {
		if (section.type === "group") {
			result.push({ kind: "group", key: `group:${section.id}`, section });
		} else {
			result.push({ kind: "ungrouped", key: "group:ungrouped", section });
		}
		if (section.type === "ungrouped" || !section.collapsed) {
			for (const hosts of chunkIntoRows(section.hosts, props.columns)) {
				result.push({ kind: "hosts", key: `hosts:${hosts[0]?.id}`, hosts, section });
			}
		}
		if (section.type === "group") {
			result.push({ kind: "separator", key: `separator:${section.id}` });
		}
	}
	return result;
});

const FOOTER_ACTIONS = ["palette", "settings", "add-host"] as const;
const footerRows = computed(() => chunkIntoRows(FOOTER_ACTIONS, props.columns));

/**
 * Whether this host is served by an agent from before an update.
 *
 * A hub deploys an agent matched to itself, so a version that differs means
 * the one answering was started by an older hub and is still there — a remote
 * daemon holding terminals, most often. Nothing is done about it: those
 * terminals are worth more than a version number (#456). The dot carries the
 * mark, the hover says why, and the detail belongs in the host's settings.
 */
function agentIsOlder(hostId: string): boolean {
	return hostsStore.getOutdatedAgent(hostId) !== null;
}

function olderAgentHint(hostId: string): string {
	const outdated = hostsStore.getOutdatedAgent(hostId);
	if (outdated === null) return "";
	return `Served by agent ${outdated.running}; this hub carries ${outdated.expected}. Its terminals have to end before it can be replaced.`;
}

const dragHostId = ref<string | null>(null);
let dragGroupId: string | null = null;
const dropTargetGroup = ref<string | null>(null);
const dropTargetHostId = ref<string | null>(null);

/**
 * Track when each host became "live" (connected) to compute display duration.
 * Key = hostId, value = timestamp when status first became "live".
 */
const connectedAtMap = ref<Map<string, number>>(new Map());

watch(
	() => hostsStore.hosts.map((h) => hostsStore.getHostStatus(h.id)),
	() => {
		const next = new Map(connectedAtMap.value);
		for (const host of hostsStore.hosts) {
			const status = hostsStore.getHostStatus(host.id);
			const wasTracked = next.has(host.id);
			if (status === "live" && !wasTracked) {
				next.set(host.id, Date.now());
			} else if (status !== "live" && wasTracked) {
				next.delete(host.id);
			}
		}
		connectedAtMap.value = next;
	},
	{ deep: false },
);

/** Format elapsed ms into human-readable duration string. */
function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** Count active (non-dead) channels for a host using the persistent channelHostMap. */
function getChannelCount(hostId: string): number {
	let count = 0;
	for (const [channelId, hId] of channelsStore.channelHostMap) {
		if (hId !== hostId) continue;
		const ch = channelsStore.channels.find((c) => c.id === channelId);
		if (ch && ch.status !== "dead") count++;
	}
	return count;
}

function getTooltip(host: Host): string {
	const parts = [host.label];
	if (host.sshHost)
		parts.push(
			`${host.sshUser ?? ""}@${host.sshHost}:${host.sshPort ?? 22}`,
		);
	if (host.hostGroup) parts.push(`Group: ${host.hostGroup}`);

	// Channel count
	const channelCount = getChannelCount(host.id);
	parts.push(`Channels: ${channelCount}`);

	// Connection duration (only when live)
	const connectedAt = connectedAtMap.value.get(host.id);
	if (connectedAt !== undefined) {
		parts.push(`Connected: ${formatDuration(Date.now() - connectedAt)}`);
	}

	return parts.join("\n");
}

// ── Host DnD: the local host neither moves nor takes a drop ──────────────

function onDragStart(event: DragEvent, host: Host, section: HostSection | null): void {
	if (section === null) return;
	dragHostId.value = host.id;
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/x-lasterm-host", host.id);
	}
}

function onDragOver(event: DragEvent, hostId: string, section: HostSection | null): void {
	if (section === null || !dragHostId.value || dragHostId.value === hostId) {
		dropTargetHostId.value = null;
		return;
	}
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
	dropTargetHostId.value = hostId;
}

function onHostDragLeave(event: DragEvent): void {
	const el = event.currentTarget as HTMLElement;
	const related = event.relatedTarget as Node | null;
	if (related && el.contains(related)) return;
	dropTargetHostId.value = null;
}

/**
 * A badge dropped on another goes just before it, in the order the rail is
 * read — left to right, then down — which is the section's own order: its
 * rows are that order cut every `columns` hosts.
 */
function onDrop(
	_event: DragEvent,
	targetHost: Host,
	section: HostSection | null,
): void {
	dropTargetHostId.value = null;
	const moved = dragHostId.value;
	dragHostId.value = null;
	if (section === null || moved === null || moved === targetHost.id) return;

	const group = section.type === "group" ? section.id : null;
	const orderedIds = moveBefore(
		section.hosts.map((h) => h.id),
		moved,
		targetHost.id,
	);

	hostsStore
		.reorderHosts(group, orderedIds)
		.then(() => hostsStore.fetchHosts());
}

function onHostDragEnd(): void {
	dragHostId.value = null;
	dropTargetHostId.value = null;
}

function onGroupDragStart(event: DragEvent, groupId: string): void {
	dragGroupId = groupId;
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/x-lasterm-group", groupId);
	}
}

function onGroupDragOver(event: DragEvent, groupId: string): void {
	// Accept host drags (cross-group move) or group drags (reorder)
	const isHostDrag = event.dataTransfer?.types.includes("text/x-lasterm-host") ?? false;
	const isGroupDrag = dragGroupId !== null && dragGroupId !== groupId;

	if (!isHostDrag && !isGroupDrag) {
		dropTargetGroup.value = null;
		return;
	}
	// For group reorder: skip self
	if (isGroupDrag && dragGroupId === groupId) {
		dropTargetGroup.value = null;
		return;
	}
	event.preventDefault();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
	dropTargetGroup.value = groupId;
}

function onUnifiedGroupDrop(event: DragEvent, targetGroupId: string): void {
	dropTargetGroup.value = null;
	// Host drag takes priority
	const hostId = event.dataTransfer?.getData("text/x-lasterm-host");
	if (hostId && !dragGroupId) {
		hostsStore
			.moveHostToGroup(hostId, targetGroupId)
			.then(() => hostsStore.fetchHosts());
		dragHostId.value = null;
		return;
	}
	// Group reorder
	if (!dragGroupId || dragGroupId === targetGroupId) return;
	reorderGroups(dragGroupId, targetGroupId);
	dragGroupId = null;
}

function onGroupDragEnd(): void {
	dragGroupId = null;
	dropTargetGroup.value = null;
}

// ── Cross-group host DnD: drop host onto group header ────────────────────

function onGroupHeaderDragOver(event: DragEvent, groupId: string): void {
	// Only accept host drags (not group drags)
	if (dragGroupId) return;
	if (!event.dataTransfer?.types.includes("text/x-lasterm-host")) return;
	event.preventDefault();
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = "move";
	}
	dropTargetGroup.value = groupId;
}

function onGroupHeaderDragLeave(event: DragEvent): void {
	// Only clear if not entering a child element
	const el = event.currentTarget as HTMLElement;
	const related = event.relatedTarget as Node | null;
	if (related && el.contains(related)) return;
	dropTargetGroup.value = null;
}

function onGroupHeaderDrop(event: DragEvent, targetGroupId: string | null): void {
	dropTargetGroup.value = null;
	if (dragGroupId) return; // ignore group drags
	const hostId = event.dataTransfer?.getData("text/x-lasterm-host");
	if (!hostId) return;
	hostsStore
		.moveHostToGroup(hostId, targetGroupId)
		.then(() => hostsStore.fetchHosts());
	dragHostId.value = null;
}

function onRailContextMenu(event: MouseEvent): void {
	// Only the background: the rail itself, or the room a row leaves beside
	// its badges — not a host or a group header.
	const target = event.target as HTMLElement;
	if (target !== event.currentTarget && !target.classList.contains("rail-row")) return;
	emit("rail-context-menu", { x: event.clientX, y: event.clientY });
}

onMounted(() => {
	void hostsStore.fetchHosts();
});
</script>

<style scoped>
/* Sizes come from the badge size, through the --rail-* variables the root
   element sets; colours only from the theme. */
.host-rail {
	display: flex;
	flex-direction: column;
	padding-top: 8px;
	overflow-y: auto;
	overflow-x: hidden;
	scrollbar-width: none; /* Firefox */
}

.host-rail::-webkit-scrollbar {
	display: none; /* Chrome/Safari */
}

.rail-hosts {
	display: flex;
	flex-direction: column;
	gap: var(--rail-gap);
	flex: 1;
	width: 100%;
	padding: 4px 0;
}

/* A row of badges, or of the footer's buttons. One column centres its badge;
   a grid fills its rows from the left. */
.rail-row {
	display: flex;
	gap: var(--rail-gap);
	padding: 0 var(--rail-padding);
	justify-content: center;
}

.host-rail--grid .rail-hosts > .rail-row {
	justify-content: flex-start;
}

.badge-wrapper {
	position: relative;
	width: var(--rail-badge);
	height: var(--rail-badge);
	cursor: pointer;
	flex-shrink: 0;
}

/* Selected, in one column — a pill at the rail's edge, as Discord does */
.selection-pill {
	position: absolute;
	left: -6px;
	top: 50%;
	transform: translateY(-50%);
	width: 4px;
	height: var(--rail-pill);
	background: var(--nt-fg);
	border-radius: 0 3px 3px 0;
}

.badge-wrapper.selected .badge,
.badge-wrapper:not(.selected):hover .badge {
	border-radius: var(--rail-squircle);
}

/* Selected, in a grid — a ring: a gap in the rail's colour, then the foreground */
.badge.badge--ring {
	box-shadow:
		0 0 0 2px var(--nt-host-rail),
		0 0 0 4px var(--nt-fg);
}

/* Where a dropped badge lands, in the gap before its target: above it in one
   column, to its left in a grid. */
.drop-mark {
	position: absolute;
	background: var(--nt-accent);
	border-radius: 1px;
	pointer-events: none;
}

.drop-mark--horizontal {
	top: -4px;
	left: 4px;
	right: 4px;
	height: 2px;
}

.drop-mark--vertical {
	left: -4px;
	top: 1px;
	bottom: 1px;
	width: 2px;
}

.badge {
	width: var(--rail-badge);
	height: var(--rail-badge);
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	position: relative;
	transition:
		border-radius 0.15s ease,
		box-shadow 0.15s ease;
	user-select: none;
}

.badge-initials {
	font-size: var(--rail-initials);
	font-weight: 700;
	color: var(--nt-bright-white);
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
	line-height: 1;
}

.host-icon-img {
	width: 100%;
	height: 100%;
	border-radius: 50%;
	object-fit: cover;
}

/* Status dot — bottom-right corner of badge */
.status-dot {
	position: absolute;
	bottom: -1px;
	right: -1px;
	width: var(--rail-dot);
	height: var(--rail-dot);
	border-radius: 50%;
	border: 2px solid var(--nt-tab-bar);
}

/* The same dot, marked — not a second thing to read beside it. */
.status-dot--older-agent {
	box-shadow: 0 0 0 2px var(--nt-badge-warning, #f9e2af);
}

.status-dot--live {
	background: var(--nt-green);
}

.status-dot--offline {
	background: var(--nt-tab-hover);
}

.status-dot--error {
	background: var(--nt-badge);
}

.status-dot--reconnecting {
	background: var(--nt-yellow);
	animation: pulse 1.4s ease-in-out infinite;
}

@keyframes pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.4;
	}
}

/* Bell badge — top-right corner of host badge */
.host-bell-badge {
	position: absolute;
	top: -4px;
	right: -4px;
	min-width: 16px;
	height: 16px;
	padding: 0 4px;
	border-radius: 8px;
	background: var(--nt-badge);
	color: var(--nt-bright-white, #fff);
	font-size: 10px;
	font-weight: 700;
	line-height: 16px;
	text-align: center;
	pointer-events: none;
	z-index: 1;
}

.rail-separator {
	height: 1px;
	background: var(--nt-tab-hover);
	flex-shrink: 0;
	margin: 0 12px;
}

.host-rail--grid .rail-separator {
	margin: 0 2px;
}

/* Group headers are centred; a grid adds a hairline on each side, and the
   host count, which one column shows only for a folded group. */
.group-header {
	display: flex;
	flex-direction: row;
	align-items: center;
	justify-content: center;
	gap: 4px;
	margin: 0 var(--rail-padding);
	padding: 2px 0;
	border-top: 2px solid transparent;
	font-size: 9px;
	line-height: 12px;
	text-transform: uppercase;
	color: var(--nt-text-secondary);
	cursor: pointer;
	user-select: none;
}

.group-header:hover {
	color: var(--nt-fg);
}

.group-header.drop-target {
	border-top-color: var(--nt-accent);
}

/* Ungrouped header — no chevron, not draggable, drop-target only */
.ungrouped-header {
	cursor: default;
	opacity: 0.6;
}

.ungrouped-header:hover,
.ungrouped-header.drop-target {
	opacity: 1;
}

.group-hairline {
	flex: 1 1 0;
	min-width: 4px;
	height: 1px;
	background: var(--nt-border);
}

.group-chevron {
	display: inline-block;
	flex-shrink: 0;
	font-size: 10px;
	line-height: 1;
	transition: transform 0.15s ease;
	transform: rotate(90deg);
}

.group-chevron.collapsed {
	transform: rotate(0deg);
}

.group-label {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
}

.group-count {
	flex-shrink: 0;
	color: var(--nt-text-muted);
	font-weight: 500;
}

.rail-footer {
	display: flex;
	flex-direction: column;
	gap: var(--rail-gap);
	padding: 8px 0 12px;
}

.rail-icon-btn {
	width: var(--rail-badge);
	height: var(--rail-badge);
	flex-shrink: 0;
	border-radius: 50%;
	border: none;
	background: transparent;
	color: var(--nt-text-secondary);
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	padding: 0;
	transition:
		color 0.15s,
		background 0.15s;
}

.rail-icon-btn:hover {
	color: var(--nt-accent);
	background: rgba(var(--nt-accent-rgb), 0.12);
}

.rail-icon-svg {
	width: calc(var(--rail-badge) / 2);
	height: calc(var(--rail-badge) / 2);
}

.add-host-btn {
	width: var(--rail-badge);
	height: var(--rail-badge);
	flex-shrink: 0;
	border-radius: 50%;
	border: 2px dashed var(--nt-tab-hover);
	background: transparent;
	color: var(--nt-text-secondary);
	font-size: calc(var(--rail-badge) * 5 / 9);
	line-height: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	cursor: pointer;
	transition:
		border-color 0.15s,
		color 0.15s;
	padding: 0;
}

.add-host-btn:hover {
	border-color: var(--nt-accent);
	color: var(--nt-accent);
}

.add-icon {
	display: block;
	line-height: 1;
	margin-top: -1px; /* optical centering */
}

</style>
