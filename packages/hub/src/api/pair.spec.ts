import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openDatabases, openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.fixture.js";
import { pairingCodeHasher } from "./pair.js";

// ─── Mock agents so no real PTY / SSH is spawned ─────────────────────────────

vi.mock("../session/ssh-agent.js", () => {
	const { EventEmitter } = require("node:events");
	class MockSshAgent extends EventEmitter {
		connected = true;
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn();
		close = vi.fn(() => {
			this.connected = false;
			this.emit("close");
		});
	}
	return { SshAgent: MockSshAgent };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-auth-token-for-pairing-flow";

let dbs: DatabaseManager;
let server: FastifyInstance;

function startHub(dbManager: DatabaseManager): Promise<FastifyInstance> {
	return createServer({
		tls: getTestTls(),
		logger: false,
		dbManager,
		skipShellDiscovery: true,
		authToken: TEST_TOKEN,
		authConfig: { tokenTtlDays: 90 },
	});
}

beforeEach(async () => {
	dbs = openTestDatabases();
	server = await startHub(dbs);
});

afterEach(async () => {
	await server.close();
	dbs.close();
});

function authHeader() {
	return { authorization: `Bearer ${TEST_TOKEN}` };
}

// ─── POST /api/pair ───────────────────────────────────────────────────────────

describe("POST /api/pair", () => {
	it("generates a valid 8-digit code and returns 201", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<{ code: string; expires_at: string }>();
		expect(body.code).toMatch(/^\d{8}$/);
		expect(body.expires_at).toBeTruthy();
	});

	it("returns expires_at approximately 60 s from now", async () => {
		const before = Date.now();
		const res = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		const after = Date.now();

		const body = res.json<{ expires_at: string }>();
		const expiresMs = new Date(body.expires_at).getTime();

		// Should be within [before + 59s, after + 61s]
		expect(expiresMs).toBeGreaterThanOrEqual(before + 59_000);
		expect(expiresMs).toBeLessThanOrEqual(after + 61_000);
	});

	it("returns 401 without auth", async () => {
		const res = await server.inject({ method: "POST", url: "/api/pair" });
		expect(res.statusCode).toBe(401);
	});

	it("returns 429 when 3 active codes already exist", async () => {
		// Create 3 codes
		for (let i = 0; i < 3; i++) {
			const r = await server.inject({
				method: "POST",
				url: "/api/pair",
				headers: authHeader(),
			});
			expect(r.statusCode).toBe(201);
		}

		// 4th should be rate-limited
		const res = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		expect(res.statusCode).toBe(429);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("RATE_LIMIT");
	});
});

// ─── POST /api/pair/verify ────────────────────────────────────────────────────

describe("POST /api/pair/verify", () => {
	it("returns a new token (64-char hex) for a valid code", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		const { code } = createRes.json<{ code: string }>();

		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ token: string }>();
		// A new unique token is issued — not the primary admin token
		expect(body.token).toMatch(/^[0-9a-f]{64}$/);
		expect(body.token).not.toBe(TEST_TOKEN);
	});

	it("requires no auth header (unauthenticated endpoint)", async () => {
		// Just verifying that verify works without Bearer token
		const createRes = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		const { code } = createRes.json<{ code: string }>();

		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			// No auth header
			payload: { code },
		});
		expect(res.statusCode).toBe(200);
	});

	it("returns 400 for non-string code", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code: 123456 },
		});
		// Fastify schema validation rejects non-string before handler runs
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for code with wrong length", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code: "12345" },
		});
		// Fastify schema validation rejects strings not matching ^\d{8}$ before handler runs
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 for code with non-digit characters", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code: "12345a" },
		});
		// Fastify schema validation rejects non-digit strings before handler runs
		expect(res.statusCode).toBe(400);
	});

	it("returns 404 for unknown code", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code: "00000000" },
		});
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("CODE_NOT_FOUND");
	});

	it("returns 409 for already-used code", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		const { code } = createRes.json<{ code: string }>();

		// First verify — succeeds
		await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code },
		});

		// Second verify — conflict
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code },
		});
		expect(res.statusCode).toBe(409);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("CODE_USED");
	});

	it("returns 410 for an expired code", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: authHeader(),
		});
		const { code } = createRes.json<{ code: string }>();

		// The only code there is, made to have expired 1 second ago
		const pastExpiry = new Date(Date.now() - 1000).toISOString();
		dbs.meta.prepare("UPDATE pairing_codes SET expires_at = ?").run(pastExpiry);

		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code },
		});
		expect(res.statusCode).toBe(410);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("CODE_EXPIRED");
	});

	it("returns 429 after 10 verify attempts within 60 s", async () => {
		// Exhaust the 10-attempt budget with unknown codes (fast, no DB setup needed)
		for (let i = 0; i < 10; i++) {
			const r = await server.inject({
				method: "POST",
				url: "/api/pair/verify",
				payload: { code: "00000000" },
			});
			// All return 404, but that's fine — counter still increments
			expect(r.statusCode).toBe(404);
		}

		// 11th attempt → rate limited
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code: "00000000" },
		});
		expect(res.statusCode).toBe(429);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("RATE_LIMIT");
	});
});

