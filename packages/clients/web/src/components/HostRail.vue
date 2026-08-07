<template>
	<div class="host-rail">
		<div
			class="rail-hosts"
			@dragover.prevent
			@contextmenu.prevent="onRailContextMenu"
		>
			<!-- Local host always first -->
			<div
				v-if="localHost"
				class="badge-wrapper"
				:class="{ selected: localHost.id === hostsStore.selectedHostId }"
				:title="getTooltip(localHost)"
				@click="hostsStore.selectHost(localHost.id)"
				@contextmenu.prevent="
					emit('host-context-menu', {
						hostId: localHost.id,
						event: $event,
					})
				"
			>
				<div
					class="badge"
					:style="{
						backgroundColor: localHost.color || getColorFromLabel(localHost.label),
					}"
				>
					<img
						v-if="localHost.iconType === 'image' && localHost.iconValue"
						:src="localHost.iconValue"
						class="host-icon-img"
					/>
					<span v-else class="badge-initials">{{
						localHost.iconType === 'emoji' && localHost.iconValue
							? localHost.iconValue
							: getInitials(localHost.label)
					}}</span>
					<span
						class="status-dot"
						:class="`status-dot--${hostsStore.getHostStatus(localHost.id)}`"
					></span>
				</div>
				<span
					v-if="notificationStore.getBellCountForHost(localHost.id) > 0"
					class="host-bell-badge"
				>{{ notificationStore.getBellCountForHost(localHost.id) }}</span>
			</div>

			<!-- Separator after local host -->
			<div
				v-if="localHost && sections.length > 0"
				class="rail-separator"
			></div>

			<!-- Group sections -->
			<template
				v-for="section in sections"
				:key="
					section.type === 'group' ? section.id : 'ungrouped'
				"
			>
				<!-- Group header -->
				<div
					v-if="section.type === 'group'"
					class="group-header"
					:class="{ 'drop-target': dropTargetGroup === section.id }"
					:title="`${section.name} (${section.hosts.length} hosts)`"
					draggable="true"
					@click="toggleGroup(section.id)"
					@contextmenu.prevent="
						emit('group-context-menu', {
							groupId: section.id,
							groupName: section.name,
							event: $event,
						})
					"
					@dragstart="onGroupDragStart($event, section.id)"
					@dragenter.prevent
					@dragover.prevent="onGroupDragOver($event, section.id)"
					@dragleave="onGroupHeaderDragLeave"
					@drop.prevent="onUnifiedGroupDrop($event, section.id)"
					@dragend="onGroupDragEnd"
				>
					<span
						class="group-chevron"
						:class="{ collapsed: section.collapsed }"
						>&#x25B8;</span
					>
					<span class="group-label">{{ section.name }}</span>
				</div>

				<!-- Ungrouped section header (drop target to move host to ungrouped) -->
				<div
					v-if="section.type === 'ungrouped'"
					class="group-header ungrouped-header"
					:class="{ 'drop-target': dropTargetGroup === 'ungrouped' }"
					@dragenter.prevent
					@dragover.prevent="onGroupHeaderDragOver($event, 'ungrouped')"
					@dragleave="onGroupHeaderDragLeave"
					@drop.prevent="onGroupHeaderDrop($event, null)"
				>
					<span class="group-label">Ungrouped</span>
				</div>

				<!-- Hosts in section (hidden if collapsed) -->
				<template
					v-if="
						section.type === 'ungrouped' || !section.collapsed
					"
				>
					<div
						v-for="host in section.hosts"
						:key="host.id"
						class="badge-wrapper"
						:class="{
							selected:
								host.id === hostsStore.selectedHostId,
							'drop-target': dropTargetHostId === host.id,
						}"
						:title="getTooltip(host)"
						draggable="true"
						@click="hostsStore.selectHost(host.id)"
						@contextmenu.prevent="
							emit('host-context-menu', {
								hostId: host.id,
								event: $event,
							})
						"
						@dragstart="onDragStart($event, host)"
						@dragenter.prevent
						@dragover.prevent="onDragOver($event, host.id)"
						@dragleave="onHostDragLeave($event)"
						@dragend="onHostDragEnd"
						@drop.prevent="onDrop($event, host, section)"
					>
						<div
							class="badge"
							:style="{
								backgroundColor:
									host.color ||
									getColorFromLabel(host.label),
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
								:class="`status-dot--${hostsStore.getHostStatus(host.id)}`"
							></span>
						</div>
						<span
							v-if="notificationStore.getBellCountForHost(host.id) > 0"
							class="host-bell-badge"
						>{{ notificationStore.getBellCountForHost(host.id) }}</span>
					</div>
				</template>

				<!-- Separator between groups -->
				<div
					v-if="section.type === 'group'"
					class="rail-separator"
				></div>
			</template>
		</div>

		<div class="rail-footer">
			<button
				class="rail-icon-btn"
				title="Command palette (Ctrl+K)"
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
				class="add-host-btn"
				title="Add host"
				aria-label="Add new host"
				@click="$emit('add-host')"
			>
				<span class="add-icon">+</span>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { useHostsStore } from "../stores/hosts.js";
