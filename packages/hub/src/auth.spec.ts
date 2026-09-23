import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkPermissions,
	createToken,
	hashToken,
	initAuth,
	listTokens,
	PRIMARY_TOKEN_ID,
	reportTokenStore,
	revokeToken,
	sweepNonPrimaryTokens,
	TokenSweepError,
	touchToken,
	upsertPrimaryToken,
	validateTokenHash,
	validateTokenRecord,
} from "./auth.js";
import { openTestDatabases } from "./storage/db.js";

// ─── initAuth ────────────────────────────────────────────────────────────────

describe("initAuth", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `lasterm-auth-test-${randomBytes(8).toString("hex")}`);
	});

	// Neither describe removed its tree, so every run left one behind under
	// tmpdir(). chmod first: a test that made the directory unreadable would
	// otherwise defeat the removal.
	afterEach(() => {
		if (existsSync(testDir)) {
			chmodSync(testDir, 0o700);
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it.runIf(process.platform !== "win32")(
		"creates the directory 0700 under a umask that masks owner bits",
		() => {
			// mkdirSync's mode is masked, so `{ mode: 0o700 }` under `umask 0700`
			// arrives as 000: a directory the validator accepts, since it inspects
			// only the group and other bits, and that the hub then cannot read.
			const previous = process.umask(0o700);
			try {
				const token = initAuth(testDir);
				expect(token).toMatch(/^[0-9a-f]{64}$/);
				expect(statSync(testDir).mode & 0o777).toBe(0o700);
			} finally {
				process.umask(previous);
			}
		},
	);

	it("generates a 64-hex-char token on first call", () => {
		const token = initAuth(testDir);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
	});

	it("writes auth.json with the generated token", () => {
		const token = initAuth(testDir);
		const authFile = join(testDir, "auth.json");
		expect(existsSync(authFile)).toBe(true);
		const parsed = JSON.parse(readFileSync(authFile, "utf-8")) as { token: string };
		expect(parsed.token).toBe(token);
	});

	it("reads the existing token on second call (no regeneration)", () => {
		const token1 = initAuth(testDir);
		const token2 = initAuth(testDir);
		expect(token1).toBe(token2);
	});

	describe("with an auth.json already there", () => {
		// An earlier install, another hub version or an operator wrote it. Paired
		// clients hold its token, so the hub must use it as it is or refuse.
		function writeExistingAuth(content: string): string {
			mkdirSync(testDir, { recursive: true, mode: 0o700 });
			chmodSync(testDir, 0o700);
			const authFile = join(testDir, "auth.json");
			writeFileSync(authFile, content, { mode: 0o600 });
			chmodSync(authFile, 0o600);
			return authFile;
		}

		it("uses the token it holds and leaves the file byte for byte as it was", () => {
			const token = randomBytes(32).toString("hex");
			// Not the generator's layout: compact, with a trailing newline.
			const content = `${JSON.stringify({ token })}\n`;
			const authFile = writeExistingAuth(content);
			const before = statSync(authFile).mtimeMs;

			expect(initAuth(testDir)).toBe(token);
			expect(readFileSync(authFile, "utf-8")).toBe(content);
			expect(statSync(authFile).mtimeMs).toBe(before);
		});

		it.each([
			["truncated JSON", '{"token": "'],
			["an empty file", ""],
			["null", "null"],
			["an array", "[]"],
			["no token field", "{}"],
			["a numeric token", '{"token": 42}'],
		])("refuses %s, naming the file and leaving it untouched", (_case, content) => {
			const authFile = writeExistingAuth(content);

			expect(() => initAuth(testDir)).toThrow(authFile);
			expect(readFileSync(authFile, "utf-8")).toBe(content);
		});

		it.each([
			["uppercase hex", "A".repeat(64)],
			["63 characters", "a".repeat(63)],
			["65 characters", "a".repeat(65)],
			["surrounding whitespace", ` ${"a".repeat(64)} `],
			["non-hex characters", "g".repeat(64)],
		])("refuses a token in %s, saying what the format is", (_case, token) => {
			const content = JSON.stringify({ token });
			const authFile = writeExistingAuth(content);

			expect(() => initAuth(testDir)).toThrow(/64 lowercase hex characters/);
			expect(() => initAuth(testDir)).toThrow(authFile);
			expect(readFileSync(authFile, "utf-8")).toBe(content);
		});
	});

	it("sets chmod 600 on auth.json (non-Windows)", () => {
		if (process.platform === "win32") return;
		initAuth(testDir);
		const authFile = join(testDir, "auth.json");
		const mode = statSync(authFile).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("refuses a group-writable existing config directory before creating auth.json (non-Windows)", () => {
		if (process.platform === "win32") return;

		mkdirSync(testDir, { recursive: true, mode: 0o700 });
		chmodSync(testDir, 0o770);

		expect(() => initAuth(testDir)).toThrow(/group- or world-writable/);
		expect(existsSync(join(testDir, "auth.json"))).toBe(false);
	});

	it("refuses a group-writable existing config directory before reading auth.json (non-Windows)", () => {
		if (process.platform === "win32") return;

		mkdirSync(testDir, { recursive: true, mode: 0o700 });
		writeFileSync(`${testDir}/auth.json`, JSON.stringify({ token: "a".repeat(64) }));
		chmodSync(testDir, 0o770);

		expect(() => initAuth(testDir)).toThrow(/group- or world-writable/);
	});

	it("refuses a group-readable auth.json with its path and mode in the error (non-Windows)", () => {
		if (process.platform === "win32") return;

		mkdirSync(testDir, { recursive: true, mode: 0o700 });
		const authFile = join(testDir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ token: "a".repeat(64) }));
		chmodSync(authFile, 0o640);

		// Not `new RegExp(authFile)`: TMPDIR may legally hold `[`, `(`, `.` or `\`,
		// which would change the pattern or make it invalid, so the test would fail
		// for the host's temporary directory rather than for the permissions.
		let thrown: unknown;
		try {
			initAuth(testDir);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain(authFile);
		expect((thrown as Error).message).toContain("640");
	});

	it("refuses auth.json symlinks (non-Windows)", () => {
		if (process.platform === "win32") return;

		mkdirSync(testDir, { recursive: true, mode: 0o700 });
		const target = join(testDir, "token-target.json");
		writeFileSync(target, JSON.stringify({ token: "a".repeat(64) }));
		chmodSync(target, 0o600);
		symlinkSync(target, join(testDir, "auth.json"));

		expect(() => initAuth(testDir)).toThrow(/not a regular file/);
	});

	it("reads a token from owner-only config directory and auth.json (non-Windows)", () => {
		if (process.platform === "win32") return;

		mkdirSync(testDir, { recursive: true, mode: 0o700 });
		const authFile = join(testDir, "auth.json");
		const token = "a".repeat(64);
		writeFileSync(authFile, JSON.stringify({ token }));
		chmodSync(testDir, 0o700);
		chmodSync(authFile, 0o600);

		expect(initAuth(testDir)).toBe(token);
	});
});

// ─── checkPermissions ────────────────────────────────────────────────────────

describe("checkPermissions", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `lasterm-perm-test-${randomBytes(8).toString("hex")}`);
	});

	// Neither describe removed its tree, so every run left one behind under
	// tmpdir(). chmod first: a test that made the directory unreadable would
	// otherwise defeat the removal.
	afterEach(() => {
		if (existsSync(testDir)) {
			chmodSync(testDir, 0o700);
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("throws if auth.json is world-readable (non-Windows)", () => {
		if (process.platform === "win32") return;

		// Create a real file with world-readable permissions
		mkdirSync(testDir, { recursive: true });
		const authFile = join(testDir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ token: "test" }));
		chmodSync(authFile, 0o604); // world-readable

		expect(() => checkPermissions(authFile)).toThrow(/world-readable/);
	});

	it("does not throw for mode 0o600 (non-Windows)", () => {
		if (process.platform === "win32") return;

		mkdirSync(testDir, { recursive: true });
		const authFile = join(testDir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ token: "test" }));
		chmodSync(authFile, 0o600);

		expect(() => checkPermissions(authFile)).not.toThrow();
	});
});

