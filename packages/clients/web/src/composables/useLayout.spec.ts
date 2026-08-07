import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";
import { useConfigStore } from "../stores/config.js";
import type { PaneNode } from "./useLayout.js";
import {
	collectTerminalChannelIds,
	countPanes,
	findChannelByPaneId,
	findFirstLeafPaneId,
	purgeOrphanedTabs,
	resolveTabLabel,
	useLayout,
} from "./useLayout.js";

let layout: ReturnType<typeof useLayout>;
let scope: ReturnType<typeof effectScope>;

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	scope = effectScope();
	scope.run(() => {
		layout = useLayout();
	});
});

afterEach(() => {
	scope.stop();
});

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Open N tabs. Each tab gets a single terminal pane with channelId = "ch-<label>".
 * Returns the tab id for each opened tab (in order).
 */
function openTabs(...labels: string[]): string[] {
	const ids: string[] = [];
	for (const label of labels) {
		const countBefore = layout.tabs.value.length;
		layout.openTab(`ch-${label}`);
		// The new tab was appended (or inserted) — find the new id
		const newTab = layout.tabs.value[layout.activeTabIndex.value];
		if (newTab) ids.push(newTab.id);
		void countBefore;
	}
	return ids;
}

/** Check that every leaf in a pane tree is vacant. */
function _isAllVacant(node: PaneNode | null | undefined): boolean {
	if (node === null || node === undefined) return false;
	if (node.type === "vacant") return true;
	if (node.type === "terminal") return false;
	return _isAllVacant(node.first) && _isAllVacant(node.second);
}

/** Get the layout root for the tab that was opened for channelId. */
function getLayoutForChannel(channelId: string): PaneNode | null | undefined {
	const tabId = layout.findTabForChannel(channelId);
	if (tabId === null) return undefined;
	return layout.layouts.value[tabId];
}

// ── Tab.id shape ──────────────────────────────────────────────────────────

describe("Tab identity", () => {
	it("tab has id (ULID) and no channelId or label", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		expect(tab).toHaveProperty("id");
		expect(typeof tab?.id).toBe("string");
		expect(tab?.id.length).toBeGreaterThan(0);
		expect(tab).not.toHaveProperty("channelId");
		expect(tab).not.toHaveProperty("label");
	});

	it("each tab gets a unique id", () => {
		openTabs("A", "B", "C");
		const ids = layout.tabs.value.map((t) => t.id);
		expect(new Set(ids).size).toBe(3);
	});

	it("layouts are keyed by tab.id", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		expect(layout.layouts.value[tab.id]).toBeDefined();
		expect(layout.layouts.value[tab.id]?.type).toBe("terminal");
	});

	it("openTab with same channel reuses existing tab", () => {
		openTabs("A");
		const countBefore = layout.tabs.value.length;
		layout.openTab("ch-A");
		expect(layout.tabs.value.length).toBe(countBefore);
	});

	it("openTab activates the first tab when new tabs open after active", () => {
		const configStore = useConfigStore();
		configStore.uiConfig = {
			...configStore.uiConfig,
			tabs: { ...configStore.uiConfig.tabs, newTabPosition: "afterActive" },
		};

		layout.openTab("ch-A");

		expect(layout.tabs.value).toHaveLength(1);
		expect(layout.activeTabIndex.value).toBe(0);
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		expect(layout.activeTab.value).toBe(tab);
		expect(layout.getActiveChannelId(tab.id)).toBe("ch-A");
	});
});

// ── activePaneIds ─────────────────────────────────────────────────────────

describe("activePaneIds", () => {
	it("sets activePaneId when opening a tab", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		const paneId = layout.activePaneIds.value[tab.id];
		expect(paneId).toBeDefined();
		expect(typeof paneId).toBe("string");
	});

	it("setActivePaneId updates activePaneIds", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		layout.setActivePaneId(tab.id, "my-pane-id");
		expect(layout.activePaneIds.value[tab.id]).toBe("my-pane-id");
	});

	it("getActiveChannelId returns channel for active pane", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		const ch = layout.getActiveChannelId(tab.id);
		expect(ch).toBe("ch-A");
	});

	it("getActiveChannelId falls back to first leaf if activePaneId not set", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		// Remove activePaneId manually
		const { [tab.id]: _, ...rest } = layout.activePaneIds.value;
		layout.activePaneIds.value = rest;
		const ch = layout.getActiveChannelId(tab.id);
		expect(ch).toBe("ch-A");
	});

	it("active pane does not change on split", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		const paneIdBefore = layout.activePaneIds.value[tab.id];
		layout.splitPane("ch-A", "vertical");
		expect(layout.activePaneIds.value[tab.id]).toBe(paneIdBefore);
	});

	it("closeTab removes activePaneId entry", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;
		layout.closeTab(0);
		expect(layout.activePaneIds.value[tab.id]).toBeUndefined();
	});

	it("fillVacant sets activePaneId to filled pane", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;

		layout.splitPane("ch-A", "vertical");
		const root = layout.layouts.value[tab.id];
		let vacantId = "";
		if (root?.type === "split" && root.second.type === "vacant") {
			vacantId = root.second.id;
		}
		expect(vacantId).toBeTruthy();

		layout.fillVacant(vacantId, "ch-B");

		// Active pane should now point to ch-B's pane
		const ch = layout.getActiveChannelId(tab.id);
		expect(ch).toBe("ch-B");
	});

	it("vacatePane updates activePaneId when active pane is closed", () => {
		openTabs("A");
		const tab = layout.tabs.value[0];
		expect(tab).toBeDefined();
		if (!tab) return;

		// Split and fill both panes
		layout.splitPane("ch-A", "vertical");
		const root = layout.layouts.value[tab.id];
		let vacantId = "";
		if (root?.type === "split" && root.second.type === "vacant") {
			vacantId = root.second.id;
		}
		layout.fillVacant(vacantId, "ch-B");

		// Set active pane to ch-B's pane
		const root2 = layout.layouts.value[tab.id];
		let chBPaneId = "";
		if (root2?.type === "split" && root2.second.type === "terminal") {
			chBPaneId = root2.second.paneId;
		}
		layout.setActivePaneId(tab.id, chBPaneId);

		// Vacate ch-B — active pane should update to ch-A
		layout.vacatePane("ch-B");
		const ch = layout.getActiveChannelId(tab.id);
		expect(ch).toBe("ch-A");
	});
});

