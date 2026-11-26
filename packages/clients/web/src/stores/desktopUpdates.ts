import { defineStore } from "pinia";
import { ref } from "vue";
import { connectUpdateState, type UpdateState } from "../utils/desktop-updates.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";

/**
 * The desktop's update state as the page last received it, and what the page itself decides:
 * whether the dialog was opened from Settings (#1214).
 */
export const useDesktopUpdatesStore = defineStore("desktopUpdates", () => {
	const state = ref<UpdateState | null>(null);
	/** The dialog was opened from Settings' Update now…, in whatever mode. */
	const openedFromSettings = ref(false);
	/** Bumped when a notice's Open Settings asks for Settings › Desktop. */
	const settingsRequests = ref(0);
	let connecting: Promise<void> | null = null;

	/** Starts following the desktop's state; once, and only in the desktop app. */
	function connect(): Promise<void> {
		if (!isTauriRuntime()) return Promise.resolve();
		connecting ??= connectUpdateState((next) => {
			state.value = next;
		})
			.then(() => undefined)
			.catch((error) => {
				connecting = null;
				console.warn("[desktop-updates] cannot follow the update state:", error);
			});
		return connecting;
	}

	function openFromSettings(): void {
		openedFromSettings.value = true;
	}

	function closeDialog(): void {
		openedFromSettings.value = false;
	}

	function requestSettings(): void {
		settingsRequests.value += 1;
	}

	return {
		state,
		openedFromSettings,
		settingsRequests,
		connect,
		openFromSettings,
		closeDialog,
		requestSettings,
	};
});
