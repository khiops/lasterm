import { generateId } from "@lasterm/shared";
import { type Ref, triggerRef } from "vue";
import { useConfigStore } from "../stores/config.js";
import type { PaneNode } from "./usePaneTree.js";

// ---------------------------------------------------------------------------
// Tab type
// ---------------------------------------------------------------------------

export interface Tab {
	id: string;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Manages the tab bar state and operations.
 *
 * Receives all four shared refs — `tabs`, `activeTabIndex`, `layouts`,
 * `activePaneIds` — so it can coordinate tab and layout state together
 * (e.g. openTab initializes a layout entry; closeTab removes it).
 *
 * Also receives `findTabForChannel` and `vacatePaneInTab` from `usePaneTree`
 * to avoid duplicating pane-tree traversal logic.
 */
export function useTabManager(
	tabs: Ref<Tab[]>,
	activeTabIndex: Ref<number>,
	layouts: Ref<Record<string, PaneNode | null>>,
	activePaneIds: Ref<Record<string, string>>,
	findTabForChannel: (channelId: string) => string | null,
	vacatePaneInTab: (tabId: string, channelId: string) => void,
) {
	// ------------------------------------------------------------------
	// Tab management
	// ------------------------------------------------------------------

	/**
	 * Open a tab for `channelId`. If a tab for this channel already exists,
	 * switch to it. Otherwise append a new tab and activate it.
	 */
	function openTab(channelId: string): void {
		// Check if channel is already in any existing tab
		const existingTabId = findTabForChannel(channelId);
		if (existingTabId !== null) {
			const existingIdx = tabs.value.findIndex((t) => t.id === existingTabId);
			if (existingIdx !== -1) {
				activeTabIndex.value = existingIdx;
				return;
			}
		}

		const configStore = useConfigStore();
		const newTabPosition = configStore.uiConfig.tabs?.newTabPosition;
		const newPaneId = generateId();
		const newTabId = generateId();
		const newTab: Tab = { id: newTabId };
		const newNode: PaneNode = { type: "terminal", channelId, paneId: newPaneId };
		let activeIdx: number;

		if (newTabPosition === "afterActive") {
			const newTabs = [...tabs.value];
			const insertIdx = Math.max(0, Math.min(activeTabIndex.value + 1, newTabs.length));
			newTabs.splice(insertIdx, 0, newTab);
			tabs.value = newTabs;
			activeIdx = insertIdx;
		} else {
			activeIdx = tabs.value.length;
			tabs.value = [...tabs.value, newTab];
		}

		// Initialize layout and active pane for the new tab
		layouts.value = {
			...layouts.value,
			[newTabId]: newNode,
		};
		activePaneIds.value = {
			...activePaneIds.value,
			[newTabId]: newPaneId,
		};
		activeTabIndex.value = activeIdx;

		// Force Vue to re-evaluate v-show on the newly created v-for element.
		// When adding the first tab, activeTabIndex is already 0 so the 0→0
		// assignment is a reactive no-op — triggerRef ensures the pane container
		// gets the correct display state.
		triggerRef(activeTabIndex);
	}

	/**
	 * Close the tab at `index`. Adjusts activeTabIndex to remain valid.
	 */
	function closeTab(index: number): void {
		const tab = tabs.value[index];
		if (tab === undefined) return;

		const next = tabs.value.filter((_, i) => i !== index);
		tabs.value = next;

		// Remove the persisted layout and active pane for the closed tab
		const { [tab.id]: _removedLayout, ...restLayouts } = layouts.value;
		layouts.value = restLayouts;
		const { [tab.id]: _removedPane, ...restPanes } = activePaneIds.value;
		activePaneIds.value = restPanes;

		// Clamp active index
		if (activeTabIndex.value >= next.length) {
			activeTabIndex.value = Math.max(0, next.length - 1);
		} else if (activeTabIndex.value > index) {
			activeTabIndex.value = activeTabIndex.value - 1;
		}
	}

	/**
	 * Switch to the tab at `index`.
	 */
	function setActiveTab(index: number): void {
		if (index >= 0 && index < tabs.value.length) {
			activeTabIndex.value = index;
		}
	}

	/**
	 * Reorder a tab from one position to another (drag-and-drop).
	 * Adjusts activeTabIndex so the currently active tab stays active.
	 */
	function reorderTab(fromIndex: number, toIndex: number): void {
		if (fromIndex === toIndex) return;
		if (fromIndex < 0 || fromIndex >= tabs.value.length) return;
		// Clamp toIndex to valid range
		const clampedTo = Math.max(0, Math.min(toIndex, tabs.value.length - 1));
		if (fromIndex === clampedTo) return;

		const newTabs = [...tabs.value];
		const [moved] = newTabs.splice(fromIndex, 1);
		if (moved === undefined) return;
		newTabs.splice(clampedTo, 0, moved);
		tabs.value = newTabs;

		// Adjust active tab index to follow the active tab
		const currentActive = activeTabIndex.value;
		if (currentActive === fromIndex) {
			// The active tab was dragged
			activeTabIndex.value = clampedTo;
		} else if (fromIndex < currentActive && clampedTo >= currentActive) {
			// Moved from before active to after → active shifts left
			activeTabIndex.value = currentActive - 1;
		} else if (fromIndex > currentActive && clampedTo <= currentActive) {
			// Moved from after active to before → active shifts right
			activeTabIndex.value = currentActive + 1;
		}
		// Otherwise active tab index is unaffected
	}

	// ------------------------------------------------------------------
	// Bulk close operations
	// ------------------------------------------------------------------

	/** Replace all terminal nodes in a tab's layout with vacant slots. */
	function vacateAllPanesInTab(tabId: string): void {
		const root = layouts.value[tabId];
		if (root === null || root === undefined) return;

		function vacateNode(node: PaneNode): PaneNode {
			if (node.type === "terminal") return { type: "vacant", id: generateId() };
			if (node.type === "vacant") return node;
			return {
				type: "split",
				direction: node.direction,
				ratio: node.ratio,
				first: vacateNode(node.first),
				second: vacateNode(node.second),
			};
		}

		const newRoot = vacateNode(root);
		layouts.value = { ...layouts.value, [tabId]: newRoot };
		// Clear active pane since all are now vacant
		const { [tabId]: _, ...restPanes } = activePaneIds.value;
		activePaneIds.value = restPanes;
	}

	/** Close all tabs except the one at `keepIndex`. */
	function closeOthers(keepIndex: number): void {
		const kept = tabs.value[keepIndex];
		if (!kept) return;
		// Clean up layouts for removed tabs
		const keptLayout = layouts.value[kept.id];
		const keptPaneId = activePaneIds.value[kept.id];
		layouts.value = keptLayout != null ? { [kept.id]: keptLayout } : {};
		activePaneIds.value = keptPaneId !== undefined ? { [kept.id]: keptPaneId } : {};
		tabs.value = [kept];
		activeTabIndex.value = 0;
	}

	/** Close all tabs to the right of `fromIndex`. */
	function closeToRight(fromIndex: number): void {
		const removed = tabs.value.slice(fromIndex + 1);
		const nextLayouts = { ...layouts.value };
		const nextPanes = { ...activePaneIds.value };
		for (const tab of removed) {
			delete nextLayouts[tab.id];
			delete nextPanes[tab.id];
		}
		tabs.value = tabs.value.slice(0, fromIndex + 1);
		layouts.value = nextLayouts;
		activePaneIds.value = nextPanes;
		// Clamp active index if needed
		if (activeTabIndex.value >= tabs.value.length) {
			activeTabIndex.value = Math.max(0, tabs.value.length - 1);
		}
	}

	/** Close all tabs. If `exceptWelcomeChannelId` is provided, keep the tab that contains it. */
	function closeAll(exceptWelcomeChannelId?: string): void {
		if (exceptWelcomeChannelId) {
			// Find the tab containing the welcome channel
			const welcomeTabId = findTabForChannel(exceptWelcomeChannelId);
			if (welcomeTabId !== null) {
				const keepTab = tabs.value.find((t) => t.id === welcomeTabId);
				const kept = keepTab !== undefined ? [keepTab] : [];
				// Clean up layouts for removed tabs
				const keptLayout = welcomeTabId ? layouts.value[welcomeTabId] : undefined;
				const keptPaneId = welcomeTabId ? activePaneIds.value[welcomeTabId] : undefined;
				const removedLayouts =
					welcomeTabId && keptLayout != null ? { [welcomeTabId]: keptLayout } : {};
				const removedPanes =
					welcomeTabId && keptPaneId !== undefined ? { [welcomeTabId]: keptPaneId } : {};
				tabs.value = kept;
				layouts.value = removedLayouts;
				activePaneIds.value = removedPanes;
				activeTabIndex.value = 0;
			} else {
				// Welcome channel not in any tab — close all
				tabs.value = [];
				layouts.value = {};
				activePaneIds.value = {};
				activeTabIndex.value = 0;
			}
		} else {
			tabs.value = [];
			layouts.value = {};
			activePaneIds.value = {};
			activeTabIndex.value = 0;
		}
	}

	// ------------------------------------------------------------------
	// Cross-tab operations
	// ------------------------------------------------------------------

	/**
	 * Move a pane out of its current tab into a brand-new tab.
	 * The new tab is inserted at `insertAtIndex`.
	 */
	function moveToNewTab(sourceChannelId: string, insertAtIndex: number): void {
		const sourceTabKey = findTabForChannel(sourceChannelId);
		if (sourceTabKey === null) return;

		// Vacate the source pane first (delegates to paneTree's vacatePaneInTab)
		vacatePaneInTab(sourceTabKey, sourceChannelId);

		// Create the new tab with the channel
		const newTabId = generateId();
		const newPaneId = generateId();
		const newTab: Tab = { id: newTabId };
		const newLayout: PaneNode = {
			type: "terminal",
			channelId: sourceChannelId,
			paneId: newPaneId,
		};

		// Insert tab at position
		const idx = Math.max(0, Math.min(insertAtIndex, tabs.value.length));
		const newTabs = [...tabs.value];
		newTabs.splice(idx, 0, newTab);
		tabs.value = newTabs;

		layouts.value = { ...layouts.value, [newTabId]: newLayout };
		activePaneIds.value = { ...activePaneIds.value, [newTabId]: newPaneId };
		activeTabIndex.value = idx;
	}

	return {
		openTab,
		closeTab,
		setActiveTab,
		reorderTab,
		vacateAllPanesInTab,
		closeOthers,
		closeToRight,
		closeAll,
		moveToNewTab,
	};
}
