import type { Host } from "./entities.js";

/** A jump named as a spec, once read. */
export interface ParsedJumpSpec {
	user: string | null;
	host: string;
	/** 22 when the spec writes none. */
	port: number;
	/** Whether the spec writes a port, bracketed or not. */
	portGiven: boolean;
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
		const portGiven = bracketed[2] !== undefined;
		const port = bracketed[2] === undefined ? 22 : Number.parseInt(bracketed[2], 10);
		if (host === "") return { kind: "invalid", reason: "it names no host" };
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			return { kind: "invalid", reason: `port ${bracketed[2]} is not a port` };
		}
		return { kind: "spec", spec: { user, host, port, portGiven } };
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
	return { kind: "spec", spec: { user, host, port, portGiven: portText !== null } };
}

/** A `ProxyJump` linked to a saved host, with the user and port it writes of its own. */
export interface JumpLink {
	bastion: Host;
	/** The user the jump writes when it differs from the bastion's own; null follows the bastion. */
	user: string | null;
	/** The port the jump writes when it differs from the bastion's own; null follows the bastion. */
	port: number | null;
}

/**
 * The saved host a `ProxyJump` from `~/.ssh/config` is linked to, if any
 * (#1040, #1042, #1047), and what the jump writes of its own.
 *
 * `ssh` reads the jump's name as a `Host` alias and applies the user and port
 * the jump writes over that alias's block (`relay@gw:2200` is
 * `ssh -l relay -p 2200 gw`). So the jump is linked when its name is a saved
 * host's alias — compared exactly: `ssh` matches `Host` names case-sensitively
 * (OpenSSH_10.6p1: `ssh -G GW` does not read the block of `Host gw`) — and reached with that host's address and sign-in, the jump's user and port
 * winning. They are kept only where they differ from the host's, so a link
 * that agrees with its bastion keeps following it. A host matched only by its
 * address (`sshHost`) is never linked: that literal name may have a `Host`
 * block of its own, which no saved host records. Two saved hosts with the
 * alias are no answer either, rather than a pick by list order.
 *
 * The import and the New Host dialog's pick both decide with this, so a picked
 * entry is tested and stored through the jump an import would give it.
 */
export function jumpLinkFor(
	spec: string,
	candidates: readonly Host[],
	selfId?: string,
): JumpLink | undefined {
	const parsed = parseJumpSpec(spec);
	if (parsed.kind !== "spec") return undefined;
	const { user, host, port, portGiven } = parsed.spec;
	const named = candidates.filter(
		(candidate) =>
			candidate.id !== selfId &&
			candidate.type === "ssh" &&
			!!candidate.sshHost &&
			candidate.sshConfigHost === host,
	);
	const bastion = named.length === 1 ? named[0] : undefined;
	if (bastion === undefined) return undefined;
	return {
		bastion,
		user: user !== null && user !== explicitUserOf(bastion) ? user : null,
		port: portGiven && port !== (bastion.sshPort ?? 22) ? port : null,
	};
}

/** The user a saved host names itself: its user field, else `user@` in its address. */
function explicitUserOf(host: Host): string | undefined {
	if (host.sshUser) return host.sshUser;
	const at = host.sshHost?.indexOf("@") ?? -1;
	return at === -1 ? undefined : host.sshHost?.slice(0, at);
}
