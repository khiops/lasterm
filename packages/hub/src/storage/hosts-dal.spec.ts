import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sshAddress, targetRoute } from "../ssh-route.js";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import { HostsDAL } from "./hosts-dal.js";
import type { CreateHostInput } from "./meta-types.js";

describe("HostsDAL — agent SHA256 pinning", () => {
	let dbs: DatabaseManager;
	let dal: HostsDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new HostsDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("stores and retrieves agent SHA256", () => {
		const host = dal.createHost({ type: "ssh", label: "Remote Server" });
		const sha256 = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

		dal.updateHostAgentSha256(host.id, sha256);

		expect(dal.getHostAgentSha256(host.id)).toBe(sha256);
	});

	it("returns null when no SHA256 pinned", () => {
		const host = dal.createHost({ type: "ssh", label: "Fresh Server" });

		expect(dal.getHostAgentSha256(host.id)).toBeNull();
	});

	it("clears SHA256 with null", () => {
		const host = dal.createHost({ type: "ssh", label: "Pinned Server" });
		const sha256 = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

		dal.updateHostAgentSha256(host.id, sha256);
		expect(dal.getHostAgentSha256(host.id)).toBe(sha256);

		dal.updateHostAgentSha256(host.id, null);
		expect(dal.getHostAgentSha256(host.id)).toBeNull();
	});

	it("reflects agentSha256 in getHost result after update", () => {
		const host = dal.createHost({ type: "ssh", label: "Mapped Server" });
		const sha256 = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

		dal.updateHostAgentSha256(host.id, sha256);

		const fetched = dal.getHost(host.id);
		expect(fetched?.agentSha256).toBe(sha256);
	});

	it("agentSha256 is absent on host when not set", () => {
		const host = dal.createHost({ type: "ssh", label: "No Pin Server" });

		const fetched = dal.getHost(host.id);
		expect(fetched?.agentSha256).toBeUndefined();
	});
});

describe("HostsDAL — the local host (#658)", () => {
	let dbs: DatabaseManager;
	let dal: HostsDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new HostsDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	function setCreatedAt(hostId: string, createdAt: string): void {
		dbs.meta.prepare("UPDATE hosts SET created_at = ? WHERE id = ?").run(createdAt, hostId);
	}

	it("finds a renamed local host by its type", () => {
		const local = dal.createHost({ type: "local", label: "local" });
		dal.updateHost(local.id, { label: "workstation" });
		dal.createHost({ type: "ssh", label: "prod", sshHost: "10.0.0.1" });

		expect(dal.listLocalHosts().map((host) => [host.id, host.label])).toEqual([
			[local.id, "workstation"],
		]);
	});

	it("lists several local hosts oldest first, here and in the host list", () => {
		// Inserted newest first, so the insertion order does not decide.
		const newer = dal.createHost({ type: "local", label: "local" });
		const remote = dal.createHost({ type: "ssh", label: "prod", sshHost: "10.0.0.1" });
		const older = dal.createHost({ type: "local", label: "workstation" });
		setCreatedAt(older.id, "2026-01-01T00:00:00.000Z");
		setCreatedAt(newer.id, "2026-02-01T00:00:00.000Z");

		expect(dal.listLocalHosts().map((host) => host.id)).toEqual([older.id, newer.id]);
		expect(dal.listHosts().map((host) => host.id)).toEqual([older.id, newer.id, remote.id]);
		expect(dal.listHosts(1, 0).map((host) => host.id)).toEqual([older.id]);
	});

	// Two ULIDs of the same millisecond are in no particular order.
	it("breaks a tie on the creation time by the order of creation", () => {
		const ids: string[] = [];
		for (const label of ["local", "b", "c", "d", "e", "f", "g", "h"]) {
			const host = dal.createHost({ type: "local", label });
			setCreatedAt(host.id, "2026-01-01T00:00:00.000Z");
			ids.push(host.id);
		}

		expect(dal.listLocalHosts().map((host) => host.id)).toEqual(ids);
		expect(dal.listHosts().map((host) => host.id)).toEqual(ids);
	});
});

