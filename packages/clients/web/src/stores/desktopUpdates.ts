import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { connectUpdateState, type UpdateState } from "../utils/desktop-updates.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";
import { useSettingsStore } from "./settings.js";

/**
 * The desktop's update state as the page last received it, and what the page itself decides:
 * whether the dialog was opened from Settings (#1214).
 */
export const useDesktopUpdatesStore = defineStore("desktopUpdates", () => {
	const state = ref<UpdateState | null>(null);
	/** The offer whose dialog Settings' Update now… opened, in whatever mode. */
	const openedFor = ref<string | null>(null);
	/** The dialog was opened from Settings for the offer known now. */
	const openedFromSettings = computed(
		() => openedFor.value !== null && openedFor.value === state.value?.offer?.key,
	);
	// An opening belongs to its offer: gone or replaced, a later offer does not inherit it.
	watch(
		() => state.value?.offer?.key,
		(key) => {
			if (openedFor.value !== null && openedFor.value !== key) openedFor.value = null;
		},
	);
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
		openedFor.value = state.value?.offer?.key ?? null;
	}

	function closeDialog(): void {
		openedFor.value = null;
	}

	/** A notice's Open Settings: Settings › Desktop, a category of the Global scope only. */
	function requestSettings(): void {
		useSettingsStore().openAt({
			category: "desktop",
			scope: "global",
			hostId: null,
			channelId: null,
		});
	}

	return {
		state,
		openedFromSettings,
		connect,
		openFromSettings,
		closeDialog,
		requestSettings,
	};
});
