<template>
	<!-- One upload (#837): its host, its name, a bar, bytes and rate, its state in words, and its
	     tree on demand. Its Retry, Cancel and conflict answers are for its own host and folder. -->
	<div class="upload" :class="{ 'upload--warn': attention }" data-upload-row>
		<div class="upload__head">
			<button
				type="button"
				class="upload__expand"
				:aria-expanded="open"
				:aria-label="open ? `Hide the files of ${upload.label}` : `Show the files of ${upload.label}`"
				@click="open = !open"
			>
				<FilesIcon :name="open ? 'chevron-down' : 'chevron-right'" />
			</button>
			<HostBadge v-if="host" :host="host" :size="14" />
			<span class="upload__name" :title="`${upload.label} → ${hostLabel} › ${upload.dir}`">{{ upload.label }}</span>
			<span class="upload__dest" :title="upload.dir">→ {{ hostLabel }} › {{ upload.dir }}</span>
			<button
				v-if="settled"
				type="button"
				class="upload__dismiss"
				:aria-label="`Dismiss ${upload.label}`"
				title="Dismiss"
				@click="transfers.dismiss(upload.id)"
			>
				<FilesIcon name="close" />
			</button>
		</div>
		<div
			class="upload__bar"
			role="progressbar"
			:aria-label="`${upload.label} to ${hostLabel}`"
			aria-valuemin="0"
			aria-valuemax="100"
			:aria-valuenow="percent"
			:aria-valuetext="`${percent} %, ${state}`"
		>
			<div class="upload__fill" :style="{ width: `${percent}%` }" />
		</div>
		<p class="upload__line">
			<span>{{ bytes }}</span>
			<span class="upload__state">{{ state }}</span>
		</p>
		<p v-if="upload.notResumable && !settled" class="upload__note">
			Can't be resumed after a restart: drop it again if it is interrupted
		</p>
		<div v-if="mayControl && (failedCount > 0 || cancellableCount > 0)" class="upload__actions">
			<button v-if="failedCount > 0" type="button" class="upload__btn" @click="transfers.retry(upload.id, 'upload')">
				Retry all failed ({{ failedCount }})
			</button>
			<button v-if="cancellableCount > 0 && !settled" type="button" class="upload__btn" @click="transfers.cancel(upload.id, 'upload')">
				Cancel the rest
			</button>
		</div>
		<TransferConflicts :upload="upload" :host-label="hostLabel" :may-control="mayControl" />
		<ul v-if="open" class="upload__tree" role="tree" :aria-label="`Files of ${upload.label}`">
			<TransferNode
				v-for="node in shownRoots"
				:key="node.item.itemId"
				:node="node"
				:transfer-id="upload.id"
				:may-control="mayControl"
				:depth="0"
			/>
			<li v-if="tree.length > shownRoots.length" class="upload__more">
				{{ (tree.length - shownRoots.length).toLocaleString("en-US") }} more
			</li>
		</ul>
	</div>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { computed, ref } from "vue";
import { useTransfersStore } from "../../stores/transfers.js";
import {
	buildTree,
	bytesText,
	cancellable,
	isActive,
	needsAttention,
	percentOf,
	retriable,
	stateText,
	type UploadView,
} from "../../utils/transfers-view.js";
import HostBadge from "../HostBadge.vue";
import FilesIcon from "./FilesIcon.vue";
import TransferConflicts from "./TransferConflicts.vue";
import TransferNode from "./TransferNode.vue";

const props = defineProps<{
	upload: UploadView;
	host: Host | undefined;
	hostLabel: string;
	/** Retry, Cancel and the answers: not for a reader. */
	mayControl: boolean;
}>();

/** The most rows a level of the tree draws; the rest are counted. */
const ROWS_SHOWN = 200;

const transfers = useTransfersStore();
const open = ref(false);

const counts = computed(() => props.upload.totals);
const percent = computed(() => percentOf(counts.value));
const state = computed(() => stateText(counts.value));
const bytes = computed(() => bytesText(counts.value, props.upload.rate));
const attention = computed(() => needsAttention(counts.value));
const settled = computed(() => !isActive(counts.value) && !needsAttention(counts.value));
const failedCount = computed(() => retriable(counts.value));
const cancellableCount = computed(() => cancellable(counts.value));
const tree = computed(() => (open.value ? buildTree(props.upload.items) : []));
const shownRoots = computed(() => tree.value.slice(0, ROWS_SHOWN));
</script>

<style scoped>
.upload {
	padding: 6px 0;
	font-size: 12px;
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.upload + .upload {
	border-top: 1px dashed var(--nt-border);
}

.upload__head {
	display: flex;
	align-items: center;
	gap: 6px;
	min-width: 0;
}

.upload__expand,
.upload__dismiss {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 18px;
	height: 18px;
	padding: 0;
	border: none;
	border-radius: 3px;
	background: transparent;
	color: inherit;
	cursor: pointer;
}

.upload__dismiss {
	margin-left: auto;
	color: var(--nt-text-secondary);
}

.upload__name {
	flex-shrink: 0;
	max-width: 50%;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 600;
}

.upload__dest {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.upload__bar {
	height: 4px;
	margin: 4px 0 2px 24px;
	border-radius: 2px;
	background: var(--nt-border);
	overflow: hidden;
}

.upload__fill {
	height: 100%;
	background: var(--nt-accent);
}

.upload--warn .upload__fill {
	background: var(--nt-badge-warning, var(--nt-badge));
}

.upload__line {
	display: flex;
	flex-wrap: wrap;
	gap: 2px 8px;
	margin: 0 0 0 24px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.upload__state {
	color: var(--nt-sidebar-text, var(--nt-fg));
}

.upload--warn .upload__state {
	color: var(--nt-badge-warning, var(--nt-badge));
	font-weight: 600;
}

.upload__note {
	margin: 2px 0 0 24px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.upload__actions {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin: 4px 0 0 24px;
}

.upload__btn {
	padding: 1px 8px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

.upload__expand:focus-visible,
.upload__dismiss:focus-visible,
.upload__btn:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.upload__tree {
	margin: 4px 0 0 18px;
	padding: 0;
	list-style: none;
}

.upload__more {
	padding: 2px 0 2px 22px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}
</style>
