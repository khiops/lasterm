<template>
	<!-- The conflict step (#837): a card in the upload's group, not a modal dialog, so that it
	     never takes the keyboard from the terminal when it arrives later. A folder that exists is
	     summed up first; a folder is never replaced as a whole. -->
	<div v-if="folders.length > 0 || files.length > 0" class="files-card transfer-conflicts" role="group" :aria-label="`Conflicts in ${upload.label}`">
		<div v-for="folder in folders" :key="folder.item.itemId" class="transfer-conflicts__block">
			<p class="files-card__text">{{ folderConflictText(folder, upload.dir) }}</p>
			<div v-if="mayControl" class="files-card__actions">
				<button
					v-for="action in actionsFor(folder.waiting)"
					:key="action"
					type="button"
					class="files-btn"
					:class="{ 'files-btn--primary': action === 'skip' }"
					@click="answer(applyToAll ? 'upload' : folder.item.itemId, action)"
				>
					{{ ACTION_LABELS[action] }}{{ action === "replace" ? ` (those ${folder.waiting.length})` : "" }}
				</button>
				<button type="button" class="files-link" :aria-expanded="shownFolder === folder.item.itemId" @click="toggleShow(folder.item.itemId)">
					Show the {{ folder.waiting.length.toLocaleString("en-US") }}
				</button>
			</div>
			<ul v-if="shownFolder === folder.item.itemId" class="transfer-conflicts__files">
				<li v-for="item in folder.waiting.slice(0, ROWS_SHOWN)" :key="item.itemId" class="transfer-conflicts__file">
					<span class="transfer-conflicts__name">{{ item.relPath }}</span>
					<span class="transfer-conflicts__detail">{{ conflictDetail(item, now) }}</span>
					<span v-if="mayControl" class="transfer-conflicts__file-actions">
						<button
							v-for="action in actionsFor([item])"
							:key="action"
							type="button"
							class="files-btn"
							@click="answer(item.itemId, action)"
						>
							{{ ACTION_LABELS[action] }}
						</button>
					</span>
				</li>
			</ul>
		</div>
		<div v-if="files.length > 0" class="transfer-conflicts__block">
			<p class="files-card__text">
				{{ files.length === 1 ? "A file is already there:" : `${files.length.toLocaleString("en-US")} files are already there:` }}
			</p>
			<ul class="transfer-conflicts__files">
				<li v-for="item in files.slice(0, ROWS_SHOWN)" :key="item.itemId" class="transfer-conflicts__file">
					<span class="transfer-conflicts__name">{{ item.relPath }}</span>
					<span class="transfer-conflicts__detail">{{ conflictDetail(item, now) }}</span>
					<span v-if="mayControl" class="transfer-conflicts__file-actions">
						<button
							v-for="action in actionsFor([item])"
							:key="action"
							type="button"
							class="files-btn"
							:class="{ 'files-btn--primary': action === 'skip' }"
							@click="answer(applyToAll ? 'upload' : item.itemId, action)"
						>
							{{ ACTION_LABELS[action] }}
						</button>
					</span>
				</li>
			</ul>
		</div>
		<div v-if="mayControl" class="transfer-conflicts__options">
			<label class="transfer-conflicts__option">
				<input v-model="applyToAll" type="checkbox" />
				{{ waitingTotal > 1 ? `Apply to all ${waitingTotal.toLocaleString("en-US")} in this upload` : "Apply to all in this upload" }}
			</label>
			<label class="transfer-conflicts__option">
				<input v-model="always" type="checkbox" />
				Always do this
			</label>
			<div
				class="transfer-conflicts__scope"
				:class="{ 'transfer-conflicts__scope--off': !always }"
				role="radiogroup"
				aria-label="Where to always do this"
			>
				<label class="transfer-conflicts__option">
					<input v-model="where" type="radio" value="host" :name="scopeName" @change="always = true" />
					{{ hostLabel }}
				</label>
				<label class="transfer-conflicts__option">
					<input v-model="where" type="radio" value="global" :name="scopeName" @change="always = true" />
					Everywhere
				</label>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { TransferConflictAction, TransferScope } from "@lasterm/shared";
import { computed, ref, useId } from "vue";
import { useTransfersStore } from "../../stores/transfers.js";
import {
	conflictActions,
	conflictDetail,
	fileConflicts,
	folderConflicts,
	folderConflictText,
	type UploadItemView,
	type UploadView,
} from "../../utils/transfers-view.js";

const props = defineProps<{
	upload: UploadView;
	/** The upload's own host, which the scope names: the panel may show another by now. */
	hostLabel: string;
	mayControl: boolean;
}>();

const ACTION_LABELS: Readonly<Record<TransferConflictAction, string>> = {
	skip: "Skip",
	keep_both: "Keep both",
	replace: "Replace",
};

const ROWS_SHOWN = 200;

const transfers = useTransfersStore();
const scopeName = useId();
const now = new Date();

const folders = computed(() => folderConflicts(props.upload));
const files = computed(() => fileConflicts(props.upload));
const waitingTotal = computed(() => props.upload.items.filter((item) => item.state === "conflict").length);

const applyToAll = ref(false);
const always = ref(false);
const where = ref<"host" | "global">("host");
const shownFolder = ref<number | null>(null);

function actionsFor(items: readonly UploadItemView[]): TransferConflictAction[] {
	return conflictActions(items);
}

function toggleShow(itemId: number): void {
	shownFolder.value = shownFolder.value === itemId ? null : itemId;
}

function answer(scope: TransferScope, action: TransferConflictAction): void {
	void transfers.resolve(props.upload.id, scope, action, always.value ? where.value : "once");
}
</script>

<style scoped>
.files-card {
	margin: 6px 0 2px 24px;
	padding: 8px 10px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
}

.files-card__text {
	margin: 0 0 6px;
	font-size: 12px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.files-card__actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
}

.files-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 2px 8px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 11px;
	cursor: pointer;
}

.files-btn--primary {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.files-link {
	padding: 0;
	border: none;
	background: none;
	color: var(--nt-accent);
	font: inherit;
	font-size: 11px;
	font-weight: 600;
	cursor: pointer;
}

.files-btn:focus-visible,
.files-link:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.transfer-conflicts__block + .transfer-conflicts__block {
	margin-top: 8px;
}

.transfer-conflicts__files {
	margin: 6px 0 0;
	padding: 0;
	list-style: none;
	max-height: 160px;
	overflow-y: auto;
}

.transfer-conflicts__file {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 2px 8px;
	padding: 2px 0;
	font-size: 11px;
}

.transfer-conflicts__name {
	font-weight: 600;
	overflow-wrap: anywhere;
}

.transfer-conflicts__detail {
	color: var(--nt-text-strong);
}

.transfer-conflicts__file-actions {
	display: inline-flex;
	gap: 4px;
	margin-left: auto;
}

.transfer-conflicts__options {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 12px;
	margin-top: 8px;
	font-size: 11px;
}

.transfer-conflicts__option {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	cursor: pointer;
}

.transfer-conflicts__scope {
	display: inline-flex;
	gap: 10px;
}

.transfer-conflicts__scope--off {
	opacity: 0.6;
}
</style>
