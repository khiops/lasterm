import { ErrorCode, toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";

/**
 * What a replace request asks for. `force` ends the terminals other hubs hold
 * on that agent too (#127); anything but a boolean there is refused, since a
 * truthy string reading as "yes, end them" is not a guess to make.
 */
export function readReplaceAgentBody(
	body: unknown,
): { readonly force: boolean } | { readonly error: string } {
	if (body === undefined || body === null) return { force: false };
	if (typeof body !== "object" || Array.isArray(body)) {
		return { error: "The body must be a JSON object." };
	}
	const force = (body as { force?: unknown }).force;
	if (force === undefined) return { force: false };
	if (typeof force !== "boolean") return { error: "force must be true or false." };
	return { force };
}

export function registerSessionRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: Pick<SessionManager, "replaceAgent" | "closeSession">,
): void {
	/**
	 * POST /api/hosts/:id/agent/replace — stop the agent serving this host, so
	 * the next connection starts the one this hub carries.
	 *
	 * Everything that agent is holding ends with it: a PTY belongs to the
	 * process that opened it, and no update carries one across (#456). That is
	 * why this is a request and never something the hub decides by itself.
	 *
	 * An agent that other hubs also use refuses while they hold terminals
	 * there: the answer is a 409 that says how many, and the same request with
	 * `{ "force": true }` ends those too (#127).
	 */
	server.post<{ Params: { id: string }; Body: unknown }>(
		"/api/hosts/:id/agent/replace",
		async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}
			const options = readReplaceAgentBody(request.body);
			if ("error" in options) {
				return reply
					.code(400)
					.send({ error: { code: "VALIDATION_ERROR", message: options.error } });
			}

			const outcome = await sessionManager.replaceAgent(request.params.id, options);
			if (!outcome.replaced) {
				if (outcome.code === ErrorCode.OTHER_HUBS_HOLD_CHANNELS) {
					return reply.code(409).send({
						error: {
							code: outcome.code,
							message: outcome.message,
							...(outcome.otherOwnerChannels !== undefined && {
								other_owner_channels: outcome.otherOwnerChannels,
							}),
						},
					});
				}
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