// ── closeOthers ──────────────────────────────────────────────────────────

describe("closeOthers", () => {
	it("removes all tabs except the specified index", () => {
		openTabs("A", "B", "C", "D");
		expect(layout.tabs.value).toHaveLength(4);

		// Get tab B's id before closing others
		const tabB = layout.tabs.value[1];
		expect(tabB).toBeDefined();
		if (!tabB) return;

		layout.closeOthers(1); // keep B

		// Only B remains
		expect(layout.tabs.value).toHaveLength(1);
		expect(layout.tabs.value[0]?.id).toBe(tabB.id);
		// B's layout should still be a terminal
		expect(layout.layouts.value[tabB.id]?.type).toBe("terminal");
		// activePaneIds for B should remain
		expect(layout.activePaneIds.value[tabB.id]).toBeDefined();
	});

	it("handles single tab (no-op)", () => {
		const [tabId] = openTabs("A");
		layout.closeOthers(0);

		expect(layout.tabs.value).toHaveLength(1);
		expect(layout.tabs.value[0]?.id).toBe(tabId);
		if (tabId) expect(layout.layouts.value[tabId]?.type).toBe("terminal");
	});

	it("resets activeTabIndex to 0", () => {
		openTabs("A", "B", "C");
		layout.setActiveTab(2); // C is active
		expect(layout.activeTabIndex.value).toBe(2);

		const tabC = layout.tabs.value[2];
		expect(tabC).toBeDefined();
		if (!tabC) return;

		layout.closeOthers(2); // keep C

		// Only C remains, index resets to 0
		expect(layout.tabs.value).toHaveLength(1);
		expect(layout.tabs.value[0]?.id).toBe(tabC.id);
		expect(layout.activeTabIndex.value).toBe(0);
		expect(layout.layouts.value[tabC.id]?.type).toBe("terminal");
	});
});

// ── closeToRight ─────────────────────────────────────────────────────────

describe("closeToRight", () => {
	it("removes all tabs to the right of specified index", () => {
		const [tabA, tabB, tabC, tabD] = openTabs("A", "B", "C", "D");
		expect(tabA && tabB && tabC && tabD).toBeTruthy();
		if (!tabA || !tabB || !tabC || !tabD) return;

		layout.closeToRight(1); // remove C, D

		// Only A and B remain
		expect(layout.tabs.value).toHaveLength(2);
		expect(layout.tabs.value[0]?.id).toBe(tabA);
		expect(layout.tabs.value[1]?.id).toBe(tabB);
		// A and B layouts untouched
		expect(layout.layouts.value[tabA]?.type).toBe("terminal");
		expect(layout.layouts.value[tabB]?.type).toBe("terminal");
		// C and D layouts are gone
		expect(layout.layouts.value[tabC]).toBeUndefined();
		expect(layout.layouts.value[tabD]).toBeUndefined();
	});

	it("is no-op when index is last tab", () => {
		const [, , tabC] = openTabs("A", "B", "C");
		expect(tabC).toBeTruthy();
		if (!tabC) return;

		layout.closeToRight(2);

		expect(layout.tabs.value).toHaveLength(3);
		expect(layout.layouts.value[tabC]?.type).toBe("terminal");
	});

	it("does not affect tabs to the left", () => {
		const [tabA, tabB, tabC, tabD] = openTabs("A", "B", "C", "D");
		expect(tabA && tabB && tabC && tabD).toBeTruthy();
		if (!tabA || !tabB || !tabC || !tabD) return;

		layout.closeToRight(2); // remove D only

		expect(layout.tabs.value).toHaveLength(3);
		expect(layout.layouts.value[tabA]?.type).toBe("terminal");
		expect(layout.layouts.value[tabB]?.type).toBe("terminal");
		expect(layout.layouts.value[tabC]?.type).toBe("terminal");
		expect(layout.layouts.value[tabD]).toBeUndefined();
	});

	it("clamps activeTabIndex when active tab is removed", () => {
		openTabs("A", "B", "C", "D");
		layout.setActiveTab(3); // D is active
		expect(layout.activeTabIndex.value).toBe(3);

		layout.closeToRight(1); // remove C, D

		expect(layout.tabs.value).toHaveLength(2);
		expect(layout.activeTabIndex.value).toBe(1); // clamped to last remaining
	});
});

// ── closeAll ─────────────────────────────────────────────────────────────

describe("closeAll", () => {
	it("removes all tabs when no welcome tab", () => {
		openTabs("A", "B", "C");

		layout.closeAll();

		expect(layout.tabs.value).toHaveLength(0);
		expect(layout.layouts.value).toEqual({});
		expect(layout.activePaneIds.value).toEqual({});
	});

	it("keeps only tab containing welcome channel when exceptWelcomeChannelId is provided", () => {
		openTabs("A", "B", "C");

		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();

		layout.closeAll("ch-B");

		// Only B remains
		expect(layout.tabs.value).toHaveLength(1);
		if (tabBId) {
			expect(layout.tabs.value[0]?.id).toBe(tabBId);
			expect(layout.layouts.value[tabBId]?.type).toBe("terminal");
		}
	});

	it("is no-op when only welcome tab exists", () => {
		const [tabA] = openTabs("A");
		expect(tabA).toBeTruthy();

		layout.closeAll("ch-A");

		expect(layout.tabs.value).toHaveLength(1);
		if (tabA) expect(layout.layouts.value[tabA]?.type).toBe("terminal");
	});
});

// ── splitPane ────────────────────────────────────────────────────────────

