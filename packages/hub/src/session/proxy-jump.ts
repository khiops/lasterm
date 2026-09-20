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

/** A jump named as a spec, once read. */
export interface ParsedJumpSpec {
	user: string | null;
	host: string;
	port: number;
}

export type JumpSpecResult =
	| { kind: "spec"; spec: ParsedJumpSpec }
	| { kind: "chain"; hops: number }
	| { kind: "invalid"; reason: string };

/**
 * Read a `ProxyJump` value the way `ssh_config(5)` writes it.
 *
 * `[host]:port` is accepted as well as `host:port`: both appear in the wild,
 * and the bracketed form is the one a copied `known_hosts` line offers.
 */
export function parseJumpSpec(raw: string): JumpSpecResult {
	const trimmed = raw.trim();
	if (trimmed === "") return { kind: "invalid", reason: "it is empty" };
	if (trimmed.toLowerCase() === "none") {
		return { kind: "invalid", reason: "`none` means no jump at all" };
	}

	const hops = trimmed.split(",").filter((hop) => hop.trim() !== "");
	if (hops.length > 1) return { kind: "chain", hops: hops.length };

	const single = hops[0] ?? trimmed;
	const at = single.lastIndexOf("@");
	const user = at === -1 ? null : single.slice(0, at);
	const hostAndPort = at === -1 ? single : single.slice(at + 1);
	if (at !== -1 && user === "") return { kind: "invalid", reason: "it names an empty user" };

	// [host]:port, the bracketed form
	const bracketed = hostAndPort.match(/^\[([^\]]+)\](?::(\d+))?$/);
	if (bracketed) {
		const host = bracketed[1] ?? "";
		const port = bracketed[2] === undefined ? 22 : Number.parseInt(bracketed[2], 10);
		if (host === "") return { kind: "invalid", reason: "it names no host" };
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return { kind: "invalid", reason: `port ${bracketed[2]} is not a port` };
		}
		return { kind: "spec", spec: { user, host, port } };
	}

	const colon = hostAndPort.lastIndexOf(":");
	// An IPv6 address without brackets has several colons and no port.
	const looksLikeIpv6 = hostAndPort.indexOf(":") !== colon;
	const host = colon === -1 || looksLikeIpv6 ? hostAndPort : hostAndPort.slice(0, colon);
	const portText = colon === -1 || looksLikeIpv6 ? null : hostAndPort.slice(colon + 1);
	if (host === "") return { kind: "invalid", reason: "it names no host" };

	const port = portText === null ? 22 : Number.parseInt(portText, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { kind: "invalid", reason: `port ${portText} is not a port` };
	}
	return { kind: "spec", spec: { user, host, port } };
}

/** What a host says about the jump it is reached through. */
export interface JumpDeclaration {
	sshProxyHostId?: string | null;
	sshProxySpec?: string | null;
}

export type JumpPlan =
	/** No jump: the host is reached directly. */
	| { kind: "direct" }
	/** Through a host this hub knows, by its id. */
	| { kind: "host"; hostId: string }
	/** Through a bastion named as a spec. */
	| { kind: "spec"; spec: ParsedJumpSpec }
	/** Declared, and unusable — the message says why. */
	| { kind: "refused"; message: string };

/**
 * What a host's declaration amounts to.
 *
 * A host id wins over a spec: a jump this hub knows is the one with the
 * authentication and the pinned key, and a spec left beside it is a leftover
 * from before it was linked.
 */
export function planJump(declaration: JumpDeclaration): JumpPlan {
	const hostId = declaration.sshProxyHostId?.trim();
	if (hostId) return { kind: "host", hostId };

	const raw = declaration.sshProxySpec?.trim();
	if (!raw) return { kind: "direct" };

	const parsed = parseJumpSpec(raw);
	switch (parsed.kind) {
		case "spec":
			return { kind: "spec", spec: parsed.spec };
		case "chain":
			return {
				kind: "refused",
				message: `This host is reached through ${parsed.hops} jumps in a row, which Lasterm does not do yet. Name the last one, or add the chain as hosts of their own.`,
			};
		case "invalid":
			return { kind: "refused", message: `This host's jump cannot be read: ${parsed.reason}.` };
	}
}

/** A jump turned into what it takes to travel through it. */
export interface ResolvedJump {
	jump: { host: string; port: number; username: string };
	/** How the jump itself is authenticated, as `buildSshConnectConfig` takes it. */
	auth: { method: string; keyPath?: string | undefined };
	/** The host id any prompt for the jump belongs to. */
	promptHostId: string;
	/** The key already trusted for this jump, when there is one. */
	pinnedFingerprint: string | null;
	/** Whether a key `known_hosts` already trusts is enough on its own. */
	trustKnownHosts: boolean;
	/** Where the key is pinned once a connection through it has worked. */
	pinTo: { kind: "host"; hostId: string } | { kind: "spec"; hostId: string };
}
