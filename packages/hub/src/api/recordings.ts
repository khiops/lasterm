import type { FastifyInstance, FastifyReply } from "fastify";
import type { SessionManager } from "../session/session-manager.js";

const NOT_FOUND = { error: { code: "RECORDING_NOT_FOUND", message: "Recording not found" } };

/** A query value that is a non-negative integer, or undefined when absent; null when malformed. */
function nonNegativeInteger(value: string | undefined): number | undefined | null {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}

function badRequest(reply: FastifyReply, message: string) {
	return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message } });
}

/**
 * Terminal recordings (#80, PROTOCOL.md § 6 Recordings): start, list, stop,
 * export as asciicast v3 in parts, delete. Every route is under the hub's
 * bearer, like every other `/api` route.
 */
export function registerRecordingRoutes(
	server: FastifyInstance,
	sessionManager: SessionManager,
): void {
	server.post<{ Params: { id: string } }>("/api/channels/:id/recording", async (request, reply) => {
		const result = sessionManager.startRecording(request.params.id);
		if (result.ok) {
			return reply.code(201).send(sessionManager.recorder.listed(result.id) ?? { id: result.id });
		}
		return reply.code(result.status).send({
			error: {
				code: result.code,
				message: result.message,
				...(result.openId !== undefined && { recording_id: result.openId }),
			},
		});
	});

	server.get("/api/recordings", async () => sessionManager.recorder.list());

	server.post<{ Params: { id: string } }>("/api/recordings/:id/stop", async (request, reply) => {
		const row = sessionManager.recorder.stop(request.params.id);
		if (row === undefined) return reply.code(404).send(NOT_FOUND);
		return reply.code(200).send(row);
	});

	server.get<{
		Params: { id: string };
		Querystring: { from_seq?: string; last_seq?: string; lost?: string };
	}>("/api/recordings/:id/cast", async (request, reply) => {
		const fromSeq = nonNegativeInteger(request.query.from_seq);
		const lastSeq = nonNegativeInteger(request.query.last_seq);
		const lost = nonNegativeInteger(request.query.lost);
		if (fromSeq === null || lastSeq === null || lost === null) {
			return badRequest(reply, "from_seq, last_seq and lost are non-negative integers");
		}
		const any = fromSeq !== undefined || lastSeq !== undefined || lost !== undefined;
		const all = fromSeq !== undefined && lastSeq !== undefined && lost !== undefined;
		if (any && !all) return badRequest(reply, "from_seq comes with last_seq and lost");
		const part = sessionManager.recorder.exportPart(
			request.params.id,
			all ? { fromSeq, lastSeq, lost } : undefined,
		);
		if (part === undefined) return reply.code(404).send(NOT_FOUND);
		reply.header("Content-Type", "application/x-asciicast; charset=utf-8");
		reply.header("X-Lasterm-Cast-Last-Seq", String(part.lastSeq));
		reply.header("X-Lasterm-Cast-Lost", String(part.lost));
		if (part.nextSeq !== undefined) reply.header("X-Lasterm-Cast-Next-Seq", String(part.nextSeq));
		if (part.fileName !== null) {
			reply.header("Content-Disposition", `attachment; filename="${part.fileName}"`);
		}
		return reply.code(200).send(part.body);
	});

	server.delete<{ Params: { id: string } }>("/api/recordings/:id", async (request, reply) => {
		if (!sessionManager.recorder.delete(request.params.id)) return reply.code(404).send(NOT_FOUND);
		return reply.code(204).send();
	});
}
