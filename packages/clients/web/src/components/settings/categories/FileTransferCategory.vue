<template>
	<div class="transfer-category">
		<section class="settings-section settings-section--first">
			<h3 class="section-title">
				File transfer <span class="experimental-badge">Experimental</span>
			</h3>

			<!-- `[experimental] file_transfer`: global whatever the scope shown, so no override. -->
			<SettingRow
				label="File transfer"
				scope="global"
				:is-overridden="true"
				description="Send files to a host by dropping them on its terminal, with a panel to follow them. Not finished yet. For every host."
			>
				<SettingControl
					type="toggle"
					:model-value="enabled"
					@update:model-value="onSwitch"
				/>
			</SettingRow>

			<p v-if="!enabled" class="transfer-off">
				Off: dropping files on a terminal sends nothing. Turn it on to choose how files reach a host.
			</p>
		</section>

		<SchemaCategory
			v-if="enabled"
			category="transfer"
			:scope="scope"
			v-bind="hostName !== undefined ? { hostName } : {}"
		/>
	</div>
</template>

<script setup lang="ts">
import { isFileTransferEnabled } from "@lasterm/shared";
import { computed } from "vue";
import { type Scope, useSettingsStore } from "../../../stores/settings.js";
import SettingControl from "../SettingControl.vue";
import SettingRow from "../SettingRow.vue";
import SchemaCategory from "./SchemaCategory.vue";

/**
 * Settings › File transfer (#835): the terminal-profile keys of uploads, at
 * every scope, and the files panel's, globally. All of it waits behind the
 * experimental switch: while it is off, the switch and one line are all there
 * is, so that no release shows a feature that does not work yet.
 */
defineProps<{
	scope: Scope;
	hostName?: string;
}>();

const settingsStore = useSettingsStore();

/** As the hub resolves `[experimental]`, with the change just made. */
const enabled = computed(() => isFileTransferEnabled(settingsStore.cascade?.ui.resolved));

function onSwitch(value: unknown): void {
	void settingsStore.updateSetting("global", "ui", "experimental.fileTransfer", value === true);
}
</script>

<style scoped>
.transfer-category {
	display: flex;
	flex-direction: column;
}

.settings-section--first {
	margin-top: 0;
	padding-top: 0;
	border-top: none;
}

.section-title {
	display: flex;
	align-items: center;
	gap: 8px;
	margin: 0 0 12px 0;
	font-size: 13px;
	font-weight: 600;
	color: var(--nt-fg);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.experimental-badge {
	padding: 1px 6px;
	font-size: 10px;
	font-weight: 600;
	letter-spacing: 0.02em;
	color: var(--nt-accent);
	border: 1px solid var(--nt-accent);
	border-radius: 3px;
}

.transfer-off {
	margin: 10px 0 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
}
</style>
