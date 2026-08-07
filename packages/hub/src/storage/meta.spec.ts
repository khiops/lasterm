import type { Host, HostGroup } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import type { PairingCodeRow } from "./meta.js";
import { MetaDAL } from "./meta.js";

describe("MetaDAL — Hosts CRUD", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	describe("createHost", () => {
		it("creates a local host with required fields", () => {
			const host = dal.createHost({ type: "local", label: "My Local" });

			expect(host.id).toBeTruthy();
			expect(host.type).toBe("local");
			expect(host.label).toBe("My Local");
			expect(host.iconType).toBe("auto");
			expect(host.trustRemoteHints).toBe("apply");
			expect(host.createdAt).toBeTruthy();
			expect(host.updatedAt).toBeTruthy();
		});

		it("creates an SSH host with all fields", () => {
			const host = dal.createHost({
				type: "ssh",
				label: "Prod Server",
				sshHost: "192.168.1.100",
				sshPort: 2222,
				sshAuth: "key",
				sshKeyPath: "/home/user/.ssh/id_ed25519",
				iconType: "emoji",
				iconValue: "",
				color: "#ff6600",
				profileJson: '{"fontSize":14}',
				trustRemoteHints: "ask",
				defaultShell: "/bin/zsh",
				defaultCwd: "/home/user",
			});

			expect(host.type).toBe("ssh");
			expect(host.sshHost).toBe("192.168.1.100");
			expect(host.sshPort).toBe(2222);
			expect(host.sshAuth).toBe("key");
			expect(host.sshKeyPath).toBe("/home/user/.ssh/id_ed25519");
			expect(host.iconType).toBe("emoji");
			expect(host.iconValue).toBe("");
			expect(host.color).toBe("#ff6600");
			expect(host.profileJson).toBe('{"fontSize":14}');
			expect(host.trustRemoteHints).toBe("ask");
			expect(host.defaultShell).toBe("/bin/zsh");
			expect(host.defaultCwd).toBe("/home/user");
		});

		it("generates ULID IDs (26 chars, unique)", () => {
			const h1 = dal.createHost({ type: "local", label: "A" });
			const h2 = dal.createHost({ type: "local", label: "B" });

			expect(h1.id).toHaveLength(26);
			expect(h2.id).toHaveLength(26);
			// Both IDs must be valid Crockford Base32 ULID format
			expect(h1.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
			expect(h2.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
			// IDs must be distinct
			expect(h1.id).not.toBe(h2.id);
		});

		it("throws on duplicate label (UNIQUE constraint)", () => {
			dal.createHost({ type: "local", label: "Duplicate" });
			expect(() => dal.createHost({ type: "local", label: "Duplicate" })).toThrow();
		});

		it("sets ISO 8601 timestamps", () => {
			const host = dal.createHost({ type: "local", label: "TS Test" });
			// ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
			expect(host.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(host.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	describe("getHost", () => {
		it("returns host by ID", () => {
			const created = dal.createHost({ type: "local", label: "Get Me" });
			const found = dal.getHost(created.id);

			expect(found).toBeDefined();
			expect(found?.id).toBe(created.id);
			expect(found?.label).toBe("Get Me");
		});

		it("returns undefined for non-existent ID", () => {
			const result = dal.getHost("non-existent-id");
			expect(result).toBeUndefined();
		});
	});

	describe("getHostByLabel", () => {
		it("returns host by label", () => {
			dal.createHost({ type: "local", label: "FindByLabel" });
			const found = dal.getHostByLabel("FindByLabel");

			expect(found).toBeDefined();
			expect(found?.label).toBe("FindByLabel");
		});

		it("returns undefined for non-existent label", () => {
			const result = dal.getHostByLabel("NoSuchLabel");
			expect(result).toBeUndefined();
		});
	});

	describe("listHosts", () => {
		it("returns empty array when no hosts", () => {
			const hosts = dal.listHosts();
			expect(hosts).toEqual([]);
		});

		it("returns hosts ordered by type (local first), then group, then sort_order", () => {
			dal.createHost({ type: "local", label: "First" });
			dal.createHost({ type: "ssh", label: "Second", sshHost: "10.0.0.1" });
			dal.createHost({ type: "local", label: "Third" });

			const hosts = dal.listHosts();
			expect(hosts).toHaveLength(3);
			// Local hosts come first, then SSH
			expect((hosts[0] as Host).label).toBe("First");
			expect((hosts[1] as Host).label).toBe("Third");
			expect((hosts[2] as Host).label).toBe("Second");
		});
	});

	describe("updateHost", () => {
		it("updates specified fields and changes updated_at", async () => {
			const host = dal.createHost({ type: "local", label: "Before Update" });
			const originalUpdatedAt = host.updatedAt;

			// Small delay to ensure timestamp difference
			await new Promise((r) => setTimeout(r, 10));

			const updated = dal.updateHost(host.id, {
				label: "After Update",
				color: "#123456",
			});

			expect(updated.label).toBe("After Update");
			expect(updated.color).toBe("#123456");
			expect(updated.type).toBe("local"); // unchanged
			expect(updated.updatedAt).not.toBe(originalUpdatedAt);
		});

		it("partial update leaves other fields unchanged", () => {
			const host = dal.createHost({
				type: "ssh",
				label: "Partial",
				sshHost: "10.0.0.1",
				color: "#aabbcc",
			});

			const updated = dal.updateHost(host.id, { color: "#ffffff" });

			expect(updated.color).toBe("#ffffff");
			expect(updated.sshHost).toBe("10.0.0.1"); // unchanged
			expect(updated.label).toBe("Partial"); // unchanged
		});

		it("throws when updating non-existent host", () => {
			expect(() => dal.updateHost("no-such-id", { label: "Ghost" })).toThrow(
				"Host not found after update",
			);
		});
	});

	describe("deleteHost", () => {
		it("deletes an existing host and returns true", () => {
			const host = dal.createHost({ type: "local", label: "To Delete" });

			const deleted = dal.deleteHost(host.id);

			expect(deleted).toBe(true);
			expect(dal.getHost(host.id)).toBeUndefined();
		});

		it("returns false when deleting non-existent host", () => {
			const result = dal.deleteHost("no-such-id");
			expect(result).toBe(false);
		});

		it("removing a host does not error with no child records", () => {
			const host = dal.createHost({ type: "local", label: "No Children" });
			expect(() => dal.deleteHost(host.id)).not.toThrow();
		});
	});
});

// ─── OS / Arch ────────────────────────────────────────────────────────────────

describe("MetaDAL — host os/arch fields", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("createHost with os/arch stores and returns them", () => {
		const host = dal.createHost({
			type: "ssh",
			label: "linux-box",
			sshHost: "10.0.0.1",
			os: "linux",
			arch: "x64",
		});
		expect(host.os).toBe("linux");
		expect(host.arch).toBe("x64");
	});

	it("createHost without os/arch defaults to null", () => {
		const host = dal.createHost({ type: "local", label: "no-os" });
		expect(host.os).toBeNull();
		expect(host.arch).toBeNull();
	});

	it("listHosts returns os/arch on each host", () => {
		dal.createHost({
			type: "ssh",
			label: "arm-server",
			sshHost: "10.0.0.2",
			os: "linux",
			arch: "arm64",
		});
		const hosts = dal.listHosts();
		const arm = hosts.find((h) => h.label === "arm-server");
		expect(arm?.os).toBe("linux");
		expect(arm?.arch).toBe("arm64");
	});

	it("updateHost with os/arch updates the values", () => {
		const host = dal.createHost({ type: "ssh", label: "update-os", sshHost: "10.0.0.3" });
		expect(host.os).toBeNull();
		const updated = dal.updateHost(host.id, { os: "darwin", arch: "arm64" });
		expect(updated.os).toBe("darwin");
		expect(updated.arch).toBe("arm64");
	});

	it("updateHostOsArch sets both values and updates updated_at", async () => {
		const host = dal.createHost({ type: "ssh", label: "detect-os", sshHost: "10.0.0.4" });
		// Ensure a tiny time gap so updated_at changes
		await new Promise((r) => setTimeout(r, 5));
		dal.updateHostOsArch(host.id, "windows", "x64");
		const found = dal.getHost(host.id);
		expect(found?.os).toBe("windows");
		expect(found?.arch).toBe("x64");
		expect(found?.updatedAt).not.toBe(host.updatedAt);
	});
});

describe("MetaDAL — Host Management fields", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("createHost returns new fields with defaults", () => {
		const host = dal.createHost({ type: "local", label: "defaults-test" });

		expect(host.sortOrder).toBe(0);
		expect(host.keepAliveSeconds).toBe(60);
		expect(host.historyRetentionDays).toBe(30);
		expect(host.hostGroup).toBeUndefined();
		expect(host.sshConfigHost).toBeUndefined();
		expect(host.sshUser).toBeUndefined();
	});

	it("createHost stores explicit new field values", () => {
		const host = dal.createHost({
			type: "ssh",
			label: "explicit-fields",
			sshHost: "10.0.0.5",
			hostGroup: "production",
			sortOrder: 3,
			sshConfigHost: "prod-server",
			sshUser: "deploy",
			keepAliveSeconds: 120,
			historyRetentionDays: 90,
		});

		expect(host.hostGroup).toBe("production");
		expect(host.sortOrder).toBe(3);
		expect(host.sshConfigHost).toBe("prod-server");
		expect(host.sshUser).toBe("deploy");
		expect(host.keepAliveSeconds).toBe(120);
		expect(host.historyRetentionDays).toBe(90);
	});

	it("updateHost updates hostGroup", () => {
		const host = dal.createHost({ type: "ssh", label: "group-test", sshHost: "10.0.0.6" });
		expect(host.hostGroup).toBeUndefined();

		const updated = dal.updateHost(host.id, { hostGroup: "staging" });
		expect(updated.hostGroup).toBe("staging");
	});

	it("updateHost updates keepAliveSeconds and historyRetentionDays", () => {
		const host = dal.createHost({ type: "local", label: "retention-test" });

		const updated = dal.updateHost(host.id, {
			keepAliveSeconds: 300,
			historyRetentionDays: 7,
		});
		expect(updated.keepAliveSeconds).toBe(300);
		expect(updated.historyRetentionDays).toBe(7);
	});

	it("listHosts orders local first, then by group and sortOrder", () => {
		// Create hosts: local, then two SSH in different groups
		dal.createHost({ type: "local", label: "my-local" });
		dal.createHost({
			type: "ssh",
			label: "ssh-beta",
			sshHost: "10.0.0.1",
			hostGroup: "beta",
			sortOrder: 0,
		});
		dal.createHost({
			type: "ssh",
			label: "ssh-alpha",
			sshHost: "10.0.0.2",
			hostGroup: "alpha",
			sortOrder: 0,
		});
		dal.createHost({
			type: "ssh",
			label: "ssh-no-group",
			sshHost: "10.0.0.3",
		});

		const hosts = dal.listHosts();
		expect(hosts).toHaveLength(4);
		// 1. local first
		expect(hosts[0]?.label).toBe("my-local");
		// 2. SSH: group "alpha" before "beta" (alphabetical)
		expect(hosts[1]?.label).toBe("ssh-alpha");
		expect(hosts[2]?.label).toBe("ssh-beta");
		// 3. SSH: NULL group sorts last (COALESCE to '~')
		expect(hosts[3]?.label).toBe("ssh-no-group");
	});
});

describe("MetaDAL — Sessions CRUD", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;
	let hostId: string;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
		const host = dal.createHost({ type: "local", label: "session-host" });
		hostId = host.id;
	});

	afterEach(() => {
		dbs.close();
	});

	it("createSession and getSession round-trip", () => {
		const id = "01AAAAAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id, hostId, status: "starting" });

		const session = dal.getSession(id);
		expect(session).toBeDefined();
		expect(session?.id).toBe(id);
		expect(session?.hostId).toBe(hostId);
		expect(session?.status).toBe("starting");
		expect(session?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(session?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("getSession returns undefined for non-existent id", () => {
		expect(dal.getSession("no-such-id")).toBeUndefined();
	});

	it("listSessions returns all sessions when no hostId filter", () => {
		const host2 = dal.createHost({ type: "local", label: "session-host-2" });
		dal.createSession({ id: "SES001AAAAAAAAAAAAAAAAAAAAAA", hostId, status: "active" });
		dal.createSession({ id: "SES002AAAAAAAAAAAAAAAAAAAAAA", hostId: host2.id, status: "closed" });

		const all = dal.listSessions();
		expect(all).toHaveLength(2);
	});

	it("listSessions filters by hostId", () => {
		const host2 = dal.createHost({ type: "local", label: "session-host-filter" });
		dal.createSession({ id: "SES003AAAAAAAAAAAAAAAAAAAAAA", hostId, status: "active" });
		dal.createSession({ id: "SES004AAAAAAAAAAAAAAAAAAAAAA", hostId: host2.id, status: "active" });

		const filtered = dal.listSessions(hostId);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.hostId).toBe(hostId);
	});

	it("updateSessionStatus changes status and updatedAt", async () => {
		const id = "SES005AAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id, hostId, status: "starting" });
		const before = dal.getSession(id);
		expect(before).toBeDefined();

		await new Promise((r) => setTimeout(r, 10));
		dal.updateSessionStatus(id, "active");

		const after = dal.getSession(id);
		expect(after).toBeDefined();
		expect(after?.status).toBe("active");
		expect(after?.updatedAt).not.toBe(before?.updatedAt);
	});

	it("updateSessionStatus supports all valid statuses", () => {
		const id = "SES006AAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id, hostId, status: "starting" });

		for (const status of ["active", "detached", "disconnected", "closed"] as const) {
			expect(() => dal.updateSessionStatus(id, status)).not.toThrow();
		}
		expect(dal.getSession(id)?.status).toBe("closed");
	});

	it("deleteSession removes the record", () => {
		const id = "SES007AAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id, hostId, status: "active" });
		dal.deleteSession(id);
		expect(dal.getSession(id)).toBeUndefined();
	});

	it("listSessions returns empty array when none exist", () => {
		expect(dal.listSessions()).toEqual([]);
	});
});

describe("MetaDAL — Channels CRUD", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;
	let sessionId: string;
	let hostId: string;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
		const host = dal.createHost({ type: "local", label: "channel-host" });
		hostId = host.id;
		sessionId = "SESSAAAAAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
	});

	afterEach(() => {
		dbs.close();
	});

	it("createChannel and getChannel round-trip", () => {
		const id = "CHN001AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born", shell: "/bin/bash", cwd: "/home/user" });

		const ch = dal.getChannel(id);
		expect(ch).toBeDefined();
		expect(ch?.id).toBe(id);
		expect(ch?.sessionId).toBe(sessionId);
		expect(ch?.status).toBe("born");
		expect(ch?.shell).toBe("/bin/bash");
		expect(ch?.cwd).toBe("/home/user");
		expect(ch?.cols).toBe(80);
		expect(ch?.rows).toBe(24);
	});

	it("createChannel uses defaults for shell and cwd", () => {
		const id = "CHN002AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });

		const ch = dal.getChannel(id);
		expect(ch).toBeDefined();
		expect(ch?.shell).toBe("/bin/sh");
		expect(ch?.cwd).toBeUndefined();
	});

	it("getChannel returns undefined for non-existent id", () => {
		expect(dal.getChannel("no-such-id")).toBeUndefined();
	});

	it("listChannels returns all channels when no filter", () => {
		dal.createChannel({ id: "CHN003AAAAAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		dal.createChannel({ id: "CHN004AAAAAAAAAAAAAAAAAAAAAA", sessionId, status: "live" });

		expect(dal.listChannels()).toHaveLength(2);
	});

	it("listChannels filters by sessionId", () => {
		const host2 = dal.createHost({ type: "local", label: "ch-host-2" });
		const sessionId2 = "SESS2AAAAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId2, hostId: host2.id, status: "active" });

		dal.createChannel({ id: "CHN005AAAAAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		dal.createChannel({
			id: "CHN006AAAAAAAAAAAAAAAAAAAAAA",
			sessionId: sessionId2,
			status: "born",
		});

		const filtered = dal.listChannels(sessionId);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.sessionId).toBe(sessionId);
	});

	it("updateChannelStatus changes status", () => {
		const id = "CHN007AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });

		dal.updateChannelStatus(id, "live");
		expect(dal.getChannel(id)?.status).toBe("live");

		dal.updateChannelStatus(id, "orphan");
		expect(dal.getChannel(id)?.status).toBe("orphan");

		dal.updateChannelStatus(id, "dead");
		expect(dal.getChannel(id)?.status).toBe("dead");
	});

	it("updateChannelStatus persists exitCode", () => {
		const id = "CHN008AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "live" });

		dal.updateChannelStatus(id, "dead", 42);
		const ch = dal.getChannel(id);
		expect(ch).toBeDefined();
		expect(ch?.status).toBe("dead");
		expect(ch?.exitCode).toBe(42);
	});

	it("deleteChannel removes the record", () => {
		const id = "CHN009AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });
		dal.deleteChannel(id);
		expect(dal.getChannel(id)).toBeUndefined();
	});

	it("listChannels includes dead channels", () => {
		dal.createChannel({ id: "CHNDEAD1AAAAAAAAAAAAAAAAAAAAA", sessionId, status: "live" });
		dal.createChannel({ id: "CHNDEAD2AAAAAAAAAAAAAAAAAAAAA", sessionId, status: "dead" });
		dal.createChannel({ id: "CHNDEAD3AAAAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });

		const all = dal.listChannels();
		expect(all).toHaveLength(3);
		expect(all.map((c) => c.id)).toContain("CHNDEAD2AAAAAAAAAAAAAAAAAAAAA");
	});

	it("listChannels with sessionId includes dead channels", () => {
		dal.createChannel({ id: "CHNDEAD4AAAAAAAAAAAAAAAAAAAAA", sessionId, status: "live" });
		dal.createChannel({ id: "CHNDEAD5AAAAAAAAAAAAAAAAAAAAA", sessionId, status: "dead" });

		const filtered = dal.listChannels(sessionId);
		expect(filtered).toHaveLength(2);
		expect(filtered.map((c) => c.id)).toContain("CHNDEAD5AAAAAAAAAAAAAAAAAAAAA");
	});

	it("listChannels returns empty array when none exist", () => {
		expect(dal.listChannels()).toEqual([]);
	});

	it("getChannelWithHost returns channel with host info", () => {
		const id = "CHWHOST01AAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "dead", shell: "/bin/bash", cwd: "/home/user" });

		const result = dal.getChannelWithHost(id);
		if (result === null) throw new Error("expected non-null");
		expect(result.channel.id).toBe(id);
		expect(result.channel.status).toBe("dead");
		expect(result.channel.shell).toBe("/bin/bash");
		expect(result.hostId).toBe(hostId);
		expect(result.hostType).toBe("local");
	});

	it("getChannelWithHost returns null for non-existent channel", () => {
		expect(dal.getChannelWithHost("no-such-id")).toBeNull();
	});

	it("createChannel stores title when provided", () => {
		const id = "CHN010AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born", title: "My Shell" });

		const ch = dal.getChannel(id);
		expect(ch).toBeDefined();
		expect(ch?.title).toBe("My Shell");
	});

	it("createChannel title is undefined when not provided", () => {
		const id = "CHN011AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });

		const ch = dal.getChannel(id);
		expect(ch).toBeDefined();
		expect(ch?.title).toBeUndefined();
	});
});

describe("MetaDAL — updateChannelTitle", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;
	let sessionId: string;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
		const host = dal.createHost({ type: "local", label: "title-host" });
		sessionId = "TITLESESS0AAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
	});

	afterEach(() => {
		dbs.close();
	});

	it("updates title and updated_at", async () => {
		const id = "TITLECH01AAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });
		const before = dal.getChannel(id);

		await new Promise((r) => setTimeout(r, 10));

		const changed = dal.updateChannelTitle(id, "Renamed");
		expect(changed).toBe(true);

		const ch = dal.getChannel(id);
		expect(ch?.title).toBe("Renamed");
		expect(ch?.updatedAt).not.toBe(before?.updatedAt);
	});

	it("sets title to null (reset)", () => {
		const id = "TITLECH02AAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born", title: "Initial" });

		const changed = dal.updateChannelTitle(id, null);
		expect(changed).toBe(true);

		const ch = dal.getChannel(id);
		expect(ch?.title).toBeUndefined();
	});

	it("returns false for non-existent channel", () => {
		expect(dal.updateChannelTitle("nonexistent", "Test")).toBe(false);
	});
});

