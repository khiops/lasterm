import type { HostsChangedMessage } from "@lasterm/shared";

/** What a write changed: the hosts, the host groups, or both. */
export type HostsChangeScope = HostsChangedMessage["scope"];

/**
 * Says that a write to the hosts or the host groups succeeded, for every client
 * to read them again (#783). A route calls it once its write is stored, never
 * for a read or a refused write.
 */
export type AnnounceHostsChange = (scope: HostsChangeScope) => void;

/** How long the hub waits for a burst of writes to end before it says so. */
export const HOSTS_CHANGED_QUIET_MS = 100;

/** The longest a write waits to be said while writes keep coming. */
export const HOSTS_CHANGED_MAX_WAIT_MS = 1_000;

export interface HostsChangeAnnouncer {
	readonly announce: AnnounceHostsChange;
	/** Drop what is still waiting to be said: the hub is closing. */
	cancel(): void;
}

/**
 * One HOSTS_CHANGED for a burst of writes. A script adding twenty hosts one
 * request at a time, or a group made in the host dialog just before its host,
 * is one message: each client then reads the lists once, not twenty times.
 * The message goes out once no write has come for `quietMs`, and no later than
 * `maxWaitMs` after the first, so a steady stream is still heard.
 */
export function createHostsChangeAnnouncer(
	send: (message: HostsChangedMessage) => void,
	quietMs = HOSTS_CHANGED_QUIET_MS,
	maxWaitMs = HOSTS_CHANGED_MAX_WAIT_MS,
): HostsChangeAnnouncer {
	let hosts = false;
	let groups = false;
	let firstAt = 0;
	let timer: NodeJS.Timeout | null = null;

	const reset = (): void => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		hosts = false;
		groups = false;
	};

	const flush = (): void => {
		const scope: HostsChangeScope = hosts && groups ? "both" : hosts ? "hosts" : "groups";
		reset();
		send({ type: "HOSTS_CHANGED", scope });
	};

	return {
		announce(scope) {
			const now = Date.now();
			if (timer === null) firstAt = now;
			else clearTimeout(timer);
			if (scope !== "groups") hosts = true;
			if (scope !== "hosts") groups = true;
			const wait = Math.max(0, Math.min(quietMs, firstAt + maxWaitMs - now));
			timer = setTimeout(flush, wait);
			// A message still waiting never keeps the hub up.
			timer.unref();
		},
		cancel: reset,
	};
}
