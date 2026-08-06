import type { Host } from "@lasterm/shared";
import { computed, ref } from "vue";
import { useHostsStore } from "../stores/hosts.js";

const COLLAPSED_KEY = "lasterm:collapsed-host-groups";

export interface HostGroupSection {
	type: "group";
	id: string;
	name: string;
	hosts: Host[];
	collapsed: boolean;
}

export interface UngroupedSection {
	type: "ungrouped";
	hosts: Host[];
}

export type HostSection = HostGroupSection | UngroupedSection;

function loadCollapsedGroups(): Set<string> {
	try {
		const raw = localStorage.getItem(COLLAPSED_KEY);
		if (!raw) return new Set();
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set();
	}
}

function saveCollapsedGroups(set: Set<string>): void {
	localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
}

export function useHostGroups() {
	const hostsStore = useHostsStore();
	const collapsedGroups = ref(loadCollapsedGroups());

	const sections = computed<HostSection[]>(() => {
		const result: HostSection[] = [];
		const ungrouped: Host[] = [];

		// Build a host lookup by hostGroupId for fast grouping
		const byGroupId = new Map<string, Host[]>();
		for (const host of hostsStore.sortedHosts) {
			if (host.type === "local") continue;
			if (host.hostGroupId) {
				const list = byGroupId.get(host.hostGroupId) ?? [];
				list.push(host);
				byGroupId.set(host.hostGroupId, list);
			} else {
				ungrouped.push(host);
			}
		}

		// Iterate DB-backed groups in sortOrder order (API already returns them sorted)
		for (const group of hostsStore.hostGroups) {
			const hosts = (byGroupId.get(group.id) ?? [])
				.slice()
				.sort((a, b) => a.sortOrder - b.sortOrder);
			result.push({
				type: "group",
				id: group.id,
				name: group.name,
				hosts,
				collapsed: collapsedGroups.value.has(group.id),
			});
		}

		// Ungrouped at the bottom
		if (ungrouped.length > 0) {
			result.push({ type: "ungrouped", hosts: ungrouped });
		}

		return result;
	});

	// The local host, always rendered first separately
	const localHost = computed(() => hostsStore.sortedHosts.find((h) => h.type === "local") ?? null);

	function toggleGroup(groupId: string): void {
		const set = new Set(collapsedGroups.value);
		if (set.has(groupId)) set.delete(groupId);
		else set.add(groupId);
		collapsedGroups.value = set;
		saveCollapsedGroups(set);
	}

	function reorderGroups(fromId: string, toId: string): void {
		if (fromId === toId) return;

		const currentIds = sections.value
			.filter((s): s is HostGroupSection => s.type === "group")
			.map((s) => s.id);

		const fromIdx = currentIds.indexOf(fromId);
		const toIdx = currentIds.indexOf(toId);
		if (fromIdx === -1 || toIdx === -1) return;

		const newOrder = [...currentIds];
		newOrder.splice(fromIdx, 1);
		const insertIdx = toIdx > fromIdx ? toIdx - 1 : toIdx;
		newOrder.splice(insertIdx, 0, fromId);

		void hostsStore.reorderHostGroups(newOrder);
	}

	return {
		sections,
		localHost,
		collapsedGroups,
		toggleGroup,
		reorderGroups,
	};
}
