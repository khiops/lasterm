import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedShellProfiles } from "../session/shell-profile-seed.js";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { sshAddress, targetRoute } from "../ssh-route.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { DatabaseManager } from "./db.js";
import { openDatabases, openTestDatabases, restrictDatabaseFiles } from "./db.js";
import { MetaDAL } from "./meta.js";
import { describeOpenDatabases } from "./open-databases.fixture.js";
import { Database } from "./sqlite.js";
import { TransfersDAL } from "./transfers-dal.js";

describe("openTestDatabases", () => {
	let dbs: DatabaseManager;

	afterEach(async () => {
		await dbs?.close();
	});

	it("creates both in-memory databases", () => {
		dbs = openTestDatabases();
		expect(dbs.meta).toBeDefined();
		expect(dbs.spool).toBeDefined();
	});

	it("meta.db: journal_mode is WAL", () => {
		dbs = openTestDatabases();
		// In-memory databases always return 'memory' for journal_mode
		// but WAL pragma is still accepted
		const mode = dbs.meta.pragma("journal_mode", { simple: true });
		// :memory: databases return 'memory' not 'wal' — that's expected SQLite behavior
		expect(["wal", "memory"]).toContain(mode);
	});

	it("meta.db: foreign_keys is enabled", () => {
		dbs = openTestDatabases();
		const fk = dbs.meta.pragma("foreign_keys", { simple: true });
		expect(fk).toBe(1);
	});

	it("meta.db: synchronous = NORMAL (1)", () => {
		dbs = openTestDatabases();
		const sync = dbs.meta.pragma("synchronous", { simple: true });
		expect(sync).toBe(1);
	});

	it("spool.db: auto_vacuum = INCREMENTAL (2)", () => {
		dbs = openTestDatabases();
		const av = dbs.spool.pragma("auto_vacuum", { simple: true });
		expect(av).toBe(2);
	});

	it("spool.db: foreign_keys is enabled", () => {
		dbs = openTestDatabases();
		const fk = dbs.spool.pragma("foreign_keys", { simple: true });
		expect(fk).toBe(1);
	});

	it("meta.db: schema_version is 26 after migration", () => {
		dbs = openTestDatabases();
		const row = dbs.meta.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
			v: number;
		};
		expect(row.v).toBe(26);
	});

	it("spool.db: schema_version is 1 after migration", () => {
		dbs = openTestDatabases();
		const row = dbs.spool.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
			v: number;
		};
		expect(row.v).toBe(1);
	});

	it("meta.db: all required tables exist", () => {
		dbs = openTestDatabases();
		const tables = dbs.meta
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all() as Array<{ name: string }>;
		const tableNames = tables.map((t) => t.name);

		expect(tableNames).toContain("hosts");
		expect(tableNames).toContain("sessions");
		expect(tableNames).toContain("channels");
		expect(tableNames).toContain("channel_groups");
		expect(tableNames).toContain("host_groups");
		expect(tableNames).toContain("cache_index");
		expect(tableNames).toContain("pairing_codes");
		expect(tableNames).toContain("auth_tokens");
		expect(tableNames).toContain("pair_rate_limits");
		expect(tableNames).toContain("schema_version");
	});

	it("spool.db: chunks table exists", () => {
		dbs = openTestDatabases();
		const table = dbs.spool
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
			.get() as { name: string } | undefined;
		expect(table).toBeDefined();
		expect(table?.name).toBe("chunks");
	});

	it("migration runner is idempotent (running twice produces same schema_version = 26)", () => {
		// First open
		const dbs1 = openTestDatabases();
		const v1 = (
			dbs1.meta.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
		).v;
		dbs1.close();

		// Second open — migrations should not re-apply
		const dbs2 = openTestDatabases();
		const v2 = (
			dbs2.meta.prepare("SELECT MAX(version) as v FROM schema_version").get() as { v: number }
		).v;
		dbs2.close();

		expect(v1).toBe(26);
		expect(v2).toBe(26);
	});

	it("close() closes memory databases synchronously and returns a promise", async () => {
		dbs = openTestDatabases();
		const closed = dbs.close();
		expect(dbs.meta.open).toBe(false);
		expect(dbs.spool.open).toBe(false);
		expect(closed).toBeInstanceOf(Promise);
		await closed;
	});

	it("meta.db: wal_autocheckpoint = 1000", () => {
		dbs = openTestDatabases();
		const val = dbs.meta.pragma("wal_autocheckpoint", { simple: true });
		expect(val).toBe(1000);
	});

	it("spool.db: wal_autocheckpoint = 2000", () => {
		dbs = openTestDatabases();
		const val = dbs.spool.pragma("wal_autocheckpoint", { simple: true });
		expect(val).toBe(2000);
	});
});

