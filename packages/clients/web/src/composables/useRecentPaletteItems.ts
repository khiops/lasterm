import { ref } from "vue";

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "lasterm:palette-recent";
const MAX_ITEMS = 8;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadRecents(): string[] {
	if (typeof localStorage === "undefined") return [];
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_ITEMS)
			: [];
	} catch {
		return [];
	}
}

function saveRecents(ids: string[]): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_ITEMS)));
	} catch {
		// localStorage unavailable — SC-25: graceful degradation
	}
}

// ─── Module-level singleton (persists across hot-reloads in dev) ──────────────

const recentIds = ref<string[]>(loadRecents());

// ─── Composable ───────────────────────────────────────────────────────────────

export function useRecentPaletteItems() {
	/**
	 * Push an item to the front of the recent list.
	 * Deduplicates (SC-24): if already present, moves it to front.
	 * Caps at MAX_ITEMS.
	 */
	function pushRecent(id: string): void {
		const filtered = recentIds.value.filter((r) => r !== id);
		filtered.unshift(id);
		recentIds.value = filtered.slice(0, MAX_ITEMS);
		saveRecents(recentIds.value);
	}

	function clearRecent(): void {
		recentIds.value = [];
		saveRecents([]);
	}

	return {
		recentIds,
		pushRecent,
		clearRecent,
	};
}
