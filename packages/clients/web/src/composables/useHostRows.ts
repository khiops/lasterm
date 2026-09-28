import type { Host } from "@lasterm/shared";
import { computed } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { type HostStatus, useHostsStore } from "../stores/hosts.js";
import { countTerminals, hostAddress, railSections } from "./hostPicker.js";
import { useHostGroups } from "./useHostGroups.js";

/**
 * What a host row shows, read from the stores: the same for the empty pane
 * and the command palette (#625), so that both say the same thing of a host
 * and list the hosts in the rail's order.
 */
export function useHostRows() {
	const hostsStore = useHostsStore();
	const channelsStore = useChannelsStore();
	// The rail's own sections, so that both list hosts as the rail does.
	const { sections, localHost } = useHostGroups();

	const rail = computed(() => railSections(localHost.value, sections.value));

	/** Each host's rank in the rail, for lists that sort by it. */
	const railOrder = computed(() => {
		const order = new Map<string, number>();
		for (const section of rail.value) {
			for (const host of section.hosts) order.set(host.id, order.size);
		}
		return order;
	});

	/** The section each host is under in the rail. */
	const railSectionName = computed(() => {
		const names = new Map<string, string>();
		for (const section of rail.value) {
			for (const host of section.hosts) names.set(host.id, section.name);
		}
		return names;
	});

	/**
	 * Terminals each host has running. `channels` is the host in view's list,
	 * and the index knows every other host's; a terminal in neither is one this
	 * window has not heard of yet, such as a spawn still under way.
	 */
	const counts = computed(() => {
		const listed = new Set(channelsStore.channels.map((channel) => channel.id));
		return countTerminals(
			channelsStore.channelHostMap,
			(channelId) =>
				(listed.has(channelId) || channelsStore.channelIndex.has(channelId)) &&
				channelsStore.statusOf(channelId) !== "dead",
		);
	});

	return {
		rail,
		railOrder,
		railSectionName,
		status: (hostId: string): HostStatus => hostsStore.getHostStatus(hostId),
		address: (host: Host): string => hostAddress(host, hostsStore.hosts),
		count: (hostId: string): number => counts.value.get(hostId) ?? 0,
		host: (hostId: string): Host | undefined => hostsStore.hosts.find((h) => h.id === hostId),
	};
}