// The cases the executable's bundle of this module runs too
// (scripts/build-sea-hub.spec.ts, #745).
describeOpenDatabases("storage/db.ts", () => openDatabases);

// STORAGE.md § 2 says owner-only, and until #536 nothing made it so: SQLite
// creates a database 0644 under the usual umask of 022. Windows has no such
// modes — chmod only toggles the read-only attribute — and relies on the
// profile's ACL, so these are skipped there, and say so.
describe.skipIf(process.platform === "win32")("openDatabases: owner-only files (POSIX)", () => {
	const META_FILES = ["meta.db", "meta.db-wal", "meta.db-shm"];
	const ALL_FILES = [...META_FILES, "spool.db", "spool.db-wal", "spool.db-shm"];
	let dir: string;
	let dbs: DatabaseManager | undefined;
	let umask: number;

	/** The mode beside the name, so a failure says which file. */
	const modeOf = (name: string) => [name, (statSync(join(dir, name)).mode & 0o777).toString(8)];

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-modes-");
		umask = process.umask(0o022);
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		process.umask(umask);
		await removeTempDir(dir);
	});

	it("creates both databases 0600, and their WAL and shared-memory files follow after a first write", () => {
		dbs = openDatabases(dir);
		// The migrations were a first write already; one more to each, so the WAL
		// files read back are ones SQLite created and wrote after the open.
		dbs.meta.exec("CREATE TABLE mode_probe (x); INSERT INTO mode_probe VALUES (1)");
		dbs.spool.exec("CREATE TABLE mode_probe (x); INSERT INTO mode_probe VALUES (1)");

		for (const name of ALL_FILES) {
			expect(existsSync(join(dir, name)), name).toBe(true);
			expect(modeOf(name)).toEqual([name, "600"]);
		}
	});

	it("sets an existing database, and the WAL files a run that never closed left, to 0600", () => {
		// A connection still open keeps its -wal and -shm, as a crash leaves them.
		const earlier = new Database(join(dir, "meta.db"));
		try {
			earlier.pragma("journal_mode = WAL");
			earlier.exec("CREATE TABLE earlier (x); INSERT INTO earlier VALUES (1)");
			for (const name of META_FILES) chmodSync(join(dir, name), 0o644);

			dbs = openDatabases(dir);

			for (const name of META_FILES) expect(modeOf(name)).toEqual([name, "600"]);
		} finally {
			earlier.close();
		}
	});

	it("refuses a WAL file that is not a regular file, before either database opens", () => {
		mkdirSync(join(dir, "spool.db-wal"));

		expect(() => openDatabases(dir)).toThrow(/spool\.db-wal is not a regular file/);
		// meta.db was prepared, but SQLite never opened it: no connection is left behind.
		expect(existsSync(join(dir, "meta.db-shm"))).toBe(false);
	});

	it("refuses a database another account owns, and leaves its mode alone", () => {
		const file = join(dir, "meta.db");
		writeFileSync(file, "");
		chmodSync(file, 0o644);
		const uid = process.geteuid?.() ?? 0;

		expect(() => restrictDatabaseFiles(file, { uid: uid + 1 })).toThrow(
			`owned by uid ${uid}, not by this account (uid ${uid + 1})`,
		);
		expect(modeOf("meta.db")).toEqual(["meta.db", "644"]);
	});
});

// ─── The baseline (STORAGE.md § 9.3) ─────────────────────────────────────────
//
// One file, 021-baseline.sql, replaced migrations 001 to 021 before the first
// public release. It keeps their last version, so a database they brought to
// 21 is not touched, and a new one comes out at 21 with the schema they built,
// less what nothing read.

