import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The databases that have migrations (STORAGE.md § 9.2). */
export type MigrationSet = "meta" | "spool";

/** One migration: its file name, whose three-digit prefix is its version, and its SQL. */
export interface MigrationFile {
	readonly file: string;
	readonly sql: string;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const MIGRATION_FILE_NAME = /^\d{3}-.*\.sql$/;

/**
 * The migrations of one database, in the order they apply (STORAGE.md § 9.2):
 * the `NNN-*.sql` files of `migrations/<set>/` beside this module, sorted by name.
 *
 * The single executable has no such directory. scripts/build-sea-hub.ts puts a
 * module in this one's place that returns these same files, read with this
 * function when the executable was built. Only this module is replaced, so the
 * executable opens its databases with db.ts itself, the module the specs cover
 * (#745).
 */
export function readMigrationFiles(set: MigrationSet): MigrationFile[] {
	const dir = join(MIGRATIONS_DIR, set);
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((file) => MIGRATION_FILE_NAME.test(file))
			.sort();
	} catch {
		// No migrations directory: nothing to apply.
		return [];
	}
	return files.map((file) => ({ file, sql: readFileSync(join(dir, file), "utf-8") }));
}
