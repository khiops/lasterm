<template>
	<!-- A file or a folder of an upload (#837): its state in words; a folder sums what it holds,
	     expands into it, and collapses to one line once everything in it is placed. -->
	<li
		class="node"
		role="treeitem"
		:aria-expanded="isFolder && !placedFolder ? open : undefined"
		:aria-level="depth + 1"
	>
		<div class="node__row" :class="{ 'node__row--warn': warn }">
			<button
				v-if="isFolder && !placedFolder"
				type="button"
				class="node__expand"
				:aria-label="open ? `Collapse ${node.name}` : `Expand ${node.name}`"
				@click="open = !open"
			>
				<FilesIcon :name="open ? 'chevron-down' : 'chevron-right'" />
			</button>
			<span v-else class="node__space" aria-hidden="true" />
			<FilesIcon :name="isFolder ? 'folder' : 'file'" />
			<span class="node__name" :title="node.item.relPath">{{ node.name }}</span>
			<span class="node__state">{{ text }}</span>
			<template v-if="mayControl">
				<button v-if="retryCount > 0" type="button" class="node__btn" @click="transfers.retry(transferId, node.item.itemId)">
					{{ isFolder ? `Retry ${retryCount} failed` : "Retry" }}
				</button>
				<button v-if="cancelCount > 0" type="button" class="node__btn" @click="transfers.cancel(transferId, node.item.itemId)">
					Cancel
				</button>
			</template>
		</div>
		<div v-if="!isFolder && node.item.state === 'sending'" class="node__bar" aria-hidden="true">
			<div class="node__fill" :style="{ width: `${percent}%` }" />
		</div>
		<ul v-if="isFolder && open && !placedFolder" class="node__children" role="group">
			<TransferNode
				v-for="child in shownChildren"
				:key="child.item.itemId"
				:node="child"
				:transfer-id="transferId"
				:may-control="mayControl"
				:depth="depth + 1"
			/>
			<li v-if="node.children.length > shownChildren.length" class="node__more">
				{{ (node.children.length - shownChildren.length).toLocaleString("en-US") }} more
			</li>
		</ul>
	</li>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useTransfersStore } from "../../stores/transfers.js";
import {
	cancellable,
	folderText,
	isFullyPlaced,
	itemText,
	percentOf,
	retriable,
	type TreeNode,
} from "../../utils/transfers-view.js";
import FilesIcon from "./FilesIcon.vue";

const props = defineProps<{
	node: TreeNode;
	transferId: string;
	mayControl: boolean;
	depth: number;
}>();

/** The most rows a folder draws; the rest are counted. */
const ROWS_SHOWN = 200;

const transfers = useTransfersStore();
const open = ref(false);

const isFolder = computed(() => props.node.item.kind === "dir");
const placedFolder = computed(() => isFolder.value && isFullyPlaced(props.node.counts));
const text = computed(() =>
	isFolder.value
		? props.node.counts.files === 0
			? itemText(props.node.item)
			: folderText(props.node.counts)
		: itemText(props.node.item),
);
const warn = computed(() => {
	const states = props.node.counts.states;
	return (states.failed ?? 0) + (states.conflict ?? 0) > 0 || props.node.item.state === "failed";
});
const retryCount = computed(() => retriable(props.node.counts));
const cancelCount = computed(() => cancellable(props.node.counts));
const percent = computed(() => percentOf({ bytes: props.node.item.size, acked: props.node.item.acked }));
const shownChildren = computed(() => props.node.children.slice(0, ROWS_SHOWN));
</script>

<style scoped>
.node {
	font-size: 11px;
}

.node__row {
	display: flex;
	align-items: center;
	gap: 4px;
	min-width: 0;
	padding: 1px 0;
}

.node__row--warn .node__state {
	color: var(--nt-badge-warning, var(--nt-badge));
	font-weight: 600;
}

.node__expand {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 16px;
	height: 16px;
	padding: 0;
	border: none;
	background: transparent;
	color: inherit;
	cursor: pointer;
}

.node__space {
	width: 16px;
	flex-shrink: 0;
}

.node__name {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.node__state {
	flex-shrink: 0;
	margin-left: auto;
	color: var(--nt-text-secondary);
}

.node__btn {
	flex-shrink: 0;
	padding: 0 6px;
	border: 1px solid var(--nt-border);
	border-radius: 3px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

.node__expand:focus-visible,
.node__btn:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.node__bar {
	height: 2px;
	margin: 0 0 2px 36px;
	background: var(--nt-border);
}

.node__fill {
	height: 100%;
	background: var(--nt-accent);
}

.node__children {
	margin: 0 0 0 14px;
	padding: 0;
	list-style: none;
}

.node__more {
	padding: 1px 0 1px 20px;
	color: var(--nt-text-secondary);
}
</style>
