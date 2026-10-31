import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sshAddress, targetRoute } from "../ssh-route.js";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import { HostsDAL } from "./hosts-dal.js";
import { LaunchProfilesDAL } from "./launch-profiles-dal.js";
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
		const before = dal.getHost(h.id)?.updatedAt;
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.now() + 1000));
		try {
			dal.updateHost(b.id, fields);
		} finally {
			vi.useRealTimers();
		}
		expect(dal.getHost(h.id)?.updatedAt).not.toBe(before);
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
		const timestamps = new Map(dal.listHosts().map((host) => [host.id, host.updatedAt]));
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.now() + 1000));
		try {
			expect(dal.deleteHost(b.id)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
		for (const h of dal.listHosts()) {
			expect(h.updatedAt).not.toBe(timestamps.get(h.id));
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

describe("HostsDAL — duplicateHost (#746)", () => {
	let dbs: DatabaseManager;
	let dal: HostsDAL;
	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new HostsDAL(dbs.meta);
	});
	afterEach(() => dbs.close());
	const create = (label: string, fields: Partial<CreateHostInput> = {}) =>
		dal.createHost({ type: "ssh", sshHost: label, label, ...fields });
	// A group's hosts as the rail shows them: in the hub's order, by sort_order.
	const order = (groupId: string | null) =>
		dal
			.listHosts()
			.filter((host) => host.type !== "local" && (host.hostGroupId ?? null) === groupId)
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((host) => [host.label, host.sortOrder]);

	it("puts the copy in the original's group, right after hosts that never moved", () => {
		const group = dal.createHostGroup("prod");
		const other = dal.createHostGroup("staging");
		create("a", { hostGroupId: group.id });
		const b = create("b", { hostGroupId: group.id });
		create("c", { hostGroupId: group.id });
		create("elsewhere", { hostGroupId: other.id });
		create("loose");

		const copy = dal.duplicateHost(b.id);

		expect(copy?.hostGroupId).toBe(group.id);
		expect(order(group.id)).toEqual([
			["a", 0],
			["b", 1],
			["b-copy", 2],
			["c", 3],
		]);
		expect(order(other.id)).toEqual([["elsewhere", 0]]);
		expect(order(null)).toEqual([["loose", 0]]);
	});

	it("keeps the order PUT /api/hosts/order wrote", () => {
		const group = dal.createHostGroup("prod");
		const a = create("a", { hostGroupId: group.id });
		const b = create("b", { hostGroupId: group.id });
		const c = create("c", { hostGroupId: group.id });
		dal.reorderHosts(group.id, [c.id, a.id, b.id]);

		dal.duplicateHost(a.id);
		dal.duplicateHost(b.id);

		expect(order(group.id)).toEqual([
			["c", 0],
			["a", 1],
			["a-copy", 2],
			["b", 3],
			["b-copy", 4],
		]);
	});

	it("leaves an ungrouped copy ungrouped, right after the original", () => {
		const local = dal.createHost({ type: "local", label: "local" });
		const x = create("x");
		create("y");

		const copy = dal.duplicateHost(x.id);

		expect(copy?.hostGroupId).toBeUndefined();
		expect(order(null)).toEqual([
			["x", 0],
			["x-copy", 1],
			["y", 2],
		]);
		expect(dal.getHost(local.id)).toEqual(local);
	});

	it("copies the jump, elevation and OS the user set", () => {
		const bastion = create("bastion");
		const viaHost = create("via-host", {
			sshProxyHostId: bastion.id,
			elevationMethod: "custom",
			customCommand: "run0 --",
			os: "linux",
			arch: "arm64",
		});
		const viaSpec = create("via-spec", { sshProxySpec: "alice@jump:2222", os: "windows" });

		const hostCopy = dal.duplicateHost(viaHost.id);
		const specCopy = dal.duplicateHost(viaSpec.id);

		expect(hostCopy).toMatchObject({
			sshProxyHostId: bastion.id,
			elevationMethod: "custom",
			customCommand: "run0 --",
			os: "linux",
			arch: "arm64",
		});
		expect(hostCopy?.sshProxySpec).toBeUndefined();
		expect(specCopy).toMatchObject({ sshProxySpec: "alice@jump:2222", os: "windows", arch: null });
		expect(specCopy?.sshProxyHostId).toBeUndefined();
	});

	// The Default Shell is the host's default profile (#802): a copy keeps the
	// one its user chose, as it kept the Default Shell, and not the hub's mark,
	// which its own agent gives it at its first connection.
	it("copies the default profile the user chose, not the one the hub marked", () => {
		const profiles = new LaunchProfilesDAL(dbs.meta);
		const profile = (name: string) =>
			profiles.createLaunchProfile({
				name,
				shell: `/usr/bin/${name}`,
				mode: "shell",
				elevated: false,
				supportedOs: "linux",
				iconType: "auto",
				sortOrder: 0,
			}).id;
		const fish = profile("fish");
		const bash = profile("bash");
		const chosen = create("chosen");
		const seeded = create("seeded");
		profiles.upsertHostProfileOverride(chosen.id, fish, "default");
		profiles.upsertHostProfileOverride(seeded.id, bash, "default", undefined, false);

		const chosenCopy = dal.duplicateHost(chosen.id);
		const seededCopy = dal.duplicateHost(seeded.id);

		expect(profiles.getHostDefaultOverride(chosenCopy?.id ?? "")).toMatchObject({
			profileId: fish,
			setByUser: true,
		});
		expect(profiles.getHostDefaultOverride(seededCopy?.id ?? "")).toBeUndefined();
	});

	it("copies none of the keys and binaries the original trusts", () => {
		const original = create("pinned", { sshProxySpec: "jump" });
		const route = targetRoute(dal.getHost(original.id)!, (id) => sshAddress(dal.getHost(id)));
		expect(dal.updateHostFingerprint(original.id, "target-pin", route)).toBe(true);
		expect(dal.updateHostProxyFingerprint(original.id, "jump-pin", route)).toBe(true);
		dal.updateHostAgentSha256(original.id, "a".repeat(64));

		const copy = dal.duplicateHost(original.id);

		expect(copy?.sshProxySpec).toBe("jump");
		expect(copy?.sshFingerprint).toBeNull();
		expect(copy?.sshProxyFingerprint).toBeUndefined();
		expect(copy?.agentSha256).toBeUndefined();
	});
});

// ─── What the hub records of a host on its own, said (#789) ─────────────────
//
// The hub writes a host's OS, its shells, its pinned keys and agent hash as it
// learns them, and creates the local host again when it is gone. A window
// showing the hosts heard none of it: only the routes' writes were said.

describe("HostsDAL — what the hub records of a host, said once it changed (#789)", () => {
	let dbs: DatabaseManager;
	let dal: HostsDAL;
	let said: number;
	let id: string;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new HostsDAL(dbs.meta);
		dal.onHostChanged(() => {
			said++;
		});
		id = dal.createHost({ type: "ssh", label: "pi", sshHost: "pi.local", sshProxySpec: "jump" }).id;
		said = 0;
	});

	afterEach(() => dbs.close());

	const route = (hostId: string) =>
		targetRoute(dal.getHost(hostId)!, (jumpId) => sshAddress(dal.getHost(jumpId)));

	const recordings: Record<string, () => unknown> = {
		"its OS detected": () => dal.updateHostOsArch(id, "linux", "arm64"),
		"its agent's hash pinned": () => dal.updateHostAgentSha256(id, "a".repeat(64)),
		"its host key pinned": () => dal.updateHostFingerprint(id, "SHA256:target", route(id)),
		"its jump's key pinned": () => dal.updateHostProxyFingerprint(id, "SHA256:jump", route(id)),
		"its shells discovered": () =>
			dal.updateHostDiscoveredShells(id, ["/bin/bash", "/bin/zsh"], "/bin/zsh"),
		"a setting the hub stores on it": () => dal.updateHost(id, { sshRemoteDaemon: false }),
	};

	it.each(Object.entries(recordings))(
		"says %s once, and nothing when it finds the same again",
		(_name, record) => {
			record();
			expect(said).toBe(1);

			record();
			expect(said).toBe(1);
		},
	);

	it("says an OS found again different", () => {
		dal.updateHostOsArch(id, "linux", "arm64");
		dal.updateHostOsArch(id, "linux", "x64");

		expect(said).toBe(2);
		expect(dal.getHost(id)).toMatchObject({ os: "linux", arch: "x64" });
	});

	it("says shells found again different, or another default shell", () => {
		dal.updateHostDiscoveredShells(id, ["/bin/bash"], "/bin/bash");
		dal.updateHostDiscoveredShells(id, ["/bin/bash", "/usr/bin/fish"], "/bin/bash");
		dal.updateHostDiscoveredShells(id, ["/bin/bash", "/usr/bin/fish"], "/usr/bin/fish");
		dal.updateHostDiscoveredShells(id, ["/bin/bash", "/usr/bin/fish"]);

		expect(said).toBe(3);
		expect(dal.getHost(id)).toMatchObject({
			discoveredShells: ["/bin/bash", "/usr/bin/fish"],
			discoveredDefaultShell: "/usr/bin/fish",
		});
	});

	// The agent's default is its own column (#794): a host is not told it
	// changed at every connection.
	it("says nothing when the agent reports again the default it reported", () => {
		dal.updateHostDiscoveredShells(id, ["/bin/bash", "/usr/bin/fish"], "/bin/bash");
		said = 0;

		dal.updateHostDiscoveredShells(id, ["/bin/bash", "/usr/bin/fish"], "/bin/bash");

		expect(said).toBe(0);
		expect(dal.getHost(id)?.discoveredDefaultShell).toBe("/bin/bash");
	});

	it("still answers that a key found again is this host's", () => {
		expect(dal.updateHostFingerprint(id, "SHA256:target", route(id))).toBe(true);
		expect(dal.updateHostFingerprint(id, "SHA256:target", route(id))).toBe(true);
		expect(dal.updateHostProxyFingerprint(id, "SHA256:jump", route(id))).toBe(true);
		expect(dal.updateHostProxyFingerprint(id, "SHA256:jump", route(id))).toBe(true);

		expect(said).toBe(2);
	});

	it("says nothing of a key it did not pin, the host having moved meanwhile", () => {
		const before = route(id);
		dal.updateHost(id, { sshHost: "elsewhere.local" });
		said = 0;

		expect(dal.updateHostFingerprint(id, "SHA256:stale", before)).toBe(false);
		expect(said).toBe(0);
	});

	it("says the local host created again", () => {
		dal.createHost({ type: "local", label: "local" });

		expect(said).toBe(1);
	});
});
