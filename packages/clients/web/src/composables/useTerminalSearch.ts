import type { ISearchDecorationOptions, ISearchResultChangeEvent } from "@xterm/addon-search";
import { SearchAddon } from "@xterm/addon-search";
import type { IDisposable, Terminal } from "@xterm/xterm";
import { type Ref, ref } from "vue";

export interface SearchOptions {
	caseSensitive: boolean;
	regex: boolean;
	wholeWord: boolean;
}

export interface SearchState {
	query: Ref<string>;
	isOpen: Ref<boolean>;
	matchCount: Ref<number>;
	currentMatch: Ref<number>;
	options: Ref<SearchOptions>;
	regexError: Ref<string | null>;
}

/**
 * Terminal search composable — wraps @xterm/addon-search with reactive
 * state for query, match count, options, and regex validation.
 *
 * Lifecycle:
 *   1. Call `init(terminal)` after the terminal is opened and themed.
 *   2. Use `search()`, `findNext()`, `findPrevious()` to navigate results.
 *   3. Call `dispose()` on terminal teardown.
 */
export interface SearchInitOptions {
	/** Whether to render match markers in the scrollbar overview ruler (default: true). */
	scrollbarMarkers?: boolean;
}

export function useTerminalSearch() {
	let searchAddon: SearchAddon | null = null;
	let resultsDisposable: IDisposable | null = null;
	let scrollbarMarkersEnabled = true;

	const query = ref("");
	const isOpen = ref(false);
	const matchCount = ref(0);
	const currentMatch = ref(0);
	const options = ref<SearchOptions>({
		caseSensitive: false,
		regex: false,
		wholeWord: false,
	});
	const regexError = ref<string | null>(null);

	/** Load the SearchAddon onto the given terminal instance. */
	function init(term: Terminal, opts?: SearchInitOptions): void {
		scrollbarMarkersEnabled = opts?.scrollbarMarkers !== false;
		const addon = new SearchAddon();
		term.loadAddon(addon);
		searchAddon = addon;

		// Track match count / active index via onDidChangeResults
		resultsDisposable = addon.onDidChangeResults((e: ISearchResultChangeEvent) => {
			matchCount.value = e.resultCount;
			// resultIndex is 0-based, -1 when threshold exceeded
			currentMatch.value = e.resultIndex >= 0 ? e.resultIndex + 1 : 0;
		});
	}

	/**
	 * Move the search to another terminal instance, which holds another
	 * terminal's output (#966). The box keeps its query, options and open
	 * state; its counts start from none, never the old instance's, and a valid
	 * query is searched again in the new one.
	 */
	function rebind(term: Terminal, opts?: SearchInitOptions): void {
		dispose();
		init(term, opts);
		matchCount.value = 0;
		currentMatch.value = 0;
		if (query.value) search(query.value);
	}

	/** Update the scrollbar markers enabled state at runtime. */
	function setScrollbarMarkers(enabled: boolean): void {
		scrollbarMarkersEnabled = enabled;
		// Re-run search to apply/remove overview ruler decorations
		if (searchAddon && query.value) {
			searchAddon.clearDecorations();
			searchAddon.findNext(query.value, {
				...options.value,
				incremental: true,
				decorations: getDecorationColors(),
			});
		}
	}

	/** Read decoration colors from CSS custom properties (UX-06 theming). */
	function getDecorationColors(): ISearchDecorationOptions {
		const style = getComputedStyle(document.documentElement);
		const highlight = style.getPropertyValue("--nt-search-highlight").trim() || "#e6db74";
		const active = style.getPropertyValue("--nt-search-highlight-active").trim() || "#f92672";

		if (scrollbarMarkersEnabled) {
			return {
				matchBackground: highlight,
				activeMatchBackground: active,
				matchOverviewRuler: highlight,
				activeMatchColorOverviewRuler: active,
			};
		}
		return {
			matchBackground: highlight,
			activeMatchBackground: active,
			matchOverviewRuler: "transparent",
			activeMatchColorOverviewRuler: "transparent",
		};
	}

	/**
	 * Execute an incremental search for the given query string.
	 * Called on every keystroke in the search input.
	 */
	function search(q: string): void {
		query.value = q;

		if (!searchAddon || !q) {
			matchCount.value = 0;
			currentMatch.value = 0;
			regexError.value = null;
			if (searchAddon) searchAddon.clearDecorations();
			return;
		}

		// Validate regex before passing to SearchAddon
		if (options.value.regex) {
			try {
				new RegExp(q);
				regexError.value = null;
			} catch (e) {
				regexError.value = (e as Error).message;
				return; // Keep previous valid decorations
			}
		} else {
			regexError.value = null;
		}

		searchAddon.findNext(q, {
			...options.value,
			incremental: true,
			decorations: getDecorationColors(),
		});
	}

	/** Navigate to the next match. */
	function findNext(): void {
		if (!searchAddon || !query.value) return;
		searchAddon.findNext(query.value, {
			...options.value,
			decorations: getDecorationColors(),
		});
	}

	/** Navigate to the previous match. */
	function findPrevious(): void {
		if (!searchAddon || !query.value) return;
		searchAddon.findPrevious(query.value, {
			...options.value,
			decorations: getDecorationColors(),
		});
	}

	/** Clear all search state and decorations. */
	function clear(): void {
		if (searchAddon) {
			searchAddon.clearDecorations();
		}
		query.value = "";
		matchCount.value = 0;
		currentMatch.value = 0;
		regexError.value = null;
	}

	/** Open the search overlay. */
	function open(): void {
		isOpen.value = true;
	}

	/** Close the search overlay and clear state. */
	function close(): void {
		isOpen.value = false;
		clear();
	}

	/** Dispose the SearchAddon and clean up listeners. */
	function dispose(): void {
		resultsDisposable?.dispose();
		resultsDisposable = null;
		if (searchAddon) {
			searchAddon.dispose();
			searchAddon = null;
		}
	}

	return {
		// State
		query,
		isOpen,
		matchCount,
		currentMatch,
		options,
		regexError,
		// Actions
		init,
		rebind,
		search,
		findNext,
		findPrevious,
		clear,
		open,
		close,
		dispose,
		setScrollbarMarkers,
	};
}
