import { generateId } from "@lasterm/shared";
import { ref, watch } from "vue";
import type { PaneNode } from "./usePaneTree.js";
import {
	ensurePaneIds,
	findFirstLeafPaneId,
	MAX_PANE_COUNT,
	truncateToMaxPanes,
	usePaneTree,
} from "./usePaneTree.js";
import type { Tab } from "./useTabManager.js";
import { useTabManager } from "./useTabManager.js";

// ---------------------------------------------------------------------------
// Re-export types and helpers so existing consumers importing from useLayout
// continue to work without any import path changes.
// ---------------------------------------------------------------------------

export type { DropZone, NodePath, PaneNode } from "./usePaneTree.js";
export {
	collectTerminalChannelIds,
	countPanes,
	findChannelByPaneId,
	findFirstLeafPaneId,
	purgeDeadTabs,
	purgeOrphanedTabs,
	resolveTabLabel,
} from "./usePaneTree.js";
export type { Tab } from "./useTabManager.js";

// ---------------------------------------------------------------------------
// localStorage persistence key
// ---------------------------------------------------------------------------

const LAYOUT_KEY = "lasterm:layout";

interface PersistedState {
	tabs: Tab[];
	activeTabIndex: number;
	layouts: Record<string, PaneNode | null>;
	activePaneIds: Record<string, string>;
}

function loadFromStorage(): PersistedState | null {
	try {
		const raw = localStorage.getItem(LAYOUT_KEY);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		// Migration: old Tab { channelId, label } → new Tab { id }
		const rawTabs = parsed.tabs as Array<Record<string, unknown>> | undefined;
		if (rawTabs && rawTabs.length > 0 && rawTabs[0]?.channelId !== undefined) {
			// Old format — migrate
			const newTabs: Tab[] = [];
			const newLayouts: Record<string, PaneNode | null> = {};
			const newActivePaneIds: Record<string, string> = {};
			const oldLayouts = (parsed.layouts as Record<string, PaneNode | null> | undefined) ?? {};

			for (const oldTab of rawTabs) {
				const oldChannelId = oldTab.channelId as string;
				const newId = generateId();
				newTabs.push({ id: newId });
				let tree = oldLayouts[oldChannelId] ?? null;
				if (tree !== null) {
					tree = ensurePaneIds(tree);
					tree = truncateToMaxPanes(tree, MAX_PANE_COUNT);
					newLayouts[newId] = tree;
					const paneId = findFirstLeafPaneId(tree);
					if (paneId) newActivePaneIds[newId] = paneId;
				} else {
					newLayouts[newId] = null;
				}
			}

			return {
				tabs: newTabs,
				activeTabIndex: (parsed.activeTabIndex as number | undefined) ?? 0,
				layouts: newLayouts,
				activePaneIds: newActivePaneIds,
			};
		}

		// New format
		const state = parsed as unknown as PersistedState;
		// Migrate old layouts that lack paneId; enforce max pane count (INV-10)
		for (const key of Object.keys(state.layouts)) {
			let tree = state.layouts[key];
			if (tree !== null && tree !== undefined) {
				tree = ensurePaneIds(tree);
				tree = truncateToMaxPanes(tree, MAX_PANE_COUNT);
				state.layouts[key] = tree;
			}
		}
		// Ensure activePaneIds is present
		if (!state.activePaneIds) {
			state.activePaneIds = {};
		}
		return state;
	} catch {
		return null;
	}
}

function saveToStorage(state: PersistedState): void {
	try {
		localStorage.setItem(LAYOUT_KEY, JSON.stringify(state));
	} catch {
		// Ignore storage errors (e.g. private browsing quota)
	}
}

// ---------------------------------------------------------------------------
// Composable facade
// ---------------------------------------------------------------------------

/**
 * Manages the tab bar and recursive pane-split layout for the main terminal area.
 *
 * Each tab has its own stable ULID identity (`tab.id`), independent of any channel.
 * Layout trees are keyed by tab.id. `activePaneIds` tracks which pane has focus
 * per tab. State is persisted to localStorage so layout survives page refresh.
 *
 * This is a thin facade composing `usePaneTree` and `useTabManager`.
 * The public API is unchanged — all consumers continue to import from this module.
 */
export function useLayout() {
	const persisted = loadFromStorage();

	// ------------------------------------------------------------------
	// Shared reactive state (owned here, passed into sub-composables)
	// ------------------------------------------------------------------

	const tabs = ref<Tab[]>(persisted?.tabs ?? []);
	const activeTabIndex = ref<number>(persisted?.activeTabIndex ?? 0);

	/**
	 * Per-tab layout trees. Key = tab.id (stable ULID, independent of channel).
	 */
	const layouts = ref<Record<string, PaneNode | null>>(persisted?.layouts ?? {});

	/**
	 * Per-tab active pane tracking. Key = tab.id, value = paneId of the focused pane.
	 */
	const activePaneIds = ref<Record<string, string>>(persisted?.activePaneIds ?? {});

	// ------------------------------------------------------------------
	// Compose sub-composables (passing shared refs by reference)
	// ------------------------------------------------------------------

	const paneTree = usePaneTree(tabs, activeTabIndex, layouts, activePaneIds);

	const tabManager = useTabManager(
		tabs,
		activeTabIndex,
		layouts,
		activePaneIds,
		paneTree.findTabForChannel,
		paneTree.vacatePaneInTab,
	);

	// ------------------------------------------------------------------
	// Persistence: auto-save on any state change
	// ------------------------------------------------------------------

	watch(
		[tabs, activeTabIndex, layouts, activePaneIds],
		() => {
			saveToStorage({
				tabs: tabs.value,
				activeTabIndex: activeTabIndex.value,
				layouts: layouts.value,
				activePaneIds: activePaneIds.value,
			});
		},
		{ deep: true },
	);

	// ------------------------------------------------------------------
	// Public API — same shape as the original useLayout
	// ------------------------------------------------------------------

	return {
		// Shared state
		tabs,
		activeTabIndex,
		layouts,
		activePaneIds,

		// Derived state (paneTree)
		activeTab: paneTree.activeTab,
		layout: paneTree.layout,

		// Tab operations (tabManager)
		openTab: tabManager.openTab,
		closeTab: tabManager.closeTab,
		setActiveTab: tabManager.setActiveTab,
		reorderTab: tabManager.reorderTab,
		vacateAllPanesInTab: tabManager.vacateAllPanesInTab,
		closeOthers: tabManager.closeOthers,
		closeToRight: tabManager.closeToRight,
		closeAll: tabManager.closeAll,
		moveToNewTab: tabManager.moveToNewTab,

		// Pane operations (paneTree)
		setLayout: paneTree.setLayout,
		splitPane: paneTree.splitPane,
		unsplitPane: paneTree.unsplitPane,
		updateRatio: paneTree.updateRatio,
		replaceChannelId: paneTree.replaceChannelId,
		getTabLabel: paneTree.getTabLabel,
		getActiveChannelId: paneTree.getActiveChannelId,
		setActivePaneId: paneTree.setActivePaneId,
		vacatePane: paneTree.vacatePane,
		detachPane: paneTree.detachPane,
		closePane: paneTree.closePane,
		fillVacant: paneTree.fillVacant,
		rearrangeVacant: paneTree.rearrangeVacant,
		movePaneTo: paneTree.movePaneTo,
		findTabForChannel: paneTree.findTabForChannel,
	};
}
