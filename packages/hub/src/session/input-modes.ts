import type { HelloMessage } from "@lasterm/shared";

/** The capability an agent says when it writes input in its program's form (#1012). */
export const INPUT_MODES_CAPABILITY = "input-modes";

/**
 * Whether the agent the hub has now for `hostId`, the one INPUT goes to
 * (`SessionManager.handleInput`), writes paste markers and cursor keys in its
 * program's form (#1012). A pane brackets its pastes itself only then. It is
 * read when an answer is sent, never from a stored snapshot: the agent that
 * stored it may not be the one that takes the input.
 */
export function agentAdaptsInput(
	agents: { get(hostId: string): { helloMessage?: HelloMessage | undefined } | undefined },
	hostId: string,
): boolean {
	return agents.get(hostId)?.helloMessage?.capabilities?.includes(INPUT_MODES_CAPABILITY) === true;
}
