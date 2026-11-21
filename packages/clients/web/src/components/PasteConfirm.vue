<template>
	<!-- A paste of several lines, held before any of it is sent (#1015): how many lines, the first
	     ones, Paste and Cancel. The card takes the keyboard, not Paste, so that a key typed right
	     after the paste does not confirm it unread; Tab reaches the buttons, Esc cancels. -->
	<div
		ref="card"
		class="paste-confirm"
		role="dialog"
		:aria-labelledby="titleId"
		:aria-describedby="textId"
		tabindex="-1"
		data-own-escape
		@keydown.esc.stop.prevent="emit('cancel')"
	>
		<p :id="titleId" class="paste-confirm__title">Paste {{ pending.lines.toLocaleString("en-US") }} lines?</p>
		<p :id="textId" class="paste-confirm__text">
			{{
				pending.bracketed
					? "The program in this terminal has asked to receive pastes as one block."
					: "Its line breaks may run commands as soon as they arrive."
			}}
		</p>
		<ol class="paste-confirm__preview" aria-label="First lines">
			<li v-for="(line, index) in previewLines" :key="index">{{ line }}</li>
		</ol>
		<p v-if="moreLines > 0" class="paste-confirm__more">
			{{ moreLines === 1 ? "1 more line" : `${moreLines.toLocaleString("en-US")} more lines` }}
		</p>
		<div class="paste-confirm__actions">
			<button type="button" class="paste-confirm__btn paste-confirm__btn--primary" @click="onPaste">Paste</button>
			<button type="button" class="paste-confirm__btn" @click="emit('cancel')">Cancel</button>
		</div>
		<div class="paste-confirm__options">
			<label class="paste-confirm__option">
				<input v-model="dontAsk" type="checkbox" />
				Don't ask again
			</label>
			<div
				class="paste-confirm__scope"
				:class="{ 'paste-confirm__scope--off': !dontAsk }"
				role="radiogroup"
				aria-label="Where not to ask again"
			>
				<label class="paste-confirm__option">
					<input v-model="where" type="radio" value="host" :name="scopeName" @change="dontAsk = true" />
					{{ hostLabel }}
				</label>
				<label class="paste-confirm__option">
					<input v-model="where" type="radio" value="global" :name="scopeName" @change="dontAsk = true" />
					Everywhere
				</label>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from "vue";
import type { PendingPaste } from "../composables/useTerminal.js";

/** How many lines the card shows, and how much of each, in code points. */
const PREVIEW_LINES = 3;
const PREVIEW_CODE_POINTS = 80;

const props = defineProps<{
	pending: PendingPaste;
	/** The pane's host, for "Don't ask again". */
	hostLabel: string;
}>();

const emit = defineEmits<{
	/** Paste clicked; where not to ask again, if the box is checked. */
	(e: "paste", dontAskAgain: "host" | "global" | null): void;
	(e: "cancel"): void;
}>();

const titleId = useId();
const textId = useId();
const scopeName = useId();
const card = ref<HTMLElement | null>(null);
const dontAsk = ref(false);
const where = ref<"host" | "global">("host");

/** A line cut whole characters at a time: an emoji is never split in two. */
function cut(line: string): string {
	const points = Array.from(line);
	return points.length > PREVIEW_CODE_POINTS ? `${points.slice(0, PREVIEW_CODE_POINTS).join("")}…` : line;
}

const previewLines = computed(() => props.pending.preview.slice(0, PREVIEW_LINES).map(cut));
const moreLines = computed(() => Math.max(0, props.pending.lines - PREVIEW_LINES));

function onPaste(): void {
	emit("paste", dontAsk.value ? where.value : null);
}

/** The card takes the keyboard when it appears, and again for each paste it is given. */
function takeKeyboard(): void {
	void nextTick(() => card.value?.focus());
}
onMounted(takeKeyboard);
watch(
	() => props.pending.id,
	() => {
		dontAsk.value = false;
		where.value = "host";
		takeKeyboard();
	},
);

defineExpose({ card });
</script>

<style scoped>
.paste-confirm {
	position: absolute;
	left: 50%;
	top: 50%;
	transform: translate(-50%, -50%);
	width: min(440px, calc(100% - 32px));
	max-height: calc(100% - 32px);
	overflow-y: auto;
	z-index: 40;
	padding: 10px 12px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	font-size: 12px;
}

.paste-confirm:focus {
	outline: none;
}

.paste-confirm:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.paste-confirm__title {
	margin: 0 0 2px;
	font-size: 13px;
	font-weight: 600;
}

.paste-confirm__text {
	margin: 0 0 8px;
	line-height: 1.4;
}

.paste-confirm__preview {
	margin: 0 0 4px;
	padding: 6px 8px;
	list-style: none;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	font-family: monospace;
	font-size: 11px;
	line-height: 1.5;
	white-space: pre;
	overflow-x: auto;
}

.paste-confirm__more {
	margin: 0 0 8px;
	font-size: 11px;
	color: var(--nt-text-secondary);
}

.paste-confirm__actions {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 8px;
}

.paste-confirm__btn {
	padding: 3px 10px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.paste-confirm__btn--primary {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.paste-confirm__btn:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}

.paste-confirm__options {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 12px;
	margin-top: 8px;
	font-size: 11px;
}

.paste-confirm__option {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	cursor: pointer;
}

.paste-confirm__scope {
	display: inline-flex;
	gap: 10px;
}

.paste-confirm__scope--off {
	opacity: 0.6;
}
</style>
