/**
 * What a person's Connect, Reconnect and Disconnect of a host decide before
 * anything is done (#648): whether its terminals outlive the connection, and
 * so how many end with it, which is what the question put to them counts.
 */

/** A host's connection, as far as the terminals it holds are concerned. */
export interface HostConnectionFacts {
	/** The agent this hub reaches the host through, if it has one. */
	readonly agent: { readonly connected: boolean; readonly usedRemoteDaemon: boolean } | undefined;
	/** Whether the host keeps a remote daemon, by its own setting and the hub's (#79). */
	readonly hostKeepsDaemon: boolean;
	/** Its terminals this hub holds that have not ended. */
	readonly liveTerminals: number;
}

/**
 * Whether the host's terminals outlive its connection.
 *
 * A connection that is up says it itself: it reached a daemon, or it runs
 * the agent on stdio, whatever the host's setting says now. With none up,
 * the setting is what the next one would do, and what the last one did.
 */
export function terminalsOutliveConnection(facts: HostConnectionFacts): boolean {
	if (facts.agent?.connected === true) return facts.agent.usedRemoteDaemon;
	return facts.hostKeepsDaemon;
}

/**
 * How many terminals a Disconnect ends: every one this hub holds there,
 * unless a daemon keeps them. On stdio, one whose link is already down is
 * counted too: the reconnect it was waiting for would have started it again,
 * and after a Disconnect nothing does.
 */
export function terminalsEndedByDisconnect(facts: HostConnectionFacts): number {
	return terminalsOutliveConnection(facts) ? 0 : facts.liveTerminals;
}

/**
 * How many terminals a Reconnect ends: those of a connection up that runs
 * them itself, closed before the next one opens. With no connection up there
 * is nothing to close: a daemon's terminals are taken up again, and on stdio
 * they start again under their ids, as after a dropped link.
 */
export function terminalsEndedByReconnect(facts: HostConnectionFacts): number {
	if (facts.agent?.connected !== true) return 0;
	return facts.agent.usedRemoteDaemon ? 0 : facts.liveTerminals;
}
