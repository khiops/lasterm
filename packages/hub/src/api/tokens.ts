import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listTokens, PRIMARY_TOKEN_ID, revokeToken } from "../auth.js";
import { type TokenRevocationOutcome, WITHHELD } from "../logging/security-log.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenRouteOptions {
	db: Database.Database;
	/**
	 * Called once a token is revoked, to end what it already opened. Without it
	 * a revoked token kept every WebSocket it had authenticated.
	 */
	onRevoked?: (tokenId: string) => void;
}

interface RevokeParams {
	id: string;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerTokenRoutes(server: FastifyInstance, opts: TokenRouteOptions): void {
	const { db, onRevoked } = opts;

	// GET /api/auth/tokens — list all tokens (auth required via global hook)
	server.get("/api/auth/tokens", async (_request: FastifyRequest, reply: FastifyReply) => {
		const records = listTokens(db);

		// Never expose token hashes — return safe metadata only
		const tokens = records.map((r) => ({
			id: r.id,
			label: r.label,
			created_at: r.createdAt,
			expires_at: r.expiresAt,
			revoked_at: r.revokedAt,
			swept_at: r.sweptAt,
			last_used_at: r.lastUsedAt,
		}));

		return reply.code(200).send({ tokens });
	});

	// DELETE /api/auth/tokens/:id — revoke a token by ID (auth required via global hook)
	//
	// Every answer is a security event (SECURITY.md § 7.1), a refusal included:
	// who ended which credential, or tried to (#522).
	server.delete<{ Params: RevokeParams }>(
		"/api/auth/tokens/:id",
		async (request: FastifyRequest<{ Params: RevokeParams }>, reply: FastifyReply) => {
			const { id } = request.params;
			const record = (outcome: TokenRevocationOutcome) =>
				server.security.tokenRevocation({
					tokenId: id,
					// The credential that asked, attached by the auth hook, which guards
					// every /api/ route: its id, never the token. The log withholds
					// anything that is not a credential id, so an absent one would be
					// written `<withheld>`, never guessed.
					byTokenId: request.authTokenRecord?.id ?? WITHHELD,
					sourceIp: request.ip,
					outcome,
				});

			// The primary token is auth.json's, and the desktop authenticates with it:
			// revoking its row locked the desktop out of its own hub, and no restart
			// undid it (#515). Replacing auth.json is how it is retired.
			if (id === PRIMARY_TOKEN_ID) {
				record("not_revocable");
				return reply.code(409).send({
					error: {
						code: "PRIMARY_TOKEN_NOT_REVOCABLE",
						message:
							"The primary token cannot be revoked: the desktop uses it to reach this hub. To retire it, stop the hub, delete auth.json and start the hub again, which issues a new one.",
					},
				});
			}

			const revoked = revokeToken(db, id);
			if (!revoked) {
				record("not_found");
				return reply.code(404).send({
					error: {
						code: "TOKEN_NOT_FOUND",
						message: "Token not found or already revoked",
					},
				});
			}

			// Recorded before the sockets it closes, whose own records follow it.
			record("revoked");
			onRevoked?.(id);
			return reply.code(200).send({ ok: true });
		},
	);
}