describe("meta.db and its baseline", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-baseline-");
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const versions = (db: Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const tables = (db: Database) =>
		(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((table) => table.name);
	const columns = (db: Database, table: string) =>
		(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(column) => column.name,
		);

	it("comes out new at version 26, with the final schema", () => {
		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(tables(dbs.meta)).toEqual([
			"auth_tokens",
			"cache_index",
			"channel_groups",
			"channels",
			"host_groups",
			"host_launch_profiles",
			"hosts",
			"launch_profiles",
			"pair_rate_limits",
			"pairing_codes",
			"schema_version",
			"sessions",
			"transfer_items",
			"transfers",
		]);
		expect(columns(dbs.meta, "hosts")).toEqual([
			"id",
			"type",
			"label",
			"ssh_host",
			"ssh_port",
			"ssh_auth",
			"ssh_key_path",
			"icon_type",
			"icon_value",
			"color",
			"profile_json",
			"trust_remote_hints",
			"default_shell",
			"default_cwd",
			"created_at",
			"updated_at",
			"sort_order",
			"ssh_config_host",
			"ssh_user",
			"host_group_id",
			"discovered_shells",
			"discovered_shells_at",
			"elevation_method",
			"custom_command",
			"os",
			"arch",
			"ssh_fingerprint",
			"agent_sha256",
			"ssh_proxy_host_id",
			"ssh_proxy_spec",
			"ssh_proxy_fingerprint",
			"ssh_remote_daemon",
			"discovered_default_shell",
		]);
		expect(columns(dbs.meta, "host_launch_profiles")).toEqual([
			"host_id",
			"profile_id",
			"override_type",
			"sort_order",
			"set_by_user",
		]);
		expect(columns(dbs.meta, "launch_profiles").at(-1)).toBe("report_directory");
		expect(columns(dbs.meta, "channels")).toContain("end_reason");
		expect(columns(dbs.meta, "auth_tokens")).toContain("swept_at");
		expect(columns(dbs.meta, "pairing_codes")).toContain("code_hash");
	});

	it("does not run the baseline on a database already at version 21", () => {
		// What the migrations before the baseline left: version 21, with a table
		// and a column the baseline no longer has. Only the migrations after it
		// run on it.
		const before = new Database(join(dir, "meta.db"));
		before.exec(`
			CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
			INSERT INTO schema_version VALUES (21, '2026-10-01 00:00:00');
			CREATE TABLE hosts (
				id TEXT PRIMARY KEY, label TEXT, keep_alive_seconds INTEGER DEFAULT 60,
				default_shell TEXT, discovered_shells TEXT,
				ssh_fingerprint TEXT, ssh_proxy_fingerprint TEXT
			);
			INSERT INTO hosts (id, label) VALUES ('H1', 'here');
			CREATE TABLE host_launch_profiles (
				host_id TEXT NOT NULL, profile_id TEXT NOT NULL, override_type TEXT NOT NULL
			);
			CREATE TABLE launch_profiles (id TEXT PRIMARY KEY, name TEXT);
			CREATE TABLE workspaces (id TEXT PRIMARY KEY);
		`);
		before.close();

		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(tables(dbs.meta)).toEqual([
			"host_launch_profiles",
			"hosts",
			"launch_profiles",
			"schema_version",
			"transfer_items",
			"transfers",
			"workspaces",
		]);
		expect(columns(dbs.meta, "launch_profiles")).toEqual(["id", "name", "report_directory"]);
		expect(columns(dbs.meta, "hosts")).toEqual([
			"id",
			"label",
			"keep_alive_seconds",
			"default_shell",
			"discovered_shells",
			"ssh_fingerprint",
			"ssh_proxy_fingerprint",
			"discovered_default_shell",
		]);
		expect(dbs.meta.prepare("SELECT * FROM hosts").all()).toEqual([
			{
				id: "H1",
				label: "here",
				keep_alive_seconds: 60,
				default_shell: null,
				discovered_shells: null,
				ssh_fingerprint: null,
				ssh_proxy_fingerprint: null,
				discovered_default_shell: null,
			},
		]);
	});
});

// ─── Migration 022: unpadded SSH pins (#717) ─────────────────────────────────
//
// 0.14.3 pinned a host key with the base64 padding, and #717 came after it: from
// then on the hub spells a key without it and compares pins as they are. A pin
// kept from 0.14.3 must come out as the key the hub now computes, or every
// pinned host would report a changed key.

describe("meta.db migration 022: SSH pins without padding", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-022-");
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const migration = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./migrations/meta/${name}`, import.meta.url)), "utf-8");
	/** A key's fingerprint as 0.14.3 wrote it, padding and all. */
	const padded = (keyBlob: Buffer) =>
		`SHA256:${createHash("sha256").update(keyBlob).digest("base64")}`;
	const versions = (db: Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const pins = (db: Database) =>
		db
			.prepare(
				"SELECT id, ssh_fingerprint, ssh_proxy_fingerprint, agent_sha256, updated_at FROM hosts ORDER BY id",
			)
			.all();

	const target = Buffer.from("the target's host key");
	const jump = Buffer.from("the spec jump's host key");
	const bastion = Buffer.from("the saved bastion's host key");
	const agentSha256 = createHash("sha256").update("an agent binary").digest("hex");
	const at = "2026-10-01T00:00:00.000Z";

	/** A database as 0.14.3 left it: version 21, its pins padded. */
	function databaseAt21(): void {
		const before = new Database(join(dir, "meta.db"));
		before.exec(migration("021-baseline.sql"));
		const insert = before.prepare(
			`INSERT INTO hosts (id, type, label, ssh_host, ssh_fingerprint, ssh_proxy_host_id,
				ssh_proxy_spec, ssh_proxy_fingerprint, agent_sha256, created_at, updated_at)
			VALUES (?, 'ssh', ?, ?, ?, ?, ?, ?, ?, '${at}', '${at}')`,
		);
		insert.run("B", "bastion", "bastion.test", padded(bastion), null, null, null, null);
		insert.run(
			"T",
			"target",
			"target.test",
			padded(target),
			null,
			"me@jump.test:22",
			padded(jump),
			agentSha256,
		);
		insert.run("V", "via bastion", "inner.test", padded(target), "B", null, null, null);
		// Never pinned, and two values that are not 0.14.3's spelling of a key.
		insert.run("N", "never", "never.test", null, null, null, null, null);
		insert.run("O", "odd", "odd.test", "SHA256:not-a-key=", null, null, "SHA256:+/=", null);
		expect(versions(before)).toEqual([{ version: 21 }]);
		expect(padded(target)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}=$/);
		before.close();
	}

	it("takes the padding off a 0.14.3 pin, which the hub then reads as the same key", () => {
		databaseAt21();

		dbs = openDatabases(dir);
		const dal = new MetaDAL(dbs.meta);
		const routeOf = (id: string) => {
			const host = dal.getHost(id);
			if (!host) throw new Error(`no host ${id}`);
			return targetRoute(host, (other) => sshAddress(dal.getHost(other)));
		};

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		// What a connection reads, and compares with fingerprintOf(key) as it is.
		expect(dal.getHostFingerprint("T", routeOf("T"))).toBe(fingerprintOf(target));
		expect(dal.getHostFingerprint("B", routeOf("B"))).toBe(fingerprintOf(bastion));
		expect(dal.getHostFingerprint("V", routeOf("V"))).toBe(fingerprintOf(target));
		expect(dal.getHost("T")?.sshProxyFingerprint).toBe(fingerprintOf(jump));
		// Nothing else moves: not a value in another form, not the agent's hex
		// hash, not the time a host was last edited.
		const row = (id: string, pin: string | null, jumpPin: string | null, sha: string | null) => ({
			id,
			ssh_fingerprint: pin,
			ssh_proxy_fingerprint: jumpPin,
			agent_sha256: sha,
			updated_at: at,
		});
		expect(pins(dbs.meta)).toEqual([
			row("B", fingerprintOf(bastion), null, null),
			row("N", null, null, null),
			row("O", "SHA256:not-a-key=", "SHA256:+/=", null),
			row("T", fingerprintOf(target), fingerprintOf(jump), agentSha256),
			row("V", fingerprintOf(target), null, null),
		]);
	});

	it("comes out new at version 26", () => {
		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(pins(dbs.meta)).toEqual([]);
	});

	it("changes nothing when it runs again", async () => {
		databaseAt21();
		dbs = openDatabases(dir);
		const migrated = pins(dbs.meta);
		await dbs.close();

		// The runner does not run it twice...
		dbs = openDatabases(dir);
		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(pins(dbs.meta)).toEqual(migrated);

		// ...and its statements find nothing left to change if they do run.
		const updates = migration("022-unpadded-ssh-pins.sql").replace(
			/INSERT INTO schema_version[^;]*;/,
			"",
		);
		const changes = dbs.meta.prepare("SELECT total_changes() AS n");
		const before = changes.get();
		dbs.meta.exec(updates);
		expect(changes.get()).toEqual(before);
		expect(pins(dbs.meta)).toEqual(migrated);
	});
});

// ─── Migration 023: the agent's default shell apart (#794) ───────────────────
//
// A hub before #794 wrote the default shell a host's agent reports into
// default_shell at every connection. What a database it left holds there is the
// agent's on every host that connected. Nothing reads default_shell any more
// (#802): it is left as it is.

describe("meta.db migration 023: the agent's default shell in a column of its own", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-023-");
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const migration = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./migrations/meta/${name}`, import.meta.url)), "utf-8");
	const versions = (db: Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const shells = (db: Database) =>
		db
			.prepare(
				"SELECT id, default_shell, discovered_default_shell, discovered_shells, updated_at FROM hosts ORDER BY id",
			)
			.all();

	const at = "2026-10-01T00:00:00.000Z";
	const cmd = "C:\\WINDOWS\\system32\\cmd.exe";
	const piShells = JSON.stringify(["/bin/bash", "/usr/bin/fish"]);

	/** A database as 0.15.1 left it: version 22, the agent's default written over the user's. */
	function databaseAt22(): void {
		const before = new Database(join(dir, "meta.db"));
		before.exec(migration("021-baseline.sql"));
		before.exec(migration("022-unpadded-ssh-pins.sql"));
		const insert = before.prepare(
			`INSERT INTO hosts (id, type, label, ssh_host, default_shell, discovered_shells,
				created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, '${at}', '${at}')`,
		);
		// Connected: the agent's default, written at each connection.
		insert.run("C", "ssh", "pi", "pi.test", "/bin/bash", piShells);
		insert.run("L", "local", "local", null, cmd, JSON.stringify([cmd]));
		// Never connected: what the user typed, or nothing.
		insert.run("N", "ssh", "new", "new.test", "/usr/bin/fish", null);
		insert.run("E", "ssh", "empty", "empty.test", null, null);
		expect(versions(before)).toEqual([{ version: 21 }, { version: 22 }]);
		before.close();
	}

	it("copies a connected host's value to the agent's column, and leaves default_shell as it is", () => {
		databaseAt22();

		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		const row = (
			id: string,
			left: string | null,
			reported: string | null,
			found: string | null,
		) => ({
			id,
			default_shell: left,
			discovered_default_shell: reported,
			discovered_shells: found,
			updated_at: at,
		});
		expect(shells(dbs.meta)).toEqual([
			row("C", "/bin/bash", "/bin/bash", piShells),
			row("E", null, null, null),
			row("L", cmd, cmd, JSON.stringify([cmd])),
			row("N", "/usr/bin/fish", null, null),
		]);
		// As the hub reads them: the agent's default where one connected, and no
		// default_shell anywhere (#802).
		const dal = new MetaDAL(dbs.meta);
		expect(dal.getHost("C")?.discoveredDefaultShell).toBe("/bin/bash");
		expect(dal.getHost("N")?.discoveredDefaultShell).toBeUndefined();
		for (const id of ["C", "E", "L", "N"]) {
			expect(dal.getHost(id)).not.toHaveProperty("defaultShell");
		}
	});

	it("is not run again over what a connection recorded since", async () => {
		databaseAt22();
		dbs = openDatabases(dir);
		dbs.meta
			.prepare("UPDATE hosts SET discovered_default_shell = '/usr/bin/fish' WHERE id = 'C'")
			.run();
		const chosen = shells(dbs.meta);
		await dbs.close();

		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(shells(dbs.meta)).toEqual(chosen);
	});
});

