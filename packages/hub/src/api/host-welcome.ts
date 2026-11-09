import { isPlainObject } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { MetaDAL } from "../storage/meta.js";

export function registerHostWelcomeRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
	// PUT /api/hosts/:id/welcome — set welcome channel for a host
	server.put<{ Params: { id: string }; Body: { channel_id: string } }>(
		"/api/hosts/:id/welcome",
		async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}

			const body: unknown = request.body;
			if (!isPlainObject(body)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "body must be an object" },
				});
			}
			const { channel_id } = body;
			if (!channel_id || typeof channel_id !== "string") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "channel_id is required" },
				});
			}

			const channelWithHost = metaDal.getChannelWithHost(channel_id);
			if (!channelWithHost) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Channel not found" } });
			}

			if (channelWithHost.hostId !== request.params.id) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "Channel does not belong to this host" },
				});
			}

			metaDal.setWelcomeChannel(channel_id);
			return reply.code(200).send({ ok: true });
		},
	);

	// DELETE /api/hosts/:id/welcome — clear welcome channel for a host
	server.delete<{ Params: { id: string } }>("/api/hosts/:id/welcome", async (request, reply) => {
		const { id } = request.params;
		const welcome = metaDal.getWelcomeChannel(id);
		if (welcome) {
			metaDal.clearWelcomeChannel(welcome.id);
		}
		return reply.code(204).send();
	});
}
