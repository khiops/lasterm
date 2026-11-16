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

/**
 * The saved host a `ProxyJump` from `~/.ssh/config` is linked to, if any
 * (#1040, #1042).
 *
 * Linked, the jump is reached with that host's address, user, port, sign-in
 * and pinned key; kept as written, through the SSH agent at the spec. So it is
 * linked only when that reaches what `ssh` would: the spec names the host's
 * alias — the saved row stands for that alias's block, whose user and port
 * apply when the spec writes none — and any user or port it writes is the
 * host's. A spec naming an address is never linked: that literal name may have
 * a `Host` block of its own, which no saved host records. Two saved hosts
 * with the alias are no answer either, rather than a pick by list order.
 *
 * The import and the New Host dialog's pick both decide with this, so a picked
 * entry is tested and stored through the jump an import would give it.
 */
export function jumpLinkFor(
	spec: string,
	candidates: readonly Host[],
	selfId?: string,
): Host | undefined {
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
	if (user !== null && user !== explicitUserOf(bastion)) return undefined;
	if (portGiven && port !== (bastion.sshPort ?? 22)) return undefined;
	return bastion;
}

/** The user a saved host names itself: its user field, else `user@` in its address. */
function explicitUserOf(host: Host): string | undefined {
	if (host.sshUser) return host.sshUser;
	const at = host.sshHost?.indexOf("@") ?? -1;
	return at === -1 ? undefined : host.sshHost?.slice(0, at);
}
