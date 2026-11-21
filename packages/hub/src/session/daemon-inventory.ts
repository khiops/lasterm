import type { DaemonInventory } from "./agent-connection.js";

/** The part of a tracked channel the stops read. */
interface TrackedChannel {
	readonly hostId: string;
	readonly status: string;
}

/**
 * What a remote daemon's inventory says to a stop asked from `hostId` (#701):
 * the hosts whose live terminals it also holds, and how many it holds that
 * this hub tracks as ended.
 */
export interface InventoryFacts {
	/** Other host records of this hub with a live terminal on that daemon. */
	readonly elsewhere: readonly string[];
	/** Terminals the daemon holds that this hub tracks as ended. */
	readonly shownEnded: number;
	/** What it holds besides what its adoption destroyed. */
	readonly held: number;
}

export function inventoryFacts(
	inventory: DaemonInventory,
	channels: ReadonlyMap<string, TrackedChannel>,
	hostId: string,
): InventoryFacts {
	const elsewhere = new Set<string>();
	let shownEnded = 0;
	let held = 0;
	for (const channelId of inventory.listed) {
		if (inventory.destroyed.has(channelId)) continue;
		held++;
		const tracked = channels.get(channelId);
		if (tracked === undefined) continue;
		if (tracked.status === "dead") shownEnded++;
		else if (tracked.hostId !== hostId) elsewhere.add(tracked.hostId);
	}
	return { elsewhere: [...elsewhere], shownEnded, held };
}