// ─── hashToken ───────────────────────────────────────────────────────────────

describe("hashToken", () => {
	it("produces a 64-char hex string", () => {
		expect(hashToken("sometoken")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic", () => {
		expect(hashToken("abc")).toBe(hashToken("abc"));
	});

	it("different inputs produce different hashes", () => {
		expect(hashToken("a")).not.toBe(hashToken("b"));
	});
});

// ─── DB-backed token operations ──────────────────────────────────────────────

function makeDb() {
	const dbs = openTestDatabases();
	return dbs.meta;
}

describe("upsertPrimaryToken", () => {
	it("inserts the primary token on first call", () => {
		const db = makeDb();
		const token = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, token);

		const row = db.prepare("SELECT * FROM auth_tokens WHERE id = ?").get(PRIMARY_TOKEN_ID) as
			| Record<string, unknown>
			| undefined;
		expect(row).toBeDefined();
		expect(row?.token_hash).toBe(hashToken(token));
		expect(row?.expires_at).toBeNull();
		expect(row?.revoked_at).toBeNull();
	});

	it("updates hash on second call (token rotation)", () => {
		const db = makeDb();
		const token1 = randomBytes(32).toString("hex");
		const token2 = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, token1);
		upsertPrimaryToken(db, token2);

		const row = db
			.prepare("SELECT token_hash FROM auth_tokens WHERE id = ?")
			.get(PRIMARY_TOKEN_ID) as { token_hash: string };
		expect(row.token_hash).toBe(hashToken(token2));
	});
});

