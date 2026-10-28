/**
 * Test-only: what opening a profile's databases must do, as cases run on two
 * modules. db.spec.ts runs them on storage/db.ts, and
 * scripts/build-sea-hub.spec.ts on db.ts as the single executable bundles it.
 *
 * Until #745 the executable bundled a copy of its own in db.ts's place. The copy
 * left the files' mode to the umask and skipped the checkpoint on close, and
 * every spec ran db.ts, so nothing saw the difference.
 *
 * The started executable has cases of its own (scripts/sea-hub-e2e.spec.ts),
 * and builds the meta.db it must refuse with the helpers below.
 */
import { existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { DatabaseManager } from "./db.js";
import { type MigrationSet, readMigrationFiles } from "./migration-files.js";

export type OpenDatabases = (dataDir: string) => DatabaseManager;

const DATABASES = { meta: "meta.db", spool: "spool.db" } as const satisfies Record<
	MigrationSet,
	string
>;

/** The version of the last migration of `set`, the one a new database comes out at. */
function lastMigration(set: MigrationSet): number {
	const last = readMigrationFiles(set).at(-1);
	if (last === undefined) throw new Error(`no ${set} migration found`);
	return Number.parseInt(last.file.slice(0, 3), 10);
}

function schemaVersion(db: Database.Database): number | null {
	return (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null })
		.v;
}

/**
 * A meta.db as the migrations squashed into the baseline left it at `version`
 * (STORAGE.md § 9.3): in WAL mode, every version up to `version` recorded, and a
 * `hosts` table, with a row, which the baseline creates again.
 */
export function createMetaDbBeforeBaseline(file: string, version: number): void {
	const db = new Database(file);
	try {
		db.pragma("journal_mode = WAL");
		db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)");
		const record = db.prepare(
			"INSERT INTO schema_version (version, applied_at) VALUES (?, '2026-06-01 00:00:00')",
		);
		for (let applied = 1; applied <= version; applied++) record.run(applied);
		db.exec("CREATE TABLE hosts (id TEXT PRIMARY KEY, label TEXT NOT NULL)");
		db.prepare("INSERT INTO hosts (id, label) VALUES (?, ?)").run("H1", "here");
	} finally {
		db.close();
	}
}

/** What the hub says of a meta.db at `file` that is at `version`, before the baseline. */
export function beforeBaselineRefusal(file: string, version: number): string {
	return `${file} is at schema version ${version}, which predates the first public release: this hub's migrations start at version ${metaBaseline()} and cannot upgrade it. Move it aside to start fresh.`;
}

/** The version of the first meta.db migration, the baseline. */
function metaBaseline(): number {
	const first = readMigrationFiles("meta")[0];
	if (first === undefined) throw new Error("no meta migration found");
	return Number.parseInt(first.file.slice(0, 3), 10);
}

/** The cases, under `subject`; `open` is called by each case, after any `beforeAll`. */
export function describeOpenDatabases(subject: string, open: () => OpenDatabases): void {
	describe(`opening a profile's databases: ${subject}`, () => {
		let dir: string;
		let dbs: DatabaseManager | undefined;
		let umask: number | undefined;

		beforeEach(() => {
			dir = makeTempDir("lasterm-open-dbs-");
			// The usual umask, under which SQLite alone creates a database 0644.
			if (process.platform !== "win32") umask = process.umask(0o022);
		});

		afterEach(async () => {
			dbs?.close();
			dbs = undefined;
			if (umask !== undefined) process.umask(umask);
			umask = undefined;
			await removeTempDir(dir);
		});

		it("creates both databases at their last migration", () => {
			dbs = open()(dir);
			expect(schemaVersion(dbs.meta)).toBe(lastMigration("meta"));
			expect(schemaVersion(dbs.spool)).toBe(lastMigration("spool"));
		});

		// Windows has no such mode, and relies on the profile's ACL (STORAGE.md § 2).
		it.skipIf(process.platform === "win32")("creates both owner-only, 0600 (#536)", () => {
			dbs = open()(dir);
			for (const name of Object.values(DATABASES)) {
				const mode = (statSync(join(dir, name)).mode & 0o777).toString(8);
				expect([name, mode]).toEqual([name, "600"]);
			}
		});

		it("empties both WAL files as it closes, even while another connection holds the database", () => {
			dbs = open()(dir);
			// A connection that has read keeps its hold on the file, so this close is
			// not the last one, and SQLite neither checkpoints nor deletes the WAL by
			// itself: only the checkpoint close() runs can empty it.
			const readers = Object.values(DATABASES).map((name) => {
				const reader = new Database(join(dir, name));
				reader.prepare("SELECT COUNT(*) FROM schema_version").get();
				return reader;
			});
			try {
				for (const name of Object.values(DATABASES)) {
					expect([name, statSync(join(dir, `${name}-wal`)).size > 0]).toEqual([name, true]);
				}
				dbs.close();
				dbs = undefined;
				for (const name of Object.values(DATABASES)) {
					expect([name, statSync(join(dir, `${name}-wal`)).size]).toEqual([name, 0]);
				}
			} finally {
				for (const reader of readers) reader.close();
			}
		});

		// Mutation caught: applying the baseline anyway, which stops on "table
		// hosts already exists" with nothing said of what to do.
		it.each([1, 20])(
			"refuses a meta.db at schema version %i, from before the baseline, and keeps it as it was (#747)",
			(version) => {
				const meta = join(dir, "meta.db");
				createMetaDbBeforeBaseline(meta, version);

				expect(() => {
					dbs = open()(dir);
				}).toThrow(beforeBaselineRefusal(meta, version));

				// No connection is left on it: its WAL went with the last one, and it
				// moves aside, which Windows refuses for a file SQLite still has open.
				expect(existsSync(`${meta}-wal`)).toBe(false);
				renameSync(meta, `${meta}.aside`);
				const aside = new Database(`${meta}.aside`, { readonly: true });
				try {
					expect(schemaVersion(aside)).toBe(version);
					expect(aside.prepare("SELECT id, label FROM hosts").all()).toEqual([
						{ id: "H1", label: "here" },
					]);
				} finally {
					aside.close();
				}

				// Moved aside, as the message says, it leaves the hub to start fresh.
				dbs = open()(dir);
				expect(schemaVersion(dbs.meta)).toBe(lastMigration("meta"));
			},
		);
	});
}
