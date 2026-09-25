import type { ChannelStatus } from "@lasterm/shared";

/** What a terminal pane knows about the terminal behind it. */
export interface PaneFacts {
	/** Its status as this client last heard it, whichever host is in view. */
	status: ChannelStatus | undefined;
	/** An attach was refused because the terminal has ended. */
	ended: boolean;
	/** The hub has no record of it. */
	gone: boolean;
	/** The last attach was answered from what the hub remembers, not from the terminal. */
	detached: boolean;
}

/**
 * What a pane lays over its terminal: the exit overlay, with Restart
 * (`exited`); the same overlay without it (`gone`); the "Not connected" banner
 * with Reconnect (`not-connected`); or nothing.
 *
 * A terminal that has ended is not waiting for a connection. The banner is
 * only for one the hub could not reach, so whatever says it ended wins over it.
 */
export type PaneCover = "exited" | "gone" | "not-connected" | null;

export function paneCover(facts: PaneFacts): PaneCover {
	if (facts.gone) return "gone";
	if (facts.ended || facts.status === "dead") return "exited";
	if (facts.detached) return "not-connected";
	return null;
}
