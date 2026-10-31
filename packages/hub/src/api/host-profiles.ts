import { toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { resolveHostOs } from "../session/host-profile-menu.js";
import { restoreAgentDefaultProfile } from "../session/shell-profile-seed.js";
import type { MetaDAL } from "../storage/meta.js";

export function registerHostProfileRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
	// GET /api/hosts/:id/profiles — filtered launch profiles for this host
	server.get<{ Params: { id: string }; Querystring: { os?: string } }>(
		"/api/hosts/:id/profiles",
		async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}
			// Auto-resolve OS from host data when client does not supply ?os=.
			// This ensures profiles are correctly filtered without requiring the
			// client to detect and send the remote OS.
			const hostOs = request.query.os ?? resolveHostOs(host);
			const profiles = metaDal.listHostProfiles(request.params.id, hostOs);
			return toSnakeCase(profiles);
		},
	);

	// PUT /api/hosts/:id/profiles/:profileId — upsert override. A `default`
	// set here is the user's (#800): what Edit Host's Default Shell and
	// Settings › Profiles › "Set as Default" both send (#802).
	server.put<{
		Params: { id: string; profileId: string };
		Body: { override_type: string; sort_order?: number };
	}>("/api/hosts/:id/profiles/:profileId", async (request, reply) => {
		const host = metaDal.getHost(request.params.id);
		if (!host) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
		}

		const profile = metaDal.getLaunchProfile(request.params.profileId);
		if (!profile) {
			return reply
				.code(404)
				.send({ error: { code: "NOT_FOUND", message: "Launch profile not found" } });
		}

		const { override_type, sort_order } = request.body;
		if (!["pin", "hide", "default"].includes(override_type)) {
			return reply.code(400).send({
				error: {
					code: "VALIDATION_ERROR",
					message: "override_type must be 'pin', 'hide', or 'default'",
				},
			});
		}

		metaDal.upsertHostProfileOverride(
			request.params.id,
			request.params.profileId,
			override_type,
			sort_order,
		);
		// The user's default turned into a pin or hidden: the agent's applies
		// again at once (#802).
		restoreAgentDefaultProfile(request.params.id, metaDal);
		return reply.code(204).send();
	});

	// DELETE /api/hosts/:id/profiles/:profileId — remove override. Removing the
	// user's default is Edit Host's "Automatic": the default the hub marks for
	// the host's agent applies again, at once (#802).
	server.delete<{ Params: { id: string; profileId: string } }>(
		"/api/hosts/:id/profiles/:profileId",
		async (request, reply) => {
			const deleted = metaDal.deleteHostProfileOverride(
				request.params.id,
				request.params.profileId,
			);
			if (!deleted) {
				return reply
					.code(404)
					.send({ error: { code: "NOT_FOUND", message: "Override not found" } });
			}
			restoreAgentDefaultProfile(request.params.id, metaDal);
			return reply.code(204).send();
		},
	);
}
