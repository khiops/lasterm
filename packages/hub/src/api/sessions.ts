import { toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";

export function registerSessionRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: SessionManager,
): void {
	/**
	 * POST /api/hosts/:id/agent/replace — stop the agent serving this host, so
	 * the next connection starts the one this hub carries.
	 *
	 * Everything that agent is holding ends with it: a PTY belongs to the
	 * process that opened it, and no update carries one across (#456). That is
	 * why this is a request and never something the hub decides by itself.
	 */
	server.post<{ Params: { id: string } }>(
		"/api/hosts/:id/agent/replace",
		async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}

			const outcome = await sessionManager.replaceAgent(request.params.id);
			if (!outcome.replaced) {
				return reply
					.code(409)
					.send({ error: { code: "AGENT_NOT_REPLACED", message: outcome.message } });
			}
			return { replaced: true, message: outcome.message };
		},
	);

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