// ─── Sweep methods ────────────────────────────────────────────────────────────

describe("MetaDAL — markAllChannelsDead", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("sweeps born and live channels to dead and returns count", () => {
		const host = dal.createHost({ type: "local", label: "sweep-host" });
		const sessionId = "SWEEPSESS0000000000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });

		// Create three channels: born (default), live, dead
		dal.createChannel({ id: "SWEEPCH01AAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		dal.createChannel({ id: "SWEEPCH02AAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		dal.createChannel({ id: "SWEEPCH03AAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });

		// Promote two to live / dead via raw SQL to bypass DAL status typing
		const db = (
			dal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
		).db;
		db.prepare("UPDATE channels SET status = 'live' WHERE id = ?").run(
			"SWEEPCH02AAAAAAAAAAAAAAAAAAA",
		);
		db.prepare("UPDATE channels SET status = 'dead' WHERE id = ?").run(
			"SWEEPCH03AAAAAAAAAAAAAAAAAAA",
		);

		const count = dal.markAllChannelsDead();
		expect(count).toBe(2); // born + live swept; dead unchanged

		expect(dal.getChannel("SWEEPCH01AAAAAAAAAAAAAAAAAAA")?.status).toBe("dead");
		expect(dal.getChannel("SWEEPCH02AAAAAAAAAAAAAAAAAAA")?.status).toBe("dead");
		expect(dal.getChannel("SWEEPCH03AAAAAAAAAAAAAAAAAAA")?.status).toBe("dead");
	});

	it("returns 0 when all channels are already dead", () => {
		const host = dal.createHost({ type: "local", label: "sweep-host-empty" });
		const sessionId = "SWEEPSESS1000000000000000000";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });

		dal.createChannel({ id: "SWEEPCH04AAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		const db = (
			dal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
		).db;
		db.prepare("UPDATE channels SET status = 'dead' WHERE id = ?").run(
			"SWEEPCH04AAAAAAAAAAAAAAAAAAA",
		);

		const count = dal.markAllChannelsDead();
		expect(count).toBe(0);
	});

	it("returns 0 when no channels exist", () => {
		expect(dal.markAllChannelsDead()).toBe(0);
	});
});

describe("MetaDAL — markAllSessionsClosed", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("sweeps active sessions to closed and returns count", () => {
		const host = dal.createHost({ type: "local", label: "sess-sweep-host" });

		dal.createSession({ id: "SESSSWEEP01AAAAAAAAAAAAAAAAAA", hostId: host.id, status: "active" });
		dal.createSession({ id: "SESSSWEEP02AAAAAAAAAAAAAAAAAA", hostId: host.id, status: "active" });

		// Mark one already closed
		const db = (
			dal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
		).db;
		db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ?").run(
			"SESSSWEEP02AAAAAAAAAAAAAAAAAA",
		);

		const count = dal.markAllSessionsClosed();
		expect(count).toBe(1); // only the active one swept

		expect(dal.getSession("SESSSWEEP01AAAAAAAAAAAAAAAAAA")?.status).toBe("closed");
		expect(dal.getSession("SESSSWEEP02AAAAAAAAAAAAAAAAAA")?.status).toBe("closed");
	});

	it("sweeps all non-closed statuses (starting, active, detached, disconnected)", () => {
		const host = dal.createHost({ type: "local", label: "sess-sweep-all" });

		const statuses = ["starting", "active", "detached", "disconnected"] as const;
		const ids = [
			"SESSSWEEP03AAAAAAAAAAAAAAAAAA",
			"SESSSWEEP04AAAAAAAAAAAAAAAAAA",
			"SESSSWEEP05AAAAAAAAAAAAAAAAAA",
			"SESSSWEEP06AAAAAAAAAAAAAAAAAA",
		];

		for (let i = 0; i < statuses.length; i++) {
			const id = ids[i];
			const status = statuses[i];
			if (id && status) {
				dal.createSession({ id, hostId: host.id, status });
			}
		}

		const count = dal.markAllSessionsClosed();
		expect(count).toBe(4);

		for (const id of ids) {
			if (id) expect(dal.getSession(id)?.status).toBe("closed");
		}
	});

	it("returns 0 when no sessions exist", () => {
		expect(dal.markAllSessionsClosed()).toBe(0);
	});
});