// ─── Migration 024: whose launch profile override it is (#800) ───────────────
//
// A hub before #800 marked the profile of its agent's default shell as the
// host's default at every connection, over any default the user had set. Every
// default mark a database it left holds is the agent's.

describe("meta.db migration 024: a launch profile override says whether the user set it", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-024-");
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const migration = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./migrations/meta/${name}`, import.meta.url)), "utf-8");
	const versions = (db: Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const overrides = (db: Database) =>
		db.prepare("SELECT * FROM host_launch_profiles ORDER BY profile_id").all();

	const at = "2026-10-01T00:00:00.000Z";

	/** A database as #799 left it: version 23, with the agent's default marked on the host. */
	function databaseAt23(): void {
		const before = new Database(join(dir, "meta.db"));
		for (const file of [
			"021-baseline.sql",
			"022-unpadded-ssh-pins.sql",
			"023-discovered-default-shell.sql",
		]) {
			before.exec(migration(file));
		}
		before
			.prepare(
				`INSERT INTO hosts (id, type, label, ssh_host, created_at, updated_at)
				VALUES ('H', 'ssh', 'pi', 'pi.test', '${at}', '${at}')`,
			)
			.run();
		const profile = before.prepare(
			`INSERT INTO launch_profiles (id, name, shell, supported_os, sort_order, created_at, updated_at)
			VALUES (?, ?, ?, 'linux', ?, '${at}', '${at}')`,
		);
		profile.run("P1", "bash", "/bin/bash", 0);
		profile.run("P2", "fish", "/usr/bin/fish", 1);
		const override = before.prepare(
			"INSERT INTO host_launch_profiles (host_id, profile_id, override_type, sort_order) VALUES ('H', ?, ?, ?)",
		);
		override.run("P1", "default", null);
		override.run("P2", "pin", 1);
		expect(versions(before)).toEqual([{ version: 21 }, { version: 22 }, { version: 23 }]);
		before.close();
	}

	it("reads every override already there as not the user's, and changes nothing else", () => {
		databaseAt23();

		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(overrides(dbs.meta)).toEqual([
			{
				host_id: "H",
				profile_id: "P1",
				override_type: "default",
				sort_order: null,
				set_by_user: 0,
			},
			{ host_id: "H", profile_id: "P2", override_type: "pin", sort_order: 1, set_by_user: 0 },
		]);
		expect(new MetaDAL(dbs.meta).getHostDefaultOverride("H")).toMatchObject({
			profileId: "P1",
			setByUser: false,
		});
	});

	it("leaves the agent's mark free to follow the agent", async () => {
		databaseAt23();
		dbs = openDatabases(dir);
		const dal = new MetaDAL(dbs.meta);
		// The seeding reports what it seeded on stderr
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

		await seedShellProfiles("H", ["/bin/bash", "/usr/bin/fish"], "/usr/bin/fish", "linux", dal);
		quiet.mockRestore();

		expect(dal.getHostDefaultOverride("H")).toMatchObject({ profileId: "P2", setByUser: false });
	});
});

// ─── Migration 025: a launch profile's PowerShell reports its directory (#839) ─
//
// The switch changes the command line a shell starts with: no profile already
// there turns it on by being migrated.

describe("meta.db migration 025: a launch profile can have its PowerShell report its directory", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-025-");
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const migration = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./migrations/meta/${name}`, import.meta.url)), "utf-8");
	const at = "2026-11-01T00:00:00.000Z";

	/** A database as #800 left it: version 24, with a PowerShell profile. */
	function databaseAt24(): void {
		const before = new Database(join(dir, "meta.db"));
		for (const file of [
			"021-baseline.sql",
			"022-unpadded-ssh-pins.sql",
			"023-discovered-default-shell.sql",
			"024-launch-profile-set-by-user.sql",
		]) {
			before.exec(migration(file));
		}
		before
			.prepare(
				`INSERT INTO launch_profiles (id, name, shell, supported_os, sort_order, created_at, updated_at)
				VALUES ('P1', 'PowerShell', 'pwsh.exe', 'windows', 0, '${at}', '${at}')`,
			)
			.run();
		before.close();
	}

	it("reads every profile already there as off, and changes nothing else", () => {
		databaseAt24();

		dbs = openDatabases(dir);

		expect(dbs.meta.prepare("SELECT version FROM schema_version ORDER BY rowid").all()).toEqual([
			{ version: 21 },
			{ version: 22 },
			{ version: 23 },
			{ version: 24 },
			{ version: 25 },
			{ version: 26 },
		]);
		expect(
			dbs.meta.prepare("SELECT id, report_directory, updated_at FROM launch_profiles").all(),
		).toEqual([{ id: "P1", report_directory: 0, updated_at: at }]);
		expect(new MetaDAL(dbs.meta).getLaunchProfile("P1")).toMatchObject({
			name: "PowerShell",
			reportDirectory: false,
		});
	});

	it("stores the switch a profile is created or updated with", () => {
		databaseAt24();
		dbs = openDatabases(dir);
		const dal = new MetaDAL(dbs.meta);

		const created = dal.createLaunchProfile({
			name: "PowerShell, reporting",
			shell: "pwsh.exe",
			mode: "shell",
			elevated: false,
			supportedOs: "windows",
			iconType: "auto",
			sortOrder: 1,
			reportDirectory: true,
		});
		expect(dal.getLaunchProfile(created.id)?.reportDirectory).toBe(true);
		expect(dal.updateLaunchProfile("P1", { reportDirectory: true })?.reportDirectory).toBe(true);
		expect(dal.updateLaunchProfile("P1", { name: "PS" })?.reportDirectory).toBe(true);
		expect(dal.updateLaunchProfile("P1", { reportDirectory: false })?.reportDirectory).toBe(false);
	});
});