describe("splitPane", () => {
	it("creates a split with the original terminal as first and a vacant node as second", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");

		const root = getLayoutForChannel("ch-A");
		expect(root?.type).toBe("split");
		if (root?.type !== "split") return;

		expect(root.direction).toBe("vertical");
		expect(root.ratio).toBe(0.5);
		expect(root.first.type).toBe("terminal");
		if (root.first.type === "terminal") {
			expect(root.first.channelId).toBe("ch-A");
		}
		expect(root.second.type).toBe("vacant");
		if (root.second.type === "vacant") {
			expect(root.second.id).toBeTruthy();
		}
	});

	it("creates a horizontal split", () => {
		openTabs("A");
		layout.splitPane("ch-A", "horizontal");

		const root = getLayoutForChannel("ch-A");
		expect(root?.type).toBe("split");
		if (root?.type === "split") {
			expect(root.direction).toBe("horizontal");
			expect(root.second.type).toBe("vacant");
		}
	});

	it("is a no-op when channelId does not exist in the active tab", () => {
		openTabs("A");
		const before = getLayoutForChannel("ch-A");

		layout.splitPane("ch-nonexistent", "vertical");

		expect(getLayoutForChannel("ch-A")).toEqual(before);
	});

	it("does nothing when MAX_PANE_COUNT (4) is already reached", () => {
		openTabs("A");

		// Build a 4-pane layout by splitting 3 times and filling vacants
		function fillFirstVacant(root: PaneNode | null | undefined): string {
			if (!root) return "";
			if (root.type === "vacant") return root.id;
			if (root.type === "split") {
				return fillFirstVacant(root.first) || fillFirstVacant(root.second);
			}
			return "";
		}

		const tabId = layout.findTabForChannel("ch-A");
		expect(tabId).not.toBeNull();
		if (!tabId) return;

		layout.splitPane("ch-A", "vertical");
		layout.fillVacant(fillFirstVacant(layout.layouts.value[tabId]), "ch-B");

		layout.splitPane("ch-A", "horizontal");
		layout.fillVacant(fillFirstVacant(layout.layouts.value[tabId]), "ch-C");

		layout.splitPane("ch-B", "vertical");
		layout.fillVacant(fillFirstVacant(layout.layouts.value[tabId]), "ch-D");

		// Snapshot state at 4 panes
		const before = layout.layouts.value[tabId];

		// Attempt a 5th split — should be a no-op
		layout.splitPane("ch-A", "vertical");

		expect(layout.layouts.value[tabId]).toEqual(before);
	});
});

// ── vacatePane ────────────────────────────────────────────────────────────

describe("vacatePane", () => {
	it("replaces terminal node with vacant in split layout", () => {
		openTabs("A");
		// Split creates: first=terminal(ch-A), second=vacant
		layout.splitPane("ch-A", "vertical");
		const root = getLayoutForChannel("ch-A");
		expect(root).not.toBeNull();
		expect(root?.type).toBe("split");

		// Fill the vacant second slot with ch-B so we have a terminal to vacate
		let vacantId = "";
		if (root?.type === "split" && root.second.type === "vacant") {
			vacantId = root.second.id;
		}
		expect(vacantId).toBeTruthy();
		layout.fillVacant(vacantId, "ch-B");

		// Now vacate ch-B — it should become a vacant node again
		layout.vacatePane("ch-B");

		const tabId = layout.findTabForChannel("ch-A");
		const updated = tabId ? layout.layouts.value[tabId] : null;
		expect(updated).not.toBeNull();
		expect(updated?.type).toBe("split");
		if (updated?.type === "split") {
			expect(updated.first.type).toBe("terminal");
			expect(updated.second.type).toBe("vacant");
			if (updated.second.type === "vacant") {
				expect(updated.second.id).toBeTruthy();
			}
		}
	});

	it("does nothing for non-existent channelId", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const before = getLayoutForChannel("ch-A");

		layout.vacatePane("ch-nonexistent");

		const after = getLayoutForChannel("ch-A");
		expect(after).toEqual(before);
	});
});

// ── rearrangeVacant ───────────────────────────────────────────────────────

describe("rearrangeVacant", () => {
	it("removes vacant node and collapses parent split", () => {
		openTabs("A");
		// Split creates a vacant second slot directly
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");
		expect(afterSplit?.type).toBe("split");

		// Get the vacant ID from the split result
		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		expect(vacantId).toBeTruthy();

		// Rearrange — should collapse the split, leaving just ch-A
		layout.rearrangeVacant(vacantId);

		const afterRearrange = getLayoutForChannel("ch-A");
		expect(afterRearrange?.type).toBe("terminal");
		if (afterRearrange?.type === "terminal") {
			expect(afterRearrange.channelId).toBe("ch-A");
		}
	});

	it("does nothing when vacant is root node (single pane)", () => {
		openTabs("A");
		// Vacate root pane
		layout.vacatePane("ch-A");
		const tabId = layout.activeTab.value?.id;
		expect(tabId).toBeTruthy();
		if (!tabId) return;
		const afterVacate = layout.layouts.value[tabId];
		expect(afterVacate?.type).toBe("vacant");

		let vacantId = "";
		if (afterVacate?.type === "vacant") {
			vacantId = afterVacate.id;
		}

		// Rearranging root vacant should be a no-op
		layout.rearrangeVacant(vacantId);

		const afterRearrange = layout.layouts.value[tabId];
		expect(afterRearrange?.type).toBe("vacant");
	});
});

// ── detachPane ────────────────────────────────────────────────────────────

describe("detachPane", () => {
	it("replaces terminal node with vacant (same as vacatePane)", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");
		expect(afterSplit?.type).toBe("split");

		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		layout.fillVacant(vacantId, "ch-B");

		layout.detachPane("ch-B");

		const updated = getLayoutForChannel("ch-A");
		expect(updated?.type).toBe("split");
		if (updated?.type === "split") {
			expect(updated.first.type).toBe("terminal");
			expect(updated.second.type).toBe("vacant");
		}
	});

	it("does not collapse the split — sibling stays in place", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");

		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		layout.fillVacant(vacantId, "ch-B");

		// Detach ch-A — the split should remain, just ch-A becomes vacant
		layout.detachPane("ch-A");

		const updated = getLayoutForChannel("ch-B");
		expect(updated?.type).toBe("split");
		if (updated?.type === "split") {
			expect(updated.first.type).toBe("vacant");
			expect(updated.second.type).toBe("terminal");
			if (updated.second.type === "terminal") {
				expect(updated.second.channelId).toBe("ch-B");
			}
		}
	});
});

