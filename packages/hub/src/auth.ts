import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fchmodSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";

const AUTH_FILE = "auth.json";

// ─── Primary-token ID — constant sentinel for auth.json token ────────────────
export const PRIMARY_TOKEN_ID = "primary";

// ─── Token record ─────────────────────────────────────────────────────────────

export interface AuthTokenRecord {
	id: string;
	/** sha256 hex digest of the plaintext token */
	tokenHash: string;
	label: string;
	createdAt: string;
	/** ISO 8601 — null means never expires (primary token default) */
	expiresAt: string | null;
	/** ISO 8601 — non-null means revoked */
	revokedAt: string | null;
	/** ISO 8601 — set on each successful auth request (sliding window) */
	lastUsedAt: string | null;
}

// ─── Auth config (re-exported from config.ts to avoid circular deps) ──────────
// The canonical definition lives in config.ts. We use the same shape here.
export type { AuthConfig } from "./config.js";

// ─── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Hash a plaintext token with SHA-256.
 * Tokens are stored as hashes — never as plaintext.
 */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

// ─── File permission check ────────────────────────────────────────────────────

/**
 * Check file permissions on the auth.json.
 * Throws if world-readable (mode & 0o004).
 * Warns if group-readable (mode & 0o040).
 * Skipped on Windows.
 */
export function checkPermissions(authFilePath: string): void {
	if (process.platform === "win32") return;

	const stat = statSync(authFilePath);
	const mode = stat.mode;

	if (mode & 0o004) {
		throw new Error(
			`SECURITY: auth.json at ${authFilePath} is world-readable (mode ${(mode & 0o777).toString(8)}). Fix with: chmod 600 auth.json`,
		);
	}

	if (mode & 0o040) {
		process.stderr.write(
			`[lasterm] WARNING: auth.json at ${authFilePath} is group-readable (mode ${(mode & 0o777).toString(8)}). Recommend: chmod 600 auth.json\n`,
		);
	}
}

// ─── Auth init ────────────────────────────────────────────────────────────────

/**
 * Initialize auth: generate token on first run, read on subsequent runs.
 * Writes auth.json with chmod 600 on first run.
 * Returns the plaintext primary token.
 */
export function initAuth(configDir: string): string {
	const authFilePath = join(configDir, AUTH_FILE);

	if (existsSync(authFilePath)) {
		checkPermissions(authFilePath);
		const raw = readFileSync(authFilePath, "utf-8");
		const parsed = JSON.parse(raw) as { token: string };
		if (typeof parsed.token !== "string" || !/^[0-9a-f]{64}$/.test(parsed.token)) {
			throw new Error(`Invalid token format in ${authFilePath} — expected 64-char hex string`);
		}
		return parsed.token;
	}

	// First run — generate and store token
	mkdirSync(configDir, { recursive: true });
	const token = randomBytes(32).toString("hex");
	// Atomic: open with restricted mode so the file is never world-readable,
	// even briefly. writeFileSync + chmodSync has a TOCTOU window at 0644.
	const fd = openSync(authFilePath, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify({ token }, null, "\t"));
		fchmodSync(fd, 0o600); // Belt-and-suspenders: enforce even if umask is weird
	} finally {
		closeSync(fd);
	}

	return token;
}

// ─── DB-backed token store ────────────────────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): AuthTokenRecord {
	return {
		id: row.id as string,
		tokenHash: row.token_hash as string,
		label: row.label as string,
		createdAt: row.created_at as string,
		expiresAt: (row.expires_at as string | null) ?? null,
		revokedAt: (row.revoked_at as string | null) ?? null,
		lastUsedAt: (row.last_used_at as string | null) ?? null,
	};
}

/**
 * Ensure the primary token (from auth.json) exists in the auth_tokens table.
 * Called on hub startup after the DB is opened and migrations run.
 * The primary token has no expiry (null) so it behaves like the legacy token.
 */
