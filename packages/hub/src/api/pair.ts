import { createHmac, randomBytes, randomInt } from "node:crypto";
import { generateId } from "@lasterm/shared";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createToken } from "../auth.js";
import type { AuthConfig } from "../config.js";
import type { MetaDAL } from "../storage/meta.js";

// ─── Types ──────────────────────────────────────────────────────────────────────────────────

export interface PairRouteOptions {
	/** The auth config (for token TTL). */
	authConfig: AuthConfig;
	/** The meta DB — used to create a token record on successful pairing. */
	db: Database.Database;
	metaDal: MetaDAL;
}

interface VerifyBody {
	code?: unknown;
}

// ─── Constants ─────────────────────────────────────────────────────────────────────────────

const VERIFY_WINDOW_MS = 60_000;
const VERIFY_MAX = 10;

// ─── Hashing ────────────────────────────────────────────────────────────────────────────────

/**
 * How a pairing code is stored: an HMAC-SHA-256 under a key drawn here and held
 * only in memory, never the code (SECURITY.md § 2.3, #521).
 *
 * The key is what protects the stored value. There are 10^8 codes, so an
 * unkeyed hash of one is found again by hashing them all, in less time than the
 * code lives: it would be the code under another name. Without the key, a
 * reader of meta.db, its WAL or a copy of it has nothing to test a guess
 * against. The key goes with the hub run that drew it, and so does every code
 * that run issued and nobody redeemed.
 */
export function pairingCodeHasher(): (code: string) => string {
	const key = randomBytes(32);
	return (code) => createHmac("sha256", key).update(code).digest("hex");
}

// ─── Route registration ─────────────────────────────────────────────────────────────────────────────

export function registerPairRoutes(server: FastifyInstance, opts: PairRouteOptions): void {
	const { authConfig, db, metaDal } = opts;
	const hashCode = pairingCodeHasher();
	// Codes an earlier run issued were hashed under a key that no longer exists:
	// none can be redeemed, and left in place they would count as active.
	metaDal.deleteUnredeemedPairingCodes();

	// POST /api/pair — authenticated, generates a one-time pairing code
	server.post("/api/pair", async (request: FastifyRequest, reply: FastifyReply) => {
		const active = metaDal.countActivePairingCodes();
		if (active >= 3) {
			return reply.code(429).send({
				error: { code: "RATE_LIMIT", message: "Too many active pairing codes" },
			});
		}

		const now = new Date();
		const expiresAt = new Date(now.getTime() + 60_000).toISOString();
		const id = generateId();

		// Generate a unique 8-digit code with retry on collision (UNIQUE constraint).
		const maxAttempts = 5;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
			try {
				metaDal.createPairingCode(id, hashCode(code), now.toISOString(), expiresAt);
				server.security.pairingCodeGenerated({
					pairingId: id,
					expiresAt,
					sourceIp: request.ip,
				});
				return reply.code(201).send({ code, expires_at: expiresAt });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : "";
				const isUniqueViolation =
					msg.includes("UNIQUE constraint failed") || msg.includes("SQLITE_CONSTRAINT_UNIQUE");
				if (isUniqueViolation && attempt < maxAttempts - 1) continue;
				throw err;
			}
		}
	});

	// POST /api/pair/verify — unauthenticated, exchanges code for a new token
	server.post<{ Body: VerifyBody }>(
		"/api/pair/verify",
		{
			schema: {
				body: {
					type: "object",
					required: ["code"],
					properties: {
						code: { type: "string", pattern: "^\\d{8}$" },
					},
					additionalProperties: false,
				},
			},
		},
		async (request: FastifyRequest<{ Body: VerifyBody }>, reply: FastifyReply) => {
			const clientIp = request.ip ?? "unknown";

			// DB-backed per-IP rate limit with exponential backoff after 5 attempts.
			if (!metaDal.checkAndIncrementPairRate(clientIp, VERIFY_MAX, VERIFY_WINDOW_MS)) {
				server.security.authFailed({ via: "pair", sourceIp: clientIp, reason: "rate_limited" });
				return reply.code(429).send({
					error: { code: "RATE_LIMIT", message: "Too many verification attempts" },
				});
			}

			// Periodically clean up stale rate-limit records (best-effort).
			metaDal.cleanExpiredPairRates(VERIFY_WINDOW_MS);

			const { code } = request.body;

			if (typeof code !== "string" || !/^\d{8}$/.test(code)) {
				server.security.authFailed({ via: "pair", sourceIp: clientIp, reason: "invalid_format" });
				return reply.code(400).send({
					error: { code: "INVALID_FORMAT", message: "Code must be 8 digits" },
				});
			}

			const row = metaDal.getPairingCodeByHash(hashCode(code));

			if (!row) {
				server.security.authFailed({ via: "pair", sourceIp: clientIp, reason: "unknown_code" });
				return reply.code(404).send({
					error: { code: "CODE_NOT_FOUND", message: "Unknown pairing code" },
				});
			}

			if (row.used !== 0) {
				server.security.authFailed({ via: "pair", sourceIp: clientIp, reason: "code_used" });
				return reply.code(409).send({
					error: { code: "CODE_USED", message: "Code already redeemed" },
				});
			}

			const now = new Date().toISOString();
			if (row.expires_at < now) {
				server.security.authFailed({ via: "pair", sourceIp: clientIp, reason: "code_expired" });
				return reply.code(410).send({
					error: { code: "CODE_EXPIRED", message: "Code has expired" },
				});
			}

			metaDal.markPairingCodeUsed(row.id, now, clientIp);

			// Create a new token in the DB — distinct from the primary token.
			// The TTL applies from this moment. ttlDays=0 means no expiry.
			const tokenExpiresAt =
				authConfig.tokenTtlDays > 0
					? new Date(Date.now() + authConfig.tokenTtlDays * 86_400_000).toISOString()
					: null;

			const { id: tokenId, token } = createToken(db, {
				label: `Paired from ${clientIp}`,
				expiresAt: tokenExpiresAt,
			});
			server.security.pairingCodeVerified({ pairingId: row.id, tokenId, sourceIp: clientIp });

			return reply.code(200).send({ token });
		},
	);
}
