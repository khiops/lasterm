import { DEFAULT_CHANNEL_NAME, generateId } from "@lasterm/shared";
import { computed, type Ref } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import type { Tab } from "./useTabManager.js";

// ---------------------------------------------------------------------------
// Pane tree types
// ---------------------------------------------------------------------------

export type PaneNode =
	| { type: "terminal"; channelId: string; paneId: string }
	| { type: "vacant"; id: string }
	| {
			type: "split";
			direction: "horizontal" | "vertical";
			ratio: number;
			first: PaneNode;
			second: PaneNode;
	  };

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

// ---------------------------------------------------------------------------
// Path type for addressing nodes in the pane tree
// ---------------------------------------------------------------------------

/**
 * A path from the root to a node, expressed as a sequence of "first" | "second"
 * turns at each split node. Empty array = root.
 */
export type NodePath = Array<"first" | "second">;

/** Hard invariant INV-10: maximum panes per tab. Not user-configurable. */
export const MAX_PANE_COUNT = 4;

// ---------------------------------------------------------------------------
// Migration helpers (used by useLayout persistence layer)
// ---------------------------------------------------------------------------

/** Ensure all terminal nodes have a paneId (backward compat with old persisted state). */
export function ensurePaneIds(node: PaneNode): PaneNode {
	if (node.type === "terminal") {
		return node.paneId ? node : { ...node, paneId: generateId() };
	}
	if (node.type === "vacant") return node;
	return { ...node, first: ensurePaneIds(node.first), second: ensurePaneIds(node.second) };
}

function countLeaves(node: PaneNode): number {
	if (node.type !== "split") return 1;
	return countLeaves(node.first) + countLeaves(node.second);
}

export function truncateToMaxPanes(node: PaneNode, max: number): PaneNode {
	if (countLeaves(node) <= max) return node;
	// Too many panes — reset to the first leaf
	if (node.type === "split") return truncateToMaxPanes(node.first, max);
	return node;
}

// ---------------------------------------------------------------------------
// Helper: find first terminal leaf paneId in a tree (for activePaneIds init)
// ---------------------------------------------------------------------------

export function findFirstLeafPaneId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.paneId;
	if (node.type === "vacant") return null;
	return findFirstLeafPaneId(node.first) ?? findFirstLeafPaneId(node.second);
}

// ---------------------------------------------------------------------------
// Helper: walk tree to find channelId for a given paneId
// ---------------------------------------------------------------------------

export function findChannelByPaneId(node: PaneNode, paneId: string): string | null {
	if (node.type === "terminal") {
		return node.paneId === paneId ? node.channelId : null;
	}
	if (node.type === "vacant") return null;
	return findChannelByPaneId(node.first, paneId) ?? findChannelByPaneId(node.second, paneId);
}

// ---------------------------------------------------------------------------
// Exported helper: count leaf panes (terminal + vacant)
// ---------------------------------------------------------------------------

export function countPanes(node: PaneNode): number {
	if (node.type === "terminal" || node.type === "vacant") return 1;
	return countPanes(node.first) + countPanes(node.second);
}

// ---------------------------------------------------------------------------
// Exported helper: collect terminal channelIds in depth-first order
// ---------------------------------------------------------------------------

/**
 * Walk the pane tree depth-first and return all terminal channelIds.
 * Skips vacant nodes (INV-06). Used by multi-pane search to iterate
 * over all searchable panes in a tab.
 */
export function collectTerminalChannelIds(node: PaneNode): string[] {
	if (node.type === "terminal") return [node.channelId];
	if (node.type === "vacant") return [];
	return [...collectTerminalChannelIds(node.first), ...collectTerminalChannelIds(node.second)];
}

// ---------------------------------------------------------------------------
// Pure helper: resolve tab label
// ---------------------------------------------------------------------------

/**
 * Resolve the display label for a channel in a tab or pane.
 *
 * The hub pre-computes `displayTitle` from the configured title source and
 * broadcasts it in TITLE_CHANGE, PROCESS_TITLE, ATTACH_OK, and STATE_SYNC.
 * The client simply reads it — no client-side mode resolution needed.
 *
 * Extracted as a standalone function for testability — no Vue/Pinia deps.
 */