// ── closePane ─────────────────────────────────────────────────────────────

describe("closePane", () => {
	it("collapses split — sibling expands to fill space", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");

		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		layout.fillVacant(vacantId, "ch-B");

		// Close ch-B — split should collapse, leaving only ch-A
		layout.closePane("ch-B");

		const updated = getLayoutForChannel("ch-A");
		expect(updated?.type).toBe("terminal");
		if (updated?.type === "terminal") {
			expect(updated.channelId).toBe("ch-A");
		}
	});

	it("collapses split when first child is closed", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");

		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		layout.fillVacant(vacantId, "ch-B");

		// Close ch-A (first child) — split collapses, ch-B becomes root
		layout.closePane("ch-A");

		const tabId = layout.findTabForChannel("ch-B");
		expect(tabId).not.toBeNull();
		const updated = tabId ? layout.layouts.value[tabId] : null;
		expect(updated?.type).toBe("terminal");
		if (updated?.type === "terminal") {
			expect(updated.channelId).toBe("ch-B");
		}
	});

	it("root pane becomes vacant instead of closing the tab (INV-04)", () => {
		openTabs("A");
		const tabId = layout.activeTab.value?.id;
		expect(tabId).toBeTruthy();
		if (!tabId) return;

		layout.closePane("ch-A");

		// Tab should still exist
		expect(layout.tabs.value.length).toBe(1);
		// Root should now be vacant
		const root = layout.layouts.value[tabId];
		expect(root?.type).toBe("vacant");
	});

	it("updates activePaneId to sibling when active pane is closed", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");

		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		layout.fillVacant(vacantId, "ch-B");

		const tabId = layout.activeTab.value?.id;
		expect(tabId).toBeTruthy();
		if (!tabId) return;

		// Make ch-A the active pane (it is the first leaf, likely already active)
		const root = layout.layouts.value[tabId];
		if (root?.type === "split" && root.first.type === "terminal") {
			layout.setActivePaneId(tabId, root.first.paneId);
		}

		// Close ch-A — activePaneId should move to ch-B's pane
		layout.closePane("ch-A");

		const updatedRoot = layout.layouts.value[tabId];
		const newActivePaneId = layout.activePaneIds.value[tabId];
		expect(newActivePaneId).toBeTruthy();
		// The remaining terminal is ch-B
		if (updatedRoot?.type === "terminal") {
			expect(updatedRoot.paneId).toBe(newActivePaneId);
			expect(updatedRoot.channelId).toBe("ch-B");
		}
	});

	it("does nothing for non-existent channelId", () => {
		openTabs("A");
		layout.splitPane("ch-A", "vertical");
		const before = getLayoutForChannel("ch-A");

		layout.closePane("ch-nonexistent");

		const after = getLayoutForChannel("ch-A");
		expect(after).toEqual(before);
	});
});

// ── fillVacant ────────────────────────────────────────────────────────────

describe("fillVacant", () => {
	it("replaces vacant node with terminal node", () => {
		openTabs("A");
		// Split creates: first=terminal(ch-A), second=vacant
		layout.splitPane("ch-A", "vertical");
		const afterSplit = getLayoutForChannel("ch-A");
		let vacantId = "";
		if (afterSplit?.type === "split" && afterSplit.second.type === "vacant") {
			vacantId = afterSplit.second.id;
		}
		expect(vacantId).toBeTruthy();

		// Fill the vacant with a new channel
		layout.fillVacant(vacantId, "ch-C");

		const afterFill = getLayoutForChannel("ch-A");
		expect(afterFill?.type).toBe("split");
		if (afterFill?.type === "split") {
			expect(afterFill.second.type).toBe("terminal");
			if (afterFill.second.type === "terminal") {
				expect(afterFill.second.channelId).toBe("ch-C");
			}
		}
	});

	it("does nothing for non-existent vacantId", () => {
		openTabs("A");
		// Split creates a vacant second slot
		layout.splitPane("ch-A", "vertical");
		const before = getLayoutForChannel("ch-A");

		layout.fillVacant("nonexistent-id", "ch-C");

		const after = getLayoutForChannel("ch-A");
		expect(after).toEqual(before);
	});
});

// ── countPanes ────────────────────────────────────────────────────────────

describe("countPanes", () => {
	it("returns 1 for single terminal", () => {
		const node: PaneNode = { type: "terminal", channelId: "ch-1", paneId: "p1" };
		expect(countPanes(node)).toBe(1);
	});

	it("returns 1 for single vacant", () => {
		const node: PaneNode = { type: "vacant", id: "v1" };
		expect(countPanes(node)).toBe(1);
	});

	it("returns 2 for split with terminal and vacant", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", channelId: "ch-1", paneId: "p1" },
			second: { type: "vacant", id: "v1" },
		};
		expect(countPanes(node)).toBe(2);
	});

	it("returns 4 for nested splits", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: {
				type: "split",
				direction: "horizontal",
				ratio: 0.5,
				first: { type: "terminal", channelId: "ch-1", paneId: "p1" },
				second: { type: "terminal", channelId: "ch-2", paneId: "p2" },
			},
			second: {
				type: "split",
				direction: "horizontal",
				ratio: 0.5,
				first: { type: "vacant", id: "v1" },
				second: { type: "terminal", channelId: "ch-3", paneId: "p3" },
			},
		};
		expect(countPanes(node)).toBe(4);
	});
});

// -- movePaneTo -----------------------------------------------------------------