// ─── How a code is stored (#521) ──────────────────────────────────────────────

function generateCode(hub: FastifyInstance = server) {
	return hub.inject({ method: "POST", url: "/api/pair", headers: authHeader() });
}

function verifyCode(code: string, hub: FastifyInstance = server) {
	return hub.inject({ method: "POST", url: "/api/pair/verify", payload: { code } });
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** A directory for a meta.db on disk, removed afterwards as far as Windows lets it. */
function makeDataDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-pairing-"));
}

function removeDataDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// A handle Windows has not released yet leaves it in the temp folder.
	}
}

describe("pairingCodeHasher", () => {
	// 10^8 codes: an unkeyed hash of one is found again by hashing them all, so
	// only a key the reader does not have makes the stored value worth nothing.
	it("is keyed: one run hashes a code the same way, another run differently, neither to its SHA-256", () => {
		const run = pairingCodeHasher();
		const nextRun = pairingCodeHasher();
		const code = "84729316";

		expect(run(code)).toMatch(/^[0-9a-f]{64}$/);
		expect(run(code)).toBe(run(code));
		expect(run(code)).not.toBe(run("84729317"));
		expect(run(code)).not.toBe(nextRun(code));
		expect(run(code)).not.toBe(sha256(code));
	});
});

describe("a pairing code does not outlive the hub run that issued it", () => {
	it("cannot be redeemed after a restart, even from a row left in place: its key is gone", async () => {
		const { code } = (await generateCode()).json<{ code: string }>();
		const row = dbs.meta.prepare("SELECT * FROM pairing_codes").get() as Record<string, unknown>;

		await server.close();
		server = await startHub(dbs);
		// The restart deletes it; put it back, as a backup restored after the restart would.
		dbs.meta
			.prepare(
				"INSERT OR REPLACE INTO pairing_codes (id, code_hash, created_at, expires_at) VALUES (@id, @code_hash, @created_at, @expires_at)",
			)
			.run(row);

		const res = await verifyCode(code);
		expect(res.statusCode).toBe(404);
		expect(res.json<{ error: { code: string } }>().error.code).toBe("CODE_NOT_FOUND");
	});

	it("does not count against the three active codes a restarted hub allows", async () => {
		for (let i = 0; i < 3; i++) {
			expect((await generateCode()).statusCode).toBe(201);
		}

		await server.close();
		server = await startHub(dbs);

		const res = await generateCode();
		expect(res.statusCode).toBe(201);
		expect((await verifyCode(res.json<{ code: string }>().code)).statusCode).toBe(200);
	});
});

