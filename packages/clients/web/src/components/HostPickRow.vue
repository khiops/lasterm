<template>
	<span class="host-pick-row">
		<span class="host-pick-row__line">
			<HostBadge :host="host" :status="status" :size="24" />
			<span class="host-pick-row__names">
				<span class="host-pick-row__label">{{ host.label }}</span>
				<span v-if="address" class="host-pick-row__address">{{ address }}</span>
			</span>
			<span v-if="countText" class="host-pick-row__count">{{ countText }}</span>
			<span class="host-pick-row__action" :data-tone="action.tone">{{ action.text }}</span>
			<span v-if="hint" class="host-pick-row__hint">{{ hint }}</span>
		</span>
		<span v-if="note" class="host-pick-row__note">{{ note }}</span>
	</span>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { computed } from "vue";
import { type RowAction, terminalCountText } from "../composables/hostPicker.js";
import type { HostStatus } from "../stores/hosts.js";
import HostBadge from "./HostBadge.vue";

/**
 * One host, as the empty pane and the command palette list it (#625): its
 * badge and status dot, its label, its address, how many terminals it has,
 * and a word on the right — its status, or what choosing it does. The row
 * around it, the option a list selects, belongs to the list.
 */
const props = withDefaults(
	defineProps<{
		host: Host;
		status: HostStatus;
		address: string;
		count?: number;
		action: RowAction;
		/** A second line: what is under way, or why it failed. */
		note?: string | null;
		/** The keys that act on it, where a list names them. */
		hint?: string | null;
	}>(),
	{ count: 0, note: null, hint: null },
);

const countText = computed(() => terminalCountText(props.count));
</script>

<style scoped>
.host-pick-row {
	display: flex;
	flex-direction: column;
	gap: 2px;
	width: 100%;
	min-width: 0;
}

.host-pick-row__line {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
}

.host-pick-row__names {
	flex: 1 1 0;
	min-width: 0;
	display: flex;
	align-items: baseline;
	gap: 8px;
	text-align: left;
}

.host-pick-row__label {
	font-size: 13px;
	color: var(--nt-fg);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	flex-shrink: 0;
	max-width: 60%;
}

.host-pick-row__address {
	font-size: 12px;
	color: var(--nt-text-muted);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	min-width: 0;
}

.host-pick-row__count {
	font-size: 12px;
	color: var(--nt-text-muted);
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}

.host-pick-row__action {
	font-size: 12px;
	font-weight: 600;
	white-space: nowrap;
	min-width: 72px;
	text-align: right;
}

.host-pick-row__action[data-tone="accent"] {
	color: var(--nt-accent);
}

.host-pick-row__action[data-tone="live"] {
	color: var(--nt-green);
}

.host-pick-row__action[data-tone="warn"] {
	color: var(--nt-yellow);
}

.host-pick-row__action[data-tone="error"] {
	color: var(--nt-danger);
}

.host-pick-row__action[data-tone="muted"] {
	color: var(--nt-text-muted);
}

.host-pick-row__hint {
	font-size: 11px;
	color: var(--nt-text-secondary);
	white-space: nowrap;
}

/* Under the label, past the badge. */
.host-pick-row__note {
	padding-left: 34px;
	font-size: 12px;
	line-height: 16px;
	color: var(--nt-text-muted);
	text-align: left;
	white-space: normal;
	overflow-wrap: anywhere;
}
</style>