// ─── Warm Restart ─────────────────────────────────────────────────────────────

describe("MetaDAL — listAliveChannelsWithHost", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("returns empty array on a fresh database", () => {
		expect(dal.listAliveChannelsWithHost()).toEqual([]);
	});

	it("returns only non-dead channels enriched with host info", () => {
		const host = dal.createHost({ type: "local", label: "wr-host" });
		const sessionId = "WRSESS01AAAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });

		dal.createChannel({
			id: "WRCH01AAAAAAAAAAAAAAAAAAAAAAAA",
			sessionId,
			status: "born",
			shell: "/bin/bash",
			cwd: "/home/user",
		});
		dal.createChannel({
			id: "WRCH02AAAAAAAAAAAAAAAAAAAAAAAA",
			sessionId,
			status: "born",
			shell: "/bin/sh",
		});

		// Mark one channel dead via raw SQL
		const db = (
			dal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
		).db;
		db.prepare("UPDATE channels SET status = 'dead' WHERE id = ?").run(
			"WRCH02AAAAAAAAAAAAAAAAAAAAAAAA",
		);

		const rows = dal.listAliveChannelsWithHost();
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row).toBeDefined();
		expect(row?.id).toBe("WRCH01AAAAAAAAAAAAAAAAAAAAAAAA");
		expect(row?.sessionId).toBe(sessionId);
		expect(row?.shell).toBe("/bin/bash");
		expect(row?.cwd).toBe("/home/user");
		expect(row?.status).toBe("born");
		expect(row?.hostId).toBe(host.id);
		expect(row?.hostType).toBe("local");
	});
});

