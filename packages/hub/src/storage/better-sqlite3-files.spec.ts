/**
 * The hub moved from better-sqlite3 to node:sqlite (#893), on the same files:
 * no migration, no schema change. A profile better-sqlite3 wrote must open
 * unchanged, after a crash that left its WAL behind included, and better-sqlite3
 * must open what node:sqlite wrote, so that reverting the switch keeps the
 * profile too.
 *
 * Each library runs in its own process. Two copies of SQLite in one process
 * must never open the same file: on POSIX, closing one copy's descriptor drops
 * the locks the other copy holds on it.
 *
 * These go with better-sqlite3, when it leaves the repository.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { type DatabaseManager, openDatabases } from "./db.js";
import { MetaDAL } from "./meta.js";
import { readMigrationFiles } from "./migration-files.js";
import { SpoolDAL } from "./spool.js";

/** The hub's package.json, from which a child resolves better-sqlite3 as the hub did. */
const HUB_PACKAGE = fileURLToPath(new URL("../../package.json", import.meta.url));

const CHUNK_BYTES = 256 * 1024;
const CHUNKS = 24;

/** Chunk `index`'s data: 256 KiB, each chunk its own bytes. */
function chunkData(index: number): Buffer {
	const data = Buffer.alloc(CHUNK_BYTES, (index * 7 + 1) & 0xff);
	data.write(`chunk ${index}`, 0, "latin1");
	return data;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Run `script` (CommonJS) in a child Node with `env` added, from a file in `dir`. */
function runChild(dir: string, name: string, script: string, env: Record<string, string>) {
	const file = join(dir, name);
	writeFileSync(file, script);
	return spawnSync(process.execPath, [file], {
		encoding: "utf8",
		env: { ...process.env, ...env, HUB_PACKAGE },
		timeout: 60_000,
	});
}

// A hub before #893 opening a new profile: db.ts's pragmas and migration runner,
// on better-sqlite3. It writes a host and the chunks, deletes every other chunk,
// and is killed before it closes anything.
const WRITER = `
const { createRequire } = require("node:module");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const Database = createRequire(process.env.HUB_PACKAGE)("better-sqlite3");
const dir = process.env.DATA_DIR;
const migrations = JSON.parse(readFileSync(process.env.MIGRATIONS, "utf8"));
function open(file, spool) {
	const db = new Database(join(dir, file));
	if (spool) db.pragma("auto_vacuum = INCREMENTAL");
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("foreign_keys = ON");
	db.pragma(spool ? "wal_autocheckpoint = 2000" : "wal_autocheckpoint = 1000");
	return db;
}
function migrate(db, files) {
	for (const { file, sql } of files) {
		const num = Number.parseInt(file.slice(0, 3), 10);
		db.transaction(() => {
			db.exec(sql);
			const { v } = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
			if ((v ?? 0) < num) {
				db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))").run(num);
			}
		})();
	}
}
const meta = open("meta.db", false);
migrate(meta, migrations.meta);
const spool = open("spool.db", true);
migrate(spool, migrations.spool);
const now = new Date().toISOString();
meta.prepare("INSERT INTO hosts (id, type, label, ssh_host, created_at, updated_at) VALUES (?, 'ssh', ?, ?, ?, ?)")
	.run("H1", "written by better-sqlite3", "user@example", now, now);
const insert = spool.prepare(
	"INSERT INTO chunks (id, channel_id, seq, ts, kind, codec, data_blob, uncompressed_len) VALUES (?, 'C1', ?, ?, 'output', 'raw', ?, ?)",
);
for (let i = 0; i < ${CHUNKS}; i++) {
	const data = Buffer.alloc(${CHUNK_BYTES}, (i * 7 + 1) & 0xff);
	data.write("chunk " + i, 0, "latin1");
	insert.run("K" + i, i + 1, now, data, data.length);
}
spool.prepare("DELETE FROM chunks WHERE seq % 2 = 0").run();
writeFileSync(join(dir, "written"), "");
process.kill(process.pid, "SIGKILL");
`;

// A hub before #893 reading what this one left open: the host, and each chunk's digest.
const READER = `
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const Database = createRequire(process.env.HUB_PACKAGE)("better-sqlite3");
const dir = process.env.DATA_DIR;
const meta = new Database(join(dir, "meta.db"));
const spool = new Database(join(dir, "spool.db"));
const out = {
	host: meta.prepare("SELECT label, ssh_host FROM hosts WHERE id = ?").get(process.env.HOST_ID),
	chunks: spool.prepare("SELECT seq, data_blob FROM chunks ORDER BY seq").all()
		.map((row) => [row.seq, createHash("sha256").update(row.data_blob).digest("hex")]),
	integrity: [meta.pragma("integrity_check", { simple: true }), spool.pragma("integrity_check", { simple: true })],
	autoVacuum: spool.pragma("auto_vacuum", { simple: true }),
};
meta.close();
spool.close();
process.stdout.write(JSON.stringify(out));
`;

describe("profiles across better-sqlite3 and node:sqlite (#893)", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-sqlite-files-");
	});

	afterEach(async () => {
		dbs?.close();
		dbs = undefined;
		await removeTempDir(dir);
	});

	it("opens a profile better-sqlite3 left with its WAL after a crash, as it was written", () => {
		const data = join(dir, "profile");
		const migrations = join(dir, "migrations.json");
		writeFileSync(
			migrations,
			JSON.stringify({ meta: readMigrationFiles("meta"), spool: readMigrationFiles("spool") }),
		);
		const child = runChild(dir, "writer.cjs", WRITER, {
			DATA_DIR: makeDir(data),
			MIGRATIONS: migrations,
		});
		expect(existsSync(join(data, "written")), child.stderr).toBe(true);
		// Killed before it closed: SQLite neither checkpointed nor removed the WALs.
		for (const name of ["meta.db-wal", "spool.db-wal"]) {
			expect([name, statSync(join(data, name)).size > 0]).toEqual([name, true]);
		}

		dbs = openDatabases(data);
		// Nothing applied twice: each migration better-sqlite3 recorded is there once.
		const versions = (
			dbs.meta.prepare("SELECT version FROM schema_version").all() as Array<{
				version: number;
			}>
		).map((row) => row.version);
		expect(versions).toEqual(
			readMigrationFiles("meta").map(({ file }) => Number(file.slice(0, 3))),
		);

		expect(new MetaDAL(dbs.meta).getHost("H1")).toMatchObject({
			label: "written by better-sqlite3",
			sshHost: "user@example",
		});
		const spool = new SpoolDAL(dbs.spool);
		const chunks = spool.getChunksByChannel("C1");
		expect(chunks.map((chunk) => chunk.seq)).toEqual(
			Array.from({ length: CHUNKS / 2 }, (_, i) => 2 * i + 1),
		);
		for (const chunk of chunks) {
			expect(Buffer.isBuffer(chunk.dataBlob)).toBe(true);
			expect(chunk.dataBlob.equals(chunkData(chunk.seq - 1)), `seq ${chunk.seq}`).toBe(true);
		}
		for (const db of [dbs.meta, dbs.spool]) {
			expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
		}

		// The pages the deletes freed go back to the file system, a step at a time,
		// as the GC does it (STORAGE.md § 7.2).
		expect(dbs.spool.pragma("auto_vacuum", { simple: true })).toBe(2);
		expect(dbs.spool.pragma("freelist_count", { simple: true })).toBeGreaterThan(0);
		while (spool.incrementalVacuum(128) > 0);
		expect(dbs.spool.pragma("freelist_count", { simple: true })).toBe(0);
	});

	it("leaves a profile better-sqlite3 opens, its WAL included, so a revert keeps it", () => {
		const data = makeDir(join(dir, "profile"));
		dbs = openDatabases(data);
		const host = new MetaDAL(dbs.meta).createHost({
			type: "ssh",
			label: "written by node:sqlite",
			sshHost: "user@example",
		});
		const spool = new SpoolDAL(dbs.spool);
		for (let i = 0; i < 4; i++) {
			const dataBlob = chunkData(i);
			spool.insertChunk({
				channelId: "C1",
				seq: i + 1,
				kind: "output",
				dataBlob,
				uncompressedLen: dataBlob.length,
			});
		}
		// Still open, under wal_autocheckpoint: what was written is in the WAL only.
		expect(statSync(join(data, "spool.db-wal")).size).toBeGreaterThan(4 * CHUNK_BYTES);

		const child = runChild(dir, "reader.cjs", READER, { DATA_DIR: data, HOST_ID: host.id });
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({
			host: { label: "written by node:sqlite", ssh_host: "user@example" },
			chunks: Array.from({ length: 4 }, (_, i) => [i + 1, sha256(chunkData(i))]),
			integrity: ["ok", "ok"],
			autoVacuum: 2,
		});
	});
});

function makeDir(path: string): string {
	mkdirSync(path);
	return path;
}
