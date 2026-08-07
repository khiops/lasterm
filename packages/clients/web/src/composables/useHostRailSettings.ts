import { reactive, watch } from "vue";

const STORAGE_KEY = "lasterm:host-rail-settings";

export interface HostRailSettingsData {
	showLabels: boolean;
	showStatusDots: boolean;
}

function loadFromStorage(): HostRailSettingsData {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<HostRailSettingsData>;
			return {
				showLabels: parsed.showLabels ?? false,
				showStatusDots: parsed.showStatusDots ?? true,
			};
		}
	} catch {
		// Ignore parse errors
	}
	return { showLabels: false, showStatusDots: true };
}

/** Singleton reactive state — shared across all consumers. */
const settings = reactive<HostRailSettingsData>(loadFromStorage());

// Auto-persist on any change
watch(settings, (val) => {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
});

/**
 * Composable for host rail display settings (show labels, show status dots).
 * State is persisted to localStorage and shared across all components.
 */
export function useHostRailSettings(): HostRailSettingsData {
	return settings;
}