describe("movePaneTo", () => {
	it("moves pane from one tab to another (center zone)", () => {
		openTabs("A", "B");
		// Tab A has one pane, Tab B has one pane
		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();
		if (!tabBId) return;

		// Get the paneId of tab B's root node
		const tabBRoot = layout.layouts.value[tabBId];
		expect(tabBRoot).not.toBeNull();
		expect(tabBRoot?.type).toBe("terminal");
		const targetPaneId = tabBRoot?.type === "terminal" ? tabBRoot.paneId : "";

		const tabAId = layout.findTabForChannel("ch-A");
		expect(tabAId).not.toBeNull();

		// Move ch-A into tab B (center = replace)
		layout.movePaneTo("ch-A", targetPaneId, tabBId, "center");

		// Tab B should now contain ch-A
		const updatedB = layout.layouts.value[tabBId];
		expect(updatedB?.type).toBe("terminal");
		if (updatedB?.type === "terminal") {
			expect(updatedB.channelId).toBe("ch-A");
		}

		// Tab A should have a vacant node (source was vacated)
		if (tabAId) {
			const updatedA = layout.layouts.value[tabAId];
			expect(updatedA?.type).toBe("vacant");
		}
	});

	it("creates horizontal split when dropping on left zone", () => {
		openTabs("A", "B");

		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();
		if (!tabBId) return;

		const tabBRoot = layout.layouts.value[tabBId];
		const targetPaneId = tabBRoot?.type === "terminal" ? tabBRoot.paneId : "";

		layout.movePaneTo("ch-A", targetPaneId, tabBId, "left");

		const updatedB = layout.layouts.value[tabBId];
		expect(updatedB?.type).toBe("split");
		if (updatedB?.type === "split") {
			// Left zone: source goes first, target goes second
			expect(updatedB.direction).toBe("vertical");
			expect(updatedB.first.type).toBe("terminal");
			if (updatedB.first.type === "terminal") {
				expect(updatedB.first.channelId).toBe("ch-A");
			}
			expect(updatedB.second.type).toBe("terminal");
			if (updatedB.second.type === "terminal") {
				expect(updatedB.second.channelId).toBe("ch-B");
			}
		}
	});

	it("creates vertical split when dropping on bottom zone", () => {
		openTabs("A", "B");

		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();
		if (!tabBId) return;

		const tabBRoot = layout.layouts.value[tabBId];
		const targetPaneId = tabBRoot?.type === "terminal" ? tabBRoot.paneId : "";

		layout.movePaneTo("ch-A", targetPaneId, tabBId, "bottom");

		const updatedB = layout.layouts.value[tabBId];
		expect(updatedB?.type).toBe("split");
		if (updatedB?.type === "split") {
			// Bottom zone: target goes first, source goes second
			expect(updatedB.direction).toBe("horizontal");
			expect(updatedB.first.type).toBe("terminal");
			if (updatedB.first.type === "terminal") {
				expect(updatedB.first.channelId).toBe("ch-B");
			}
			expect(updatedB.second.type).toBe("terminal");
			if (updatedB.second.type === "terminal") {
				expect(updatedB.second.channelId).toBe("ch-A");
			}
		}
	});

	it("vacates source pane after move", () => {
		openTabs("A", "B");
		layout.setActiveTab(0); // switch to tab A before splitting
		// Split tab A: first=terminal(ch-A), second=vacant

		const tabAId = layout.findTabForChannel("ch-A");
		expect(tabAId).not.toBeNull();
		if (!tabAId) return;

		layout.splitPane("ch-A", "vertical");

		// Fill the vacant slot with ch-C so we have a terminal pane to move
		const splitRoot = layout.layouts.value[tabAId];
		let vacantId = "";
		if (splitRoot?.type === "split" && splitRoot.second.type === "vacant") {
			vacantId = splitRoot.second.id;
		}
		expect(vacantId).toBeTruthy();
		layout.fillVacant(vacantId, "ch-C");

		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();
		if (!tabBId) return;

		const tabBRoot = layout.layouts.value[tabBId];
		const targetPaneId = tabBRoot?.type === "terminal" ? tabBRoot.paneId : "";

		// Move ch-C from tab A into tab B
		layout.movePaneTo("ch-C", targetPaneId, tabBId, "center");

		// Tab A should still be split but second child is now vacant
		const updatedA = layout.layouts.value[tabAId];
		expect(updatedA?.type).toBe("split");
		if (updatedA?.type === "split") {
			expect(updatedA.first.type).toBe("terminal");
			expect(updatedA.second.type).toBe("vacant");
		}

		// Tab B should now contain ch-C
		const updatedB = layout.layouts.value[tabBId];
		expect(updatedB?.type).toBe("terminal");
		if (updatedB?.type === "terminal") {
			expect(updatedB.channelId).toBe("ch-C");
		}
	});

	it("handles same-tab move (rearrange panes within tab)", () => {
		openTabs("A");
		// Split: first=terminal(ch-A), second=vacant
		layout.splitPane("ch-A", "vertical");

		const tabAId = layout.findTabForChannel("ch-A");
		expect(tabAId).not.toBeNull();
		if (!tabAId) return;

		// Fill the vacant slot with ch-B so we have a terminal to move
		const splitRoot = layout.layouts.value[tabAId];
		let vacantId = "";
		if (splitRoot?.type === "split" && splitRoot.second.type === "vacant") {
			vacantId = splitRoot.second.id;
		}
		expect(vacantId).toBeTruthy();
		layout.fillVacant(vacantId, "ch-B");

		const root = layout.layouts.value[tabAId];
		expect(root?.type).toBe("split");
		if (root?.type !== "split") return;

		// Get paneId of first child (ch-A)
		const firstPaneId = root.first.type === "terminal" ? root.first.paneId : "";

		// Move ch-B onto ch-A (center) — should replace ch-A with ch-B, vacate ch-B's old slot
		layout.movePaneTo("ch-B", firstPaneId, tabAId, "center");

		const updated = layout.layouts.value[tabAId];
		expect(updated?.type).toBe("split");
		if (updated?.type === "split") {
			// First should now be ch-B, second should be vacant
			expect(updated.first.type).toBe("terminal");
			if (updated.first.type === "terminal") {
				expect(updated.first.channelId).toBe("ch-B");
			}
			expect(updated.second.type).toBe("vacant");
		}
	});
});

// -- moveToNewTab ---------------------------------------------------------------

