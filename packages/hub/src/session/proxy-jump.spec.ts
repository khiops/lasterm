import type { Host } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { sshAddress, targetRoute } from "../ssh-route.js";
import { type JumpHosts, parseJumpSpec, planJump, resolveJump } from "./proxy-jump.js";

describe("parseJumpSpec", () => {
	it("reads the plain form ssh_config uses", () => {
		expect(parseJumpSpec("bastion")).toEqual({
			kind: "spec",
			spec: { user: null, host: "bastion", port: 22, portGiven: false },
		});
		expect(parseJumpSpec("jump@bastion.example.com:2222")).toEqual({
			kind: "spec",
			spec: { user: "jump", host: "bastion.example.com", port: 2222, portGiven: true },
		});
		// Whether a port is written, which a link to a saved bastion compares (#1040).
		expect(parseJumpSpec("gw")).toEqual({
			kind: "spec",
			spec: { user: null, host: "gw", port: 22, portGiven: false },
		});
		expect(parseJumpSpec("gw:2200")).toEqual({
			kind: "spec",
			spec: { user: null, host: "gw", port: 2200, portGiven: true },
		});
	});

	// The bracketed form is what a copied known_hosts line offers.
	it("reads the bracketed form", () => {
		expect(parseJumpSpec("me@[bastion]:2222")).toEqual({
			kind: "spec",
			spec: { user: "me", host: "bastion", port: 2222, portGiven: true },
		});
		expect(parseJumpSpec("[bastion]")).toEqual({
			kind: "spec",
			spec: { user: null, host: "bastion", port: 22, portGiven: false },
		});
	});

	// An address with several colons and no brackets is a host, not a port.
	it("does not mistake an IPv6 address for a host and a port", () => {
		expect(parseJumpSpec("fe80::1")).toEqual({
			kind: "spec",
			spec: { user: null, host: "fe80::1", port: 22, portGiven: false },
		});
		expect(parseJumpSpec("[fe80::1]:2222")).toEqual({
			kind: "spec",
			spec: { user: null, host: "fe80::1", port: 2222, portGiven: true },
		});
	});

	// Two hops is not one hop twice as far: taking only the first would connect
	// somewhere nobody asked for.
	it("reports a chain rather than taking its first hop", () => {
		expect(parseJumpSpec("first,second")).toEqual({ kind: "chain", hops: 2 });
	});

	it("refuses what is not a jump", () => {
		expect(parseJumpSpec("").kind).toBe("invalid");
		expect(parseJumpSpec("   ").kind).toBe("invalid");
		expect(parseJumpSpec("none").kind).toBe("invalid");
		expect(parseJumpSpec("@bastion").kind).toBe("invalid");
		expect(parseJumpSpec("bastion:0").kind).toBe("invalid");
		expect(parseJumpSpec("bastion:99999").kind).toBe("invalid");
		expect(parseJumpSpec("bastion:ssh").kind).toBe("invalid");
	});
});

describe("planJump", () => {
	it("has no jump to make when none is declared", () => {
		expect(planJump({})).toEqual({ kind: "direct" });
		expect(planJump({ sshProxySpec: "  ", sshProxyHostId: null })).toEqual({ kind: "direct" });
	});

	it("goes through a host this hub knows", () => {
		expect(planJump({ sshProxyHostId: "host-1" })).toEqual({
			kind: "host",
			hostId: "host-1",
			user: null,
			port: null,
		});
	});

	// A jump this hub knows is the one with the authentication and the pinned
	// key; a spec left beside it is a leftover from before it was linked.
	it("prefers the known host to a spec left beside it", () => {
		expect(planJump({ sshProxyHostId: "host-1", sshProxySpec: "bastion" })).toEqual({
			kind: "host",
			hostId: "host-1",
			user: null,
			port: null,
		});
	});

	it("goes through a known host as another user and port than its own (#1047)", () => {
		expect(
			planJump({ sshProxyHostId: "host-1", sshProxyUser: "relay", sshProxyPort: 2200 }),
		).toEqual({ kind: "host", hostId: "host-1", user: "relay", port: 2200 });
	});

	it("goes through a bastion named as a spec", () => {
		expect(planJump({ sshProxySpec: "jump@bastion:2222" })).toEqual({
			kind: "spec",
			spec: { user: "jump", host: "bastion", port: 2222, portGiven: true },
		});
	});

	it("says why a declared jump cannot be made", () => {
		const chain = planJump({ sshProxySpec: "a,b" });
		expect(chain.kind).toBe("refused");
		expect(chain.kind === "refused" && chain.message).toContain("2 jumps");

		const broken = planJump({ sshProxySpec: "bastion:0" });
		expect(broken.kind).toBe("refused");
		expect(broken.kind === "refused" && broken.message).toContain("cannot be read");
	});
});

