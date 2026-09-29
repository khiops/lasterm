import { ErrorCode, type HostConnectionResponse, isValidUlid } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { HostConnectionOutcome, SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";

/** What a connect, reconnect or disconnect request asks for (#648). */
export interface HostConnectionRequest {
	/** End the terminals the connection runs, the person having been told how many. */
	readonly force: boolean;
	/** The window whose questions these are: the id AUTH_OK gave it. */
	readonly clientId?: string;
}

/**
 * Read the body of a connect, reconnect or disconnect request.
 *
 * `force` is a boolean or nothing: a truthy string read as "yes, end them"
 * is not a guess to make about someone's terminals. `client_id` is a window's
 * id, a ULID, or nothing. Anything else in the body is ignored, and connect
 * ignores `force`: it closes nothing.
 */
export function readHostConnectionBody(
	body: unknown,
): HostConnectionRequest | { readonly error: string } {
	if (body === undefined || body === null) return { force: false };
	if (typeof body !== "object" || Array.isArray(body)) {
		return { error: "The body must be a JSON object." };
	}
	const { force, client_id: clientId } = body as { force?: unknown; client_id?: unknown };
	if (force !== undefined && typeof force !== "boolean") {
		return { error: "force must be true or false." };
	}
	if (clientId !== undefined && !isValidUlid(clientId)) {
		return { error: "client_id must be the id AUTH_OK gave this window." };
	}
	return { force: force === true, ...(clientId !== undefined && { clientId }) };
}

/** "3 terminals", "1 terminal". */
function terminalsText(count: number): string {
	return count === 1 ? "1 terminal" : `${count} terminals`;
}

/** Say what came of it, in the shapes PROTOCOL.md § 6 gives. */
function answer(reply: FastifyReply, outcome: HostConnectionOutcome): FastifyReply {
	switch (outcome.kind) {
		case "not-ssh":
			return reply.code(400).send({
				error: {
					code: ErrorCode.NOT_SSH_HOST,
					message: "The local host has no connection to connect or close.",
				},
			});
		case "quitting":
			return reply.code(409).send({
				error: { code: "HUB_QUITTING", message: "The hub is quitting." },
			});
		case "terminals-would-end":
			return reply.code(409).send({
				error: {
					code: ErrorCode.TERMINALS_WOULD_END,
					message: `${terminalsText(outcome.terminals)} on this host would end. Send force: true to end them.`,
					terminals: outcome.terminals,
				},
			});
		case "connected":
			return reply.code(200).send({ status: "connected" } satisfies HostConnectionResponse);
		case "connecting":
			return reply
				.code(202)
				.send({ status: "connecting", ended: outcome.ended } satisfies HostConnectionResponse);
		case "disconnected":
			return reply
				.code(200)
				.send({ status: "disconnected", ended: outcome.ended } satisfies HostConnectionResponse);
	}
}

/**
 * POST /api/hosts/:id/connect, /reconnect and /disconnect: a person's
 * Connect, Reconnect and Disconnect of an SSH host, from its menu (#648).
 * PROTOCOL.md § 6 says what each answers.
 */
export function registerHostConnectionRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: Pick<SessionManager, "connectHost" | "reconnectHost" | "disconnectHost">,
): void {
	const routes: ReadonlyArray<{
		readonly path: string;
		readonly act: (hostId: string, request: HostConnectionRequest) => HostConnectionOutcome;
	}> = [
		{
			path: "/api/hosts/:id/connect",
			act: (hostId, request) =>
				sessionManager.connectHost(
					hostId,
					request.clientId !== undefined ? { clientId: request.clientId } : {},
				),
		},
		{
			path: "/api/hosts/:id/reconnect",
			act: (hostId, request) => sessionManager.reconnectHost(hostId, request),
		},
		{
			path: "/api/hosts/:id/disconnect",
			act: (hostId, request) => sessionManager.disconnectHost(hostId, { force: request.force }),
		},
	];

	for (const route of routes) {
		server.post<{ Params: { id: string }; Body: unknown }>(route.path, async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}
			const body = readHostConnectionBody(request.body);
			if ("error" in body) {
				return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: body.error } });
			}
			return answer(reply, route.act(host.id, body));
		});
	}
}
