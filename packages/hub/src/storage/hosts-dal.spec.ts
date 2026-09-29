import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import { HostsDAL } from "./hosts-dal.js";

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

	it("breaks a tie on the creation time by id", () => {
		const a = dal.createHost({ type: "local", label: "local" });
		const b = dal.createHost({ type: "local", label: "workstation" });
		setCreatedAt(a.id, "2026-01-01T00:00:00.000Z");
		setCreatedAt(b.id, "2026-01-01T00:00:00.000Z");

		const byId = [a.id, b.id].sort();
		expect(dal.listLocalHosts().map((host) => host.id)).toEqual(byId);
		expect(dal.listHosts().map((host) => host.id)).toEqual(byId);
	});
});
