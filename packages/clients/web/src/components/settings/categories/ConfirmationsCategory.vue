<template>
	<div class="confirmations-category">
		<section class="settings-section settings-section--first">
			<h3 class="section-title">Confirmations</h3>

			<p class="confirmations-help">
				What Lasterm asks before doing something nothing undoes. Each question can be
				answered once with "don't ask again"; this is where it comes back. The answers
				are kept in this browser, on this machine.
			</p>
			<p class="confirmations-help">
				Closing a terminal that has ended is not asked about: Settings › Terminal says
				whether it is deleted or kept in the sidebar.
			</p>

			<label v-for="entry in CONFIRMATIONS" :key="entry.key" class="confirmation-row">
				<input
					type="checkbox"
					:checked="asked[entry.key]"
					@change="onToggle(entry.key, ($event.target as HTMLInputElement).checked)"
				/>
				<span class="confirmation-text">
					<span class="confirmation-label">Ask before {{ entry.label.toLowerCase() }}</span>
					<span class="confirmation-description">{{ entry.description }}</span>
				</span>
			</label>
		</section>
	</div>
</template>

<script setup lang="ts">
import { reactive } from "vue";
import {
	CONFIRMATIONS,
	type ConfirmationKey,
	confirmationIsAsked,
	setConfirmationAsked,
} from "../../../utils/confirmations.js";

/** Read once on open: nothing else in this session changes these. */
const asked = reactive(
	Object.fromEntries(CONFIRMATIONS.map((entry) => [entry.key, confirmationIsAsked(entry.key)])) as
		Record<ConfirmationKey, boolean>,
);

function onToggle(key: ConfirmationKey, wanted: boolean): void {
	setConfirmationAsked(key, wanted);
	asked[key] = confirmationIsAsked(key);
}
</script>

<style scoped>
.confirmations-help {
	margin: 0 0 16px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	max-width: 62ch;
}

.confirmation-row {
	display: flex;
	gap: 10px;
	align-items: flex-start;
	padding: 8px 0;
	cursor: pointer;
}

.confirmation-text {
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.confirmation-label {
	font-size: 13px;
	color: var(--nt-fg);
}

.confirmation-description {
	font-size: 12px;
	color: var(--nt-text-secondary);
	max-width: 62ch;
}
</style>