describe("moveToNewTab", () => {
	it("moves pane from split into a new tab", () => {
		openTabs("A");
		// Split: first=terminal(ch-A), second=vacant
		layout.splitPane("ch-A", "vertical");

		const tabAId = layout.findTabForChannel("ch-A");
		expect(tabAId).not.toBeNull();
		if (!tabAId) return;

		// Fill the vacant slot with ch-B so we have a terminal pane to move
		const splitRoot = layout.layouts.value[tabAId];
		let vacantId = "";
		if (splitRoot?.type === "split" && splitRoot.second.type === "vacant") {
			vacantId = splitRoot.second.id;
		}
		expect(vacantId).toBeTruthy();
		layout.fillVacant(vacantId, "ch-B");
		expect(layout.tabs.value).toHaveLength(1);

		// Move ch-B to a new tab at index 1
		layout.moveToNewTab("ch-B", 1);

		// Should now have 2 tabs
		expect(layout.tabs.value).toHaveLength(2);

		// Find the new tab for ch-B
		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();
		if (!tabBId) return;
		expect(layout.tabs.value[1]?.id).toBe(tabBId);

		// Tab A should have ch-B vacated
		const tabA = layout.layouts.value[tabAId];
		expect(tabA?.type).toBe("split");
		if (tabA?.type === "split") {
			expect(tabA.second.type).toBe("vacant");
		}

		// New tab should have ch-B as single pane
		const tabBLayout = layout.layouts.value[tabBId];
		expect(tabBLayout?.type).toBe("terminal");
		if (tabBLayout?.type === "terminal") {
			expect(tabBLayout.channelId).toBe("ch-B");
		}

		// Active tab should be the new one
		expect(layout.activeTabIndex.value).toBe(1);
	});
});

// -- findTabForChannel ----------------------------------------------------------

describe("findTabForChannel", () => {
	it("finds the tab containing a channel", () => {
		openTabs("A", "B");
		layout.setActiveTab(0); // switch to tab A before splitting

		const tabAId = layout.findTabForChannel("ch-A");
		expect(tabAId).not.toBeNull();
		if (!tabAId) return;

		// Split: first=terminal(ch-A), second=vacant
		layout.splitPane("ch-A", "vertical");

		// Fill the vacant slot with ch-C so we can look it up by channelId
		const splitRoot = layout.layouts.value[tabAId];
		let vacantId = "";
		if (splitRoot?.type === "split" && splitRoot.second.type === "vacant") {
			vacantId = splitRoot.second.id;
		}
		expect(vacantId).toBeTruthy();
		layout.fillVacant(vacantId, "ch-C");

		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabBId).not.toBeNull();

		// ch-A and ch-C are in tab A; ch-B is in tab B
		expect(layout.findTabForChannel("ch-A")).toBe(tabAId);
		expect(layout.findTabForChannel("ch-C")).toBe(tabAId);
		expect(layout.findTabForChannel("ch-B")).toBe(tabBId);
	});

	it("returns null for unknown channel", () => {
		openTabs("A");
		expect(layout.findTabForChannel("ch-unknown")).toBeNull();
	});
});

// -- reorderTab ----------------------------------------------------------------

describe("reorderTab", () => {
	it("moves tab B before tab A: [A,B,C] → [B,A,C]", () => {
		const [tabA, tabB, tabC] = openTabs("A", "B", "C");
		layout.reorderTab(1, 0);
		expect(layout.tabs.value.map((t) => t.id)).toEqual([tabB, tabA, tabC]);
	});

	it("moves last tab to first: [A,B,C] → [C,A,B]", () => {
		const [tabA, tabB, tabC] = openTabs("A", "B", "C");
		layout.reorderTab(2, 0);
		expect(layout.tabs.value.map((t) => t.id)).toEqual([tabC, tabA, tabB]);
	});

	it("moves first tab to last: [A,B,C] → [B,C,A]", () => {
		const [tabA, tabB, tabC] = openTabs("A", "B", "C");
		layout.reorderTab(0, 2);
		expect(layout.tabs.value.map((t) => t.id)).toEqual([tabB, tabC, tabA]);
	});

	it("same index is a no-op", () => {
		const tabIds = openTabs("A", "B", "C");
		layout.reorderTab(1, 1);
		expect(layout.tabs.value.map((t) => t.id)).toEqual(tabIds);
	});

	it("active tab follows drag: active=B(1), reorder(1,0) → active=0", () => {
		const [, tabB] = openTabs("A", "B", "C");
		layout.setActiveTab(1); // B is active
		layout.reorderTab(1, 0);
		expect(layout.tabs.value[0]?.id).toBe(tabB);
		expect(layout.activeTabIndex.value).toBe(0);
	});

	it("active tab shifts left: active=C(2), reorder(0,2) → active=1", () => {
		openTabs("A", "B", "C");
		layout.setActiveTab(2); // C is active
		layout.reorderTab(0, 2);
		// A moved from before C to after C → C shifts left
		expect(layout.activeTabIndex.value).toBe(1);
	});

	it("active tab shifts right: active=A(0), reorder(2,0) → active=1", () => {
		openTabs("A", "B", "C");
		layout.setActiveTab(0); // A is active
		layout.reorderTab(2, 0);
		// C moved from after A to before A → A shifts right
		expect(layout.activeTabIndex.value).toBe(1);
	});

	it("out-of-range fromIndex is a no-op", () => {
		const tabIds = openTabs("A", "B", "C");
		layout.reorderTab(-1, 0);
		expect(layout.tabs.value.map((t) => t.id)).toEqual(tabIds);
	});

	it("persists to localStorage after reorder", async () => {
		const [tabA, tabB] = openTabs("A", "B", "C");
		layout.reorderTab(1, 0);
		// Flush the Vue watcher (deep watch runs post-flush)
		await nextTick();
		const stored = localStorage.getItem("lasterm:layout");
		expect(stored).not.toBeNull();
		if (!stored) return;
		const parsed = JSON.parse(stored) as { tabs: { id: string }[] };
		expect(parsed.tabs[0]?.id).toBe(tabB);
		expect(parsed.tabs[1]?.id).toBe(tabA);
	});
});

// -- purgeOrphanedTabs ---------------------------------------------------------