export function resolveTabLabel(
	channelId: string,
	channels: ReadonlyArray<{ id: string; displayTitle?: string }>,
	_tabs?: ReadonlyArray<unknown>,
): string {
	const channel = channels.find((c) => c.id === channelId);
	return channel?.displayTitle ?? DEFAULT_CHANNEL_NAME;
}

// ---------------------------------------------------------------------------
// Pure helper: purge dead tabs
// ---------------------------------------------------------------------------

/**
 * Close tabs whose channels have a "dead" status.
 * Iterates in reverse so that index-based closeTab remains valid as items
 * are removed.
 *
 * Extracted as a standalone function for testability — no Vue/Pinia deps.
 *
 * In the new model, a tab is dead when ALL of its terminal panes are dead.
 * For backward compat with callers that only have tabs (no layouts), accepts
 * an optional layouts map. If provided, checks all panes; otherwise skips.
 */
export function purgeDeadTabs(
	channels: ReadonlyArray<{ id: string; status: string }>,
	tabs: ReadonlyArray<{ id: string }>,
	closeTab: (index: number) => void,
	layouts?: Record<string, PaneNode | null>,
): void {
	const deadIds = new Set(channels.filter((c) => c.status === "dead").map((c) => c.id));
	for (let i = tabs.length - 1; i >= 0; i--) {
		const tab = tabs[i];
		if (tab === undefined) continue;
		if (layouts) {
			// Close tab if ALL terminal panes are dead
			const root = layouts[tab.id];
			if (root !== null && root !== undefined) {
				const terminalIds = collectTerminalChannelIds(root);
				const allDead = terminalIds.length > 0 && terminalIds.every((id) => deadIds.has(id));
				if (allDead) closeTab(i);
			}
		}
		// If no layouts provided, can't determine — skip
	}
}

/**
 * Close tabs whose channels no longer exist on the given host.
 * After a hub/agent restart, channels may be gone from the API but tabs
 * persist in localStorage. This purges those orphaned references.
 *
 * Only purges tabs known to belong to `hostId` (via channelHostMap) to
 * avoid closing tabs for channels on other hosts that haven't been fetched.
 *
 * In the new model, a tab is orphaned when ALL of its terminal channel IDs
 * are on the given host AND none of them are in the alive set.
 */
export function purgeOrphanedTabs(
	channels: ReadonlyArray<{ id: string }>,
	tabs: ReadonlyArray<{ id: string }>,
	closeTab: (index: number) => void,
	hostId: string,
	channelHostMap: ReadonlyMap<string, string>,
	layouts?: Record<string, PaneNode | null>,
): void {
	const aliveIds = new Set(channels.map((c) => c.id));
	for (let i = tabs.length - 1; i >= 0; i--) {
		const tab = tabs[i];
		if (tab === undefined) continue;

		if (layouts) {
			// New model: check all terminal panes in this tab
			const root = layouts[tab.id];
			if (root !== null && root !== undefined) {
				const terminalIds = collectTerminalChannelIds(root);
				if (terminalIds.length === 0) continue;
				// Only purge if ALL panes belong to hostId
				const allOnHost = terminalIds.every((id) => channelHostMap.get(id) === hostId);
				if (!allOnHost) continue;
				// Purge if at least one pane is orphaned (and none are alive)
				const anyOrphaned = terminalIds.some((id) => !aliveIds.has(id));
				const anyAlive = terminalIds.some((id) => aliveIds.has(id));
				if (anyOrphaned && !anyAlive) closeTab(i);
			}
		}
		// If no layouts provided, can't determine — skip
	}
}

// ---------------------------------------------------------------------------
// Internal tree helpers
// ---------------------------------------------------------------------------

function setNodeAtPath(root: PaneNode, path: NodePath, node: PaneNode): PaneNode {
	if (path.length === 0) return node;

	if (root.type !== "split") {
		return root;
	}

	const [head, ...rest] = path;
	if (head === "first") {
		return { ...root, first: setNodeAtPath(root.first, rest, node) };
	}
	return { ...root, second: setNodeAtPath(root.second, rest, node) };
}

