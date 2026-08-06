import { toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";

export function registerSessionRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: SessionManager,
): void {
	// GET /api/sessions?host_id=X
	server.get<{ Querystring: { host_id?: string } }>("/api/sessions", async (request) => {
		const sessions = metaDal.listSessions(request.query.host_id);
		return toSnakeCase(sessions);
	});

	// GET /api/sessions/:id
	server.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
		const session = metaDal.getSession(request.params.id);
		if (!session) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Session not found" } });
		}

		// Include channels for this session
		const channels = metaDal.listChannels(request.params.id);
		return toSnakeCase({ ...session, channels });
	});

	// DELETE /api/sessions/:id
	server.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
		const session = metaDal.getSession(request.params.id);
		if (!session) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Session not found" } });
		}

		await sessionManager.closeSession(request.params.id);
		return reply.code(204).send();
	});
}