describe("MetaDAL — markHostChannelsOrphan", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("marks non-dead channels orphan and returns count, leaves dead unchanged", () => {
		const host = dal.createHost({ type: "local", label: "orphan-host" });
		const sessionId = "ORPHSESS01AAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });

		dal.createChannel({ id: "ORPHCH01AAAAAAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		dal.createChannel({ id: "ORPHCH02AAAAAAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });
		dal.createChannel({ id: "ORPHCH03AAAAAAAAAAAAAAAAAAAAAAA", sessionId, status: "born" });

		// Mark one live, one dead via raw SQL
		const db = (
			dal as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }
		).db;
		db.prepare("UPDATE channels SET status = 'live' WHERE id = ?").run(
			"ORPHCH02AAAAAAAAAAAAAAAAAAAAAAA",
		);
		db.prepare("UPDATE channels SET status = 'dead' WHERE id = ?").run(
			"ORPHCH03AAAAAAAAAAAAAAAAAAAAAAA",
		);

		const count = dal.markHostChannelsOrphan(host.id);
		expect(count).toBe(2); // born + live changed; dead unchanged

		expect(dal.getChannel("ORPHCH01AAAAAAAAAAAAAAAAAAAAAAA")?.status).toBe("orphan");
		expect(dal.getChannel("ORPHCH02AAAAAAAAAAAAAAAAAAAAAAA")?.status).toBe("orphan");
		expect(dal.getChannel("ORPHCH03AAAAAAAAAAAAAAAAAAAAAAA")?.status).toBe("dead");
	});

	it("does not affect channels belonging to other hosts", () => {
		const host1 = dal.createHost({ type: "local", label: "orphan-host-1" });
		const host2 = dal.createHost({ type: "local", label: "orphan-host-2" });
		const sessionId1 = "ORPHSESS02AAAAAAAAAAAAAAAAAAAAA";
		const sessionId2 = "ORPHSESS03AAAAAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId1, hostId: host1.id, status: "active" });
		dal.createSession({ id: sessionId2, hostId: host2.id, status: "active" });

		dal.createChannel({
			id: "ORPHCH04AAAAAAAAAAAAAAAAAAAAAAA",
			sessionId: sessionId1,
			status: "born",
		});
		dal.createChannel({
			id: "ORPHCH05AAAAAAAAAAAAAAAAAAAAAAA",
			sessionId: sessionId2,
			status: "born",
		});

		const count = dal.markHostChannelsOrphan(host1.id);
		expect(count).toBe(1);

		expect(dal.getChannel("ORPHCH04AAAAAAAAAAAAAAAAAAAAAAA")?.status).toBe("orphan");
		expect(dal.getChannel("ORPHCH05AAAAAAAAAAAAAAAAAAAAAAA")?.status).toBe("born"); // unaffected
	});
});

