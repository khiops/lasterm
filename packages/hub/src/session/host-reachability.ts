/**
 * Whether a host is away, for a terminal that is to start there (#605).
 *
 * A start that fails because its host cannot be reached says nothing about
 * the terminal: started again once the host is back, it may well run. It is
 * refused with `HOST_UNREACHABLE` and the status of the host's session, so
 * that a pane can wait for that host rather than report a failure of its own.
 */

import { ErrorCode, type ErrorMessage, type SessionStatus } from "@lasterm/shared";
import type { AgentConnection } from "./agent-connection.js";
import type { SharedSessionContext } from "./session-context.js";

type ReachabilityContext = Pick<
	SharedSessionContext,
	"agents" | "sessions" | "reconnectTimers" | "reconnectAbortControllers"
>;

/**
 * The hub lost this host and is reaching for it again: the status of its
 * session (`disconnected`), or null.
 *
 * That is a session whose agent went, with a reconnect waiting its turn or
 * under way. A start sent now would open a second connection beside that one,
 * or wait on a host that does not answer, so it is refused at once: the next
 * attempt is the reconnect's, and a pane waits for it (#605).
 *
 * Anything else is left to the start. A host this hub is not connected to and
 * not reaching for, a first terminal there or one whose reconnect gave up, is
 * connected by the SPAWN itself, as it always was; a local host's agent is
 * started by it.
 */
export function hostReconnecting(ctx: ReachabilityContext, hostId: string): SessionStatus | null {
	if (ctx.agents.get(hostId)?.connected === true) return null;
	const session = ctx.sessions.get(hostId);
	if (session?.status !== "disconnected") return null;
	if (!ctx.reconnectTimers.has(hostId) && !ctx.reconnectAbortControllers.has(hostId)) return null;
	return session.status;
}

/**
 * A SPAWN sent to `agent` went unanswered: whether its host was away
 * meanwhile, and the status of its session now, or null.
 *
 * Away when the connection it went over went down: the hub is reaching for
 * the host again (`disconnected`, `starting`), or has it back over another
 * connection (`active`). Not away when that connection is still the host's
 * and up: the agent was there, and did not answer, which is the terminal's
 * failure, reported as before. Nor when the hub has stopped reaching for the
 * host: nothing will bring it back to wait for.
 */
export function hostAwayDuringSpawn(
	ctx: ReachabilityContext,
	hostId: string,
	agent: AgentConnection,
): SessionStatus | null {
	const current = ctx.agents.get(hostId);
	if (current === agent && agent.connected) return null;
	const session = ctx.sessions.get(hostId);
	if (session === undefined || session.status === "closed") return null;
	// Down, and not yet let go of: what its session says has not caught up.
	if (current === agent) return "disconnected";
	return session.status;
}

/** The refusal a client is sent, for a host that is away. */
export function hostUnreachableMessage(
	hostId: string,
	hostLabel: string | undefined,
	hostStatus: SessionStatus,
	channelId?: string,
): ErrorMessage {
	return {
		type: "ERROR",
		code: ErrorCode.HOST_UNREACHABLE,
		message: `${hostLabel ?? "This host"} cannot be reached right now.`,
		hostId,
		hostStatus,
		...(channelId !== undefined && { channelId }),
	};
}

/**
 * A start refused because its host is away, thrown where the refusal is
 * found and sent by whoever answers the client (`ws/handlers/spawn.ts`).
 */
export class HostUnreachableError extends Error {
	readonly code = ErrorCode.HOST_UNREACHABLE;

	constructor(
		readonly hostId: string,
		readonly hostLabel: string | undefined,
		readonly hostStatus: SessionStatus,
	) {
		super(`${hostLabel ?? "This host"} cannot be reached right now.`);
		this.name = "HostUnreachableError";
	}

	/** The ERROR to send, naming the terminal it was for when it was one being brought back. */
	toMessage(channelId?: string): ErrorMessage {
		return hostUnreachableMessage(this.hostId, this.hostLabel, this.hostStatus, channelId);
	}
}
