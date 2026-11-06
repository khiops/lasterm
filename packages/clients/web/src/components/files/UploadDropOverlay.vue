<template>
	<!-- While files are dragged over a terminal (#837): over the terminal area, below its header
	     and banner, where they would go, the host first, in its colour; or why they cannot. Once a
	     refused drop is let go here, "Request write" is offered for a moment. -->
	<div v-if="hover" class="upload-drop" :class="{ 'upload-drop--refused': hover.decision.kind === 'refuse' }" :style="accent" aria-hidden="true">
		<div class="upload-drop__card">
			<p class="upload-drop__title">
				<HostBadge v-if="host" :host="host" :size="20" />
				<span>{{ text }}</span>
			</p>
			<p v-for="warning in warnings" :key="warning" class="upload-drop__warn">{{ warning }}</p>
		</div>
	</div>
	<div v-else-if="refused" class="upload-drop upload-drop--note" role="status">
		<div class="upload-drop__card">
			<p class="upload-drop__title">{{ refusedText }}</p>
			<div class="upload-drop__actions">
				<button v-if="refused.reason === 'reader'" type="button" class="upload-drop__btn upload-drop__btn--primary" @click="requestWrite">
					Request write
				</button>
				<button type="button" class="upload-drop__btn" @click="transfers.clearRefusal()">Dismiss</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { computed } from "vue";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { useTransfersStore } from "../../stores/transfers.js";
import { useWriteLockStore } from "../../stores/writelock.js";
import { overlayText, refusalText } from "../../utils/upload-drop.js";
import HostBadge from "../HostBadge.vue";

const props = defineProps<{
	paneId: string | null;
	channelId: string | null;
	host: Host | undefined;
	hostLabel: string;
	/** The host's badge colour, which the overlay's edge takes. */
	color: string | null;
}>();

const transfers = useTransfersStore();
const filesPanel = useFilesPanelStore();
const writeLockStore = useWriteLockStore();

const hover = computed(() => {
	const h = transfers.dropHover;
	if (h === null || h.place !== "pane" || h.paneId !== props.paneId) return null;
	return h;
});

const refused = computed(() => {
	const r = transfers.refusal;
	return r !== null && r.paneId === props.paneId ? r : null;
});

const text = computed(() => {
	const h = hover.value;
	if (h === null) return "";
	if (h.decision.kind === "refuse") return refusalText(h.decision.reason, props.hostLabel);
	return overlayText({ count: h.count, hostLabel: props.hostLabel, dir: h.dir, origin: h.origin });
});

const refusedText = computed(() => (refused.value === null ? "" : refusalText(refused.value.reason, props.hostLabel)));

/** A program in the foreground, or a terminal that shows another host (#834): said before the drop. */
const warnings = computed(() => {
	if (hover.value?.decision.kind !== "take" || props.channelId === null) return [];
	const live = filesPanel.liveCwdFor(props.channelId);
	const out: string[] = [];
	if (live?.otherHost !== undefined) {
		out.push(`This terminal shows ${live.otherHost}: the files go to ${props.hostLabel}`);
	} else if (live?.atPrompt === false && live.foreground !== undefined) {
		out.push(`${live.foreground} is running in this terminal: the files go to the shell's directory`);
	}
	return out;
});

const accent = computed(() => (props.color === null ? {} : { "--upload-drop-accent": props.color }));

function requestWrite(): void {
	if (props.channelId !== null) writeLockStore.claim(props.channelId);
	transfers.clearRefusal();
}
</script>

<style scoped>
.upload-drop {
	position: absolute;
	left: 0;
	right: 0;
	bottom: 0;
	top: var(--upload-drop-top, 0);
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 16px;
	z-index: 35;
	pointer-events: none;
	border: 2px dashed var(--upload-drop-accent, var(--nt-accent));
	background: rgba(var(--nt-accent-rgb, 100, 149, 237), 0.12);
}

.upload-drop--refused {
	border-color: var(--nt-border);
	background: rgba(var(--nt-bg-rgb), 0.5);
}

.upload-drop--note {
	border: none;
	background: transparent;
	align-items: flex-end;
}

.upload-drop--note .upload-drop__card {
	pointer-events: all;
}

/* The exit card's opaque ground: it reads over any terminal content or wallpaper. */
.upload-drop__card {
	max-width: min(460px, 100%);
	padding: 10px 14px;
	border-radius: 6px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	font-size: 13px;
}

.upload-drop__title {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0;
	overflow-wrap: anywhere;
}

.upload-drop__warn {
	margin: 6px 0 0;
	font-size: 12px;
	font-weight: 600;
}

.upload-drop__actions {
	display: flex;
	gap: 6px;
	margin-top: 8px;
}

.upload-drop__btn {
	padding: 3px 10px;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: transparent;
	color: inherit;
	font: inherit;
	font-size: 12px;
	cursor: pointer;
}

.upload-drop__btn--primary {
	background: var(--nt-accent);
	border-color: var(--nt-accent);
	color: var(--nt-accent-fg);
}

.upload-drop__btn:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}
</style>