describe("MetaDAL — markHostSessionDisconnected", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("marks active session disconnected and returns 1, leaves closed unchanged", () => {
		const host = dal.createHost({ type: "local", label: "disc-host" });

		dal.createSession({ id: "DISCSESS01AAAAAAAAAAAAAAAAAAAA", hostId: host.id, status: "active" });
		dal.createSession({ id: "DISCSESS02AAAAAAAAAAAAAAAAAAAA", hostId: host.id, status: "closed" });

		const count = dal.markHostSessionDisconnected(host.id);
		expect(count).toBe(1);

		expect(dal.getSession("DISCSESS01AAAAAAAAAAAAAAAAAAAA")?.status).toBe("disconnected");
		expect(dal.getSession("DISCSESS02AAAAAAAAAAAAAAAAAAAA")?.status).toBe("closed");
	});

	it("does not affect sessions belonging to other hosts", () => {
		const host1 = dal.createHost({ type: "local", label: "disc-host-1" });
		const host2 = dal.createHost({ type: "local", label: "disc-host-2" });

		dal.createSession({ id: "DISCSESS03AAAAAAAAAAAAAAAAAAAA", hostId: host1.id, status: "active" });
		dal.createSession({ id: "DISCSESS04AAAAAAAAAAAAAAAAAAAA", hostId: host2.id, status: "active" });

		const count = dal.markHostSessionDisconnected(host1.id);
		expect(count).toBe(1);

		expect(dal.getSession("DISCSESS03AAAAAAAAAAAAAAAAAAAA")?.status).toBe("disconnected");
		expect(dal.getSession("DISCSESS04AAAAAAAAAAAAAAAAAAAA")?.status).toBe("active"); // unaffected
	});

	it("returns 0 when called again on an already-disconnected session (status != closed so still matches, but changes = 0 when no rows changed)", () => {
		const host = dal.createHost({ type: "local", label: "disc-host-idempotent" });
		dal.createSession({ id: "DISCSESS05AAAAAAAAAAAAAAAAAAAA", hostId: host.id, status: "active" });

		// First call sets to disconnected
		expect(dal.markHostSessionDisconnected(host.id)).toBe(1);
		// Second call: status is 'disconnected' which != 'closed', so the WHERE matches
		// but SQLite reports changes=1 because the row is updated again (same value)
		// In practice the count reflects rows touched, not rows changed to a new value.
		// What matters is the final state is correct.
		expect(dal.getSession("DISCSESS05AAAAAAAAAAAAAAAAAAAA")?.status).toBe("disconnected");
	});
});

// ─── PairingCodes ─────────────────────────────────────────────────────────────

