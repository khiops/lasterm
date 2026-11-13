import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { type DatabaseManager, openDatabases, openTestDatabases } from "./db.js";
import { Database } from "./sqlite.js";

describe("spool checkpoint worker (#786)", () => {
	let dir: string;
	let dbs: DatabaseManager | undefined;

	beforeEach(() => {
		dir = makeTempDir("lasterm-checkpointer-");
	});
	afterEach(async () => {
		try {
			await dbs?.close();
		} catch {}
		vi.restoreAllMocks();
		await removeTempDir(dir);
	});

	const noSidecars = () => {
		for (const suffix of ["-wal", "-shm"]) {
			expect(existsSync(join(dir, `spool.db${suffix}`))).toBe(false);
		}
	};
	const storageLines = (calls: unknown[][]) =>
		calls
			.flatMap(([text]) => String(text).split("\n"))
			.filter((line) => line.startsWith("[storage]"));

	// Missing exit/error/constructor handling leaves 65536, crashes, or reports twice.
	it.each(["terminated", "throws", "constructor"] as const)(
		"falls back once, without a path, when the worker %s",
		async (cause) => {
			const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			dbs = openDatabases(dir, {
				...(cause === "throws" ? { workerSource: `throw new Error(${JSON.stringify(dir)})` } : {}),
				...(cause === "constructor"
					? {
							createWorker: () => {
								throw new TypeError(dir);
							},
						}
					: {}),
			});
			if (cause === "terminated") {
				await dbs.checkpointerForTests?.ready;
				await dbs.checkpointerForTests?.worker?.terminate();
			}
			await vi.waitFor(
				() => {
					expect(dbs?.spool.pragma("wal_autocheckpoint", { simple: true })).toBe(2000);
					expect(storageLines(stderr.mock.calls)).toHaveLength(1);
				},
				{ timeout: 5000 },
			);
			// A worker that already failed holds close() back by nothing: its stop
			// settles at once. The bound times that alone, not the final checkpoints,
			// which take the disk's time (#978: over 2 s on a loaded Windows runner).
			const checkpointer = dbs.checkpointerForTests;
			expect(checkpointer).toBeDefined();
			const start = performance.now();
			await checkpointer?.stop();
			expect(performance.now() - start).toBeLessThan(1000);
			await dbs.close();
			const lines = storageLines(stderr.mock.calls);
			expect(lines).toHaveLength(1);
			// The parentheses hold an error code or an exit status, never the message
			// that names the directory.
			expect(lines[0]).toMatch(
				/^\[storage\] spool checkpoint worker stopped \((?:[A-Za-z_]+|exit -?\d+)\): checkpoints run on commits again$/,
			);
			expect(lines[0]).not.toContain(dir);
		},
	);

	// Skipping spool after a failed meta checkpoint leaves its connection open.
	it("closes both databases before rejecting a failing meta checkpoint, and memoizes the rejection", async () => {
		dbs = openDatabases(dir);
		const failure = new Error("meta checkpoint failed");
		const pragma = dbs.meta.pragma.bind(dbs.meta);
		vi.spyOn(dbs.meta, "pragma").mockImplementation((sql, options) => {
			if (sql.startsWith("wal_checkpoint")) throw failure;
			return pragma(sql, options);
		});
		const closed = dbs.close();
		await expect(closed).rejects.toBe(failure);
		expect(dbs.meta.open).toBe(false);
		expect(dbs.spool.open).toBe(false);
		expect(dbs.close()).toBe(closed);
	});

	// Removing the await lets the hub close first, leaving the worker and sidecars.
	it("waits for the worker connection to close before closing the hub connection", async () => {
		dbs = openDatabases(dir, { closeDelayMs: 500 });
		await dbs.checkpointerForTests?.ready;
		const start = performance.now();
		await dbs.close();
		expect(performance.now() - start).toBeGreaterThanOrEqual(500);
		expect(dbs.checkpointerForTests?.worker?.threadId).toBe(-1);
		noSidecars();
	});

	// Treating a requested exit as a failure writes before stop() settles.
	it("does not report a requested stop as a failure", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		dbs = openDatabases(dir);
		await dbs.close();
		expect(storageLines(stderr.mock.calls)).toEqual([]);
	});

	it("starts no worker for memory databases", async () => {
		dbs = openTestDatabases();
		expect(dbs.checkpointerForTests).toBeUndefined();
		expect(dbs.spool.pragma("wal_autocheckpoint", { simple: true })).toBe(2000);
		await dbs.close();
	});

	// A closed boolean resolves the second close before the first has finished.
	it("joins concurrent and later closes with the same promise", async () => {
		dbs = openDatabases(dir, { closeDelayMs: 500 });
		await dbs.checkpointerForTests?.ready;
		const start = performance.now();
		const first = dbs.close();
		const second = dbs.close();
		expect(second).toBe(first);
		await second;
		expect(performance.now() - start).toBeGreaterThanOrEqual(500);
		expect(dbs.checkpointerForTests?.worker?.threadId).toBe(-1);
		noSidecars();
		expect(dbs.close()).toBe(first);
	});

	// Without ref() in stop(), a child with no other handle exits before printing.
	it("keeps a child alive until its worker has closed", async () => {
		const script = join(dir, "close.mjs");
		const module = pathToFileURL(join(import.meta.dirname, "db.ts")).href;
		writeFileSync(
			script,
			`import { openDatabases } from ${JSON.stringify(module)};
const dbs = openDatabases(${JSON.stringify(dir)}, { closeDelayMs: 500 });
const start = performance.now();
await dbs.close();
if (performance.now() - start < 500) throw new Error("closed too early");
console.log("closed");`,
		);
		const child = spawn(process.execPath, ["--import", "tsx", script], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		try {
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			expect(code, stderr).toBe(0);
			expect(stdout.trim()).toBe("closed");
		} finally {
			child.kill();
		}
	});

	// A missing PASSIVE never copies the first batch; a single run misses the second.
	it("copies two distinct batches into the main file while connections stay open", async () => {
		dbs = openDatabases(dir);
		dbs.spool.exec(
			"CREATE TABLE checkpoint_probe (id INTEGER); INSERT INTO checkpoint_probe VALUES (1)",
		);
		const copyDir = join(dir, "copy");
		mkdirSync(copyDir);
		const copy = join(copyDir, "spool.db");
		const copiedRows = () => {
			copyFileSync(join(dir, "spool.db"), copy);
			const db = new Database(copy, { readonly: true });
			try {
				if (!db.prepare("SELECT name FROM sqlite_master WHERE name = 'checkpoint_probe'").get())
					return [];
				return db.prepare("SELECT id FROM checkpoint_probe ORDER BY id").all();
			} finally {
				db.close();
			}
		};
		await vi.waitFor(() => expect(copiedRows()).toEqual([{ id: 1 }]), {
			timeout: 5000,
			interval: 20,
		});
		dbs.spool.exec("INSERT INTO checkpoint_probe VALUES (2)");
		await vi.waitFor(() => expect(copiedRows()).toEqual([{ id: 1 }, { id: 2 }]), {
			timeout: 5000,
			interval: 20,
		});
	});
});
