import type { AgentAuthMessage } from "@lasterm/shared";

/**
 * The AUTH a daemon connection opens with (#127). Every daemon requires one,
 * carrying the hub key, before it acts on anything else.
 *
 * `token` is what the daemon checks against its `auth.json`. The local daemon
 * reads the same file as this hub, so it gets the primary token. A remote
 * daemon gets an empty one: this hub's token opens this hub, and a machine it
 * merely reaches has no business holding it.
 *
 * `hubKey` is null only for a manager built without one, as tests do: it then
 * sends an empty key, which every daemon refuses.
 */
export function daemonAuthFrame(credentials: {
	readonly token: string | null;
	readonly hubKey: string | null;
}): AgentAuthMessage {
	return { type: "AUTH", token: credentials.token ?? "", hubKey: credentials.hubKey ?? "" };
}