describe("purgeOrphanedTabs (layout-aware)", () => {
	it("closes tabs where all terminal panes are orphaned on current host", () => {
		openTabs("A", "B");
		const tabAId = layout.findTabForChannel("ch-A");
		const tabBId = layout.findTabForChannel("ch-B");
		expect(tabAId).not.toBeNull();
		expect(tabBId).not.toBeNull();
		if (!tabAId || !tabBId) return;

		const closeTab = vi.fn();
		const tabs = [{ id: tabAId }, { id: tabBId }];
		const channels: { id: string }[] = []; // both orphaned
		const hostId = "host-A";
		const channelHostMap = new Map([
			["ch-A", "host-A"],
			["ch-B", "host-A"],
		]);
		purgeOrphanedTabs(channels, tabs, closeTab, hostId, channelHostMap, layout.layouts.value);
		// Both tabs are orphaned on host-A — closed in reverse order
		expect(closeTab).toHaveBeenCalledTimes(2);
		expect(closeTab).toHaveBeenNthCalledWith(1, 1);
		expect(closeTab).toHaveBeenNthCalledWith(2, 0);
	});

	it("preserves tabs where channel is alive", () => {
		openTabs("A");
		const tabAId = layout.findTabForChannel("ch-A");
		expect(tabAId).not.toBeNull();
		if (!tabAId) return;

		const closeTab = vi.fn();
		const tabs = [{ id: tabAId }];
		const channels = [{ id: "ch-A" }]; // alive
		const hostId = "host-A";
		const channelHostMap = new Map([["ch-A", "host-A"]]);
		purgeOrphanedTabs(channels, tabs, closeTab, hostId, channelHostMap, layout.layouts.value);
		expect(closeTab).not.toHaveBeenCalled();
	});

	it("preserves tabs for channels on other hosts", () => {
		openTabs("A");
		const tabAId = layout.findTabForChannel("ch-A");
		if (!tabAId) return;

		const closeTab = vi.fn();
		const tabs = [{ id: tabAId }];
		const channels: { id: string }[] = [];
		const hostId = "host-A";
		const channelHostMap = new Map([["ch-A", "host-B"]]);
		purgeOrphanedTabs(channels, tabs, closeTab, hostId, channelHostMap, layout.layouts.value);
		expect(closeTab).not.toHaveBeenCalled();
	});

	it("preserves tabs not in channelHostMap", () => {
		openTabs("A");
		const tabAId = layout.findTabForChannel("ch-A");
		if (!tabAId) return;

		const closeTab = vi.fn();
		const tabs = [{ id: tabAId }];
		const channels: { id: string }[] = [];
		const hostId = "host-A";
		const channelHostMap = new Map<string, string>();
		purgeOrphanedTabs(channels, tabs, closeTab, hostId, channelHostMap, layout.layouts.value);
		expect(closeTab).not.toHaveBeenCalled();
	});

	it("does not purge tabs with mixed alive/dead panes (partial alive = keep)", () => {
		openTabs("A");
		const tabAId = layout.findTabForChannel("ch-A");
		if (!tabAId) return;

		// Split and fill with ch-B
		layout.splitPane("ch-A", "vertical");
		const root = layout.layouts.value[tabAId];
		if (root?.type === "split" && root.second.type === "vacant") {
			layout.fillVacant(root.second.id, "ch-B");
		}

		const closeTab = vi.fn();
		const tabs = [{ id: tabAId }];
		const channels = [{ id: "ch-A" }]; // ch-A alive, ch-B orphaned
		const hostId = "host-A";
		const channelHostMap = new Map([
			["ch-A", "host-A"],
			["ch-B", "host-A"],
		]);
		purgeOrphanedTabs(channels, tabs, closeTab, hostId, channelHostMap, layout.layouts.value);
		// ch-A is alive → tab survives
		expect(closeTab).not.toHaveBeenCalled();
	});
});

// -- localStorage migration -------------------------------------------------------

describe("localStorage migration (old format)", () => {
	it("migrates old Tab { channelId, label } format to new { id } format", () => {
		// Write old format to localStorage
		const oldState = {
			tabs: [
				{ channelId: "ch-A", label: "Tab A" },
				{ channelId: "ch-B", label: "Tab B" },
			],
			activeTabIndex: 1,
			layouts: {
				"ch-A": { type: "terminal", channelId: "ch-A", paneId: "p1" },
				"ch-B": { type: "terminal", channelId: "ch-B", paneId: "p2" },
			},
		};
		localStorage.setItem("lasterm:layout", JSON.stringify(oldState));

		// Create a new layout instance — it should migrate
		let migratedLayout: ReturnType<typeof useLayout> | undefined;
		const migratedScope = effectScope();
		migratedScope.run(() => {
			migratedLayout = useLayout();
		});

		expect(migratedLayout).toBeDefined();
		if (!migratedLayout) {
			migratedScope.stop();
			return;
		}

		// Should have 2 tabs with new id field
		expect(migratedLayout.tabs.value).toHaveLength(2);
		expect(migratedLayout.tabs.value[0]).toHaveProperty("id");
		expect(migratedLayout.tabs.value[0]).not.toHaveProperty("channelId");
		expect(migratedLayout.tabs.value[1]).toHaveProperty("id");

		// Active tab index preserved
		expect(migratedLayout.activeTabIndex.value).toBe(1);

		// Layouts keyed by new tab ids
		const tab0Id = migratedLayout.tabs.value[0]?.id;
		const tab1Id = migratedLayout.tabs.value[1]?.id;
		expect(tab0Id).toBeTruthy();
		expect(tab1Id).toBeTruthy();
		if (!tab0Id || !tab1Id) {
			migratedScope.stop();
			return;
		}

		const root0 = migratedLayout.layouts.value[tab0Id];
		expect(root0?.type).toBe("terminal");
		if (root0?.type === "terminal") {
			expect(root0.channelId).toBe("ch-A");
		}

		const root1 = migratedLayout.layouts.value[tab1Id];
		expect(root1?.type).toBe("terminal");
		if (root1?.type === "terminal") {
			expect(root1.channelId).toBe("ch-B");
		}

		// activePaneIds should be populated
		expect(migratedLayout.activePaneIds.value[tab0Id]).toBeTruthy();
		expect(migratedLayout.activePaneIds.value[tab1Id]).toBeTruthy();

		migratedScope.stop();
	});
});

// -- resolveTabLabel -------------------------------------------------------------------

