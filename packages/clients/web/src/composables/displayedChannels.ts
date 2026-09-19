import type { ComputedRef, InjectionKey } from "vue";
import { collectTerminalChannelIds, type PaneNode } from "./usePaneTree.js";

/**
 * The channels a pane shows, in any tab. A vacant pane's picker offers only
 * the others, the detached ones (UX-01 EFF-03): offering a shown channel put
 * the same terminal twice in one tab.
 */
export const DISPLAYED_CHANNELS_KEY: InjectionKey<ComputedRef<ReadonlySet<string>>> =
	Symbol("displayed-channels");

export function displayedChannelIds(
	layouts: Readonly<Record<string, PaneNode | null | undefined>>,
): Set<string> {
	const ids = new Set<string>();
	for (const root of Object.values(layouts)) {
		if (!root) continue;
		for (const id of collectTerminalChannelIds(root)) ids.add(id);
	}
	return ids;
}

/**
 * The channels a vacant pane of `hostId` can take: alive, of that host, and
 * detached — shown in no pane (UX-01 EFF-03).
 */
export function pickableChannels<T extends { id: string; status: string }>(
	channels: readonly T[],
	channelHost: ReadonlyMap<string, string>,
	hostId: string | null,
	displayed: ReadonlySet<string>,
): T[] {
	if (!hostId) return [];
	return channels.filter(
		(c) => c.status !== "dead" && channelHost.get(c.id) === hostId && !displayed.has(c.id),
	);
}
