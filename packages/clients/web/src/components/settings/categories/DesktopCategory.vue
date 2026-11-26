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

		<template v-if="update?.eligible">
			<SettingRow
				label="Updates"
				description="What Lasterm does when a newer version is in the Microsoft Store. The Microsoft Store installs Lasterm updates; it may also install them while Lasterm is closed, following its own settings."
				scope="global"
				:is-overridden="true"
			>
				<div class="update-control">
					<SettingControl
						:model-value="update.mode"
						type="select"
						:options="UPDATE_MODE_OPTIONS"
						:disabled="savingMode"
						@update:model-value="onModeChange"
					/>
					<p v-if="update.loadError" class="update-error" role="alert">{{ update.loadError }}</p>
					<p v-if="modeError" class="update-error" role="alert">{{ modeError }}</p>
				</div>
			</SettingRow>

			<SettingRow label="Version" scope="global" :is-overridden="true">
				<span class="update-version">{{ threeParts(update.runningVersion) }}</span>
			</SettingRow>

			<SettingRow label="Check for updates" scope="global" :is-overridden="true">
				<div class="update-check">
					<button
						class="update-button"
						type="button"
						data-update-check
						:disabled="update.checking === 'running'"
						@click="onCheck"
					>
						Check for updates
					</button>
					<p class="update-status">{{ statusLine }}</p>
					<div v-if="update.offer" class="update-offer">
						<span>{{ offerLine }}</span>
						<button class="update-button" type="button" data-update-opener @click="updates.openFromSettings()">
							Update now…
						</button>
						<button class="update-button" type="button" @click="onWhatsNew">What's new</button>
					</div>
					<p v-if="update.checkError" class="update-error">
						The last check failed: {{ update.checkError }}{{ failureTime }}
					</p>
					<p v-if="checkPressError" class="update-error" role="alert">{{ checkPressError }}</p>
					<p v-if="linkError" class="update-error" role="alert">{{ linkError }}</p>
				</div>
			</SettingRow>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useDesktopUpdatesStore } from "../../../stores/desktopUpdates.js";
import {
	type CloseBehavior,
	closeBehaviorOptionsForTray,
	isCloseBehavior,
	readCloseBehavior,
	saveCloseBehavior,
} from "../../../utils/close-behavior.js";
import { commandError, type UpdateMode, updateCommands } from "../../../utils/desktop-updates.js";
import SettingControl from "../SettingControl.vue";
import SettingRow from "../SettingRow.vue";

const trayAvailable = ref(false);
const closeBehavior = ref<CloseBehavior>("ask");
const closeBehaviorError = ref<string | null>(null);
const closeBehaviorOptions = computed(() =>
	closeBehaviorOptionsForTray(trayAvailable.value, closeBehavior.value),
);

// ── Updates (STORE-UPDATE-NOTICE, #1214) ──

const UPDATE_MODE_OPTIONS: { label: string; value: UpdateMode }[] = [
	{ label: "Notify me", value: "ask" },
	{ label: "Leave updates to the Microsoft Store", value: "auto" },
	{ label: "Don't check", value: "off" },
];

const updates = useDesktopUpdatesStore();
const update = computed(() => updates.state);
const savingMode = ref(false);
const modeError = ref<string | null>(null);
const linkError = ref<string | null>(null);
/** Check for updates itself refused, which is not a failed check. */
const checkPressError = ref<string | null>(null);
/** A Store page asked for and not yet answered: one at a time. */
const opening = ref(false);

function threeParts(version: string): string {
	return version.split(".").slice(0, 3).join(".");
}

function when(iso: string | undefined): string {
	return iso ? new Date(iso).toLocaleString() : "";
}

const statusLine = computed(() => {
	const current = update.value;
	if (!current) return "";
	if (current.checking === "running") return "Checking…";
	if (current.checking === "waiting") return "Waiting for the Microsoft Store";
	if (current.lastCheckedAt && !current.offer) {
		return `The Microsoft Store reports no update (${when(current.lastCheckedAt)})`;
	}
	// No answer yet, a failed attempt or none: the failure has its own line beneath (D3).
	if (!current.lastCheckedAt && !current.offer) return "Not checked yet";
	return "";
});

const offerLine = computed(() => {
	const version = update.value?.offer?.version;
	return version ? `Lasterm ${version} is available` : "A newer version of Lasterm is available";
});

// When that check failed, which the next attempt does not change.
const failureTime = computed(() =>
	update.value?.checkFailedAt ? ` (${when(update.value.checkFailedAt)})` : "",
);

async function onModeChange(value: unknown): Promise<void> {
	if (value !== "ask" && value !== "auto" && value !== "off") return;
	savingMode.value = true;
	modeError.value = null;
	try {
		await updateCommands.setMode(value);
	} catch (error) {
		// The selector keeps showing the mode the desktop holds (D3).
		modeError.value = `The update preference could not be saved: ${commandError(error)}`;
	} finally {
		savingMode.value = false;
	}
}

async function onCheck(): Promise<void> {
	checkPressError.value = null;
	try {
		await updateCommands.check();
	} catch (error) {
		checkPressError.value = commandError(error);
	}
}

async function onWhatsNew(): Promise<void> {
	if (opening.value) return;
	opening.value = true;
	linkError.value = null;
	try {
		await updateCommands.openStorePage();
	} catch (error) {
		linkError.value = commandError(error);
	} finally {
		opening.value = false;
	}
}

onMounted(async () => {
	void updates.connect();
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
.close-behavior-error,
.update-error {
	margin: 4px 0 0;
	color: var(--nt-danger);
	font-size: 12px;
}

.update-control {
	max-width: 320px;
}

.update-status {
	margin: 4px 0 0;
	color: var(--nt-text-secondary);
	font-size: 12px;
}

.update-version {
	font-size: 12px;
	color: var(--nt-fg);
}

.update-check {
	max-width: 360px;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
}

.update-offer {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	font-size: 12px;
	color: var(--nt-fg);
}

.update-button {
	padding: 4px 10px;
	font-size: 12px;
	font-family: inherit;
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
	cursor: pointer;
}

.update-button:disabled {
	cursor: default;
	opacity: 0.6;
}

.update-button:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}
</style>