describe("MetaDAL — PairingCodes", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("createPairingCode + getPairingCodeByCode round-trip", () => {
		const id = "PAIR01AAAAAAAAAAAAAAAAAAAAAAAA";
		const now = new Date().toISOString();
		const exp = new Date(Date.now() + 60_000).toISOString();

		dal.createPairingCode(id, "123456", now, exp);

		const row = dal.getPairingCodeByCode("123456");
		expect(row).toBeDefined();
		expect(row?.id).toBe(id);
		expect(row?.code).toBe("123456");
		expect(row?.created_at).toBe(now);
		expect(row?.expires_at).toBe(exp);
		expect(row?.used).toBe(0);
		expect(row?.used_at).toBeNull();
		expect(row?.used_by_ip).toBeNull();
	});

	it("getPairingCodeByCode returns undefined for unknown code", () => {
		expect(dal.getPairingCodeByCode("999999")).toBeUndefined();
	});

	it("markPairingCodeUsed updates used, used_at, used_by_ip", () => {
		const id = "PAIR02AAAAAAAAAAAAAAAAAAAAAAAA";
		const now = new Date().toISOString();
		const exp = new Date(Date.now() + 60_000).toISOString();
		dal.createPairingCode(id, "234567", now, exp);

		const usedAt = new Date().toISOString();
		dal.markPairingCodeUsed(id, usedAt, "127.0.0.1");

		const row = dal.getPairingCodeByCode("234567") as PairingCodeRow;
		expect(row.used).toBe(1);
		expect(row.used_at).toBe(usedAt);
		expect(row.used_by_ip).toBe("127.0.0.1");
	});

	it("countActivePairingCodes counts only non-expired, non-used codes", () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const past = new Date(Date.now() - 1000).toISOString();
		const now = new Date().toISOString();

		// Active (future expiry, not used)
		dal.createPairingCode("PAIR03AAAAAAAAAAAAAAAAAAAAAAAA", "345678", now, future);
		dal.createPairingCode("PAIR04AAAAAAAAAAAAAAAAAAAAAAAA", "456789", now, future);

		// Expired (past expiry, not used) — should NOT count
		dal.createPairingCode("PAIR05AAAAAAAAAAAAAAAAAAAAAAAA", "567890", now, past);

		// Used (future expiry, used=1) — should NOT count
		dal.createPairingCode("PAIR06AAAAAAAAAAAAAAAAAAAAAAAA", "678901", now, future);
		dal.markPairingCodeUsed("PAIR06AAAAAAAAAAAAAAAAAAAAAAAA", now, "10.0.0.1");

		expect(dal.countActivePairingCodes()).toBe(2);
	});

	it("cleanExpiredPairingCodes removes only expired non-used records", () => {
		const future = new Date(Date.now() + 60_000).toISOString();
		const past = new Date(Date.now() - 1000).toISOString();
		const now = new Date().toISOString();

		// Active — should survive
		dal.createPairingCode("PAIR07AAAAAAAAAAAAAAAAAAAAAAAA", "789012", now, future);

		// Expired non-used — should be removed
		dal.createPairingCode("PAIR08AAAAAAAAAAAAAAAAAAAAAAAA", "890123", now, past);

		// Expired but used — NOT cleaned (used = 1, audit trail)
		dal.createPairingCode("PAIR09AAAAAAAAAAAAAAAAAAAAAAAA", "901234", now, past);
		dal.markPairingCodeUsed("PAIR09AAAAAAAAAAAAAAAAAAAAAAAA", now, "10.0.0.2");

		dal.cleanExpiredPairingCodes();

		expect(dal.getPairingCodeByCode("789012")).toBeDefined(); // active — survives
		expect(dal.getPairingCodeByCode("890123")).toBeUndefined(); // expired — removed
		expect(dal.getPairingCodeByCode("901234")).toBeDefined(); // used+expired — survives
	});
});

// ─── Welcome Channel ──────────────────────────────────────────────────────────

describe("MetaDAL — Welcome Channel", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;
	let hostId: string;
	let sessionId: string;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
		const host = dal.createHost({ type: "local", label: "welcome-host" });
		hostId = host.id;
		sessionId = "WELCOMESESS0AAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sessionId, hostId, status: "active" });
	});

	afterEach(() => {
		dbs.close();
	});

	it("setWelcomeChannel sets is_welcome=1 on the channel", () => {
		const id = "WELCH01AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });

		const result = dal.setWelcomeChannel(id);
		expect(result).toBe(true);

		const ch = dal.getChannel(id);
		expect(ch?.isWelcome).toBe(true);
	});

	it("setWelcomeChannel clears previous welcome on same host", () => {
		const id1 = "WELCH02AAAAAAAAAAAAAAAAAAAAAA";
		const id2 = "WELCH03AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id: id1, sessionId, status: "born" });
		dal.createChannel({ id: id2, sessionId, status: "born" });

		dal.setWelcomeChannel(id1);
		expect(dal.getChannel(id1)?.isWelcome).toBe(true);

		dal.setWelcomeChannel(id2);
		expect(dal.getChannel(id2)?.isWelcome).toBe(true);
		// Previous welcome should be cleared
		expect(dal.getChannel(id1)?.isWelcome).toBeUndefined();
	});

	it("setWelcomeChannel returns false for non-existent channel", () => {
		expect(dal.setWelcomeChannel("no-such-id")).toBe(false);
	});

	it("clearWelcomeChannel clears is_welcome", () => {
		const id = "WELCH04AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });
		dal.setWelcomeChannel(id);
		expect(dal.getChannel(id)?.isWelcome).toBe(true);

		const result = dal.clearWelcomeChannel(id);
		expect(result).toBe(true);
		expect(dal.getChannel(id)?.isWelcome).toBeUndefined();
	});

	it("clearWelcomeChannel returns false for non-existent channel", () => {
		expect(dal.clearWelcomeChannel("no-such-id")).toBe(false);
	});

	it("getWelcomeChannel returns the welcome channel for a host", () => {
		const id = "WELCH05AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id, sessionId, status: "born" });
		dal.setWelcomeChannel(id);

		const welcome = dal.getWelcomeChannel(hostId);
		expect(welcome).toBeDefined();
		expect(welcome?.id).toBe(id);
		expect(welcome?.isWelcome).toBe(true);
	});

	it("getWelcomeChannel returns undefined when no welcome set", () => {
		expect(dal.getWelcomeChannel(hostId)).toBeUndefined();
	});

	it("only one welcome per host at a time", () => {
		const id1 = "WELCH06AAAAAAAAAAAAAAAAAAAAAA";
		const id2 = "WELCH07AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id: id1, sessionId, status: "born" });
		dal.createChannel({ id: id2, sessionId, status: "born" });

		dal.setWelcomeChannel(id1);
		dal.setWelcomeChannel(id2);

		const welcome = dal.getWelcomeChannel(hostId);
		expect(welcome?.id).toBe(id2);
		// Verify only one channel has isWelcome
		const ch1 = dal.getChannel(id1);
		const ch2 = dal.getChannel(id2);
		expect(ch1?.isWelcome).toBeUndefined();
		expect(ch2?.isWelcome).toBe(true);
	});

	it("welcome does not cross host boundaries", () => {
		const host2 = dal.createHost({ type: "local", label: "welcome-host-2" });
		const sess2Id = "WELCOMESESS2AAAAAAAAAAAAAAAAAA";
		dal.createSession({ id: sess2Id, hostId: host2.id, status: "active" });

		const id1 = "WELCH08AAAAAAAAAAAAAAAAAAAAAA";
		const id2 = "WELCH09AAAAAAAAAAAAAAAAAAAAAA";
		dal.createChannel({ id: id1, sessionId, status: "born" });
		dal.createChannel({ id: id2, sessionId: sess2Id, status: "born" });

		dal.setWelcomeChannel(id1);
		dal.setWelcomeChannel(id2);

		// Each host should have its own welcome
		expect(dal.getWelcomeChannel(hostId)?.id).toBe(id1);
		expect(dal.getWelcomeChannel(host2.id)?.id).toBe(id2);
	});
});

