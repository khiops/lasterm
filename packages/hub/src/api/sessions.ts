import { type AgentEnvironmentResponse, ErrorCode, toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";

/**
 * What a replace request asks for. `force` ends the terminals other hubs hold
 * on that agent too (#127); `stop_transfers` stops the uploads to the host
 * (#833). Anything but a boolean there is refused, since a truthy string
 * reading as "yes, end them" is not a guess to make.
 */
export function readReplaceAgentBody(
	body: unknown,
): { readonly force: boolean; readonly stopTransfers: boolean } | { readonly error: string } {
	if (body === undefined || body === null) return { force: false, stopTransfers: false };
	if (typeof body !== "object" || Array.isArray(body)) {
		return { error: "The body must be a JSON object." };
	}
	const { force, stop_transfers: stopTransfers } = body as {
		force?: unknown;
		stop_transfers?: unknown;
	};
	if (force !== undefined && typeof force !== "boolean") {
		return { error: "force must be true or false." };
	}
	if (stopTransfers !== undefined && typeof stopTransfers !== "boolean") {
		return { error: "stop_transfers must be true or false." };
	}
	return { force: force === true, stopTransfers: stopTransfers === true };
}

export function registerSessionRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: Pick<SessionManager, "replaceAgent" | "closeSession" | "queryAgentEnvironment">,
): void {
	/**
	 * GET /api/hosts/:id/agent-environment?mode=inherit|minimal — the variables
	 * a terminal on this host would start with in that mode, before the
	 * profile changes anything, as the agent there says (#576).
	 *
	 * Asked live and never kept: the values can be secrets, readable here by
	 * the same authenticated owner who could type `env` in a terminal on that
	 * host. Neither they nor their names are logged, at any level.
	 */
	server.get<{ Params: { id: string }; Querystring: { mode?: string } }>(
		"/api/hosts/:id/agent-environment",
		async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}
			const mode = request.query.mode ?? "inherit";
			if (mode !== "inherit" && mode !== "minimal") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "mode must be inherit or minimal." },
				});
			}

			const outcome = await sessionManager.queryAgentEnvironment(host.id, mode);
			switch (outcome.kind) {
				case "ok":
					return reply
						.header("Cache-Control", "no-store")
						.send({ mode, os: outcome.os, env: outcome.env } satisfies AgentEnvironmentResponse);
				case "not-connected":
					return reply.code(409).send({
						error: {
							code: ErrorCode.HOST_NOT_CONNECTED,
							message: "This host is not connected. Open a terminal on it to see its variables.",
						},
					});
				case "timeout":
					return reply.code(504).send({
						error: {
							code: ErrorCode.AGENT_TIMEOUT,
							message: "The agent on this host did not answer in time.",
						},
					});
			}
		},
	);

	/**
	 * POST /api/hosts/:id/agent/replace — stop the agent serving this host, so
	 * the next connection starts the one this hub carries.
	 *
	 * Everything that agent is holding ends with it: a PTY belongs to the
	 * process that opened it, and no update carries one across (#456). That is
	 * why, while it holds terminals of this hub, this is a request and never
	 * something the hub decides by itself. One older than the hub that holds
	 * none, the hub replaces itself (#805).
	 *
	 * An agent that other hubs also use refuses while they hold terminals
	 * there: the answer is a 409 that says how many, and the same request with
	 * `{ "force": true }` ends those too (#127).
	 *
	 * On the local host it does only what the hub would do by itself, now, and
	 * ends nothing: ending the local terminals is what Quit completely is for.
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
				if (
					outcome.code === ErrorCode.OTHER_HUBS_HOLD_CHANNELS ||
					outcome.code === "HOST_BUSY" ||
					outcome.code === ErrorCode.TRANSFERS_WOULD_STOP
				) {
					return reply.code(409).send({
						error: {
							code: outcome.code,
							message: outcome.message,
							...(outcome.otherOwnerChannels !== undefined && {
								other_owner_channels: outcome.otherOwnerChannels,
							}),
							...(outcome.transfers !== undefined && { transfers: outcome.transfers }),
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

	// DELETE /api/sessions/:id?force=true — `force`: the uploads to the host stop too (#833)
	server.delete<{ Params: { id: string }; Querystring: { force?: unknown } }>(
		"/api/sessions/:id",
		async (request, reply) => {
			const session = metaDal.getSession(request.params.id);
			if (!session) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Session not found" } });
			}
			const { force } = request.query;
			if (force !== undefined && force !== "true" && force !== "false") {
				return reply
					.code(400)
					.send({ error: { code: "VALIDATION_ERROR", message: "force must be true or false." } });
			}

			const outcome = await sessionManager.closeSession(request.params.id, {
				force: force === "true",
			});
			if (outcome === "busy") {
				return reply.code(409).send({
					error: { code: "HOST_BUSY", message: "This host's agent is being stopped." },
				});
			}
			if (outcome !== "closed") {
				const count = outcome.transfersWouldStop;
				return reply.code(409).send({
					error: {
						code: ErrorCode.TRANSFERS_WOULD_STOP,
						message: `${count === 1 ? "1 upload" : `${count} uploads`} to this host would stop. Send force=true to stop them; a retry resumes them.`,
						transfers: count,
					},
				});
			}
			return reply.code(204).send();
		},
	);
}
