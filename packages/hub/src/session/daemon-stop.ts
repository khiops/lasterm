import { ErrorCode, type ErrorMessage, type ProtocolMessage } from "@lasterm/shared";
import type { AgentConnection } from "./agent-connection.js";

/**
 * How long a STOP may take to end the connection. The daemon shuts down as it
 * does on SIGTERM, which gives its terminals ten seconds to confirm they ended;
 * the rest is slack for the frames to travel, over SSH for a remote daemon.
 */
export const DAEMON_STOP_TIMEOUT_MS = 15_000;

/** What came of asking a daemon to stop over its own connection (#127). */
export type DaemonStopOutcome =
	/** The connection ended: the daemon is shutting down, and its terminals with it. */
	| { readonly kind: "stopped" }
	| { readonly kind: "displaced" }
	| { readonly kind: "closed_by_hub" }
	/** Other hubs hold channels there, and the STOP was not forced: nothing stopped. */
	| {
			readonly kind: "refused";
			readonly message: string;
			/** How many, when the agent said; null when it could not be read. */
			readonly otherOwnerChannels: number | null;
	  }
	/** The agent answered the STOP with another error: nothing is known to have stopped. */
	| { readonly kind: "error"; readonly code: string; readonly message: string }
	/** Neither an answer nor the end of the connection came in time. */
	| { readonly kind: "timeout" }
	/** The STOP could not be written: there is no connection to say it on. */
	| { readonly kind: "unsent"; readonly message: string };

export interface DaemonStopOptions {
	readonly force: boolean;
	readonly timeoutMs?: number;
	readonly isHubQuitting?: () => boolean;
	/**
	 * Run when the connection ends, before anyone else hears of it. The
	 * connection's owner uses it to let go of the agent first, so that its own
	 * close handling reads a stop that was asked for, not a link that dropped
	 * and should be dialled again.
	 */
	readonly onStopped?: () => void;
}

/**
 * Ask the daemon at the other end of `agent` to stop, over the hub's own
 * connection to it (#127).
 *
 * A daemon stopping says nothing before it goes: its connection ending is the
 * answer. Without `force` it refuses while other hubs hold channels there, and
 * its refusal states how many.
 */
export function requestDaemonStop(
	agent: AgentConnection & { closedByHub?: boolean },
	options: DaemonStopOptions,
): Promise<DaemonStopOutcome> {
	const timeoutMs = options.timeoutMs ?? DAEMON_STOP_TIMEOUT_MS;
	return new Promise<DaemonStopOutcome>((resolve) => {
		let settled = false;
		const finish = (outcome: DaemonStopOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			agent.off("message", onMessage);
			agent.off("close", onClose);
			resolve(outcome);
		};

		const onMessage = (msg: ProtocolMessage): void => {
			if (msg.type !== "ERROR") return;
			const error = msg as ErrorMessage;
			if (error.channelId !== undefined) return;
			if (error.code === ErrorCode.DISPLACED) {
				finish({ kind: "displaced" });
				return;
			}
			const message = typeof error.message === "string" ? error.message : "";
			if (error.code === ErrorCode.OTHER_HUBS_HOLD_CHANNELS) {
				finish({
					kind: "refused",
					message,
					otherOwnerChannels: countInRefusal(error),
				});
				return;
			}
			finish({ kind: "error", code: error.code, message });
		};

		const onClose = (): void => {
			if (settled) return;
			if (agent.closedByHub || options.isHubQuitting?.()) {
				finish({ kind: "closed_by_hub" });
				return;
			}
			options.onStopped?.();
			finish({ kind: "stopped" });
		};

		const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
		agent.prependListener("message", onMessage);
		// First in line, so the owner lets go before its own close handling runs.
		agent.prependListener("close", onClose);

		try {
			agent.send({ type: "STOP", force: options.force });
		} catch (error) {
			finish({
				kind: "unsent",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

/**
 * How many channels other hubs hold, from a refusal's own
 * `other_owner_channels`, which every agent sends with it (#552); null when
 * it is not a count. Never read out of the message.
 */
function countInRefusal(error: ErrorMessage): number | null {
	return isCount(error.otherOwnerChannels) ? error.otherOwnerChannels : null;
}

/** A count the hub can show: a whole number, not negative. */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
