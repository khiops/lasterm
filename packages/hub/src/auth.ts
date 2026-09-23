import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fchmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
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
	/** ISO 8601 — the first hub restart that invalidated this token; never rewritten */
	sweptAt: string | null;
	/** ISO 8601 — set on each successful auth request (sliding window) */
	lastUsedAt: string | null;
}

/**
 * The hub cannot safely start unless it has invalidated every browser-issued
 * credential from the preceding run.
 */
export class TokenSweepError extends Error {
	readonly code = "AUTH_TOKEN_SWEEP_FAILED";

	constructor(cause: unknown) {
		super("Unable to invalidate non-primary tokens before startup", { cause });
		this.name = "TokenSweepError";
	}
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
 * Check file permissions on auth.json.
 * Skipped on Windows, where the file relies on the profile's default ACL: a DACL
 * check was judged not worth its cost (#200).
 */
/**
 * Single-quote a path for a shell command a reader is meant to paste. Same form
 * as `quoteForShell` in the desktop e2e runner: a literal single quote is closed,
 * escaped and reopened. Without it a configuration directory containing a space
 * produced a repair command that does something else.
 *
 * Quoting is not enough on its own: `chmod` still reads an operand beginning with
 * `-` as an option, which a relative `XDG_CONFIG_HOME` of `-R` produces. Every
 * command built from this ends its options with `--` first.
 */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function checkPermissions(authFilePath: string): void {
	if (process.platform === "win32") return;

	const stat = lstatSync(authFilePath);
	if (!stat.isFile()) {
		throw new Error(`SECURITY: auth.json at ${authFilePath} is not a regular file`);
	}
	const mode = stat.mode;

	if (mode & 0o066) {
		throw new Error(
			`SECURITY: auth.json at ${authFilePath} is group- or world-readable or writable (mode ${(mode & 0o777).toString(8)}). Fix with: chmod 600 -- ${shellQuote(authFilePath)}`,
		);
	}

	// This POSIX safety check is not proof of ownership: the directory ancestry
	// and namespace can still change after lstatSync returns.
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`SECURITY: auth.json at ${authFilePath} is not owned by this user`);
	}
}

/**
 * Create a directory owner-only, and mean it. `mkdirSync(dir, { mode: 0o700 })`
 * gives `0o700 & ~umask`, which a umask carrying owner bits reduces: under
 * `umask 0700` the directory arrives at mode 000, the validator below accepts it
 * because it inspects only the group and other bits, and the process then fails
 * with EACCES on its own directory. `mkdirSync` with `recursive` returns the
 * first path it created, or undefined when the directory already existed, so the
 * chmod lands only on a directory this call made — an existing one keeps its mode
 * and is judged by the validator instead of being silently repaired.
 */
export function createOwnerOnlyDirectory(directory: string): void {
	const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (created !== undefined) chmodSync(directory, 0o700);
}

/** Check the directory that contains auth.json before using it. */
export function checkConfigDirectoryPermissions(configDir: string): void {
	if (process.platform === "win32") return;

	// One lstat of configDir is defence in depth, not path integrity. An ancestor
	// that can rename or replace configDir defeats it. The lasterm-protected-fs
	// crate does the descriptor walk that would establish the stronger claim, and
	// it is Rust, unreachable from this file.
	const stat = lstatSync(configDir);
	if (!stat.isDirectory()) {
		throw new Error(`SECURITY: auth config directory at ${configDir} is not a directory`);
	}
	const mode = stat.mode;

	if (mode & 0o022) {
		throw new Error(
			`SECURITY: auth config directory at ${configDir} is group- or world-writable (mode ${(mode & 0o777).toString(8)}). Fix with: chmod 700 -- ${shellQuote(configDir)}`,
		);
	}

	// This POSIX safety check is not proof of ownership: the directory ancestry
	// and namespace can still change after lstatSync returns.
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`SECURITY: auth config directory at ${configDir} is not owned by this user`);
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
		checkConfigDirectoryPermissions(configDir);
		checkPermissions(authFilePath);
		return readExistingToken(authFilePath);
	}

	// First run — generate and store token
	createOwnerOnlyDirectory(configDir);
	checkConfigDirectoryPermissions(configDir);
	const token = randomBytes(32).toString("hex");
	// Atomic: open with restricted mode so the file is never world-readable,
	// even briefly. writeFileSync + chmodSync has a TOCTOU window at 0644.
	const fd = openSync(authFilePath, "wx", 0o600);
	try {
		writeSync(fd, JSON.stringify({ token }, null, "\t"));
		fchmodSync(fd, 0o600); // Belt-and-suspenders: enforce even if umask is weird
	} finally {
		closeSync(fd);
	}

	return token;
}

