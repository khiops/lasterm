<template>
	<!-- A pane's uploads (#837): its own terminal's only, whether or not the panel shows them;
	     it opens the panel on this pane, its group expanded. -->
	<button
		v-if="chip"
		type="button"
		class="transfer-chip"
		:class="{ 'transfer-chip--warn': chip.warn }"
		:aria-label="`${chip.label}: show in Transfers`"
		:title="`${chip.label}: show in Transfers`"
		@click="onClick"
	>
		{{ chip.text }}
	</button>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useConfigStore } from "../../stores/config.js";
import { useTransfersStore } from "../../stores/transfers.js";
import { chipFor } from "../../utils/transfers-view.js";

const props = defineProps<{ channelId: string | null }>();

const configStore = useConfigStore();
const transfers = useTransfersStore();

const chip = computed(() =>
	!configStore.fileTransferEnabled || props.channelId === null ? null : chipFor(transfers.uploads, props.channelId),
);

function onClick(): void {
	transfers.showTransfers(props.channelId);
}
</script>

<style scoped>
.transfer-chip {
	flex-shrink: 0;
	height: 18px;
	padding: 0 6px;
	border: 1px solid var(--nt-border);
	border-radius: 9px;
	background: transparent;
	color: var(--nt-text-secondary);
	font: inherit;
	font-size: 11px;
	line-height: 16px;
	white-space: nowrap;
	cursor: pointer;
}

.transfer-chip--warn {
	color: var(--nt-badge-warning, var(--nt-badge));
	border-color: currentColor;
	font-weight: 600;
}

.transfer-chip:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 1px;
}
</style>
