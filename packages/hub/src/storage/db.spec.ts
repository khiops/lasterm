import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { DatabaseManager } from "./db.js";
import { openDatabases, openTestDatabases, restrictDatabaseFiles } from "./db.js";

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

	it("meta.db: schema_version is 20 after migration", () => {
		dbs = openTestDatabases();
		const row = dbs.meta.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
			v: number;
		};
		expect(row.v).toBe(20);
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
		expect(tableNames).toContain("workspaces");
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

	it("migration runner is idempotent (running twice produces same schema_version = 20)", () => {
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

		expect(v1).toBe(20);
		expect(v2).toBe(20);
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
