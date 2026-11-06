<template>
	<!-- A pane's way to its files (#836): left of the write-lock indicator, pressed while the
	     panel shows this pane's terminal. Only while file transfer is on (#835). -->
	<button
		v-if="shown"
		type="button"
		class="files-button"
		:class="{ 'files-button--on': pressed }"
		:aria-pressed="pressed"
		:aria-controls="FILES_PANEL_ID"
		:aria-label="label"
		:title="label"
		@click="onClick"
	>
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path
				d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
			/>
		</svg>
	</button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useConfigStore } from "../../stores/config.js";
import { useFilesPanelStore } from "../../stores/files-panel.js";
import { shortcutLabel } from "../../utils/app-shortcuts.js";
import { FILES_PANEL_ID } from "../../utils/files-panel.js";

const props = defineProps<{
	/** The pane's terminal; a pane still spawning has none, and shows no button. */
	channelId: string | null;
}>();

const configStore = useConfigStore();
const filesPanel = useFilesPanelStore();

const shown = computed(() => configStore.fileTransferEnabled && props.channelId !== null);
const pressed = computed(() => filesPanel.isOpenOn(props.channelId));
const label = computed(() => `Files (${shortcutLabel("files.toggle")})`);

function onClick(): void {
	if (props.channelId !== null) filesPanel.toggleFor(props.channelId);
}
</script>

<style scoped>
.files-button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 22px;
	height: 20px;
	padding: 0;
	border: 1px solid transparent;
	border-radius: 4px;
	background: transparent;
	color: var(--nt-text-secondary);
	cursor: pointer;
}

.files-button svg {
	width: 14px;
	height: 14px;
	fill: none;
	stroke: currentColor;
	stroke-width: 2;
	stroke-linecap: round;
	stroke-linejoin: round;
}

.files-button:hover {
	color: var(--nt-fg);
	border-color: var(--nt-border);
}

.files-button--on {
	color: var(--nt-accent-fg);
	background: var(--nt-accent);
	border-color: var(--nt-accent);
}

.files-button--on:hover {
	color: var(--nt-accent-fg);
}

.files-button:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}
</style>
