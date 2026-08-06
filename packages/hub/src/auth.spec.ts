import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	checkPermissions,
	createToken,
	hashToken,
	initAuth,
	listTokens,
	PRIMARY_TOKEN_ID,
	revokeToken,
	touchToken,
	upsertPrimaryToken,
	validateTokenRecord,
} from "./auth.js";
import { openTestDatabases } from "./storage/db.js";

// ─── initAuth ────────────────────────────────────────────────────────────────

describe("initAuth", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `lasterm-auth-test-${randomBytes(8).toString("hex")}`);
	});

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

	it("sets chmod 600 on auth.json (non-Windows)", () => {
		if (process.platform === "win32") return;
		initAuth(testDir);
		const authFile = join(testDir, "auth.json");
		const mode = statSync(authFile).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});

// ─── checkPermissions ────────────────────────────────────────────────────────

describe("checkPermissions", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `lasterm-perm-test-${randomBytes(8).toString("hex")}`);
	});

	it("throws if auth.json is world-readable (non-Windows)", () => {
		if (process.platform === "win32") return;

		// Create a real file with world-readable permissions
		const { mkdirSync } = require("node:fs") as typeof import("node:fs");
		mkdirSync(testDir, { recursive: true });
		const authFile = join(testDir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ token: "test" }));
		chmodSync(authFile, 0o604); // world-readable

		expect(() => checkPermissions(authFile)).toThrow(/world-readable/);
	});

	it("does not throw for mode 0o600 (non-Windows)", () => {
		if (process.platform === "win32") return;

		const { mkdirSync } = require("node:fs") as typeof import("node:fs");
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

		const record = validateTokenRecord(db, token);
		expect(record).not.toBeNull();
		expect(record?.id).toBe(PRIMARY_TOKEN_ID);
	});

	it("returns null for unknown token", () => {
		const db = makeDb();
		expect(validateTokenRecord(db, "unknowntoken")).toBeNull();
	});

	it("returns null for revoked token", () => {
		const db = makeDb();
		const { id, token } = createToken(db, { label: "test", expiresAt: null });
		revokeToken(db, id);
		expect(validateTokenRecord(db, token)).toBeNull();
	});

	it("returns null for expired token", () => {
		const db = makeDb();
		const pastExpiry = new Date(Date.now() - 1000).toISOString();
		const { token } = createToken(db, { label: "test", expiresAt: pastExpiry });
		expect(validateTokenRecord(db, token)).toBeNull();
	});

	it("returns record for token expiring in the future", () => {
		const db = makeDb();
		const futureExpiry = new Date(Date.now() + 86_400_000).toISOString();
		const { token } = createToken(db, { label: "test", expiresAt: futureExpiry });
		expect(validateTokenRecord(db, token)).not.toBeNull();
	});

	it("returns record for token with null expiresAt (never expires)", () => {
		const db = makeDb();
		const { token } = createToken(db, { label: "test", expiresAt: null });
		expect(validateTokenRecord(db, token)).not.toBeNull();
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