// ─── Migration 026: uploads that survive a hub restart (#860) ───────────────
//
// Two tables added, nothing else touched. A hub before #860 opens a database
// at 26 as one ahead of its migrations, never names the tables, and a host it
// deletes takes its uploads with it, through the cascades.

describe("meta.db migration 026: the uploads' tables", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-db-026-");
	});

	afterEach(async () => {
		await dbs?.close();
		dbs = undefined;
		vi.doUnmock("./migration-files.js");
		vi.resetModules();
		await removeTempDir(dir);
	});

	const migration = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./migrations/meta/${name}`, import.meta.url)), "utf-8");
	const versions = (db: Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const tables = (db: Database) =>
		(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((table) => table.name);
	const columns = (db: Database, table: string) =>
		(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(column) => column.name,
		);
	/** Every table but the version's, with its columns and its rows. */
	const contents = (db: Database) =>
		Object.fromEntries(
			tables(db)
				.filter((table) => table !== "schema_version")
				.map((table) => [
					table,
					{ columns: columns(db, table), rows: db.prepare(`SELECT * FROM ${table}`).all() },
				]),
		);
	const count = (db: Database, table: string) =>
		(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
	const upTo25 = [
		{ version: 21 },
		{ version: 22 },
		{ version: 23 },
		{ version: 24 },
		{ version: 25 },
	];

	const at = "2026-11-01T00:00:00.000Z";

	/** A database as #839 left it: version 25, two hosts, a session and its terminal. */
	function databaseAt25(): ReturnType<typeof contents> {
		const before = new Database(join(dir, "meta.db"));
		for (const file of [
			"021-baseline.sql",
			"022-unpadded-ssh-pins.sql",
			"023-discovered-default-shell.sql",
			"024-launch-profile-set-by-user.sql",
			"025-launch-profile-report-directory.sql",
		]) {
			before.exec(migration(file));
		}
		const host = before.prepare(
			`INSERT INTO hosts (id, type, label, ssh_host, created_at, updated_at)
			VALUES (?, 'ssh', ?, ?, '${at}', '${at}')`,
		);
		host.run("H", "pi", "pi.test");
		host.run("H2", "box", "box.test");
		before
			.prepare(
				`INSERT INTO sessions (id, host_id, status, created_at, updated_at)
				VALUES ('S', 'H', 'active', '${at}', '${at}')`,
			)
			.run();
		before
			.prepare(
				`INSERT INTO channels (id, session_id, status, shell, created_at, updated_at)
				VALUES ('C', 'S', 'live', 'bash', '${at}', '${at}')`,
			)
			.run();
		const snapshot = contents(before);
		expect(versions(before)).toEqual(upTo25);
		before.close();
		return snapshot;
	}

	/** An upload to `hostId`, with one file. */
	function uploadTo(db: Database, id: string, hostId: string): void {
		new TransfersDAL(db).insert(
			{
				id,
				hostId,
				channelId: "C",
				tokenId: null,
				destDir: "/srv",
				pathStyle: "posix",
				direction: "upload",
				state: "interrupted",
				onConflict: "ask",
				verify: true,
				signature: "s",
				reason: null,
				createdAt: at,
				updatedAt: at,
			},
			[
				{
					id: 0,
					parentId: null,
					relPath: "a.bin",
					kind: "file",
					size: 10,
					mtime: null,
					state: "interrupted",
					ackedOffset: 4,
					tempPath: "/srv/.a.bin.0123456789abcdef.partial",
					tempWhole: false,
					direct: false,
					finalName: null,
					resolution: null,
					outcome: null,
					verification: null,
					existingJson: null,
					typeClash: false,
					late: false,
					errorCode: null,
					reason: null,
					updatedAt: at,
				},
			],
		);
	}

	it("adds the two tables, and changes nothing that was there", () => {
		const before = databaseAt25();

		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([...upTo25, { version: 26 }]);
		const after = contents(dbs.meta);
		expect(Object.keys(after).filter((table) => !(table in before))).toEqual([
			"transfer_items",
			"transfers",
		]);
		for (const [table, was] of Object.entries(before)) expect(after[table]).toEqual(was);
		expect(columns(dbs.meta, "transfers")).toEqual([
			"id",
			"host_id",
			"channel_id",
			"token_id",
			"dest_dir",
			"path_style",
			"direction",
			"state",
			"on_conflict",
			"verify",
			"signature",
			"reason",
			"created_at",
			"updated_at",
		]);
		expect(columns(dbs.meta, "transfer_items")).toEqual([
			"transfer_id",
			"id",
			"parent_id",
			"rel_path",
			"kind",
			"size",
			"mtime",
			"state",
			"acked_offset",
			"temp_path",
			"temp_whole",
			"direct",
			"final_name",
			"resolution",
			"outcome",
			"verification",
			"existing_json",
			"type_clash",
			"late",
			"error_code",
			"reason",
			"updated_at",
		]);
		expect(
			dbs.meta
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_transfer%' ORDER BY name",
				)
				.all(),
		).toEqual([{ name: "idx_transfer_items_state" }, { name: "idx_transfers_host" }]);
		// An upload goes with its host, and its items with it.
		uploadTo(dbs.meta, "T", "H2");
		expect(new TransfersDAL(dbs.meta).items("T")).toHaveLength(1);
		expect(new MetaDAL(dbs.meta).deleteHost("H2")).toBe(true);
		expect(count(dbs.meta, "transfers")).toBe(0);
		expect(count(dbs.meta, "transfer_items")).toBe(0);
	});

	it("is ignored by a hub without it, which opens the database and deletes a host with uploads", async () => {
		databaseAt25();
		dbs = openDatabases(dir);
		uploadTo(dbs.meta, "T", "H2");
		uploadTo(dbs.meta, "U", "H");
		await dbs.close();
		dbs = undefined;

		// The hub before #860: its migrations stop at 025.
		vi.resetModules();
		vi.doMock("./migration-files.js", async (importOriginal) => {
			const real = await importOriginal<typeof import("./migration-files.js")>();
			return {
				...real,
				readMigrationFiles: (set: Parameters<typeof real.readMigrationFiles>[0]) =>
					real
						.readMigrationFiles(set)
						.filter((file) => set !== "meta" || Number.parseInt(file.file, 10) <= 25),
			};
		});
		const older = await import("./db.js");
		const said = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		dbs = older.openDatabases(dir);
		const ahead = said.mock.calls.some(([text]) =>
			String(text).includes("ahead of latest migration"),
		);
		said.mockRestore();

		expect(ahead).toBe(true);
		expect(versions(dbs.meta)).toEqual([...upTo25, { version: 26 }]);
		const meta = new MetaDAL(dbs.meta);
		expect(meta.getHost("H")?.label).toBe("pi");
		expect(meta.deleteHost("H2")).toBe(true);
		expect(count(dbs.meta, "transfers")).toBe(1);
		expect(count(dbs.meta, "transfer_items")).toBe(1);
		expect(tables(dbs.meta)).toEqual(expect.arrayContaining(["transfer_items", "transfers"]));
	});
});