describe("HostsDAL — route-bound pins", () => {
	let dbs: DatabaseManager;
	let dal: HostsDAL;
	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new HostsDAL(dbs.meta);
	});
	afterEach(() => dbs.close());
	const route = (id: string) =>
		targetRoute(dal.getHost(id)!, (jumpId) => sshAddress(dal.getHost(jumpId)));
	const create = (label: string, fields: Partial<CreateHostInput> = {}) =>
		dal.createHost({ type: "ssh", sshHost: label, label, ...fields });
	const pin = (id: string) => {
		expect(dal.updateHostFingerprint(id, "target-pin", route(id))).toBe(true);
		expect(dal.updateHostProxyFingerprint(id, "jump-pin", route(id))).toBe(true);
	};
	it("clears target pins on address changes and retains the jump pin", () => {
		const h = create("target", { sshProxySpec: "b" });
		for (const fields of [{ sshHost: "other" }, { sshPort: 2222 }]) {
			pin(h.id);
			dal.updateHost(h.id, fields);
			expect(dal.getHost(h.id)?.sshFingerprint).toBeNull();
			expect(dal.getHost(h.id)?.sshProxyFingerprint).toBe("jump-pin");
		}
	});
	it("clears both pins when the declared jump changes, overriding an explicit pin", () => {
		const b = create("b");
		const h = create("target", { sshProxySpec: "b" });
		for (const fields of [
			{ sshProxySpec: "c" },
			{ sshProxyHostId: b.id },
			{ sshProxyHostId: null, sshProxySpec: null },
			{ sshProxySpec: "b" },
		]) {
			pin(h.id);
			dal.updateHost(h.id, { ...fields, sshProxyFingerprint: "explicit" });
			expect(dal.getHost(h.id)?.sshFingerprint).toBeNull();
			expect(dal.getHost(h.id)?.sshProxyFingerprint).toBeUndefined();
		}
	});
	it("preserves trust across label, user, normalized port and spec user edits", () => {
		const h = create("target", { sshProxySpec: "alice@b" });
		pin(h.id);
		for (const fields of [
			{ label: "new" },
			{ sshUser: "bob" },
			{ sshHost: "bob@target", sshPort: 22 },
			{ sshProxySpec: "bob@b" },
			{ sshProxyFingerprint: "jump-pin" },
		]) {
			dal.updateHost(h.id, fields);
			expect(dal.getHostFingerprint(h.id, route(h.id))).toBe("target-pin");
			expect(dal.getHost(h.id)?.sshProxyFingerprint).toBe("jump-pin");
		}
	});
	it.each([
		{ sshHost: "new" },
		{ sshPort: 2222 },
		{ type: "local" as const },
		{ sshHost: null as unknown as string },
	])("invalidates dependents on bastion endpoint edits: %j", (fields) => {
		const b = create("b");
		const h = create("target", { sshProxyHostId: b.id });
		const other = create("other");
		pin(b.id);
		pin(h.id);
		pin(other.id);
		dal.updateHost(b.id, fields);
		expect(dal.getHost(b.id)?.sshFingerprint).toBeNull();
		expect(dal.getHost(h.id)?.sshFingerprint).toBeNull();
		expect(dal.getHost(h.id)?.sshProxyFingerprint).toBe("jump-pin");
		expect(dal.getHostFingerprint(other.id, route(other.id))).toBe("target-pin");
	});
	it("clears dependent pins with deletion, including a dormant spec", () => {
		const b = create("b");
		for (const sshProxySpec of [null, "other"]) {
			const h = create(sshProxySpec ? "target-with-spec" : "target", {
				sshProxyHostId: b.id,
				sshProxySpec,
			});
			pin(h.id);
		}
		expect(dal.deleteHost(b.id)).toBe(true);
		for (const h of dal.listHosts()) {
			expect(h.sshFingerprint).toBeNull();
			expect(h.sshProxyFingerprint).toBeUndefined();
			expect(h.sshProxyHostId).toBeUndefined();
		}
	});
	it("rejects stale conditional reads and writes and accepts the current route", () => {
		const h = create("target");
		pin(h.id);
		const old = route(h.id);
		dal.updateHost(h.id, { sshHost: "new" });
		expect(dal.getHostFingerprint(h.id, old)).toBeNull();
		expect(dal.updateHostFingerprint(h.id, "stale", old)).toBe(false);
		expect(dal.updateHostProxyFingerprint(h.id, "stale", old)).toBe(false);
		expect(dal.getHost(h.id)?.sshFingerprint).toBeNull();
		expect(dal.getHost(h.id)?.sshProxyFingerprint).toBe("jump-pin");
		pin(h.id);
		expect(dal.getHostFingerprint(h.id, route(h.id))).toBe("target-pin");
		expect(dal.getHost(h.id)?.sshProxyFingerprint).toBe("jump-pin");
	});
	it("has no pins usable for a non-SSH host, or as a direct bastion with a declared jump", () => {
		const h = create("target", { sshProxySpec: "b" });
		pin(h.id);
		expect(
			dal.getHostFingerprint(
				h.id,
				targetRoute({ ...h, sshProxySpec: null }, () => undefined),
			),
		).toBeNull();
		dal.updateHost(h.id, { type: "local" });
		expect(route(h.id)).toBeNull();
		expect(dal.updateHostFingerprint(h.id, "pin", null)).toBe(false);
	});
	it("refuses a dependent pin from a snapshot before its bastion moved", () => {
		const b = create("b");
		const h = create("target", { sshProxyHostId: b.id });
		pin(h.id);
		const old = route(h.id);
		dal.updateHost(b.id, { sshHost: "new-b" });
		expect(dal.getHostFingerprint(h.id, old)).toBeNull();
		expect(dal.updateHostFingerprint(h.id, "stale", old)).toBe(false);
		expect(dal.updateHostProxyFingerprint(h.id, "stale", old)).toBe(false);
		expect(dal.getHost(h.id)?.sshFingerprint).toBeNull();
	});

	it("distinguishes saved bastions at the same address", () => {
		const a = create("b");
		const b = create("other-b", { sshHost: "b" });
		const h = create("target", { sshProxyHostId: a.id });
		pin(h.id);
		const old = route(h.id);
		dal.updateHost(h.id, { sshProxyHostId: b.id });
		expect(route(h.id)).not.toBe(old);
		expect(dal.getHost(h.id)?.sshFingerprint).toBeNull();
	});
});