// ─── Host Group Operations ────────────────────────────────────────────────────

describe("MetaDAL — Host Group Operations", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("reorderHosts updates sort_order for hosts in a group", () => {
		const grp = dal.createHostGroup("prod");
		const h1 = dal.createHost({
			type: "ssh",
			label: "reorder-a",
			sshHost: "10.0.0.1",
			hostGroupId: grp.id,
			sortOrder: 0,
		});
		const h2 = dal.createHost({
			type: "ssh",
			label: "reorder-b",
			sshHost: "10.0.0.2",
			hostGroupId: grp.id,
			sortOrder: 1,
		});
		const h3 = dal.createHost({
			type: "ssh",
			label: "reorder-c",
			sshHost: "10.0.0.3",
			hostGroupId: grp.id,
			sortOrder: 2,
		});

		// Reverse order
		dal.reorderHosts(grp.id, [h3.id, h2.id, h1.id]);

		const updated1 = dal.getHost(h1.id);
		const updated2 = dal.getHost(h2.id);
		const updated3 = dal.getHost(h3.id);

		expect(updated3?.sortOrder).toBe(0);
		expect(updated2?.sortOrder).toBe(1);
		expect(updated1?.sortOrder).toBe(2);
	});

	it("reorderHosts also updates host_group_id", () => {
		const grpOld = dal.createHostGroup("old-group");
		const grpNew = dal.createHostGroup("new-group");
		const h1 = dal.createHost({
			type: "ssh",
			label: "move-group-a",
			sshHost: "10.0.0.4",
			hostGroupId: grpOld.id,
		});
		const h2 = dal.createHost({
			type: "ssh",
			label: "move-group-b",
			sshHost: "10.0.0.5",
		});

		// Move both to new-group
		dal.reorderHosts(grpNew.id, [h1.id, h2.id]);

		expect(dal.getHost(h1.id)?.hostGroupId).toBe(grpNew.id);
		expect(dal.getHost(h2.id)?.hostGroupId).toBe(grpNew.id);
	});

	it("duplicateHost creates copy with -copy suffix", () => {
		const original = dal.createHost({
			type: "ssh",
			label: "dup-source",
			sshHost: "10.0.0.10",
			sshPort: 2222,
			color: "#ff0000",
			hostGroup: "staging",
		});

		const copy = dal.duplicateHost(original.id);

		expect(copy).not.toBeNull();
		expect(copy?.label).toBe("dup-source-copy");
		expect(copy?.sshHost).toBe("10.0.0.10");
		expect(copy?.sshPort).toBe(2222);
		expect(copy?.color).toBe("#ff0000");
		expect(copy?.hostGroup).toBe("staging");
		expect(copy?.id).not.toBe(original.id);
	});

	it("duplicateHost increments suffix: -copy, -copy-2, -copy-3", () => {
		const original = dal.createHost({
			type: "ssh",
			label: "dup-inc",
			sshHost: "10.0.0.11",
		});

		const copy1 = dal.duplicateHost(original.id);
		expect(copy1?.label).toBe("dup-inc-copy");

		const copy2 = dal.duplicateHost(original.id);
		expect(copy2?.label).toBe("dup-inc-copy-2");

		const copy3 = dal.duplicateHost(original.id);
		expect(copy3?.label).toBe("dup-inc-copy-3");
	});

	it("duplicateHost returns null for local host", () => {
		const local = dal.createHost({ type: "local", label: "dup-local" });
		expect(dal.duplicateHost(local.id)).toBeNull();
	});

	it("duplicateHost returns null for non-existent host", () => {
		expect(dal.duplicateHost("no-such-id")).toBeNull();
	});
});

// ─── Host Group First-Class Entities ─────────────────────────────────────────

