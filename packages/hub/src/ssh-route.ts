import type { Host, ParsedJumpSpec } from "@lasterm/shared";
import { parseJumpSpec } from "@lasterm/shared";

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

export type { JumpSpecResult, ParsedJumpSpec } from "@lasterm/shared";
export { parseJumpSpec } from "@lasterm/shared";

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
