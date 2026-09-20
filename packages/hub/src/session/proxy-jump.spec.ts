import { describe, expect, it } from "vitest";
import { parseJumpSpec, planJump } from "./proxy-jump.js";

describe("parseJumpSpec", () => {
	it("reads the plain form ssh_config uses", () => {
		expect(parseJumpSpec("bastion")).toEqual({
			kind: "spec",
			spec: { user: null, host: "bastion", port: 22 },
		});
		expect(parseJumpSpec("jump@bastion.example.com:2222")).toEqual({
			kind: "spec",
			spec: { user: "jump", host: "bastion.example.com", port: 2222 },
		});
	});

	// The bracketed form is what a copied known_hosts line offers.
	it("reads the bracketed form", () => {
		expect(parseJumpSpec("me@[bastion]:2222")).toEqual({
			kind: "spec",
			spec: { user: "me", host: "bastion", port: 2222 },
		});
		expect(parseJumpSpec("[bastion]")).toEqual({
			kind: "spec",
			spec: { user: null, host: "bastion", port: 22 },
		});
	});

	// An address with several colons and no brackets is a host, not a port.
	it("does not mistake an IPv6 address for a host and a port", () => {
		expect(parseJumpSpec("fe80::1")).toEqual({
			kind: "spec",
			spec: { user: null, host: "fe80::1", port: 22 },
		});
		expect(parseJumpSpec("[fe80::1]:2222")).toEqual({
			kind: "spec",
			spec: { user: null, host: "fe80::1", port: 2222 },
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
		expect(planJump({ sshProxyHostId: "host-1" })).toEqual({ kind: "host", hostId: "host-1" });
	});

	// A jump this hub knows is the one with the authentication and the pinned
	// key; a spec left beside it is a leftover from before it was linked.
	it("prefers the known host to a spec left beside it", () => {
		expect(planJump({ sshProxyHostId: "host-1", sshProxySpec: "bastion" })).toEqual({
			kind: "host",
			hostId: "host-1",
		});
	});

	it("goes through a bastion named as a spec", () => {
		expect(planJump({ sshProxySpec: "jump@bastion:2222" })).toEqual({
			kind: "spec",
			spec: { user: "jump", host: "bastion", port: 2222 },
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