export function upsertPrimaryToken(db: Database.Database, plaintextToken: string): void {
	const hash = hashToken(plaintextToken);
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO auth_tokens (id, token_hash, label, created_at, expires_at, revoked_at, last_used_at)
		 VALUES (?, ?, 'Primary', ?, NULL, NULL, NULL)
		 ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash`,
	).run(PRIMARY_TOKEN_ID, hash, now);
}

/**
 * Create a new token entry (e.g. from a pairing flow).
 * Returns the plaintext token — caller must transmit it to the client and
 * discard it; only the hash is stored.
 */
export function createToken(
	db: Database.Database,
	opts: { label: string; expiresAt: string | null },
): { id: string; token: string } {
	const id = generateId();
	const token = randomBytes(32).toString("hex");
	const hash = hashToken(token);
	const now = new Date().toISOString();

	db.prepare(
		`INSERT INTO auth_tokens (id, token_hash, label, created_at, expires_at, revoked_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
	).run(id, hash, opts.label, now, opts.expiresAt);

	return { id, token };
}

/**
 * Look up a token record by plaintext value.
 * Returns null when not found.
 */
export function getTokenByValue(
	db: Database.Database,
	plaintextToken: string,
): AuthTokenRecord | null {
	const hash = hashToken(plaintextToken);
	const row = db.prepare("SELECT * FROM auth_tokens WHERE token_hash = ?").get(hash) as
		| Record<string, unknown>
		| undefined;
	return row ? rowToRecord(row) : null;
}

/**
 * List all tokens (active and revoked).
 * Returns newest-first.
 */
export function listTokens(db: Database.Database): AuthTokenRecord[] {
	const rows = db.prepare("SELECT * FROM auth_tokens ORDER BY created_at DESC").all() as Array<
		Record<string, unknown>
	>;
	return rows.map(rowToRecord);
}

/**
 * Revoke a token by ID.
 * Returns true if a token was found and revoked, false if not found or already revoked.
 */
export function revokeToken(db: Database.Database, id: string): boolean {
	const now = new Date().toISOString();
	const result = db
		.prepare("UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
		.run(now, id);
	return result.changes > 0;
}

/**
 * Update last_used_at and extend expiry by TTL (sliding window).
 * Called on each successful authenticated request.
 * If ttlDays is 0 or expires_at is NULL, expiry is not changed.
 */
export function touchToken(db: Database.Database, id: string, ttlDays: number): void {
	const now = new Date().toISOString();
	if (ttlDays > 0) {
		const newExpiry = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
		db.prepare(
			`UPDATE auth_tokens SET last_used_at = ?,
			 expires_at = CASE WHEN expires_at IS NOT NULL THEN ? ELSE NULL END
			 WHERE id = ?`,
		).run(now, newExpiry, id);
	} else {
		db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?").run(now, id);
	}
}

// ─── Token validation ─────────────────────────────────────────────────────────

/**
 * Validate a plaintext token against the DB.
 *
 * Checks:
 * 1. Token hash exists in auth_tokens
 * 2. Not revoked (revoked_at IS NULL)
 * 3. Not expired (expires_at IS NULL OR expires_at > now)
 *
 * Returns the token record on success, or null on failure.
 */
export function validateTokenRecord(
	db: Database.Database,
	plaintextToken: string,
): AuthTokenRecord | null {
	const record = getTokenByValue(db, plaintextToken);
	if (!record) return null;
	if (record.revokedAt !== null) return null;

	const now = new Date().toISOString();
	if (record.expiresAt !== null && record.expiresAt <= now) return null;

	return record;
}

/**
 * Constant-time token comparison using crypto.timingSafeEqual.
 * Returns false immediately if lengths differ (avoids timingSafeEqual crash).
 *
 * @deprecated Use validateTokenRecord for DB-backed validation with expiry/revocation.
 *   This function is kept for backward-compatibility with tests that don't use a DB.
 */
