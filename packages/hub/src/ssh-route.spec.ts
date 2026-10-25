import { describe, expect, it } from "vitest";
import { type RouteHost, targetRoute } from "./ssh-route.js";

const host: RouteHost = { id: "target", type: "ssh", sshHost: "h" };
const route = (fields: Partial<RouteHost> = {}, address = { hostname: "b", port: 22 }) =>
	targetRoute({ ...host, ...fields }, () => address);
describe("target route", () => {
	it("normalizes users and default ports", () => {
		expect(route({ sshHost: "user@h", sshPort: 22 })).toBe(route());
		expect(route({ sshPort: 23 })).not.toBe(route());
		expect(route({ sshProxySpec: "alice@b" })).toBe(route({ sshProxySpec: "bob@b:22" }));
	});
	it("distinguishes jump kind, id, address, and spec", () => {
		expect(route({ sshProxyHostId: "a" })).not.toBe(route({ sshProxySpec: "b" }));
		expect(route({ sshProxyHostId: "a" })).not.toBe(route({ sshProxyHostId: "other" }));
		expect(route({ sshProxySpec: "b" })).not.toBe(route({ sshProxySpec: "c" }));
		expect(route({ sshProxyHostId: "a" })).not.toBe(
			route({ sshProxyHostId: "a" }, { hostname: "c", port: 22 }),
		);
		expect(targetRoute({ ...host, sshProxyHostId: "a" }, () => undefined)).toBe(
			JSON.stringify(["h", 22, ["host", "a", null]]),
		);
	});
	it("encodes names without delimiter collisions", () => {
		expect(route({ sshHost: "::1", sshPort: 22 })).not.toBe(route({ sshHost: "::1:22" }));
		expect(route({ sshHost: "h:23", sshPort: 22 })).not.toBe(route({ sshHost: "h", sshPort: 23 }));
	});
	it("keeps refused declarations distinct and stable", () => {
		expect(route({ sshProxySpec: " a,b " })).toBe(route({ sshProxySpec: "a,b" }));
		expect(route({ sshProxySpec: "a,b" })).not.toBe(route({ sshProxySpec: "a,c" }));
		expect(route({ sshProxySpec: "a,b" })).not.toBe(route({ sshProxySpec: "b" }));
	});
	it("has no route without an SSH address", () => {
		expect(targetRoute({ id: "target", type: "ssh" }, () => undefined)).toBeNull();
		expect(route({ type: "local" })).toBeNull();
	});
});
