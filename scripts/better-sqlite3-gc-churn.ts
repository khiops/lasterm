/**
 * The garbage-collector churn of better-sqlite3's addon (#883, docs/STORAGE.md § 2), shared by
 * packages/hub/src/storage/better-sqlite3-gc.spec.ts and by package-sea-hub.ts, which runs it on
 * the addon the executable embeds.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

/** better-sqlite3's entry point, resolved from the hub's package as the hub resolves it. */
const BETTER_SQLITE3 = createRequire(
	new URL("../packages/hub/package.json", import.meta.url),
).resolve("better-sqlite3");

/**
 * Opens in-memory databases and prepares, runs and drops statements on them by the ten
 * thousand, amid other garbage. Half the databases are closed before they are dropped, half
 * are dropped open. The garbage collector reclaims the statements and the databases on its
 * own, as it does in a hub that runs for days.
 *
 * What aborts, with an addon built from source on Node 24.21, is a collection that an
 * allocation in JavaScript triggers. A collection run by `gc()` reclaimed statements without
 * harm, and an earlier churn that turned the event loop between rounds survived 8 runs in 20. So this one makes its garbage in JavaScript, several objects per statement, and never
 * yields: it then aborted 60 runs in 60, on Node 24.21 and 24.14.
 *
 * It prints the addon it loaded, then that it survived.
 */
const CHURN = `
const Database = require(process.argv[1]);
const options = process.argv[2] ? { nativeBinding: process.argv[2] } : {};
let garbage = [];
for (let round = 0; round < 20; round++) {
	const db = new Database(":memory:", options);
	if (round === 0) {
		const addon = Object.keys(require.cache).find((file) => file.endsWith(".node"));
		process.stdout.write("addon " + addon + "\\n");
	}
	db.pragma("journal_mode = WAL");
	db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
	for (let i = 0; i < 2500; i++) {
		db.prepare("INSERT INTO t (v) VALUES (?)").run(String(i));
		db.prepare("SELECT v FROM t WHERE id = ?").get(i + 1);
		for (let k = 0; k < 8; k++) garbage.push({ round, i, k });
		if (garbage.length > 8000) garbage = [];
	}
	if (round % 2 === 0) db.close();
}
process.stdout.write("survived\\n");
`;

export interface ChurnResult {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Run the churn in a process of its own, under the Node running this one: an abort is then a
 * result, not the end of the caller.
 *
 * @param nativeBinding the `.node` file to load, through better-sqlite3's `nativeBinding`
 *   option. Without it, better-sqlite3 finds its addon itself, as the hub run from source does.
 */
export function churnBetterSqlite3(nativeBinding?: string): Promise<ChurnResult> {
	return new Promise((resolve, reject) => {
		const args = ["-e", CHURN, BETTER_SQLITE3];
		if (nativeBinding !== undefined) args.push(nativeBinding);
		const child = spawn(process.execPath, args);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
}