function findChannelPath(root: PaneNode, channelId: string): NodePath | null {
	if (root.type === "terminal") {
		return root.channelId === channelId ? [] : null;
	}
	if (root.type === "vacant") return null;
	const inFirst = findChannelPath(root.first, channelId);
	if (inFirst !== null) return ["first", ...inFirst];
	const inSecond = findChannelPath(root.second, channelId);
	if (inSecond !== null) return ["second", ...inSecond];
	return null;
}

function getNodeAtPath(root: PaneNode, path: NodePath): PaneNode | null {
	if (path.length === 0) return root;
	if (root.type !== "split") return null;
	const [head, ...rest] = path;
	return getNodeAtPath(head === "first" ? root.first : root.second, rest);
}

function replaceInTree(node: PaneNode, oldId: string, newId: string): PaneNode {
	if (node.type === "terminal") {
		return node.channelId === oldId ? { ...node, channelId: newId } : node;
	}
	if (node.type === "vacant") return node;
	return {
		...node,
		first: replaceInTree(node.first, oldId, newId),
		second: replaceInTree(node.second, oldId, newId),
	};
}

function findVacantPath(root: PaneNode, vacantId: string): NodePath | null {
	if (root.type === "vacant") {
		return root.id === vacantId ? [] : null;
	}
	if (root.type === "terminal") return null;
	const inFirst = findVacantPath(root.first, vacantId);
	if (inFirst !== null) return ["first", ...inFirst];
	const inSecond = findVacantPath(root.second, vacantId);
	if (inSecond !== null) return ["second", ...inSecond];
	return null;
}

function replaceTerminalNode(
	node: PaneNode,
	channelId: string,
	replacement: PaneNode,
): PaneNode | null {
	if (node.type === "terminal") {
		return node.channelId === channelId ? replacement : null;
	}
	if (node.type === "vacant") return null;
	const firstResult = replaceTerminalNode(node.first, channelId, replacement);
	if (firstResult !== null) {
		return { ...node, first: firstResult };
	}
	const secondResult = replaceTerminalNode(node.second, channelId, replacement);
	if (secondResult !== null) {
		return { ...node, second: secondResult };
	}
	return null;
}

function getLeafId(node: PaneNode): string | null {
	if (node.type === "terminal") return node.paneId;
	if (node.type === "vacant") return node.id;
	return null;
}

function findNodePathByPaneId(root: PaneNode, paneId: string): NodePath | null {
	const leafId = getLeafId(root);
	if (leafId === paneId) return [];
	if (root.type !== "split") return null;
	const inFirst = findNodePathByPaneId(root.first, paneId);
	if (inFirst !== null) return ["first", ...inFirst];
	const inSecond = findNodePathByPaneId(root.second, paneId);
	if (inSecond !== null) return ["second", ...inSecond];
	return null;
}