import { useNotificationStore } from "../stores/notifications.js";
import { useChannelsStore } from "../stores/channels.js";
import {
	useHostGroups,
	type HostSection,
} from "../composables/useHostGroups.js";
import {
	getInitials,
	getColorFromLabel,
} from "../composables/useHostIcon.js";
import type { Host } from "@lasterm/shared";

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

function onDragStart(event: DragEvent, host: Host): void {
	dragHostId.value = host.id;
	if (event.dataTransfer) {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/x-lasterm-host", host.id);
	}
}

function onDragOver(event: DragEvent, hostId: string): void {
	if (!dragHostId.value || dragHostId.value === hostId) {
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

function onDrop(
	_event: DragEvent,
	targetHost: Host,
	section: HostSection,
): void {
	dropTargetHostId.value = null;
	if (!dragHostId.value || dragHostId.value === targetHost.id) return;

	const group = section.type === "group" ? section.id : null;
	const hostsInSection = section.hosts;
	const draggedIdx = hostsInSection.findIndex(
		(h) => h.id === dragHostId.value,
	);
	const targetIdx = hostsInSection.findIndex(
		(h) => h.id === targetHost.id,
	);

	// Build new order
	const orderedIds = hostsInSection.map((h) => h.id);
	if (draggedIdx >= 0) {
		// Reorder within same section
		orderedIds.splice(draggedIdx, 1);
		const insertIdx = targetIdx > draggedIdx ? targetIdx - 1 : targetIdx;
		orderedIds.splice(insertIdx, 0, dragHostId.value);
	} else {
		// Move from different section
		orderedIds.splice(targetIdx, 0, dragHostId.value);
	}

	hostsStore
		.reorderHosts(group, orderedIds)
		.then(() => hostsStore.fetchHosts());
	dragHostId.value = null;
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
	// Only fire when clicking the background itself, not a host or group header
	if (event.target !== event.currentTarget) return;
	emit("rail-context-menu", { x: event.clientX, y: event.clientY });
}

onMounted(() => {
	void hostsStore.fetchHosts();
});
</script>

<style scoped>
.host-rail {
	display: flex;
	flex-direction: column;
	align-items: center;
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
	align-items: center;
	gap: 4px;
	flex: 1;
	width: 100%;
	padding: 4px 0;
}

.badge-wrapper {
	position: relative;
	width: 36px;
	height: 36px;
	cursor: pointer;
	flex-shrink: 0;
}

/* Selected indicator — white left pill, same approach as Discord */
.badge-wrapper.selected::before {
	content: "";
	position: absolute;
	left: -6px;
	top: 50%;
	transform: translateY(-50%);
	width: 4px;
	height: 20px;
	background: var(--nt-fg);
	border-radius: 0 3px 3px 0;
}

.badge-wrapper.selected .badge {
	border-radius: 12px;
}

.badge-wrapper:not(.selected):hover .badge {
	border-radius: 12px;
}

/* Drop indicator — horizontal line above target host */
.badge-wrapper.drop-target::after {
	content: "";
	position: absolute;
	top: -3px;
	left: 4px;
	right: 4px;
	height: 2px;
	background: var(--nt-accent);
	border-radius: 1px;
}

.badge {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	position: relative;
	transition: border-radius 0.15s ease;
	user-select: none;
}

.badge-initials {
	font-size: 14px;
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
	width: 10px;
	height: 10px;
	border-radius: 50%;
	border: 2px solid var(--nt-tab-bar);
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
	width: 24px;
	height: 1px;
	background: var(--nt-tab-hover);
	flex-shrink: 0;
	margin: 2px 0;
}

.group-header {
	display: flex;
	flex-direction: row;
	align-items: center;
	gap: 4px;
	width: 100%;
	padding: 4px 6px;
	font-size: 9px;
	text-transform: uppercase;
	color: var(--nt-text-secondary);
	cursor: pointer;
	user-select: none;
}

.group-header:hover {
	color: var(--nt-fg);
}

.group-header.drop-target {
	border-top: 2px solid var(--nt-accent);
}

/* Ungrouped header — no chevron, not draggable, drop-target only */
.ungrouped-header {
	cursor: default;
	opacity: 0.6;
}

.ungrouped-header:hover {
	opacity: 1;
}

.group-chevron {
	display: inline-block;
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
	flex: 1;
	min-width: 0;
}

.rail-footer {
	padding: 8px 0 12px;
	display: flex;
	flex-direction: column;
	align-items: center;
}

.rail-icon-btn {
	width: 36px;
	height: 36px;
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
	width: 18px;
	height: 18px;
}

.add-host-btn {
	width: 36px;
	height: 36px;
	border-radius: 50%;
	border: 2px dashed var(--nt-tab-hover);
	background: transparent;
	color: var(--nt-text-secondary);
	font-size: 20px;
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