describe("resolveTabLabel", () => {
	it("returns displayTitle when set", () => {
		const channels = [{ id: "ch-1", displayTitle: "vim ~/project" }];
		expect(resolveTabLabel("ch-1", channels)).toBe("vim ~/project");
	});

	it("returns DEFAULT_CHANNEL_NAME when displayTitle is not set", () => {
		const channels = [{ id: "ch-1" }];
		expect(resolveTabLabel("ch-1", channels)).toBe("Terminal");
	});

	it("returns DEFAULT_CHANNEL_NAME when channel not found", () => {
		expect(resolveTabLabel("missing", [])).toBe("Terminal");
	});

	it("returns DEFAULT_CHANNEL_NAME when channel list is empty", () => {
		expect(resolveTabLabel("ch-1", [])).toBe("Terminal");
	});

	it("ignores other channel fields, only uses displayTitle", () => {
		// Hub pre-computes displayTitle — client should not re-derive from raw fields
		const channels = [{ id: "ch-1", displayTitle: "hub-computed" }];
		expect(resolveTabLabel("ch-1", channels)).toBe("hub-computed");
	});
});

// -- findFirstLeafPaneId + findChannelByPaneId -----------------------------------

describe("findFirstLeafPaneId", () => {
	it("returns paneId for a terminal node", () => {
		const node: PaneNode = { type: "terminal", channelId: "ch-1", paneId: "p1" };
		expect(findFirstLeafPaneId(node)).toBe("p1");
	});

	it("returns null for a vacant node", () => {
		const node: PaneNode = { type: "vacant", id: "v1" };
		expect(findFirstLeafPaneId(node)).toBeNull();
	});

	it("returns first terminal paneId from split tree", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", channelId: "ch-1", paneId: "p1" },
			second: { type: "terminal", channelId: "ch-2", paneId: "p2" },
		};
		expect(findFirstLeafPaneId(node)).toBe("p1");
	});

	it("skips vacant and finds terminal in second branch", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "vacant", id: "v1" },
			second: { type: "terminal", channelId: "ch-2", paneId: "p2" },
		};
		expect(findFirstLeafPaneId(node)).toBe("p2");
	});
});

describe("findChannelByPaneId", () => {
	it("returns channelId for matching paneId", () => {
		const node: PaneNode = { type: "terminal", channelId: "ch-1", paneId: "p1" };
		expect(findChannelByPaneId(node, "p1")).toBe("ch-1");
	});

	it("returns null for non-matching paneId", () => {
		const node: PaneNode = { type: "terminal", channelId: "ch-1", paneId: "p1" };
		expect(findChannelByPaneId(node, "p99")).toBeNull();
	});

	it("returns null for vacant node", () => {
		const node: PaneNode = { type: "vacant", id: "v1" };
		expect(findChannelByPaneId(node, "v1")).toBeNull();
	});

	it("finds channel in nested split", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", channelId: "ch-1", paneId: "p1" },
			second: { type: "terminal", channelId: "ch-2", paneId: "p2" },
		};
		expect(findChannelByPaneId(node, "p2")).toBe("ch-2");
	});
});

// -- collectTerminalChannelIds ---------------------------------------------------

describe("collectTerminalChannelIds", () => {
	it("returns empty array for vacant node", () => {
		const node: PaneNode = { type: "vacant", id: "v1" };
		expect(collectTerminalChannelIds(node)).toEqual([]);
	});

	it("returns channelId array for terminal", () => {
		const node: PaneNode = { type: "terminal", channelId: "ch-1", paneId: "p1" };
		expect(collectTerminalChannelIds(node)).toEqual(["ch-1"]);
	});

	it("collects all terminals from split tree depth-first", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", channelId: "ch-1", paneId: "p1" },
			second: { type: "terminal", channelId: "ch-2", paneId: "p2" },
		};
		expect(collectTerminalChannelIds(node)).toEqual(["ch-1", "ch-2"]);
	});

	it("skips vacant nodes", () => {
		const node: PaneNode = {
			type: "split",
			direction: "vertical",
			ratio: 0.5,
			first: { type: "terminal", channelId: "ch-1", paneId: "p1" },
			second: { type: "vacant", id: "v1" },
		};
		expect(collectTerminalChannelIds(node)).toEqual(["ch-1"]);
	});
});

// ── findTabForChannel — active-tab preference ─────────────────────────────

describe("findTabForChannel", () => {
	it("returns null when no tab contains the channel", () => {
		openTabs("A");
		expect(layout.findTabForChannel("ch-missing")).toBeNull();
	});

	it("returns the tab id when exactly one tab contains the channel", () => {
		const [tabA] = openTabs("A");
		expect(layout.findTabForChannel("ch-A")).toBe(tabA);
	});

	it("prefers the active tab when the same channelId appears in two tabs", () => {
		// Open two tabs for distinct channels so we get two real tab ids.
		const [tabA, tabB] = openTabs("A", "B") as [string, string];

		// Manually inject "ch-shared" into both tab layouts so that the channel
		// exists in two tabs simultaneously (simulates split/copy scenario).
		layout.layouts.value = {
			...layout.layouts.value,
			[tabA]: { type: "terminal", channelId: "ch-shared", paneId: "p-a" },
			[tabB]: { type: "terminal", channelId: "ch-shared", paneId: "p-b" },
		};

		// Make Tab B active (it is already active after openTabs, but be explicit).
		layout.activeTabIndex.value = layout.tabs.value.findIndex((t) => t.id === tabB);
		expect(layout.activeTab.value?.id).toBe(tabB);

		// findTabForChannel must return the active tab (tabB), not the first match (tabA).
		expect(layout.findTabForChannel("ch-shared")).toBe(tabB);
	});

	it("falls back to the first tab when the active tab does NOT contain the channel", () => {
		const [tabA, tabB] = openTabs("A", "B");

		// "ch-A" is only in tabA; tabB is active.
		layout.activeTabIndex.value = layout.tabs.value.findIndex((t) => t.id === tabB);
		expect(layout.activeTab.value?.id).toBe(tabB);

		// Should fall through to the first match (tabA).
		expect(layout.findTabForChannel("ch-A")).toBe(tabA);
	});
});
