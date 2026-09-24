import type { AgentAuthMessage } from "@lasterm/shared";
import { type AgentConnection, hasHubIdentity } from "./agent-connection.js";

/**
 * The AUTH a daemon connection opens with, or null when none is sent (#127).
 *
 * `token` is what the daemon checks against its `auth.json`. The local daemon
 * reads the same file as this hub, so it gets the primary token, as it always
 * has. A remote daemon gets null: this hub's token opens this hub, and a
 * machine it merely reaches has no business holding it.
 *
 * With a token, the AUTH is sent whatever the agent is, and carries the hub key
 * when there is one: an agent without `hub-identity` ignores a field it does not
 * know. Without a token, it is sent only to an agent that asks for an identity,
 * so a daemon from before #127 gets exactly the frames it always did.
 */
export function daemonAuthFrame(
	agent: Pick<AgentConnection, "helloMessage">,
	credentials: { readonly token: string | null; readonly hubKey: string | null },
): AgentAuthMessage | null {
	const { token, hubKey } = credentials;
	const key = typeof hubKey === "string" && hubKey !== "" ? hubKey : null;
	if (token !== null) {
		return { type: "AUTH", token, ...(key !== null && { hubKey: key }) };
	}
	if (key !== null && hasHubIdentity(agent)) {
		return { type: "AUTH", token: "", hubKey: key };
	}
	return null;
}
