import { type MaybeRef, ref, toValue } from "vue";

export interface SearchHistoryEntry {
	query: string;
	regex: boolean;
}

export function useSearchHistory(maxSize: MaybeRef<number> = 20) {
	const STORAGE_KEY = "lasterm:search-history";

	// Load from localStorage on init
	const history = ref<SearchHistoryEntry[]>(loadFromStorage());

	function add(query: string, regex: boolean): void {
		if (!query.trim()) return;
		// Remove duplicate (same query + same regex state)
		history.value = history.value.filter((e) => !(e.query === query && e.regex === regex));
		// Add to front (MRU order)
		history.value.unshift({ query, regex });
		// Cap at maxSize (reactive — picks up config changes at runtime)
		const cap = toValue(maxSize);
		if (history.value.length > cap) history.value.pop();
		// Persist
		saveToStorage();
	}

	function clear(): void {
		history.value = [];
		localStorage.removeItem(STORAGE_KEY);
	}

	function loadFromStorage(): SearchHistoryEntry[] {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			return raw ? JSON.parse(raw) : [];
		} catch {
			return [];
		}
	}

	function saveToStorage(): void {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(history.value));
	}

	return { history, add, clear };
}