/**
 * The token an existing auth.json holds, as written: never regenerated, never
 * rewritten. Anything else refuses to start, naming the file, because a hub that
 * replaced an unreadable token would invalidate every paired client without
 * saying so (SECURITY.md § 2.2). The generator emits lowercase hex, and the
 * reader accepts exactly that (#264).
 */
function readExistingToken(authFilePath: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(authFilePath, "utf-8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${authFilePath} is not valid JSON (${reason}); expected {"token": "<64 lowercase hex characters>"}`,
		);
	}
	const token =
		typeof parsed === "object" && parsed !== null
			? (parsed as { token?: unknown }).token
			: undefined;
	if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) {
		throw new Error(
			`Invalid token format in ${authFilePath} — expected 64 lowercase hex characters`,
		);
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
		sweptAt: (row.swept_at as string | null) ?? null,
		lastUsedAt: (row.last_used_at as string | null) ?? null,
	};
}

/**
 * Ensure the primary token (from auth.json) exists in the auth_tokens table.
 * Called on hub startup after the DB is opened and migrations run.
 * The primary token has no expiry (null) so it behaves like the legacy token.
 *
 * The row follows auth.json, which is where the primary token is retired
 * (SECURITY.md § 2.1), so it is never left revoked. `revokeToken` refuses it,
 * and a revocation an earlier version recorded is cleared here (#515). Kept, it
 * refused the desktop its own hub on every start, and replacing auth.json did
 * not lift it: the new token took over the revoked row.
 */
