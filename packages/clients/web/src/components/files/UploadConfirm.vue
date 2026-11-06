<template>
	<!-- Before any byte moves (#837): what will be sent, to which host and folder, the host
	     first. Counting shows with Cancel; a large upload warns; names the host cannot hold are
	     listed for the whole tree. Esc cancels, and the keyboard goes back where it was. -->
	<div
		v-if="shown && p"
		ref="card"
		class="files-card upload-confirm"
		:class="`upload-confirm--${place}`"
		role="dialog"
		:aria-labelledby="titleId"
		tabindex="-1"
		data-own-escape
		@keydown.esc.stop.prevent="cancel"
	>
		<p :id="titleId" class="upload-confirm__title">
			<HostBadge v-if="host" :host="host" :size="16" />
			<span>Upload to <strong>{{ hostLabel }}</strong> › <code class="upload-confirm__dir">{{ p.target.dir }}</code></span>
		</p>
		<p class="upload-confirm__origin">{{ originText }}</p>

		<template v-if="p.phase === 'counting'">
			<p class="files-card__text" role="status">{{ countingText(p.counts) }}</p>
			<div class="files-card__actions">
				<button ref="primary" type="button" class="files-btn" @click="cancel">Cancel</button>
			</div>
		</template>
		<template v-else>
			<p class="files-card__text">{{ p.summary }}</p>
			<p v-if="p.joins !== null" class="files-card__text">
				This finishes the interrupted upload of {{ p.joins }}: what is placed is not sent again.
			</p>
			<p v-if="limit !== null" class="files-card__text upload-confirm__warn" role="alert">{{ limit }}</p>
			<p v-if="p.error !== null" class="files-card__text upload-confirm__warn" role="alert">{{ p.error }}</p>
			<template v-if="p.problems.length > 0">
				<p class="files-card__text upload-confirm__warn">
					{{ p.problems.length === 1 ? "1 name" : `${p.problems.length.toLocaleString("en-US")} names` }}
					cannot be on {{ hostLabel }}:
				</p>
				<ul class="upload-confirm__problems">
					<li v-for="problem in p.problems.slice(0, PROBLEMS_SHOWN)" :key="problem.relPath">
						<code>{{ problem.relPath }}</code>: {{ problem.reason }}
					</li>
					<li v-if="p.problems.length > PROBLEMS_SHOWN">
						{{ (p.problems.length - PROBLEMS_SHOWN).toLocaleString("en-US") }} more
					</li>
				</ul>
			</template>
			<div v-if="choosing" class="upload-confirm__choose">
				<input
					ref="dirInput"
					v-model="dirText"
					class="upload-confirm__input"
					type="text"
					aria-label="Folder to upload to"
					spellcheck="false"
					autocomplete="off"
					@keydown.enter.prevent="applyDir"
				/>
				<button type="button" class="files-btn" @click="applyDir">Use this folder</button>
			</div>
			<div class="files-card__actions">
				<template v-if="p.limits.refuse">
					<button ref="primary" type="button" class="files-btn files-btn--primary" @click="cancel">Close</button>
				</template>
				<template v-else-if="p.problems.length > 0">
					<button
						ref="primary"
						type="button"
						class="files-btn files-btn--primary"
						:disabled="p.phase === 'starting'"
						@click="upload(true)"
					>
						Skip those
					</button>
					<button type="button" class="files-btn" @click="cancel">Cancel</button>
				</template>
				<template v-else>
					<button
						ref="primary"
						type="button"
						class="files-btn files-btn--primary"
						:disabled="p.phase === 'starting'"
						@click="upload(false)"
					>
						{{ p.phase === "starting" ? "Starting…" : "Upload" }}
					</button>
					<button v-if="!choosing" type="button" class="files-btn" @click="startChoosing">Choose folder…</button>
					<button type="button" class="files-btn" @click="cancel">Cancel</button>
				</template>
			</div>
			<div v-if="p.target.confirm && !p.limits.refuse" class="upload-confirm__options">
				<label class="upload-confirm__option">
					<input v-model="dontAsk" type="checkbox" />
					Don't ask again
				</label>
				<div
					class="upload-confirm__scope"
					:class="{ 'upload-confirm__scope--off': !dontAsk }"
					role="radiogroup"
					aria-label="Where not to ask again"
				>
					<label class="upload-confirm__option">
						<input v-model="where" type="radio" value="host" :name="scopeName" @change="dontAsk = true" />
						{{ hostLabel }}
					</label>
					<label class="upload-confirm__option">
						<input v-model="where" type="radio" value="global" :name="scopeName" @change="dontAsk = true" />
						Everywhere
					</label>
				</div>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import { useHostsStore } from "../../stores/hosts.js";
import { useTransfersStore } from "../../stores/transfers.js";
import { countingText, limitText } from "../../utils/upload-drop.js";
import HostBadge from "../HostBadge.vue";

const props = defineProps<{
	/** Where this card shows: over a pane, or in the files panel. */
	place: "pane" | "panel";
	/** Over a pane: which one. */
	paneId?: string | null;
}>();

const emit = defineEmits<{
	/** The card went: the keyboard goes back where it was. */
	(e: "done"): void;
}>();

const PROBLEMS_SHOWN = 20;

const transfers = useTransfersStore();
const hostsStore = useHostsStore();
const titleId = useId();
const scopeName = useId();

const p = computed(() => transfers.pending);
const shown = computed(() => {
	const pending = p.value;
	if (pending === null || !transfers.pendingShown || pending.target.place !== props.place) return false;
	return props.place === "panel" || pending.target.paneId === (props.paneId ?? null);
});
const host = computed(() => hostsStore.hosts.find((h) => h.id === p.value?.target.hostId));
const hostLabel = computed(() => host.value?.label ?? "this host");
const limit = computed(() => (p.value === null ? null : limitText(p.value.limits, p.value.counts)));
const originText = computed(() => {
	switch (p.value?.target.origin) {
		case "terminal":
			return "This terminal's directory";
		case "start":
			return "The folder for unknown directories: the terminal's own is not known";
		case "panel":
			return "The folder the files panel shows";
		default:
			return "The folder chosen";
	}
});

const card = ref<HTMLElement | null>(null);
const primary = ref<HTMLButtonElement | null>(null);
const dontAsk = ref(false);
const where = ref<"host" | "global">("host");
const choosing = ref(false);
const dirText = ref("");
const dirInput = ref<HTMLInputElement | null>(null);

// Right after the drop or the pick, the card takes the keyboard: it is the answer to a gesture.
watch(
	() => [shown.value, p.value?.phase] as const,
	([now]) => {
		if (!now) return;
		void nextTick(() => {
			if (card.value !== null && !card.value.contains(document.activeElement)) {
				(primary.value ?? card.value).focus();
			}
		});
	},
	{ immediate: true },
);

function finish(): void {
	choosing.value = false;
	dontAsk.value = false;
	emit("done");
}

function cancel(): void {
	transfers.cancelPending();
	finish();
}

async function upload(skipProblems: boolean): Promise<void> {
	await transfers.confirmPending({ skipProblems, dontAskAgain: dontAsk.value ? where.value : null });
	if (transfers.pending === null) finish();
}

function startChoosing(): void {
	dirText.value = p.value?.target.dir ?? "";
	choosing.value = true;
	void nextTick(() => {
		dirInput.value?.focus();
		dirInput.value?.select();
	});
}

function applyDir(): void {
	transfers.retargetPending(dirText.value);
	choosing.value = false;
	void nextTick(() => primary.value?.focus());
}
</script>

<style scoped>
.files-card {
	padding: 10px 12px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	font-size: 12px;
}

.upload-confirm--pane {
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	width: min(440px, calc(100% - 32px));
	max-height: calc(100% - 32px);
	overflow-y: auto;
	z-index: 40;
}

.upload-confirm--panel {
	margin: 8px;
}

.upload-confirm:focus {
	outline: none;
}

.upload-confirm__title {
	display: flex;
	align-items: center;
	gap: 6px;
	margin: 0;
	font-size: 13px;
	overflow-wrap: anywhere;
}

.upload-confirm__dir {
	font-size: 12px;
}

.upload-confirm__origin {
	margin: 2px 0 8px;
	font-size: 11px;
}

.files-card__text {
	margin: 0 0 8px;
	font-size: 12px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.upload-confirm__warn {
	font-weight: 600;
}

.upload-confirm__problems {
	margin: 0 0 8px;
	padding-left: 16px;
	max-height: 140px;
	overflow-y: auto;
	font-size: 11px;
	overflow-wrap: anywhere;
}

.files-card__actions {
	display: flex;
	flex-wrap: wrap;
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
.upload-confirm__input:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.upload-confirm__choose {
	display: flex;
	gap: 6px;
	margin-bottom: 8px;
}

.upload-confirm__input {
	flex: 1;
	min-width: 0;
	padding: 3px 6px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: rgb(var(--nt-bg-rgb));
	color: inherit;
	font: inherit;
	font-family: monospace;
	font-size: 12px;
}

.upload-confirm__options {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 12px;
	margin-top: 8px;
	font-size: 11px;
}

.upload-confirm__option {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	cursor: pointer;
}

.upload-confirm__scope {
	display: inline-flex;
	gap: 10px;
}

.upload-confirm__scope--off {
	opacity: 0.6;
}
</style>
