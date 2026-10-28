import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprintOf } from "../ssh/fingerprint.js";
import { sshAddress, targetRoute } from "../ssh-route.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { DatabaseManager } from "./db.js";
import { openDatabases, openTestDatabases, restrictDatabaseFiles } from "./db.js";
import { MetaDAL } from "./meta.js";
import { describeOpenDatabases } from "./open-databases.fixture.js";

describe("openTestDatabases", () => {
	let dbs: DatabaseManager;

	afterEach(() => {
		dbs?.close();
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

	it("meta.db: schema_version is 22 after migration", () => {
		dbs = openTestDatabases();
		const row = dbs.meta.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
			v: number;
		};
		expect(row.v).toBe(22);
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

	it("migration runner is idempotent (running twice produces same schema_version = 22)", () => {
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

		expect(v1).toBe(22);
		expect(v2).toBe(22);
	});

	it("close() does not throw", () => {
		dbs = openTestDatabases();
		expect(() => dbs.close()).not.toThrow();
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
		dbs?.close();
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
		dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const versions = (db: Database.Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const tables = (db: Database.Database) =>
		(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((table) => table.name);
	const columns = (db: Database.Database, table: string) =>
		(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(column) => column.name,
		);

	it("comes out new at version 22, with the final schema", () => {
		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([{ version: 21 }, { version: 22 }]);
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
		]);
		expect(columns(dbs.meta, "channels")).toContain("end_reason");
		expect(columns(dbs.meta, "auth_tokens")).toContain("swept_at");
		expect(columns(dbs.meta, "pairing_codes")).toContain("code_hash");
	});

	it("does not run the baseline on a database already at version 21", () => {
		// What the migrations before the baseline left: version 21, with a table
		// and a column the baseline no longer has. Only 022 runs on it.
		const before = new Database(join(dir, "meta.db"));
		before.exec(`
			CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL);
			INSERT INTO schema_version VALUES (21, '2026-10-01 00:00:00');
			CREATE TABLE hosts (
				id TEXT PRIMARY KEY, label TEXT, keep_alive_seconds INTEGER DEFAULT 60,
				ssh_fingerprint TEXT, ssh_proxy_fingerprint TEXT
			);
			INSERT INTO hosts (id, label) VALUES ('H1', 'here');
			CREATE TABLE workspaces (id TEXT PRIMARY KEY);
		`);
		before.close();

		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([{ version: 21 }, { version: 22 }]);
		expect(tables(dbs.meta)).toEqual(["hosts", "schema_version", "workspaces"]);
		expect(columns(dbs.meta, "hosts")).toEqual([
			"id",
			"label",
			"keep_alive_seconds",
			"ssh_fingerprint",
			"ssh_proxy_fingerprint",
		]);
		expect(dbs.meta.prepare("SELECT * FROM hosts").all()).toEqual([
			{
				id: "H1",
				label: "here",
				keep_alive_seconds: 60,
				ssh_fingerprint: null,
				ssh_proxy_fingerprint: null,
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
		dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	const migration = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./migrations/meta/${name}`, import.meta.url)), "utf-8");
	/** A key's fingerprint as 0.14.3 wrote it, padding and all. */
	const padded = (keyBlob: Buffer) =>
		`SHA256:${createHash("sha256").update(keyBlob).digest("base64")}`;
	const versions = (db: Database.Database) =>
		db.prepare("SELECT version FROM schema_version ORDER BY rowid").all();
	const pins = (db: Database.Database) =>
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

		expect(versions(dbs.meta)).toEqual([{ version: 21 }, { version: 22 }]);
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

	it("comes out new at version 22", () => {
		dbs = openDatabases(dir);

		expect(versions(dbs.meta)).toEqual([{ version: 21 }, { version: 22 }]);
		expect(pins(dbs.meta)).toEqual([]);
	});

	it("changes nothing when it runs again", () => {
		databaseAt21();
		dbs = openDatabases(dir);
		const migrated = pins(dbs.meta);
		dbs.close();

		// The runner does not run it twice...
		dbs = openDatabases(dir);
		expect(versions(dbs.meta)).toEqual([{ version: 21 }, { version: 22 }]);
		expect(pins(dbs.meta)).toEqual(migrated);

		// ...and its statements find nothing left to change if they do run.
		const updates = migration("022-unpadded-ssh-pins.sql").replace(
			/INSERT INTO schema_version[^;]*;/,
			"",
		);
		const changes = dbs.meta.prepare("SELECT total_changes()").pluck();
		const before = changes.get();
		dbs.meta.exec(updates);
		expect(changes.get()).toBe(before);
		expect(pins(dbs.meta)).toEqual(migrated);
	});
});
