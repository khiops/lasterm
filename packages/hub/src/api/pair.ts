import { randomInt } from "node:crypto";
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

// ─── Route registration ─────────────────────────────────────────────────────────────────────────────

export function registerPairRoutes(server: FastifyInstance, opts: PairRouteOptions): void {
	const { authConfig, db, metaDal } = opts;

	// POST /api/pair — authenticated, generates a one-time pairing code
	server.post("/api/pair", async (_request: FastifyRequest, reply: FastifyReply) => {
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
				metaDal.createPairingCode(id, code, now.toISOString(), expiresAt);
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
				return reply.code(429).send({
					error: { code: "RATE_LIMIT", message: "Too many verification attempts" },
				});
			}

			// Periodically clean up stale rate-limit records (best-effort).
			metaDal.cleanExpiredPairRates(VERIFY_WINDOW_MS);

			const { code } = request.body;

			if (typeof code !== "string" || !/^\d{8}$/.test(code)) {
				return reply.code(400).send({
					error: { code: "INVALID_FORMAT", message: "Code must be 8 digits" },
				});
			}

			const row = metaDal.getPairingCodeByCode(code);

			if (!row) {
				return reply.code(404).send({
					error: { code: "CODE_NOT_FOUND", message: "Unknown pairing code" },
				});
			}

			if (row.used !== 0) {
				return reply.code(409).send({
					error: { code: "CODE_USED", message: "Code already redeemed" },
				});
			}

			const now = new Date().toISOString();
			if (row.expires_at < now) {
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

			const { token } = createToken(db, {
				label: `Paired from ${clientIp}`,
				expiresAt: tokenExpiresAt,
			});

			return reply.code(200).send({ token });
		},
	);
}