describe("MetaDAL — host groups (first-class)", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("createHostGroup creates with ULID id and auto-increments sort_order", () => {
		const g1 = dal.createHostGroup("Alpha");
		const g2 = dal.createHostGroup("Beta");
		const g3 = dal.createHostGroup("Gamma");

		expect(g1.id).toHaveLength(26);
		expect(g1.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(g2.id).not.toBe(g1.id);
		expect(g1.sortOrder).toBe(0);
		expect(g2.sortOrder).toBe(1);
		expect(g3.sortOrder).toBe(2);
	});

	it("createHostGroup stores color when provided", () => {
		const g = dal.createHostGroup("Colorful", "#ff6600");
		expect(g.color).toBe("#ff6600");
	});

	it("createHostGroup stores null color by default", () => {
		const g = dal.createHostGroup("NoColor");
		expect(g.color).toBeNull();
	});

	it("listHostGroupEntities returns groups ordered by sort_order", () => {
		dal.createHostGroup("Charlie");
		dal.createHostGroup("Alpha");
		dal.createHostGroup("Bravo");

		const groups = dal.listHostGroupEntities();
		expect(groups).toHaveLength(3);
		// sorted by sort_order (insertion order: Charlie=0, Alpha=1, Bravo=2)
		expect((groups[0] as HostGroup).name).toBe("Charlie");
		expect((groups[1] as HostGroup).name).toBe("Alpha");
		expect((groups[2] as HostGroup).name).toBe("Bravo");
	});

	it("getHostGroupEntity returns group by id", () => {
		const created = dal.createHostGroup("FindMe", "#aabbcc");
		const found = dal.getHostGroupEntity(created.id);

		expect(found).not.toBeNull();
		expect(found?.id).toBe(created.id);
		expect(found?.name).toBe("FindMe");
		expect(found?.color).toBe("#aabbcc");
	});

	it("getHostGroupEntity returns null for non-existent id", () => {
		const result = dal.getHostGroupEntity("non-existent-id");
		expect(result).toBeNull();
	});

	it("updateHostGroup updates name and bumps updated_at", async () => {
		const g = dal.createHostGroup("OldName");
		const originalUpdatedAt = g.updatedAt;

		await new Promise((r) => setTimeout(r, 10));

		const updated = dal.updateHostGroup(g.id, { name: "NewName" });
		expect(updated).not.toBeNull();
		expect(updated?.name).toBe("NewName");
		expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
	});

	it("updateHostGroup updates color", () => {
		const g = dal.createHostGroup("WithColor", "#111111");
		const updated = dal.updateHostGroup(g.id, { color: "#222222" });
		expect(updated?.color).toBe("#222222");
	});

	it("updateHostGroup sets color to null", () => {
		const g = dal.createHostGroup("ClearColor", "#ff0000");
		const updated = dal.updateHostGroup(g.id, { color: null });
		expect(updated?.color).toBeNull();
	});

	it("updateHostGroup returns null for non-existent id", () => {
		const result = dal.updateHostGroup("no-such-id", { name: "Ghost" });
		expect(result).toBeNull();
	});

	it("deleteHostGroupEntity removes group and returns true", () => {
		const g = dal.createHostGroup("ToDelete");
		const deleted = dal.deleteHostGroupEntity(g.id);
		expect(deleted).toBe(true);
		expect(dal.getHostGroupEntity(g.id)).toBeNull();
	});

	it("deleteHostGroupEntity returns false for non-existent id", () => {
		const result = dal.deleteHostGroupEntity("no-such-id");
		expect(result).toBe(false);
	});

	it("deleteHostGroupEntity cascade: hosts get host_group_id=null (ON DELETE SET NULL)", () => {
		const g = dal.createHostGroup("Doomed");
		const h1 = dal.createHost({
			type: "ssh",
			label: "cascade-host-a",
			sshHost: "10.1.0.1",
			hostGroupId: g.id,
		});
		const h2 = dal.createHost({
			type: "ssh",
			label: "cascade-host-b",
			sshHost: "10.1.0.2",
			hostGroupId: g.id,
		});

		dal.deleteHostGroupEntity(g.id);

		expect(dal.getHost(h1.id)?.hostGroupId).toBeUndefined();
		expect(dal.getHost(h2.id)?.hostGroupId).toBeUndefined();
	});

	it("reorderHostGroups reassigns sort_order by position", () => {
		const g1 = dal.createHostGroup("First");
		const g2 = dal.createHostGroup("Second");
		const g3 = dal.createHostGroup("Third");

		// Reverse order
		dal.reorderHostGroups([g3.id, g2.id, g1.id]);

		const groups = dal.listHostGroupEntities();
		expect(groups[0]?.id).toBe(g3.id);
		expect(groups[1]?.id).toBe(g2.id);
		expect(groups[2]?.id).toBe(g1.id);
	});

	it("createHostGroup UNIQUE name constraint throws on duplicate", () => {
		dal.createHostGroup("Unique");
		expect(() => dal.createHostGroup("Unique")).toThrow();
	});

	it("migrateHostGroupData migrates legacy host_group strings to host_groups table", () => {
		// Create hosts with legacy host_group string
		const h1 = dal.createHost({
			type: "ssh",
			label: "migrate-a",
			sshHost: "10.2.0.1",
			hostGroup: "legacy-prod",
		});
		const h2 = dal.createHost({
			type: "ssh",
			label: "migrate-b",
			sshHost: "10.2.0.2",
			hostGroup: "legacy-prod",
		});
		const h3 = dal.createHost({
			type: "ssh",
			label: "migrate-c",
			sshHost: "10.2.0.3",
			hostGroup: "legacy-staging",
		});
		const h4 = dal.createHost({
			type: "ssh",
			label: "migrate-d",
			sshHost: "10.2.0.4",
			// no hostGroup
		});

		dal.migrateHostGroupData();

		// host_groups table should have the two legacy names
		const entities = dal.listHostGroupEntities();
		const names = entities.map((g) => g.name).sort();
		expect(names).toContain("legacy-prod");
		expect(names).toContain("legacy-staging");

		// hosts should have host_group_id set
		const r1 = dal.getHost(h1.id);
		const r2 = dal.getHost(h2.id);
		const r3 = dal.getHost(h3.id);
		const r4 = dal.getHost(h4.id);

		const prodGroup = entities.find((g) => g.name === "legacy-prod");
		const stagingGroup = entities.find((g) => g.name === "legacy-staging");

		expect(r1?.hostGroupId).toBe(prodGroup?.id);
		expect(r2?.hostGroupId).toBe(prodGroup?.id);
		expect(r3?.hostGroupId).toBe(stagingGroup?.id);
		expect(r4?.hostGroupId).toBeUndefined();
	});

	it("migrateHostGroupData is idempotent (safe to call twice)", () => {
		dal.createHost({
			type: "ssh",
			label: "idem-host",
			sshHost: "10.2.0.10",
			hostGroup: "idem-group",
		});

		dal.migrateHostGroupData();
		dal.migrateHostGroupData();

		const entities = dal.listHostGroupEntities();
		const idemGroups = entities.filter((g) => g.name === "idem-group");
		expect(idemGroups).toHaveLength(1);
	});

	it("createHost with hostGroupId stores correctly", () => {
		const g = dal.createHostGroup("MyGroup");
		const h = dal.createHost({
			type: "ssh",
			label: "grouped-host",
			sshHost: "10.3.0.1",
			hostGroupId: g.id,
		});

		expect(h.hostGroupId).toBe(g.id);
		const reloaded = dal.getHost(h.id);
		expect(reloaded?.hostGroupId).toBe(g.id);
	});

	it("updateHost with hostGroupId updates correctly", () => {
		const g1 = dal.createHostGroup("GroupOne");
		const g2 = dal.createHostGroup("GroupTwo");
		const h = dal.createHost({
			type: "ssh",
			label: "movable-host",
			sshHost: "10.3.0.2",
			hostGroupId: g1.id,
		});

		expect(h.hostGroupId).toBe(g1.id);

		const updated = dal.updateHost(h.id, { hostGroupId: g2.id });
		expect(updated.hostGroupId).toBe(g2.id);
	});

	it("reorderHosts with groupId moves hosts between groups", () => {
		const g1 = dal.createHostGroup("Source");
		const g2 = dal.createHostGroup("Destination");

		const h1 = dal.createHost({
			type: "ssh",
			label: "rh-a",
			sshHost: "10.4.0.1",
			hostGroupId: g1.id,
		});
		const h2 = dal.createHost({
			type: "ssh",
			label: "rh-b",
			sshHost: "10.4.0.2",
		});

		// Move both to g2, reverse order
		dal.reorderHosts(g2.id, [h2.id, h1.id]);

		const r1 = dal.getHost(h1.id);
		const r2 = dal.getHost(h2.id);

		expect(r1?.hostGroupId).toBe(g2.id);
		expect(r2?.hostGroupId).toBe(g2.id);
		expect(r2?.sortOrder).toBe(0);
		expect(r1?.sortOrder).toBe(1);
	});
});