describe("meta.db never holds a pairing code", () => {
	/** Every byte SQLite keeps for meta.db: the database, its WAL and its shared memory. */
	function metaDbBytes(dir: string): string {
		return fs
			.readdirSync(dir)
			.filter((name) => name.startsWith("meta.db"))
			.map((name) => fs.readFileSync(path.join(dir, name)).toString("latin1"))
			.join("\n");
	}

	it("stores a keyed hash, and the code in no byte of the file, its WAL, or the file left behind", async () => {
		const dir = makeDataDir();
		const disk = openDatabases(dir);
		let hub: FastifyInstance | undefined;
		try {
			hub = await startHub(disk);
			const { code } = (await generateCode(hub)).json<{ code: string }>();

			// While the code is live, which is the only time it is worth anything.
			expect(metaDbBytes(dir)).not.toContain(code);
			const rows = disk.meta.prepare("SELECT * FROM pairing_codes").all() as Array<
				Record<string, unknown>
			>;
			expect(rows).toHaveLength(1);
			expect(Object.values(rows[0] ?? {})).not.toContain(code);
			expect(rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(rows[0]?.code_hash).not.toBe(sha256(code));

			// Redeemed, then checkpointed into meta.db as the hub closes it.
			expect((await verifyCode(code, hub)).statusCode).toBe(200);
			expect(metaDbBytes(dir)).not.toContain(code);
			await hub.close();
			hub = undefined;
			disk.close();
			expect(metaDbBytes(dir)).not.toContain(code);
		} finally {
			await hub?.close();
			disk.close();
			removeDataDir(dir);
		}
	});
});

// ─── Upgrading from plain-text codes (migration 020) ──────────────────────────

const META_MIGRATIONS = fileURLToPath(new URL("../storage/migrations/meta", import.meta.url));

/** Apply the meta migrations up to `version`, as the hub's runner does: a hub of that schema. */
function migrateMetaTo(db: Database.Database, version: number): void {
	const files = fs
		.readdirSync(META_MIGRATIONS)
		.filter((file) => /^\d{3}-.*\.sql$/.test(file))
		.sort();
	for (const file of files) {
		const num = Number.parseInt(file.slice(0, 3), 10);
		if (num > version) break;
		db.transaction(() => {
			db.exec(fs.readFileSync(path.join(META_MIGRATIONS, file), "utf-8"));
			const { v } = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
				v: number | null;
			};
			if ((v ?? 0) < num) {
				db.prepare(
					"INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))",
				).run(num);
			}
		})();
	}
}

describe("an upgrade from a hub that stored pairing codes in plain text", () => {
	it("drops the stored codes, so one still live no longer pairs, and new codes pair", async () => {
		const LIVE = "31415926";
		const REDEEMED = "27182818";
		const dir = makeDataDir();
		// meta.db as a hub before #521 left it: schema 19, one code live and one
		// redeemed, both in plain text.
		const before = new Database(path.join(dir, "meta.db"));
		migrateMetaTo(before, 19);
		const now = new Date();
		const inAMinute = new Date(now.getTime() + 60_000).toISOString();
		const insert = before.prepare(
			"INSERT INTO pairing_codes (id, code, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?)",
		);
		insert.run("01K5ZC0000000000000000PA1R", LIVE, now.toISOString(), inAMinute, 0);
		insert.run("01K5ZC0000000000000000PA2R", REDEEMED, now.toISOString(), inAMinute, 1);
		before.close();

		const upgraded = openDatabases(dir);
		let hub: FastifyInstance | undefined;
		try {
			const columns = upgraded.meta.prepare("PRAGMA table_info(pairing_codes)").all() as Array<{
				name: string;
			}>;
			expect(columns.map((column) => column.name)).toEqual([
				"id",
				"code_hash",
				"created_at",
				"expires_at",
				"used",
				"used_at",
				"used_by_ip",
			]);
			expect(upgraded.meta.prepare("SELECT * FROM pairing_codes").all()).toEqual([]);

			hub = await startHub(upgraded);
			const stale = await verifyCode(LIVE, hub);
			expect(stale.statusCode).toBe(404);
			expect(stale.json<{ error: { code: string } }>().error.code).toBe("CODE_NOT_FOUND");

			const { code } = (await generateCode(hub)).json<{ code: string }>();
			expect((await verifyCode(code, hub)).statusCode).toBe(200);
		} finally {
			await hub?.close();
			upgraded.close();
			removeDataDir(dir);
		}
	});
});
