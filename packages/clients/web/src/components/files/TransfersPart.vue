<template>
	<!-- Transfers (#836): the window's, every upload of every terminal it shows, whatever host
	     the Files part above is on. Neutral: no banner, no border, no tint, a host on each group.
	     Its rows come with upload (#837). -->
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
		<div v-if="!collapsed" :id="bodyId" class="transfers__body">
			<p v-if="groups.length === 0" class="transfers__empty">
				No uploads. Uploads from every terminal of this window are listed here, grouped by host.
			</p>
			<ul v-else class="transfers__groups">
				<li v-for="group in groups" :key="group.hostId" class="transfers__group">
					<div class="transfers__host">
						<HostBadge v-if="hostOf(group.hostId)" :host="hostOf(group.hostId)!" :size="16" />
						<span class="transfers__host-name">{{ hostOf(group.hostId)?.label ?? "Unknown host" }}</span>
					</div>
					<ul class="transfers__terminals">
						<li v-for="terminal in group.terminals" :key="terminal.channelId">
							<span class="transfers__terminal">{{ titleOf(terminal.channelId) }}</span>
							<ul class="transfers__rows">
								<li v-for="entry in terminal.transfers" :key="entry.id" class="transfers__row">
									<HostBadge v-if="hostOf(entry.hostId)" :host="hostOf(entry.hostId)!" :size="14" />
									<span class="transfers__state">{{ entry.state }}</span>
								</li>
							</ul>
						</li>
					</ul>
				</li>
			</ul>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { DEFAULT_CHANNEL_NAME } from "@lasterm/shared";
import { computed, useId } from "vue";
import { useChannelsStore } from "../../stores/channels.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useHostsStore } from "../../stores/hosts.js";
import { groupTransfers, type TransferEntry, transfersCount } from "../../utils/files-panel.js";
import HostBadge from "../HostBadge.vue";
import FilesIcon from "./FilesIcon.vue";

const props = withDefaults(
	defineProps<{
		/** The focused terminal, whose group comes first. */
		focusedChannelId: string | null;
		/** The window's uploads; none until upload lands (#837). */
		transfers?: readonly TransferEntry[];
	}>(),
	{ transfers: () => [] },
);

const filesPanel = useFilesPanelStore();
const hostsStore = useHostsStore();
const channelsStore = useChannelsStore();
const bodyId = useId();

const collapsed = computed(() => filesPanel.transfersCollapsed);
const groups = computed(() => groupTransfers(props.transfers, props.focusedChannelId));
// Collapsed, the header still counts what runs and fails; a failure turns it to the warning
// style and does not expand it.
const count = computed(() => transfersCount(props.transfers));

function hostOf(hostId: string): Host | undefined {
	return hostsStore.hosts.find((host) => host.id === hostId);
}

function titleOf(channelId: string): string {
	return (
		channelsStore.channels.find((channel) => channel.id === channelId)?.displayTitle ??
		channelsStore.channelIndex.get(channelId)?.displayTitle ??
		DEFAULT_CHANNEL_NAME
	);
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

.transfers__toggle:focus-visible {
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

.transfers__body {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 0 10px 8px;
}

.transfers__empty {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	color: var(--nt-text-secondary);
}

.transfers__groups,
.transfers__terminals,
.transfers__rows {
	margin: 0;
	padding: 0;
	list-style: none;
}

.transfers__host {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 4px 0;
	font-size: 12px;
	font-weight: 600;
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.transfers__terminal {
	display: block;
	padding-left: 22px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.transfers__row {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 2px 0 2px 22px;
	font-size: 12px;
	color: var(--nt-sidebar-text, var(--nt-fg));
}
</style>
