/**
 * Reaching a host through another one.
 *
 * `ProxyJump` in `~/.ssh/config`: the SSH connection to the target is carried
 * inside a channel opened on a bastion, so the target needs no route of its
 * own. Here a jump is named in one of two ways, never both:
 *
 *   - **a host this hub knows**, which brings its own authentication and its
 *     own pinned host key — nothing about it is described twice;
 *   - **a spec**, `user@host:port`, the form `~/.ssh/config` uses, for a
 *     bastion that is not a host here. It authenticates through the SSH agent,
 *     because that is what a bastion is reached with, and it has no row of its
 *     own to pin a key on, so the host that jumps through it pins it instead.
 *
 * A chain (`ProxyJump a,b`) is refused rather than half-honoured: two hops is
 * not one hop twice as far, and silently taking only the first would connect
 * somewhere nobody asked for.
 */

import type { Host } from "@lasterm/shared";
import { parseSshHost, planJump, targetRoute } from "../ssh-route.js";

export type { JumpDeclaration, JumpPlan, JumpSpecResult, ParsedJumpSpec } from "../ssh-route.js";
export { parseJumpSpec, planJump } from "../ssh-route.js";

/** A jump turned into what it takes to travel through it. */
export interface ResolvedJump {
	jump: { host: string; port: number; username: string };
	/** Names used to look up this jump in `known_hosts`. */
	knownHostsNames: string[];
	/** How the jump itself is authenticated, as `buildSshConnectConfig` takes it. */
	auth: { method: string; keyPath?: string | undefined };
	/** The host id any prompt for the jump belongs to. */
	promptHostId: string;
	/** The key already trusted for this jump, when there is one. */
	pinnedFingerprint: string | null;
	/** Whether a key `known_hosts` already trusts is enough on its own. */
	trustKnownHosts: boolean;
	/** Where the key is pinned once a connection through it has worked. */
	pinTo:
		| { kind: "host"; hostId: string; expectedRoute: string | null }
		| { kind: "spec"; hostId: string };
}

export type JumpResolution =
	/** No jump: the host is reached directly. */
	| { kind: "direct" }
	/** Through `jump`. */
	| { kind: "jump"; jump: ResolvedJump }
	/** Declared, and unusable — the message says why. */
	| { kind: "refused"; message: string };

/** What resolving a jump reads from this hub's hosts. */
export interface JumpHosts {
	getHost(id: string): Host | undefined;
	getHostFingerprint(id: string, expectedRoute: string | null): string | null;
}

/**
 * The route to `host`, read afresh from what this hub knows now.
 *
 * Every connection to the host goes this way, reconnects included: a host
 * reached only through its bastion is not reachable at all without it, and a
 * reconnect that dialled it directly would fail every attempt until its
 * session gave up (#609).
 */
export function resolveJump(
	host: Pick<
		Host,
		"id" | "sshHost" | "sshUser" | "sshProxyHostId" | "sshProxySpec" | "sshProxyFingerprint"
	>,
	hosts: JumpHosts,
	trustKnownHosts: boolean,
): JumpResolution {
	const plan = planJump(host);
	switch (plan.kind) {
		case "direct":
		case "refused":
			return plan;
		case "host": {
			const jumpHost = hosts.getHost(plan.hostId);
			if (jumpHost?.type !== "ssh" || !jumpHost.sshHost) {
				return {
					kind: "refused",
					message:
						"The host this one is reached through is no longer an SSH host here. Point it at another, or give its address instead.",
				};
			}
			const jumpParsed = parseSshHost(jumpHost.sshHost);
			const expectedRoute = targetRoute(
				{ ...jumpHost, sshProxyHostId: null, sshProxySpec: null },
				() => undefined,
			);
			return {
				kind: "jump",
				jump: {
					jump: {
						host: jumpParsed.hostname,
						port: jumpHost.sshPort ?? 22,
						username: jumpHost.sshUser || jumpParsed.username,
					},
					knownHostsNames: [jumpParsed.hostname, jumpHost.sshConfigHost].filter(
						(name): name is string => !!name,
					),
					auth: {
						method: jumpHost.sshAuth ?? "agent",
						keyPath: jumpHost.sshKeyPath ?? undefined,
					},
					promptHostId: jumpHost.id,
					pinnedFingerprint: hosts.getHostFingerprint(jumpHost.id, expectedRoute),
					trustKnownHosts,
					pinTo: {
						kind: "host",
						hostId: jumpHost.id,
						expectedRoute,
					},
				},
			};
		}
		case "spec":
			// A bastion named as an address is reached the way bastions are: with
			// whatever the agent holds. A key of its own would be a second host,
			// which is the other way of naming it.
			return {
				kind: "jump",
				jump: {
					jump: {
						host: plan.spec.host,
						port: plan.spec.port,
						username: plan.spec.user ?? host.sshUser ?? parseSshHost(host.sshHost ?? "").username,
					},
					knownHostsNames: [plan.spec.host],
					auth: { method: "agent" },
					promptHostId: host.id,
					pinnedFingerprint: host.sshProxyFingerprint ?? null,
					trustKnownHosts,
					pinTo: { kind: "spec", hostId: host.id },
				},
			};
	}
}

/** Record a jump key only after the caller has established a successful connection. */
export function pinJumpKey(
	writer: {
		updateHostFingerprint(id: string, fingerprint: string, expectedRoute: string | null): boolean;
		updateHostProxyFingerprint(
			id: string,
			fingerprint: string,
			expectedRoute: string | null,
		): boolean;
	},
	jump: ResolvedJump,
	fingerprint: string,
	expectedRoute: string | null,
): boolean {
	if (jump.pinTo.kind === "host")
		return writer.updateHostFingerprint(jump.pinTo.hostId, fingerprint, jump.pinTo.expectedRoute);
	return writer.updateHostProxyFingerprint(jump.pinTo.hostId, fingerprint, expectedRoute);
}