describe("createToken", () => {
	it("returns a 64-char hex token", () => {
		const db = makeDb();
		const { token } = createToken(db, { label: "test", expiresAt: null });
		expect(token).toMatch(/^[0-9a-f]{64}$/);
	});

	it("stores a hash (not plaintext) in the DB", () => {
		const db = makeDb();
		const { id, token } = createToken(db, { label: "test", expiresAt: null });
		const row = db.prepare("SELECT token_hash FROM auth_tokens WHERE id = ?").get(id) as {
			token_hash: string;
		};
		expect(row.token_hash).toBe(hashToken(token));
		expect(row.token_hash).not.toBe(token);
	});

	it("stores expiresAt when provided", () => {
		const db = makeDb();
		const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
		const { id } = createToken(db, { label: "test", expiresAt });
		const row = db.prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(id) as {
			expires_at: string;
		};
		expect(row.expires_at).toBe(expiresAt);
	});

	it("stores null expiresAt when not provided", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "test", expiresAt: null });
		const row = db.prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(id) as {
			expires_at: string | null;
		};
		expect(row.expires_at).toBeNull();
	});
});

describe("validateTokenRecord", () => {
	it("returns the record for a valid active token", () => {
		const db = makeDb();
		const token = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, token);

		const validation = validateTokenRecord(db, token);
		expect(validation.status).toBe("valid");
		expect(validation.status === "valid" && validation.record.id).toBe(PRIMARY_TOKEN_ID);
	});

	it("calls an unknown token invalid", () => {
		const db = makeDb();
		expect(validateTokenRecord(db, "unknowntoken")).toEqual({
			status: "invalid",
			reason: "unknown",
		});
	});

	it("calls a revoked token invalid", () => {
		const db = makeDb();
		const { id, token } = createToken(db, { label: "test", expiresAt: null });
		revokeToken(db, id);
		expect(validateTokenRecord(db, token)).toEqual({ status: "invalid", reason: "revoked" });
	});

	it("calls an expired token invalid", () => {
		const db = makeDb();
		const pastExpiry = new Date(Date.now() - 1000).toISOString();
		const { token } = createToken(db, { label: "test", expiresAt: pastExpiry });
		expect(validateTokenRecord(db, token)).toEqual({ status: "invalid", reason: "expired" });
	});

	it("returns record for token expiring in the future", () => {
		const db = makeDb();
		const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
		const { token } = createToken(db, { label: "test", expiresAt: futureExpiry });
		expect(validateTokenRecord(db, token).status).toBe("valid");
	});

	it("returns record for token with null expiresAt (never expires)", () => {
		const db = makeDb();
		const { token } = createToken(db, { label: "test", expiresAt: null });
		expect(validateTokenRecord(db, token).status).toBe("valid");
	});

	it("calls a store it cannot read unavailable, not the token invalid", () => {
		const db = makeDb();
		db.close();

		// Still no record, so nothing is authorised; but the answer says the
		// store failed rather than that the credential did.
		const validation = validateTokenRecord(db, "unreadable-database");
		expect(validation.status).toBe("unavailable");
		expect(validation.status === "unavailable" && validation.error).toBeInstanceOf(Error);
	});
});

describe("validateTokenHash", () => {
	it("judges a stored hash as validateTokenRecord judges its token", () => {
		const db = makeDb();
		const { id, token } = createToken(db, { label: "browser", expiresAt: null });

		const validation = validateTokenHash(db, hashToken(token));
		expect(validation.status === "valid" && validation.record.id).toBe(id);

		revokeToken(db, id);
		expect(validateTokenHash(db, hashToken(token))).toEqual({
			status: "invalid",
			reason: "revoked",
		});

		db.close();
		expect(validateTokenHash(db, hashToken(token)).status).toBe("unavailable");
	});
});

