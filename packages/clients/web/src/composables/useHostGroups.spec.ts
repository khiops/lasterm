import type { Host, HostGroup } from "@lasterm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";

function makeHost(overrides: Partial<Host> & { id: string; label: string }): Host {
	return {
		type: "ssh",
		sshHost: "example.com",
		sshPort: 22,
		iconType: "auto",
		trustRemoteHints: "apply",
		sortOrder: 0,
		keepAliveSeconds: 0,
		historyRetentionDays: 30,
		os: null,
		arch: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeGroup(overrides: Partial<HostGroup> & { id: string; name: string }): HostGroup {
	return {
		sortOrder: 0,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const mockHosts = ref<Host[]>([]);
const mockHostGroups = ref<HostGroup[]>([]);
const mockReorderHostGroups = vi.fn();
const mockMoveHostToGroup = vi.fn();
const mockFetchHosts = vi.fn();

/**
 * Pinia stores unwrap computed/ref at access time, so `store.sortedHosts`
 * returns the raw value. We replicate that with a getter on a plain object.
 */
vi.mock("../stores/hosts.js", () => ({
	useHostsStore: () => ({
		get sortedHosts() {
			return mockHosts.value;
		},
		get hostGroups() {
			return mockHostGroups.value;
		},
		selectedHostId: null as string | null,
		getHostStatus: () => "offline" as const,
		reorderHostGroups: mockReorderHostGroups,
		moveHostToGroup: mockMoveHostToGroup,
		fetchHosts: mockFetchHosts,
	}),
}));

// Mock localStorage
const localStorageMap = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => localStorageMap.get(key) ?? null,
	setItem: (key: string, value: string) => localStorageMap.set(key, value),
	removeItem: (key: string) => localStorageMap.delete(key),
});

// Must import AFTER mocks
const { useHostGroups } = await import("./useHostGroups.js");

describe("useHostGroups", () => {
	beforeEach(() => {
		mockHosts.value = [];
		mockHostGroups.value = [];
		localStorageMap.clear();
		mockReorderHostGroups.mockClear();
		mockMoveHostToGroup.mockClear();
		mockFetchHosts.mockClear();
	});

	it("separates local host from grouped and ungrouped", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "Production", sortOrder: 0 })];
		mockHosts.value = [
			makeHost({ id: "1", label: "Local", type: "local" }),
			makeHost({ id: "2", label: "Prod", hostGroupId: "g1" }),
			makeHost({ id: "3", label: "Dev", hostGroupId: null }),
		];

		const { localHost, sections } = useHostGroups();

		await nextTick();

		expect(localHost.value).not.toBeNull();
		expect(localHost.value?.id).toBe("1");

		// Should have 2 sections: "Production" group + ungrouped
		expect(sections.value).toHaveLength(2);
		expect(sections.value[0]?.type).toBe("group");
		expect((sections.value[0] as { name: string }).name).toBe("Production");
		expect((sections.value[0] as { id: string }).id).toBe("g1");
		expect(sections.value[0]?.hosts).toHaveLength(1);
		expect(sections.value[0]?.hosts[0]?.id).toBe("2");

		expect(sections.value[1]?.type).toBe("ungrouped");
		expect(sections.value[1]?.hosts).toHaveLength(1);
		expect(sections.value[1]?.hosts[0]?.id).toBe("3");
	});

	it("groups hosts by hostGroupId", async () => {
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "Beta", sortOrder: 1 }),
		];
		mockHosts.value = [
			makeHost({ id: "1", label: "S1", hostGroupId: "g1" }),
			makeHost({ id: "2", label: "S2", hostGroupId: "g1" }),
			makeHost({ id: "3", label: "S3", hostGroupId: "g2" }),
		];

		const { sections } = useHostGroups();

		await nextTick();

		// 2 group sections in sortOrder: Alpha, Beta
		expect(sections.value).toHaveLength(2);
		expect((sections.value[0] as { name: string }).name).toBe("Alpha");
		expect(sections.value[0]?.hosts).toHaveLength(2);
		expect((sections.value[1] as { name: string }).name).toBe("Beta");
		expect(sections.value[1]?.hosts).toHaveLength(1);
	});

	it("shows empty group sections when group has no hosts", async () => {
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Empty", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "HasHosts", sortOrder: 1 }),
		];
		mockHosts.value = [makeHost({ id: "1", label: "S1", hostGroupId: "g2" })];

		const { sections } = useHostGroups();

		await nextTick();

		// Both group sections appear, even the empty one
		expect(sections.value).toHaveLength(2);
		expect((sections.value[0] as { name: string }).name).toBe("Empty");
		expect(sections.value[0]?.hosts).toHaveLength(0);
		expect((sections.value[1] as { name: string }).name).toBe("HasHosts");
		expect(sections.value[1]?.hosts).toHaveLength(1);
	});

	it("handles empty host list", async () => {
		mockHosts.value = [];
		mockHostGroups.value = [];

		const { localHost, sections } = useHostGroups();

		await nextTick();

		expect(localHost.value).toBeNull();
		expect(sections.value).toHaveLength(0);
	});

	it("toggles group collapse by ID and persists to localStorage", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "MyGroup", sortOrder: 0 })];
		mockHosts.value = [makeHost({ id: "1", label: "S1", hostGroupId: "g1" })];

		const { sections, toggleGroup } = useHostGroups();

		await nextTick();

		expect(sections.value[0]?.type).toBe("group");
		expect((sections.value[0] as { collapsed: boolean }).collapsed).toBe(false);

		toggleGroup("g1");
		await nextTick();

		expect((sections.value[0] as { collapsed: boolean }).collapsed).toBe(true);
		expect(localStorageMap.get("lasterm:collapsed-host-groups")).toBe(JSON.stringify(["g1"]));

		toggleGroup("g1");
		await nextTick();

		expect((sections.value[0] as { collapsed: boolean }).collapsed).toBe(false);
	});

	it("reorderGroups calls hostsStore.reorderHostGroups with new ID order", async () => {
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "Beta", sortOrder: 1 }),
			makeGroup({ id: "g3", name: "Gamma", sortOrder: 2 }),
		];
		mockHosts.value = [];

		const { sections, reorderGroups } = useHostGroups();

		await nextTick();

		// Initial order: Alpha(g1), Beta(g2), Gamma(g3)
		expect((sections.value[0] as { id: string }).id).toBe("g1");
		expect((sections.value[1] as { id: string }).id).toBe("g2");
		expect((sections.value[2] as { id: string }).id).toBe("g3");

		reorderGroups("g3", "g1");
		await nextTick();

		// reorderHostGroups called with new order: [g3, g1, g2]
		expect(mockReorderHostGroups).toHaveBeenCalledWith(["g3", "g1", "g2"]);
	});

	it("reorderGroups is a no-op when IDs are the same", async () => {
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "Beta", sortOrder: 1 }),
		];
		mockHosts.value = [];

		const { reorderGroups } = useHostGroups();

		await nextTick();

		reorderGroups("g1", "g1");
		await nextTick();

		expect(mockReorderHostGroups).not.toHaveBeenCalled();
	});

	it("reorderGroups handles forward drag (fromIdx < toIdx)", async () => {
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "Beta", sortOrder: 1 }),
			makeGroup({ id: "g3", name: "Gamma", sortOrder: 2 }),
		];
		mockHosts.value = [];

		const { reorderGroups } = useHostGroups();
		await nextTick();

		// Alpha(0) → Gamma(2) position: expect [g2, g1, g3]
		reorderGroups("g1", "g3");
		await nextTick();

		expect(mockReorderHostGroups).toHaveBeenCalledWith(["g2", "g1", "g3"]);
	});

	it("section order follows hostGroups sortOrder from store", async () => {
		// Groups given in sortOrder 0,1,2 — should appear in that order
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Gamma", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "Alpha", sortOrder: 1 }),
			makeGroup({ id: "g3", name: "Beta", sortOrder: 2 }),
		];
		mockHosts.value = [];

		const { sections } = useHostGroups();
		await nextTick();

		// Order follows store sortOrder, not alphabetical
		expect((sections.value[0] as { name: string }).name).toBe("Gamma");
		expect((sections.value[1] as { name: string }).name).toBe("Alpha");
		expect((sections.value[2] as { name: string }).name).toBe("Beta");
	});

	it("collapsed state persists by group ID across instances", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "MyGroup", sortOrder: 0 })];
		mockHosts.value = [];

		// First instance: collapse the group
		const { toggleGroup } = useHostGroups();
		await nextTick();
		toggleGroup("g1");
		await nextTick();

		expect(localStorageMap.get("lasterm:collapsed-host-groups")).toBe(JSON.stringify(["g1"]));

		// Second instance: should read collapsed state from localStorage
		const { sections: sections2 } = useHostGroups();
		await nextTick();

		expect((sections2.value[0] as { collapsed: boolean }).collapsed).toBe(true);
	});

	it("hosts within a group are sorted by sortOrder", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "G1", sortOrder: 0 })];
		mockHosts.value = [
			makeHost({ id: "1", label: "S1", hostGroupId: "g1", sortOrder: 2 }),
			makeHost({ id: "2", label: "S2", hostGroupId: "g1", sortOrder: 0 }),
			makeHost({ id: "3", label: "S3", hostGroupId: "g1", sortOrder: 1 }),
		];

		const { sections } = useHostGroups();
		await nextTick();

		expect(sections.value[0]?.hosts[0]?.id).toBe("2");
		expect(sections.value[0]?.hosts[1]?.id).toBe("3");
		expect(sections.value[0]?.hosts[2]?.id).toBe("1");
	});

	// ── Cross-group DnD: sections react to store updates ───────────────────

	it("sections update reactively when host moves between groups via store", async () => {
		mockHostGroups.value = [
			makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 }),
			makeGroup({ id: "g2", name: "Beta", sortOrder: 1 }),
		];
		mockHosts.value = [
			makeHost({ id: "h1", label: "Server1", hostGroupId: "g1", sortOrder: 0 }),
			makeHost({ id: "h2", label: "Server2", hostGroupId: "g2", sortOrder: 0 }),
		];

		const { sections } = useHostGroups();
		await nextTick();

		expect(sections.value[0]?.hosts).toHaveLength(1);
		expect(sections.value[0]?.hosts[0]?.id).toBe("h1");
		expect(sections.value[1]?.hosts).toHaveLength(1);

		// Simulate store update: move h1 to g2
		mockHosts.value = [
			makeHost({ id: "h1", label: "Server1", hostGroupId: "g2", sortOrder: 1 }),
			makeHost({ id: "h2", label: "Server2", hostGroupId: "g2", sortOrder: 0 }),
		];
		await nextTick();

		expect(sections.value[0]?.hosts).toHaveLength(0);
		expect(sections.value[1]?.hosts).toHaveLength(2);
	});

	it("sections update reactively when host moves to ungrouped via store", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 })];
		mockHosts.value = [makeHost({ id: "h1", label: "Server1", hostGroupId: "g1", sortOrder: 0 })];

		const { sections } = useHostGroups();
		await nextTick();

		expect(sections.value).toHaveLength(1);
		expect(sections.value[0]?.type).toBe("group");

		// Simulate store update: move h1 to ungrouped (hostGroupId = null)
		mockHosts.value = [makeHost({ id: "h1", label: "Server1", hostGroupId: null, sortOrder: 0 })];
		await nextTick();

		// Now: g1 group (empty) + ungrouped section
		expect(sections.value).toHaveLength(2);
		expect(sections.value[0]?.type).toBe("group");
		expect(sections.value[0]?.hosts).toHaveLength(0);
		expect(sections.value[1]?.type).toBe("ungrouped");
		expect(sections.value[1]?.hosts[0]?.id).toBe("h1");
	});

	it("sections update reactively when host moves from ungrouped to a group", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 })];
		mockHosts.value = [makeHost({ id: "h1", label: "Server1", hostGroupId: null, sortOrder: 0 })];

		const { sections } = useHostGroups();
		await nextTick();

		// Initial: group section (empty) + ungrouped
		expect(sections.value).toHaveLength(2);
		expect(sections.value[1]?.type).toBe("ungrouped");
		expect(sections.value[1]?.hosts[0]?.id).toBe("h1");

		// Simulate store update: h1 assigned to g1
		mockHosts.value = [makeHost({ id: "h1", label: "Server1", hostGroupId: "g1", sortOrder: 0 })];
		await nextTick();

		// Now: only g1 group section with h1
		expect(sections.value).toHaveLength(1);
		expect(sections.value[0]?.type).toBe("group");
		expect(sections.value[0]?.hosts[0]?.id).toBe("h1");
	});

	it("reorderGroups is a no-op when fromId is not found", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 })];
		mockHosts.value = [];

		const { reorderGroups } = useHostGroups();
		await nextTick();

		reorderGroups("nonexistent", "g1");
		await nextTick();

		expect(mockReorderHostGroups).not.toHaveBeenCalled();
	});

	it("reorderGroups is a no-op when toId is not found", async () => {
		mockHostGroups.value = [makeGroup({ id: "g1", name: "Alpha", sortOrder: 0 })];
		mockHosts.value = [];

		const { reorderGroups } = useHostGroups();
		await nextTick();

		reorderGroups("g1", "nonexistent");
		await nextTick();

		expect(mockReorderHostGroups).not.toHaveBeenCalled();
	});
});