describe("resolveJump", () => {
	function sshHost(id: string, overrides: Partial<Host> = {}): Host {
		return {
			id,
			type: "ssh",
			label: id,
			sshHost: `me@${id}.example.com`,
			// With a method, as POST /api/hosts and the import store an SSH host (#917).
			sshAuth: "agent",
			iconType: "auto",
			trustRemoteHints: "ignore",
			sortOrder: 0,
			os: null,
			arch: null,
			createdAt: "2026-09-28T00:00:00.000Z",
			updatedAt: "2026-09-28T00:00:00.000Z",
			...overrides,
		};
	}

	/** The hosts this hub knows, with the keys pinned for them. */
	function known(hosts: Host[], pins: Record<string, string> = {}): JumpHosts {
		return {
			getHost: (id) => hosts.find((host) => host.id === id),
			getHostFingerprint: (id, expectedRoute) => {
				const host = hosts.find((h) => h.id === id);
				return host &&
					targetRoute(host, (jumpId) => sshAddress(hosts.find((h) => h.id === jumpId))) ===
						expectedRoute
					? (pins[id] ?? null)
					: null;
			},
		};
	}

	it("cannot use a saved jumped host's target pin for direct bastion access", () => {
		const bastion = sshHost("bastion", { sshProxySpec: "other" });
		const resolution = resolveJump(
			sshHost("target", { sshProxyHostId: "bastion" }),
			known([bastion], { bastion: "SHA256:pinned-through-other" }),
			false,
		);
		expect(resolution.kind).toBe("jump");
		if (resolution.kind === "jump") {
			expect(resolution.jump.pinnedFingerprint).toBeNull();
			expect(resolution.jump.knownHostsNames).toEqual(["bastion.example.com"]);
			expect(resolution.jump.jump.host).toBe("bastion.example.com");
			expect(resolution.jump.pinTo).toEqual({
				kind: "host",
				hostId: bastion.id,
				expectedRoute: targetRoute({ ...bastion, sshProxySpec: null }, () => undefined),
			});
		}
	});

	it("has no jump to make when none is declared", () => {
		expect(resolveJump(sshHost("target"), known([]), false)).toEqual({ kind: "direct" });
	});

	// The method it signs in with is the one connecting to it directly uses (#917).
	it.each(["agent", "key", "password"] as const)(
		"goes through a known host with its own address, authentication and pinned key: %s",
		(method) => {
			const bastion = sshHost("bastion", {
				sshPort: 2222,
				sshConfigHost: "alias",
				sshUser: "jumper",
				sshAuth: method,
				sshKeyPath: "/keys/bastion",
			});
			const target = sshHost("target", { sshProxyHostId: "bastion" });

			expect(resolveJump(target, known([bastion], { bastion: "SHA256:pinned" }), true)).toEqual({
				kind: "jump",
				jump: {
					jump: { host: "bastion.example.com", port: 2222, username: "jumper" },
					knownHostsNames: ["bastion.example.com", "alias"],
					// The alias goes with its authentication: its `IdentityAgent none`
					// keeps the agent from signing the bastion's key (#876).
					auth: { method, keyPath: "/keys/bastion", sshConfigHost: "alias" },
					promptHostId: "bastion",
					pinnedFingerprint: "SHA256:pinned",
					trustKnownHosts: true,
					pinTo: {
						kind: "host",
						hostId: "bastion",
						expectedRoute: targetRoute(bastion, () => undefined),
					},
				},
			});
		},
	);

	// `relay@gw:2200` is `ssh -l relay -p 2200 gw`: the saved host's address and
	// sign-in apply, the jump's user and port win (#1047).
	describe("a linked jump with a user and port of its own", () => {
		const gw = sshHost("gw", {
			sshHost: "base@gateway.example",
			sshPort: 2222,
			sshUser: "base",
			sshConfigHost: "gw",
			sshAuth: "key",
			sshKeyPath: "/keys/gw",
		});

		it("signs in as the jump's user, with the saved host's key, address and own pin", () => {
			const target = sshHost("target", { sshProxyHostId: "gw", sshProxyUser: "relay" });
			const resolution = resolveJump(target, known([gw], { gw: "SHA256:gw" }), false);
			expect(resolution.kind).toBe("jump");
			if (resolution.kind !== "jump") return;
			expect(resolution.jump.jump).toEqual({
				host: "gateway.example",
				port: 2222,
				username: "relay",
			});
			expect(resolution.jump.auth).toEqual({
				method: "key",
				keyPath: "/keys/gw",
				sshConfigHost: "gw",
			});
			// Same server: the saved host's own pin still speaks, and revocation under
			// its alias keeps applying.
			expect(resolution.jump.pinnedFingerprint).toBe("SHA256:gw");
			expect(resolution.jump.pinTo.kind).toBe("host");
			expect(resolution.jump.knownHostsNames).toEqual(["gateway.example", "gw"]);
		});

		it("dials the jump's port, and pins its key on the jumped host: another port is another server", () => {
			const target = sshHost("target", {
				sshProxyHostId: "gw",
				sshProxyPort: 2200,
				sshProxyFingerprint: "SHA256:target-side",
			});
			const resolution = resolveJump(target, known([gw], { gw: "SHA256:gw-own" }), false);
			expect(resolution.kind).toBe("jump");
			if (resolution.kind !== "jump") return;
			expect(resolution.jump.jump).toEqual({
				host: "gateway.example",
				port: 2200,
				username: "base",
			});
			expect(resolution.jump.pinnedFingerprint).toBe("SHA256:target-side");
			expect(resolution.jump.pinTo).toEqual({ kind: "spec", hostId: "target" });
		});

		it("keeps the saved host's pin for a port that is its own", () => {
			const target = sshHost("target", { sshProxyHostId: "gw", sshProxyPort: 2222 });
			const resolution = resolveJump(target, known([gw], { gw: "SHA256:gw-own" }), false);
			expect(resolution.kind === "jump" && resolution.jump.pinnedFingerprint).toBe("SHA256:gw-own");
		});

		it("tells the jump's port apart in the route a pin is tied to", () => {
			const lookup = (id: string) => sshAddress(id === "gw" ? gw : undefined);
			const via = (port?: number) =>
				targetRoute(
					sshHost("target", { sshProxyHostId: "gw", ...(port && { sshProxyPort: port }) }),
					lookup,
				);
			expect(via(2200)).not.toBe(via());
			expect(via(2222)).toBe(via());
		});
	});

	it("goes through a bastion named as a spec, with the agent, as the host's user by default", () => {
		const target = sshHost("target", {
			sshProxySpec: "bastion.example.com:2200",
			sshProxyFingerprint: "SHA256:spec-pin",
		});

		expect(resolveJump(target, known([]), false)).toEqual({
			kind: "jump",
			jump: {
				jump: { host: "bastion.example.com", port: 2200, username: "me" },
				knownHostsNames: ["bastion.example.com"],
				// Its own name, for its `IdentityAgent none` in ~/.ssh/config (#1038).
				auth: { method: "agent", sshConfigHost: "bastion.example.com" },
				promptHostId: "target",
				pinnedFingerprint: "SHA256:spec-pin",
				trustKnownHosts: false,
				pinTo: { kind: "spec", hostId: "target" },
			},
		});
	});

	it("refuses a jump through a host with no sign-in method", () => {
		const bastion = sshHost("bastion");
		Reflect.deleteProperty(bastion, "sshAuth");
		expect(
			resolveJump(sshHost("target", { sshProxyHostId: "bastion" }), known([bastion]), false),
		).toEqual({
			kind: "refused",
			message:
				"The host this one is reached through has no sign-in method. Edit it and choose one.",
		});
	});

	it("refuses a jump through a host that is gone, or is no SSH host", () => {
		const target = sshHost("target", { sshProxyHostId: "bastion" });
		const local = { ...sshHost("bastion"), type: "local" as const };

		for (const hosts of [known([]), known([local])]) {
			const route = resolveJump(target, hosts, false);
			expect(route.kind).toBe("refused");
			expect(route.kind === "refused" && route.message).toContain("no longer an SSH host");
		}
	});

	it("refuses a declared jump that cannot be made, saying why", () => {
		const route = resolveJump(sshHost("target", { sshProxySpec: "a,b" }), known([]), false);
		expect(route.kind === "refused" && route.message).toContain("2 jumps");
	});
});