describe("reportTokenStore", () => {
	function makeLog() {
		return { error: vi.fn(), warn: vi.fn() };
	}

	it("logs an outage once however many credentials it refuses, then its end", () => {
		const db = makeDb();
		const token = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, token);
		const log = makeLog();
		const failure = new Error("database is locked");

		for (let request = 0; request < 3; request++) {
			reportTokenStore(db, { status: "unavailable", error: failure }, log);
		}
		expect(log.error).toHaveBeenCalledTimes(1);
		expect(log.error).toHaveBeenCalledWith(
			{ err: failure },
			expect.stringContaining("unavailable"),
		);

		reportTokenStore(db, validateTokenRecord(db, token), log);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith({ refused: 3 }, expect.stringContaining("answering"));

		// A second outage is a new one, and is reported again.
		reportTokenStore(db, { status: "unavailable", error: failure }, log);
		expect(log.error).toHaveBeenCalledTimes(2);
	});

	it("says nothing while the store answers, whatever it answers", () => {
		const db = makeDb();
		const log = makeLog();

		reportTokenStore(db, validateTokenRecord(db, "unknowntoken"), log);

		expect(log.error).not.toHaveBeenCalled();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("keeps one database's outage apart from another's", () => {
		const unavailable = makeDb();
		const healthy = makeDb();
		const log = makeLog();

		reportTokenStore(unavailable, { status: "unavailable", error: new Error("closed") }, log);
		reportTokenStore(healthy, validateTokenRecord(healthy, "unknowntoken"), log);

		expect(log.warn).not.toHaveBeenCalled();
	});
});

describe("sweepNonPrimaryTokens", () => {
	it("keeps only the primary token valid across a restart", () => {
		const db = makeDb();
		const primaryToken = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, primaryToken);
		const pairing = createToken(db, { label: "browser", expiresAt: null });

		sweepNonPrimaryTokens(db);

		const primary = validateTokenRecord(db, primaryToken);
		expect(primary.status === "valid" && primary.record.id).toBe(PRIMARY_TOKEN_ID);
		expect(validateTokenRecord(db, pairing.token)).toEqual({ status: "invalid", reason: "swept" });
	});

	it("sweeps every non-primary id, including an unrecognised future row", () => {
		const db = makeDb();
		const primaryToken = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, primaryToken);
		const futureToken = randomBytes(32).toString("hex");
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO auth_tokens
			 (id, token_hash, label, created_at, expires_at, revoked_at, last_used_at)
			 VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
		).run("future-issuer-token", hashToken(futureToken), "future", now);

		sweepNonPrimaryTokens(db);

		const row = db
			.prepare("SELECT swept_at FROM auth_tokens WHERE id = ?")
			.get("future-issuer-token") as { swept_at: string | null };
		expect(row.swept_at).not.toBeNull();
		expect(validateTokenRecord(db, futureToken)).toEqual({ status: "invalid", reason: "swept" });
	});

	it("records the first restart sweep once instead of rewriting its audit timestamp", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "browser", expiresAt: null });
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-08-01T09:00:00.000Z"));
			sweepNonPrimaryTokens(db);
			const firstSweep = (
				db.prepare("SELECT swept_at FROM auth_tokens WHERE id = ?").get(id) as {
					swept_at: string;
				}
			).swept_at;

			vi.setSystemTime(new Date("2026-08-02T09:00:00.000Z"));
			sweepNonPrimaryTokens(db);
			expect(
				(
					db.prepare("SELECT swept_at FROM auth_tokens WHERE id = ?").get(id) as {
						swept_at: string;
					}
				).swept_at,
			).toBe(firstSweep);
		} finally {
			vi.useRealTimers();
		}
	});

	it("records restart invalidation separately from operator revocation", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "operator-revoked", expiresAt: null });
		revokeToken(db, id);

		sweepNonPrimaryTokens(db);

		const token = listTokens(db).find((record) => record.id === id);
		expect(token?.revokedAt).not.toBeNull();
		expect(token?.sweptAt).not.toBeNull();
	});

	it("fails closed when auth_tokens is absent", () => {
		const db = new Database(":memory:");

		expect(() => sweepNonPrimaryTokens(db)).toThrow(TokenSweepError);
		try {
			sweepNonPrimaryTokens(db);
		} catch (error) {
			expect(error).toMatchObject({
				code: "AUTH_TOKEN_SWEEP_FAILED",
				message: "Unable to invalidate non-primary tokens before startup",
			});
		}
	});

	it("fails closed when the restart-sweep migration column is absent", () => {
		const db = new Database(":memory:");
		db.exec(`CREATE TABLE auth_tokens (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT,
			revoked_at TEXT,
			last_used_at TEXT
		)`);

		expect(() => sweepNonPrimaryTokens(db)).toThrow(TokenSweepError);
	});

	it("fails closed when the database is unreadable", () => {
		const db = makeDb();
		db.close();

		expect(() => sweepNonPrimaryTokens(db)).toThrow(TokenSweepError);
	});
});

