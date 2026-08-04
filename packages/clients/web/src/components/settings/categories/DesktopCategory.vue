<template>
	<div class="desktop-category">
		<SettingRow
			label="Window Close Behavior"
			description="Choose what the desktop app does when the main window is closed."
			scope="global"
			:is-overridden="true"
		>
			<div>
				<SettingControl
					:model-value="closeBehavior"
					type="select"
					:options="closeBehaviorOptions"
					@update:model-value="onCloseBehaviorChange"
				/>
				<p v-if="closeBehaviorError" class="close-behavior-error" role="alert">
					{{ closeBehaviorError }}
				</p>
			</div>
		</SettingRow>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
	type CloseBehavior,
	closeBehaviorOptionsForTray,
	isCloseBehavior,
	readCloseBehavior,
	saveCloseBehavior,
} from "../../../utils/close-behavior.js";
import SettingControl from "../SettingControl.vue";
import SettingRow from "../SettingRow.vue";

const trayAvailable = ref(false);
const closeBehavior = ref<CloseBehavior>("ask");
const closeBehaviorError = ref<string | null>(null);
const closeBehaviorOptions = computed(() =>
	closeBehaviorOptionsForTray(trayAvailable.value, closeBehavior.value),
);

onMounted(async () => {
	try {
		closeBehavior.value = await readCloseBehavior();
	} catch (error) {
		closeBehaviorError.value = `Close preference could not be loaded: ${errorMessage(error)}`;
	}
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		trayAvailable.value = await invoke<boolean>("is_tray_available");
	} catch {
		trayAvailable.value = false;
	}
});

async function onCloseBehaviorChange(value: unknown): Promise<void> {
	if (!isCloseBehavior(value)) return;
	const previous = closeBehavior.value;
	closeBehaviorError.value = null;
	const result = await saveCloseBehavior(previous, value);
	closeBehavior.value = result.behavior;
	closeBehaviorError.value = result.error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
</script>

<style scoped>
.close-behavior-error {
	margin: 4px 0 0;
	color: var(--nt-danger);
	font-size: 12px;
}
</style>
