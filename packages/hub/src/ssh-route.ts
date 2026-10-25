import type { Host } from "@lasterm/shared";

export function parseSshHost(sshHost: string): { username: string; hostname: string } {
	const atIdx = sshHost.indexOf("@");
	if (atIdx !== -1) {
		return {
			username: sshHost.slice(0, atIdx),
			hostname: sshHost.slice(atIdx + 1),
		};
	}
	return {
		username: process.env.USER ?? process.env.USERNAME ?? "root",
		hostname: sshHost,
	};
}

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

export type RouteHost = Pick<
	Host,
	"id" | "type" | "sshHost" | "sshPort" | "sshProxyHostId" | "sshProxySpec"
>;
export function sshAddress(
	host: RouteHost | undefined,
): { hostname: string; port: number } | undefined {
	if (host?.type !== "ssh" || !host.sshHost) return undefined;
	return { hostname: parseSshHost(host.sshHost).hostname, port: host.sshPort ?? 22 };
}
export function targetRoute(
	host: RouteHost,
	lookup: (id: string) => { hostname: string; port: number } | undefined,
): string | null {
	const address = sshAddress(host);
	if (!address) return null;
	const plan = planJump(host);
	let jump: unknown[];
	switch (plan.kind) {
		case "direct":
			jump = ["direct"];
			break;
		case "host": {
			const bastion = lookup(plan.hostId);
			jump = bastion
				? ["host", plan.hostId, bastion.hostname, bastion.port]
				: ["host", plan.hostId, null];
			break;
		}
		case "spec":
			jump = ["spec", plan.spec.host, plan.spec.port];
			break;
		case "refused":
			jump = ["refused", host.sshProxySpec?.trim() ?? ""];
			break;
	}
	return JSON.stringify([address.hostname, address.port, jump]);
}