describe("revokeToken", () => {
	it("returns true when revoking an active token", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "test", expiresAt: null });
		expect(revokeToken(db, id)).toBe(true);
	});

	it("returns false for already-revoked token", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "test", expiresAt: null });
		revokeToken(db, id);
		expect(revokeToken(db, id)).toBe(false);
	});

	it("returns false for unknown ID", () => {
		const db = makeDb();
		expect(revokeToken(db, "nonexistent")).toBe(false);
	});

	it("sets revoked_at timestamp", () => {
		const db = makeDb();
		const before = new Date().toISOString();
		const { id } = createToken(db, { label: "test", expiresAt: null });
		revokeToken(db, id);
		const after = new Date().toISOString();
		const row = db.prepare("SELECT revoked_at FROM auth_tokens WHERE id = ?").get(id) as {
			revoked_at: string;
		};
		expect(row.revoked_at >= before).toBe(true);
		expect(row.revoked_at <= after).toBe(true);
	});
});

describe("touchToken", () => {
	it("updates last_used_at", () => {
		const db = makeDb();
		const { id, token } = createToken(db, { label: "test", expiresAt: null });

		const before = new Date().toISOString();
		touchToken(db, id, 0);
		const after = new Date().toISOString();

		const row = db.prepare("SELECT last_used_at FROM auth_tokens WHERE id = ?").get(id) as {
			last_used_at: string;
		};
		expect(row.last_used_at >= before).toBe(true);
		expect(row.last_used_at <= after).toBe(true);
		// suppress unused warning
		void token;
	});

	it("extends expires_at when ttlDays > 0 and token has expiry", () => {
		const db = makeDb();
		const initialExpiry = new Date(Date.now() + 1_000).toISOString(); // 1 second
		const { id } = createToken(db, { label: "test", expiresAt: initialExpiry });

		touchToken(db, id, 90);

		const row = db.prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(id) as {
			expires_at: string;
		};
		// New expiry should be ~90 days from now — definitely greater than initial 1s expiry
		expect(row.expires_at > initialExpiry).toBe(true);
	});

	it("does not change expires_at when ttlDays is 0", () => {
		const db = makeDb();
		const initialExpiry = new Date(Date.now() + 86_400_000).toISOString();
		const { id } = createToken(db, { label: "test", expiresAt: initialExpiry });

		touchToken(db, id, 0);

		const row = db.prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(id) as {
			expires_at: string;
		};
		expect(row.expires_at).toBe(initialExpiry);
	});

	it("does not set expires_at when token has null expiry (never-expiring)", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "test", expiresAt: null });

		touchToken(db, id, 90);

		const row = db.prepare("SELECT expires_at FROM auth_tokens WHERE id = ?").get(id) as {
			expires_at: string | null;
		};
		expect(row.expires_at).toBeNull();
	});
});

describe("listTokens", () => {
	it("returns empty array when no tokens exist", () => {
		const db = makeDb();
		expect(listTokens(db)).toEqual([]);
	});

	it("returns all tokens including primary and created ones", () => {
		const db = makeDb();
		const token1 = randomBytes(32).toString("hex");
		upsertPrimaryToken(db, token1);
		createToken(db, { label: "second", expiresAt: null });

		const tokens = listTokens(db);
		expect(tokens.length).toBe(2);
		// Both tokens present
		expect(tokens.some((t) => t.id === PRIMARY_TOKEN_ID)).toBe(true);
		expect(tokens.some((t) => t.label === "second")).toBe(true);
	});

	it("includes revoked tokens", () => {
		const db = makeDb();
		const { id } = createToken(db, { label: "revoked", expiresAt: null });
		revokeToken(db, id);

		const tokens = listTokens(db);
		const revoked = tokens.find((t) => t.id === id);
		expect(revoked?.revokedAt).not.toBeNull();
	});
});
