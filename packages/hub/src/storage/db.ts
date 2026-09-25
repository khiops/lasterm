import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "migrations");

/** The files SQLite keeps beside a database in WAL mode. */
const WAL_FILE_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * Make a database and the files SQLite keeps beside it owner-only (0600), before
 * SQLite opens it (STORAGE.md § 2, #536). `meta.db` holds token hashes and host
 * definitions, `spool.db` terminal output.
 *
 * The database file is created 0600 when it does not exist yet: left to SQLite,
 * it would get 0644 under the usual umask of 022. An existing one is set to 0600,
 * and so is a `-wal` or `-shm` file an earlier run left behind: a database an
 * earlier version created, or one copied in, has whatever mode the umask gave it.
 * The `-wal` and `-shm` files SQLite creates from then on take the database's
 * mode, which SQLite copies to them on Unix.
 *
 * A file another account owns, or one that is not a regular file, stops the hub:
 * lasterm does not change another account's file, and SQLite could not keep a
 * FIFO or a directory anyway.
 *
 * Windows is not touched. chmod there only toggles the read-only attribute, and
 * the files rely on the profile's default ACL, as auth.json does (#200).
 */
export function restrictDatabaseFiles(
	databasePath: string,
	options: { readonly uid?: number } = {},
): void {
	if (process.platform === "win32") return;
	// The account the files must belong to. Defaults to the effective uid; tests substitute it.
	const uid = options.uid ?? process.geteuid?.();
	restrictToOwner(databasePath, uid, { create: true });
	for (const suffix of WAL_FILE_SUFFIXES) {
		restrictToOwner(`${databasePath}${suffix}`, uid, { create: false });
	}
}

/**
 * Set `file` to 0600 through a descriptor, so the mode lands on the file that
 * was inspected. A link is followed, as SQLite follows it. O_NONBLOCK keeps a
 * FIFO in its place from blocking the open until the check refuses it.
 */
function restrictToOwner(
	file: string,
	uid: number | undefined,
	{ create }: { create: boolean },
): void {
	const flags = constants.O_RDONLY | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0);
	let fd: number;
	try {
		fd = openSync(file, flags, 0o600);
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			throw new Error(`SECURITY: database file at ${file} is not a regular file`);
		}
		if (uid !== undefined && stat.uid !== uid) {
			throw new Error(
				`SECURITY: database file at ${file} is owned by uid ${stat.uid}, not by this account (uid ${uid})`,
			);
		}
		// Exactly 0600, whatever the umask removed from a file just created.
		if ((stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
	} finally {
		closeSync(fd);
	}
}

export interface DatabaseManager {
	meta: Database.Database;
	spool: Database.Database;
	close(): void;
}

function checkpointAndClose(db: Database.Database): void {
	if (!db.open) return;
	try {
		db.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		if (db.open) db.close();
	}
}

function applyCommonPragmas(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	db.pragma("cache_size = -8000");
}

function applySpoolPragmas(db: Database.Database): void {
	const currentAutoVacuum = db.pragma("auto_vacuum", { simple: true }) as number;
	if (currentAutoVacuum !== 2) {
		db.pragma("auto_vacuum = INCREMENTAL");
	}
}

function runMigrations(db: Database.Database, migrationsDir: string): void {
	const hasSchemaVersion =
		db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
			.get() !== undefined;

	let currentVersion = 0;
	if (hasSchemaVersion) {
		const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
			v: number | null;
		};
		currentVersion = row.v ?? 0;
	}

	let files: string[];
	try {
		files = readdirSync(migrationsDir)
			.filter((f) => /^\d{3}-.*\.sql$/.test(f))
			.sort();
	} catch {
		// No migrations directory — nothing to apply
		return;
	}

	const parseNum = (filename: string): number => Number.parseInt(filename.slice(0, 3), 10);

	const lastFile = files[files.length - 1];
	const latestMigration = files.length > 0 && lastFile !== undefined ? parseNum(lastFile) : 0;

	if (currentVersion > latestMigration && latestMigration > 0) {
		process.stderr.write("[storage] DB schema version ahead of latest migration - skipping\n");
		return;
	}

	for (const file of files) {
		const num = parseNum(file);
		if (num <= currentVersion) continue;

		const sql = readFileSync(join(migrationsDir, file), "utf-8");

		const applyMigration = db.transaction(() => {
			db.exec(sql);
			const versionAfter = db.prepare("SELECT MAX(version) as v FROM schema_version").get() as {
				v: number | null;
			};
			if ((versionAfter.v ?? 0) < num) {
				db.prepare(
					"INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
				).run(num);
			}
		});

		applyMigration();
	}
}

export function openDatabases(dataDir: string): DatabaseManager {
	const metaPath = join(dataDir, "meta.db");
	const spoolPath = join(dataDir, "spool.db");
	// Both before either opens, so a refusal leaves no connection behind.
	restrictDatabaseFiles(metaPath);
	restrictDatabaseFiles(spoolPath);

	const metaDb = new Database(metaPath);
	applyCommonPragmas(metaDb);
	metaDb.pragma("wal_autocheckpoint = 1000");

	const spoolDb = new Database(spoolPath);
	applySpoolPragmas(spoolDb);
	applyCommonPragmas(spoolDb);
	spoolDb.pragma("wal_autocheckpoint = 2000");

	runMigrations(metaDb, join(MIGRATIONS_DIR, "meta"));
	runMigrations(spoolDb, join(MIGRATIONS_DIR, "spool"));

	return {
		meta: metaDb,
		spool: spoolDb,
		close() {
			checkpointAndClose(metaDb);
			checkpointAndClose(spoolDb);
		},
	};
}

export function openTestDatabases(): DatabaseManager {
	const metaDb = new Database(":memory:");
	applyCommonPragmas(metaDb);
	metaDb.pragma("wal_autocheckpoint = 1000");

	const spoolDb = new Database(":memory:");
	applySpoolPragmas(spoolDb);
	applyCommonPragmas(spoolDb);
	spoolDb.pragma("wal_autocheckpoint = 2000");

	runMigrations(metaDb, join(MIGRATIONS_DIR, "meta"));
	runMigrations(spoolDb, join(MIGRATIONS_DIR, "spool"));

	return {
		meta: metaDb,
		spool: spoolDb,
		close() {
			checkpointAndClose(metaDb);
			checkpointAndClose(spoolDb);
		},
	};
}
