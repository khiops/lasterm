import { generateId } from "@lasterm/shared";
import { type Ref, triggerRef } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { useConfigStore } from "../stores/config.js";
import { type PaneNode, tabIsOnHost } from "./usePaneTree.js";

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

	/**
	 * The tabs on screen, or null when that is all of them.
	 *
	 * "Close the others" and "close every tab" mean the ones in front of the
	 * person. While the bar shows one host, tabs on other hosts are not in the
	 * room, and a gesture aimed at what is on screen must not reach them.
	 */
	function tabsInView(): ReadonlySet<string> | null {
		const configStore = useConfigStore();
		if (configStore.uiConfig.tabs?.scope !== "perHost") return null;
		const channelsStore = useChannelsStore();
		const hostId = channelsStore.activeHostId;
		if (hostId === null) return null;
		const inView = new Set<string>();
		for (const tab of tabs.value) {
			if (tabIsOnHost(tab.id, layouts.value, channelsStore.channelHostMap, hostId)) {
				inView.add(tab.id);
			}
		}
		return inView;
	}

	/** Close every tab on screen except the one at `keepIndex`. */
	function closeOthers(keepIndex: number): void {
		const kept = tabs.value[keepIndex];
		if (!kept) return;
		const inView = tabsInView();
		const keepIds = new Set<string>([kept.id]);
		if (inView !== null) {
			for (const tab of tabs.value) {
				if (!inView.has(tab.id)) keepIds.add(tab.id);
			}
		}

		const nextLayouts: Record<string, PaneNode | null> = {};
		const nextPanes: Record<string, string> = {};
		for (const tab of tabs.value) {
			if (!keepIds.has(tab.id)) continue;
			const layout = layouts.value[tab.id];
			if (layout != null) nextLayouts[tab.id] = layout;
			const paneId = activePaneIds.value[tab.id];
			if (paneId !== undefined) nextPanes[tab.id] = paneId;
		}
		const next = tabs.value.filter((t) => keepIds.has(t.id));
		layouts.value = nextLayouts;
		activePaneIds.value = nextPanes;
		tabs.value = next;
		activeTabIndex.value = Math.max(
			0,
			next.findIndex((t) => t.id === kept.id),
		);
	}

	/** Close all tabs to the right of `fromIndex`. */
	function closeToRight(fromIndex: number): void {
		const inView = tabsInView();
		const removed = tabs.value
			.slice(fromIndex + 1)
			.filter((tab) => inView === null || inView.has(tab.id));
		const nextLayouts = { ...layouts.value };
		const nextPanes = { ...activePaneIds.value };
		for (const tab of removed) {
			delete nextLayouts[tab.id];
			delete nextPanes[tab.id];
		}
		const removedIds = new Set(removed.map((tab) => tab.id));
		const anchor = tabs.value[fromIndex];
		const wasActiveId = tabs.value[activeTabIndex.value]?.id;
		const next = tabs.value.filter((tab) => !removedIds.has(tab.id));
		tabs.value = next;
		layouts.value = nextLayouts;
		activePaneIds.value = nextPanes;
		// Keep whatever was active, unless it is one of the tabs just closed.
		const stillActive = next.findIndex((t) => t.id === wasActiveId);
		if (stillActive !== -1) {
			activeTabIndex.value = stillActive;
		} else {
			const anchorIndex = anchor === undefined ? -1 : next.findIndex((t) => t.id === anchor.id);
			activeTabIndex.value = Math.max(0, anchorIndex === -1 ? next.length - 1 : anchorIndex);
		}
	}

	/**
	 * Close every tab on screen. `exceptWelcomeChannelId` keeps the tab holding
	 * that channel; tabs on other hosts are never on screen, so they stay.
	 */
	function closeAll(exceptWelcomeChannelId?: string): void {
		const inView = tabsInView();
		const welcomeTabId =
			exceptWelcomeChannelId !== undefined ? findTabForChannel(exceptWelcomeChannelId) : null;

		const keepIds = new Set<string>();
		if (welcomeTabId !== null) keepIds.add(welcomeTabId);
		if (inView !== null) {
			for (const tab of tabs.value) {
				if (!inView.has(tab.id)) keepIds.add(tab.id);
			}
		}

		const wasActiveId = tabs.value[activeTabIndex.value]?.id;
		const nextLayouts: Record<string, PaneNode | null> = {};
		const nextPanes: Record<string, string> = {};
		for (const tab of tabs.value) {
			if (!keepIds.has(tab.id)) continue;
			const layout = layouts.value[tab.id];
			if (layout != null) nextLayouts[tab.id] = layout;
			const paneId = activePaneIds.value[tab.id];
			if (paneId !== undefined) nextPanes[tab.id] = paneId;
		}

		const next = tabs.value.filter((tab) => keepIds.has(tab.id));
		tabs.value = next;
		layouts.value = nextLayouts;
		activePaneIds.value = nextPanes;
		const stillActive = next.findIndex((t) => t.id === wasActiveId);
		activeTabIndex.value = stillActive === -1 ? 0 : stillActive;
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
		tabsInView,
		closeOthers,
		closeToRight,
		closeAll,
		moveToNewTab,
	};
}
