import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listTokens, revokeToken } from "../auth.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TokenRouteOptions {
	db: Database.Database;
}

interface RevokeParams {
	id: string;
}

// ─── Route registration ───────────────────────────────────────────────────────

export function registerTokenRoutes(server: FastifyInstance, opts: TokenRouteOptions): void {
	const { db } = opts;

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
	server.delete<{ Params: RevokeParams }>(
		"/api/auth/tokens/:id",
		async (request: FastifyRequest<{ Params: RevokeParams }>, reply: FastifyReply) => {
			const { id } = request.params;

			const revoked = revokeToken(db, id);
			if (!revoked) {
				return reply.code(404).send({
					error: {
						code: "TOKEN_NOT_FOUND",
						message: "Token not found or already revoked",
					},
				});
			}

			return reply.code(200).send({ ok: true });
		},
	);
}
