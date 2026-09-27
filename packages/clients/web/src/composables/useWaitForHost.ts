import { onScopeDispose, type Ref, readonly, ref, watch } from "vue";
import type { RestartFailure } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { afterRestartFailure } from "../utils/exit-action.js";

/** What a pane tells the wait for its terminal's host. */
export interface WaitForHostSources {
	/** Its terminal has ended, and the pane is over it: the card or its line shows. */
	ended: Readonly<Ref<boolean>>;
	channelId: Readonly<Ref<string | null>>;
	/** Restart the terminal, as one made on its own: the host's return, or a retry. */
	restart: () => void;
}

/** What the pane asks of the wait, and hears back. */
export interface WaitForHostHandle {
	/**
	 * A restart of its terminal failed, and why, as the store kept it: wait for
	 * the host, show the card, or try again at once, as `afterRestartFailure`
	 * says. `automatic` when that restart was one made on its own.
	 */
	restartFailed(failure: RestartFailure | undefined, automatic: boolean): void;
	/** Another restart is starting: whatever it meets decides afresh. */
	restartStarting(): void;
	/** Stop waiting: the card comes back, with the reason. */
	cancel(): void;
	/** The host waited for, or null. */
	waitingFor: Readonly<Ref<string | null>>;
}

/**
 * A pane whose restart failed because its terminal's host is away waits for
 * that host, and restarts its terminal once when it is connected again (#605).
 *
 * The host's return is what the hub says of its session, as the hosts store
 * keeps it, local hosts included: no clock, and no condition of view or
 * focus, since someone, or the setting, already asked. Only that host's
 * return counts, and only once: the restart it sets off decides afresh.
 *
 * It stops waiting when cancelled, when another restart starts, when its
 * terminal no longer shows ended (brought back from elsewhere), and when the
 * pane is handed another terminal.
 */
export function useWaitForHost(sources: WaitForHostSources): WaitForHostHandle {
	const hostsStore = useHostsStore();
	const waitingFor = ref<string | null>(null);

	// First, so that a terminal brought back or replaced is never restarted.
	watch([sources.ended, sources.channelId], ([ended, channelId], [, channelBefore]) => {
		if (!ended || channelId !== channelBefore) waitingFor.value = null;
	});

	const stopWatchingHost = watch(
		() => waitingFor.value !== null && hostsStore.isHostConnected(waitingFor.value),
		(back) => {
			if (!back) return;
			waitingFor.value = null;
			sources.restart();
		},
	);

	onScopeDispose(() => {
		stopWatchingHost();
		waitingFor.value = null;
	});

	return {
		restartFailed(failure, automatic) {
			const hostId = failure?.hostAway?.hostId ?? null;
			const verdict = afterRestartFailure({
				hostAway: hostId !== null,
				hostConnected: hostId !== null && hostsStore.isHostConnected(hostId),
				automatic,
			});
			if (verdict === "wait") {
				waitingFor.value = hostId;
				return;
			}
			waitingFor.value = null;
			if (verdict === "retry-now") sources.restart();
		},
		restartStarting() {
			waitingFor.value = null;
		},
		cancel() {
			waitingFor.value = null;
		},
		waitingFor: readonly(waitingFor),
	};
}