export function upsertPrimaryToken(db: Database.Database, plaintextToken: string): void {
	const hash = hashToken(plaintextToken);
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO auth_tokens (id, token_hash, label, created_at, expires_at, revoked_at, last_used_at)
		 VALUES (?, ?, 'Primary', ?, NULL, NULL, NULL)
		 ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash, revoked_at = NULL`,
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
 * Invalidate every credential except the durable auth.json token. `swept_at`
 * records the first restart that invalidated a token and is never rewritten.
 *
 * This runs once during startup, before the listener is bound. The sentinel is
 * deliberately the entire allowlist: rows from an unknown future issuer are
 * invalidated too, rather than being accidentally allowed to survive a restart.
 */
export function sweepNonPrimaryTokens(db: Database.Database): void {
	try {
		db.prepare("UPDATE auth_tokens SET swept_at = ? WHERE id <> ? AND swept_at IS NULL").run(
			new Date().toISOString(),
			PRIMARY_TOKEN_ID,
		);
	} catch (cause) {
		throw new TokenSweepError(cause);
	}
}

/**
 * Look up a token record by plaintext value.
 * Returns null when not found.
 */
export function getTokenByValue(
	db: Database.Database,
	plaintextToken: string,
): AuthTokenRecord | null {
	return getTokenByHash(db, hashToken(plaintextToken));
}

function getTokenByHash(db: Database.Database, tokenHash: string): AuthTokenRecord | null {
	const row = db.prepare("SELECT * FROM auth_tokens WHERE token_hash = ?").get(tokenHash) as
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
 *
 * The primary token is never revoked, and gets false like an unknown id; the
 * route says why before it asks (#515). The desktop authenticates with it, so a
 * revoked primary row locked the desktop out of its own hub. It is retired by
 * replacing auth.json instead (SECURITY.md § 2.1).
 */
export function revokeToken(db: Database.Database, id: string): boolean {
	const now = new Date().toISOString();
	const result = db
		.prepare(
			"UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND id <> ? AND revoked_at IS NULL",
		)
		.run(now, id, PRIMARY_TOKEN_ID);
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
 * What the token store said about a credential. `unavailable` is an answer of
 * its own rather than a refusal in disguise: a closed, corrupt or locked
 * database still authorises nothing, but folding it into `invalid` told the
 * client its credential was bad and told the operator nothing at all.
 */
export type TokenValidation =
	| { readonly status: "valid"; readonly record: AuthTokenRecord }
	| { readonly status: "invalid"; readonly reason: InvalidTokenReason }
	| { readonly status: "unavailable"; readonly error: unknown };

/** Why the store refused a credential: none has that value, or its row no longer allows it. */
export type InvalidTokenReason = "unknown" | "revoked" | "swept" | "expired";

/**
 * Validate a plaintext token against the DB.
 *
 * Checks:
 * 1. Token hash exists in auth_tokens
 * 2. Not operator-revoked or restart-swept
 * 3. Not expired (expires_at IS NULL OR expires_at > now)
 *
 * Only a record that passes all three is `valid`. A store that cannot be read
 * is `unavailable`, which every caller must still refuse.
 */
export function validateTokenRecord(
	db: Database.Database,
	plaintextToken: string,
): TokenValidation {
	return validateTokenHash(db, hashToken(plaintextToken));
}

/**
 * The same checks, for a credential already known by its stored hash. An open
 * WebSocket re-checks the token it authenticated with before acting on each
 * frame, and keeps the hash to do so rather than the token itself.
 */
export function validateTokenHash(db: Database.Database, tokenHash: string): TokenValidation {
	let record: AuthTokenRecord | null;
	try {
		record = getTokenByHash(db, tokenHash);
	} catch (error) {
		return { status: "unavailable", error };
	}
	if (!record) return { status: "invalid", reason: "unknown" };
	if (record.revokedAt !== null) return { status: "invalid", reason: "revoked" };
	if (record.sweptAt !== null) return { status: "invalid", reason: "swept" };

	const now = new Date().toISOString();
	if (record.expiresAt !== null && record.expiresAt <= now) {
		return { status: "invalid", reason: "expired" };
	}

	return { status: "valid", record };
}

/** The two levels an outage report needs; Fastify's logger has both. */
export interface TokenStoreLog {
	error(details: object, message: string): void;
	warn(details: object, message: string): void;
}

/** Credentials refused since the store last answered, per database. */
const tokenStoreOutages = new WeakMap<Database.Database, number>();

/**
 * Report a token store that cannot answer once per outage, not once per
 * request. A client retrying against a locked database would otherwise write
 * the same error on every attempt, and the first one is the one worth reading.
 * The next answer the store does give ends the outage and says how many
 * credentials were refused meanwhile.
 *
 * The count belongs to the database rather than to a caller, so the REST hook,
 * the WebSocket handshake and the agent routes report one outage between them.
 */
export function reportTokenStore(
	db: Database.Database,
	validation: TokenValidation,
	log: TokenStoreLog,
): void {
	const refused = tokenStoreOutages.get(db) ?? 0;
	if (validation.status === "unavailable") {
		if (refused === 0) {
			log.error(
				{ err: validation.error },
				"auth: token store unavailable; refusing credentials until it answers again",
			);
		}
		tokenStoreOutages.set(db, refused + 1);
		return;
	}
	if (refused > 0) {
		tokenStoreOutages.delete(db);
		log.warn({ refused }, "auth: token store answering again");
	}
}

/**
 * Whether a token someone presented is the one expected, compared in constant
 * time with `crypto.timingSafeEqual` (CLAUDE.md). A plain `===` stops at the
 * first character that differs, so the time it takes tells a guesser how much
 * of the token was right (#514).
 *
 * Every token the hub holds in memory is compared here: the primary token on
 * the agent routes, the owner token of a shutdown or quit, the asset token of a
 * public URL. A credential the store checks is looked up by its hash instead,
 * which a guess cannot steer.
 *
 * Only a difference in length answers sooner, and each of those tokens has a
 * length its format already makes public. The lengths compared are in bytes, not
 * characters: `timingSafeEqual` throws on buffers of different sizes, and a
 * multibyte guess of the right character count would make them differ.
 */
export function tokensEqual(provided: string, expected: string): boolean {
	const actual = Buffer.from(provided);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