function replaceNodeByPaneId(
	node: PaneNode,
	paneId: string,
	replacement: PaneNode,
): PaneNode | null {
	const leafId = getLeafId(node);
	if (leafId === paneId) return replacement;
	if (node.type !== "split") return null;
	const firstResult = replaceNodeByPaneId(node.first, paneId, replacement);
	if (firstResult !== null) {
		return { ...node, first: firstResult };
	}
	const secondResult = replaceNodeByPaneId(node.second, paneId, replacement);
	if (secondResult !== null) {
		return { ...node, second: secondResult };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/**
 * Manages pane-split layout trees for the terminal area.
 *
 * Receives the shared `tabs` and `activeTabIndex` refs from `useTabManager`
 * so it can resolve the currently active tab without owning those refs.
 * Owns `layouts` and `activePaneIds`.
 */
export function usePaneTree(
	tabs: Ref<Tab[]>,
	activeTabIndex: Ref<number>,
	layouts: Ref<Record<string, PaneNode | null>>,
	activePaneIds: Ref<Record<string, string>>,
) {
	// ------------------------------------------------------------------
	// Derived: layout for the currently active tab
	// ------------------------------------------------------------------

	const activeTab = computed<Tab | null>(() => tabs.value[activeTabIndex.value] ?? null);

	const layout = computed<PaneNode | null>(() => {
		const tab = activeTab.value;
		if (tab === null) return null;
		return layouts.value[tab.id] ?? null;
	});

	// ------------------------------------------------------------------
	// Active pane helpers
	// ------------------------------------------------------------------

	/**
	 * Get the channelId of the currently active (focused) pane for a tab.
	 * Falls back to the first terminal leaf if no active pane is recorded.
	 */
	function getActiveChannelId(tabId: string): string | null {
		const root = layouts.value[tabId];
		if (root === null || root === undefined) return null;

		const paneId = activePaneIds.value[tabId];
		if (paneId !== undefined) {
			const ch = findChannelByPaneId(root, paneId);
			if (ch !== null) return ch;
		}

		// Fallback: first terminal leaf
		return findChannelByPaneId(root, findFirstLeafPaneId(root) ?? "") ?? null;
	}

	/**
	 * Set the active pane for a tab.
	 */
	function setActivePaneId(tabId: string, paneId: string): void {
		activePaneIds.value = { ...activePaneIds.value, [tabId]: paneId };
	}

	// ------------------------------------------------------------------
	// Layout manipulation
	// ------------------------------------------------------------------

	/**
	 * Update the pane layout for the active tab.
	 */
	function setLayout(node: PaneNode | null): void {
		const tab = activeTab.value;
		if (tab === null) return;
		layouts.value = { ...layouts.value, [tab.id]: node };
	}

	/**
	 * Split the pane that currently contains `channelId` into two panes.
	 * The original pane keeps `channelId`; the second pane is a vacant slot
	 * so the user can pick or spawn a channel via VacantPane.
	 *
	 * If the layout is null (no tabs), this is a no-op.
	 * The active pane does NOT change on split.
	 */
	function splitPane(channelId: string, direction: "horizontal" | "vertical"): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		if (countLeaves(root) >= MAX_PANE_COUNT) return;

		const path = findChannelPath(root, channelId);
		if (path === null) return;

		const existingNode = getNodeAtPath(root, path);
		if (existingNode === null) return;

		const splitNode: PaneNode = {
			type: "split",
			direction,
			ratio: 0.5,
			first: existingNode,
			second: { type: "vacant", id: generateId() },
		};

		const newRoot = setNodeAtPath(root, path, splitNode);
		layouts.value = { ...layouts.value, [tab.id]: newRoot };
		// Active pane does not change on split
	}

	/**
	 * Remove a split by replacing the parent split node with the sibling of
	 * the pane that contained `channelId`.
	 */
	function unsplitPane(channelId: string): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		const path = findChannelPath(root, channelId);
		if (path === null || path.length === 0) return;

		// Parent path = all but last segment; sibling = the other branch
		const parentPath = path.slice(0, -1);
		const lastTurn = path[path.length - 1];
		if (lastTurn === undefined) return;
		const siblingTurn = lastTurn === "first" ? "second" : "first";

		const parentNode = getNodeAtPath(root, parentPath);
		if (parentNode === null || parentNode.type !== "split") return;

		const sibling = siblingTurn === "first" ? parentNode.first : parentNode.second;

		let newRoot: PaneNode;
		if (parentPath.length === 0) {
			// Parent is the root — replace root with sibling
			newRoot = sibling;
		} else {
			newRoot = setNodeAtPath(root, parentPath, sibling);
		}

		layouts.value = { ...layouts.value, [tab.id]: newRoot };
	}

	/**
	 * Update the split ratio for a split node identified by the path from
	 * the root. The path is provided by the PaneSplitter component.
	 */
	function updateRatio(splitNodePath: NodePath, ratio: number): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		const splitNode = getNodeAtPath(root, splitNodePath);
		if (splitNode === null || splitNode.type !== "split") return;

		const clamped = Math.min(0.9, Math.max(0.1, ratio));
		const updated: PaneNode = { ...splitNode, ratio: clamped };
		const newRoot = setNodeAtPath(root, splitNodePath, updated);
		layouts.value = { ...layouts.value, [tab.id]: newRoot };
	}

	// ------------------------------------------------------------------
	// Channel ID replacement (pending spawn → real channel)
	// ------------------------------------------------------------------

	/**
	 * Replace a temporary channelId with the real one after a deferred spawn.
	 * Updates layout tree nodes (channelId in terminal panes).
	 * The paneId stays stable so Vue reuses the TerminalPane component.
	 */
	function replaceChannelId(oldId: string, newId: string): void {
		// Update all layout trees (inner nodes only — keys are tab IDs now)
		const newLayouts: Record<string, PaneNode | null> = {};
		for (const [key, tree] of Object.entries(layouts.value)) {
			newLayouts[key] = tree !== null ? replaceInTree(tree, oldId, newId) : null;
		}
		layouts.value = newLayouts;
	}

	/**
	 * Resolve the display label for a tab/pane. Delegates to the pure
	 * `resolveTabLabel` helper, passing in the channels store data.
	 * Title resolution is done hub-side; the client reads `channel.displayTitle`.
	 *
	 * For a tab, resolves the label using the active pane's channelId.
	 */
	function getTabLabel(tabId: string): string {
		const channelsStore = useChannelsStore();
		const channelId = getActiveChannelId(tabId);
		if (channelId === null) return DEFAULT_CHANNEL_NAME;
		return resolveTabLabel(channelId, channelsStore.channels);
	}

	// ------------------------------------------------------------------
	// Vacant pane management
	// ------------------------------------------------------------------

	/**
	 * Replace a terminal pane with a vacant slot (detach, don't remove).
	 * INV-03: closing a pane detaches the terminal — it keeps running.
	 * If the vacated pane was the active pane, update activePaneId.
	 */
	function vacatePane(channelId: string): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		const newVacant: PaneNode = { type: "vacant", id: generateId() };
		const updated = replaceTerminalNode(root, channelId, newVacant);
		if (updated !== null) {
			layouts.value = { ...layouts.value, [tab.id]: updated };

			// If the closed pane was the active one, update to first terminal leaf
			const activePaneId = activePaneIds.value[tab.id];
			if (activePaneId !== undefined) {
				const chForActive = findChannelByPaneId(root, activePaneId);
				if (chForActive === channelId) {
					// Active pane was closed — find another terminal
					const newActive = findFirstLeafPaneId(updated);
					if (newActive !== null) {
						activePaneIds.value = { ...activePaneIds.value, [tab.id]: newActive };
					} else {
						const { [tab.id]: _, ...rest } = activePaneIds.value;
						activePaneIds.value = rest;
					}
				}
			}
		}
	}

	/**
	 * Fill a vacant slot with a channel.
	 * After filling, set the active pane to the new pane.
	 */
	function fillVacant(vacantId: string, channelId: string): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		const path = findVacantPath(root, vacantId);
		if (path === null) return;

		const newPaneId = generateId();
		const replacement: PaneNode = { type: "terminal", channelId, paneId: newPaneId };
		const newRoot = setNodeAtPath(root, path, replacement);
		layouts.value = { ...layouts.value, [tab.id]: newRoot };
		// Set active pane to the newly filled pane
		activePaneIds.value = { ...activePaneIds.value, [tab.id]: newPaneId };
	}

	/**
	 * Remove a vacant pane slot and give its space to the sibling. The sibling expands
	 * to fill the space. If the root is vacant, do nothing (can't rearrange
	 * the last pane — INV-04: tab never auto-closes).
	 */
	function rearrangeVacant(vacantId: string): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		const path = findVacantPath(root, vacantId);
		if (path === null || path.length === 0) return; // root vacant — can't rearrange

		// Parent path = all but last segment; sibling = the other branch
		const parentPath = path.slice(0, -1);
		const lastTurn = path[path.length - 1];
		if (lastTurn === undefined) return;
		const siblingTurn = lastTurn === "first" ? "second" : "first";

		const parentNode = getNodeAtPath(root, parentPath);
		if (parentNode === null || parentNode.type !== "split") return;

		const sibling = siblingTurn === "first" ? parentNode.first : parentNode.second;

		let newRoot: PaneNode;
		if (parentPath.length === 0) {
			newRoot = sibling;
		} else {
			newRoot = setNodeAtPath(root, parentPath, sibling);
		}

		layouts.value = { ...layouts.value, [tab.id]: newRoot };
	}

	/**
	 * Detach a terminal pane: replace it with a vacant slot.
	 * The channel/PTY keeps running — only the pane slot is cleared.
	 * If the detached pane was the active pane, activePaneId moves to the
	 * nearest remaining terminal leaf.
	 * This is the "Detach" action in the context menu — non-destructive.
	 */
	function detachPane(channelId: string): void {
		vacatePane(channelId);
	}

	/**
	 * Close a terminal pane: collapse the split and give the space to the sibling.
	 * Unlike detachPane, this removes the pane slot entirely — the sibling expands.
	 * If the pane is the root (no parent split), it is replaced with a vacant slot
	 * instead (INV-04: tab never auto-closes).
	 * If the closed pane was the active pane, activePaneId is set to the sibling's
	 * first leaf paneId.
	 * The channel/PTY keeps running (INV-03: closing never kills the terminal).
	 */
	function closePane(channelId: string): void {
		const tab = activeTab.value;
		if (tab === null) return;

		const root = layouts.value[tab.id];
		if (root === null || root === undefined) return;

		const path = findChannelPath(root, channelId);
		if (path === null) return;

		// Root pane (no parent split) → replace with vacant (INV-04)
		if (path.length === 0) {
			const newVacant: PaneNode = { type: "vacant", id: generateId() };
			layouts.value = { ...layouts.value, [tab.id]: newVacant };
			const { [tab.id]: _, ...rest } = activePaneIds.value;
			activePaneIds.value = rest;
			return;
		}

		// Find the parent split and collapse it with the sibling
		const parentPath = path.slice(0, -1);
		const lastTurn = path[path.length - 1];
		if (lastTurn === undefined) return;
		const siblingTurn = lastTurn === "first" ? "second" : "first";

		const parentNode = getNodeAtPath(root, parentPath);
		if (parentNode === null || parentNode.type !== "split") return;

		const sibling = siblingTurn === "first" ? parentNode.first : parentNode.second;

		let newRoot: PaneNode;
		if (parentPath.length === 0) {
			newRoot = sibling;
		} else {
			newRoot = setNodeAtPath(root, parentPath, sibling);
		}

		layouts.value = { ...layouts.value, [tab.id]: newRoot };

		// If the closed pane was active, move activePaneId to the sibling's first leaf
		const activePaneId = activePaneIds.value[tab.id];
		if (activePaneId !== undefined) {
			const chForActive = findChannelByPaneId(root, activePaneId);
			if (chForActive === channelId) {
				const newActive = findFirstLeafPaneId(newRoot);
				if (newActive !== null) {
					activePaneIds.value = { ...activePaneIds.value, [tab.id]: newActive };
				} else {
					const { [tab.id]: _, ...rest } = activePaneIds.value;
					activePaneIds.value = rest;
				}
			}
		}
	}

	// ------------------------------------------------------------------
	// Cross-tab pane DnD helpers
	// ------------------------------------------------------------------

	/**
	 * Vacate a pane in a SPECIFIC tab (not just the active one).
	 * Needed for cross-tab drag where source tab is not active.
	 */
	function vacatePaneInTab(tabId: string, channelId: string): void {
		const root = layouts.value[tabId];
		if (root === null || root === undefined) return;

		const newVacant: PaneNode = { type: "vacant", id: generateId() };
		const updated = replaceTerminalNode(root, channelId, newVacant);
		if (updated !== null) {
			layouts.value = { ...layouts.value, [tabId]: updated };

			// Update activePaneId if the vacated pane was active
			const activePaneId = activePaneIds.value[tabId];
			if (activePaneId !== undefined) {
				const chForActive = findChannelByPaneId(root, activePaneId);
				if (chForActive === channelId) {
					const newActive = findFirstLeafPaneId(updated);
					if (newActive !== null) {
						activePaneIds.value = { ...activePaneIds.value, [tabId]: newActive };
					} else {
						const { [tabId]: _, ...rest } = activePaneIds.value;
						activePaneIds.value = rest;
					}
				}
			}
		}
	}

	/**
	 * Find which tab contains a given channel ID.
	 * Returns the tab's id, or null if not found.
	 *
	 * When the same channelId appears in multiple tabs (e.g. after a split/move),
	 * the currently active tab is preferred — this prevents openTab() from
	 * bouncing the user to a different tab when the channel is already visible.
	 */
	function findTabForChannel(channelId: string): string | null {
		// Prefer the active tab if it contains this channel
		const active = activeTab.value;
		if (active) {
			const activeLayout = layouts.value[active.id];
			if (activeLayout && findChannelPath(activeLayout, channelId) !== null) {
				return active.id;
			}
		}
		// Fall back to first match
		for (const [tabKey, root] of Object.entries(layouts.value)) {
			if (root !== null && findChannelPath(root, channelId) !== null) {
				return tabKey;
			}
		}
		return null;
	}

	/**
	 * Move a pane from one location to another (possibly cross-tab).
	 *
	 * - CENTER: replace the target pane content with the source
	 * - LEFT/RIGHT: wrap target in horizontal split, source on chosen side
	 * - TOP/BOTTOM: wrap target in vertical split, source on chosen side
	 *
	 * The source pane is vacated (replaced with a vacant slot).
	 * If the source pane is the only pane in its tab, that tab is NOT closed
	 * (INV-04: tabs never auto-close) — a vacant slot remains.
	 */
	function movePaneTo(
		sourceChannelId: string,
		targetPaneId: string,
		targetTabId: string,
		zone: DropZone,
	): void {
		// 1. Find source tab
		const sourceTabKey = findTabForChannel(sourceChannelId);
		if (sourceTabKey === null) return;

		// 2. Vacate source FIRST to avoid duplicate channelId in same-tab moves.
		//    After this, the source slot becomes vacant. Then we re-read the
		//    (possibly mutated) target root for the insertion step.
		vacatePaneInTab(sourceTabKey, sourceChannelId);

		const targetRoot = layouts.value[targetTabId];
		if (targetRoot === null || targetRoot === undefined) return;

		// 3. Build source terminal node (reuse channel, fresh paneId)
		const newSourcePaneId = generateId();
		const sourceNode: PaneNode = {
			type: "terminal",
			channelId: sourceChannelId,
			paneId: newSourcePaneId,
		};

		if (zone === "center") {
			// Replace target pane content with source
			const updated = replaceNodeByPaneId(targetRoot, targetPaneId, sourceNode);
			if (updated === null) return;
			layouts.value = { ...layouts.value, [targetTabId]: updated };
		} else {
			// Find the target node in the tree
			const targetPath = findNodePathByPaneId(targetRoot, targetPaneId);
			if (targetPath === null) return;

			const existingNode = getNodeAtPath(targetRoot, targetPath);
			if (existingNode === null) return;

			const direction: "horizontal" | "vertical" =
				zone === "left" || zone === "right" ? "vertical" : "horizontal";
			const first = zone === "left" || zone === "top" ? sourceNode : existingNode;
			const second = zone === "left" || zone === "top" ? existingNode : sourceNode;

			const splitNode: PaneNode = {
				type: "split",
				direction,
				ratio: 0.5,
				first,
				second,
			};

			const updated = setNodeAtPath(targetRoot, targetPath, splitNode);
			layouts.value = { ...layouts.value, [targetTabId]: updated };
		}
		// Set the moved pane as active in the target tab
		activePaneIds.value = { ...activePaneIds.value, [targetTabId]: newSourcePaneId };
	}

	return {
		activeTab,
		layout,
		getActiveChannelId,
		setActivePaneId,
		setLayout,
		splitPane,
		unsplitPane,
		updateRatio,
		replaceChannelId,
		getTabLabel,
		vacatePane,
		detachPane,
		closePane,
		fillVacant,
		rearrangeVacant,
		vacatePaneInTab,
		findTabForChannel,
		movePaneTo,
	};
}
