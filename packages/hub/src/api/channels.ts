import { type Channel, isValidUlid, toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";
import type { SpoolDAL } from "../storage/spool.js";

export function registerChannelRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: SessionManager,
	spoolDal: SpoolDAL,
): void {
	// GET /api/channels?host_id=X
	// host_id filtering: look up sessions for that host, then get channels for those sessions
	server.get<{ Querystring: { host_id?: string; session_id?: string } }>(
		"/api/channels",
		async (request) => {
			const { host_id, session_id } = request.query;

			let channels: Channel[];
			if (session_id) {
				channels = metaDal.listChannels(session_id);
			} else if (host_id) {
				const sessions = metaDal.listSessions(host_id);
				channels = sessions.flatMap((s) => metaDal.listChannels(s.id));
			} else {
				channels = metaDal.listChannels();
			}

			return channels.map((ch) => {
				const row = toSnakeCase(ch) as Record<string, unknown>;
				row.display_title = sessionManager.resolveDisplayTitle(ch.id);
				return row;
			});
		},
	);

	// DELETE /api/channels/dead — bulk delete all dead channels (optionally scoped to a host)
	// Alias: POST /api/channels/purge-dead (kept for backward compatibility)
	// MUST be registered before /:id routes to avoid matching as a channel ID param.
	const purgeDeadHandler = async (
		request: { body?: { host_id?: string } },
		reply: { code: (n: number) => { send: (v: unknown) => unknown } },
	) => {
		const { host_id } = request.body ?? {};

		let deadChannelIds: string[];
		if (host_id) {
			const sessions = metaDal.listSessions(host_id);
			const allChannels = sessions.flatMap((s) => metaDal.listChannels(s.id));
			deadChannelIds = allChannels.filter((c) => c.status === "dead").map((c) => c.id);
		} else {
			const allChannels = metaDal.listChannels();
			deadChannelIds = allChannels.filter((c) => c.status === "dead").map((c) => c.id);
		}

		for (const id of deadChannelIds) {
			spoolDal.deleteChunksForChannel(id);
			metaDal.deleteChannel(id);
		}

		return reply.code(200).send({ ok: true, purged: deadChannelIds.length });
	};

	server.delete<{ Body: { host_id?: string } }>("/api/channels/dead", purgeDeadHandler);
	// Backward-compat alias — original method was POST
	server.post<{ Body: { host_id?: string } }>("/api/channels/purge-dead", purgeDeadHandler);

	// GET /api/channels/:id
	server.get<{ Params: { id: string } }>("/api/channels/:id", async (request, reply) => {
		const channel = metaDal.getChannel(request.params.id);
		if (!channel) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Channel not found" } });
		}
		const row = toSnakeCase(channel) as Record<string, unknown>;
		row.display_title = sessionManager.resolveDisplayTitle(channel.id);
		return row;
	});

	// PATCH /api/channels/:id
	server.patch<{
		Params: { id: string };
		Body: {
			title?: string | null;
			group_id?: string | null;
			icon?: string | null;
			shell?: string | null;
			args?: string[];
			cwd?: string | null;
			direct_process?: boolean;
		};
	}>(
		"/api/channels/:id",
		{
			schema: {
				body: {
					type: "object",
					properties: {
						title: { type: ["string", "null"], minLength: 1, maxLength: 128 },
						group_id: { type: ["string", "null"] },
						icon: { type: ["string", "null"], maxLength: 64 },
						shell: { type: ["string", "null"], maxLength: 512 },
						args: {
							type: "array",
							items: { type: "string" },
							maxItems: 64,
						},
						cwd: { type: ["string", "null"], maxLength: 1024 },
						direct_process: { type: "boolean" },
					},
					minProperties: 1,
					additionalProperties: false,
				},
				params: {
					type: "object",
					required: ["id"],
					properties: {
						id: { type: "string" },
					},
				},
			},
		},
		async (request, reply) => {
			const { id } = request.params;

			if (!isValidUlid(id)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "Invalid channel ID" },
				});
			}

			const { title, group_id, icon, shell, args, cwd, direct_process } = request.body;

			// Whitespace-only titles still need a manual check (schema can't validate trimmed length).
			if (title !== undefined && title !== null && title.trim().length === 0) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "title must be a string of 1\u2013128 characters, or null",
					},
				});
			}

			if (group_id !== undefined && group_id !== null && !isValidUlid(group_id)) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "group_id must be a valid ULID or null",
					},
				});
			}

			const channel = metaDal.getChannel(id);
			if (!channel) {
				return reply.code(404).send({
					error: { code: "NOT_FOUND", message: "Channel not found" },
				});
			}

			if (title !== undefined) {
				metaDal.updateChannelTitle(id, title?.trim() ?? null);
				// Recompute displayTitle and broadcast to active UI clients
				sessionManager.notifyChannelRenamed(id);
			}
			if (group_id !== undefined) {
				metaDal.updateChannelGroupId(id, group_id);
			}

			// Collect config fields and update in a single call
			const configUpdate: {
				icon?: string | null;
				shell?: string | null;
				args?: string[];
				cwd?: string | null;
				directProcess?: boolean;
			} = {};
			if (icon !== undefined) configUpdate.icon = icon;
			if (shell !== undefined) configUpdate.shell = shell;
			if (args !== undefined) configUpdate.args = args;
			if (cwd !== undefined) configUpdate.cwd = cwd;
			if (direct_process !== undefined) configUpdate.directProcess = direct_process;
			if (Object.keys(configUpdate).length > 0) {
				metaDal.updateChannelConfig(id, configUpdate);
			}

			const updated = metaDal.getChannel(id);
			return reply.code(200).send(toSnakeCase(updated));
		},
	);

	// POST /api/channels/:id/restart — restart a channel's PTY
	server.post<{ Params: { id: string } }>("/api/channels/:id/restart", async (request, reply) => {
		const { id } = request.params;

		if (!isValidUlid(id)) {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: "Invalid channel ID" },
			});
		}

		const channel = metaDal.getChannel(id);
		if (!channel) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Channel not found" },
			});
		}

		try {
			const ok = await sessionManager.restartChannel(id);
			if (!ok) {
				return reply.code(503).send({
					error: { code: "RESTART_FAILED", message: "Unable to restart channel" },
				});
			}
			return reply.code(200).send({ channel_id: id });
		} catch (err) {
			return reply.code(500).send({
				error: {
					code: "RESTART_ERROR",
					message: err instanceof Error ? err.message : "Unknown error",
				},
			});
		}
	});

	// DELETE /api/channels/:id — destroy a channel's PTY and mark it dead
	server.delete<{ Params: { id: string } }>("/api/channels/:id", async (request, reply) => {
		const { id } = request.params;

		if (!isValidUlid(id)) {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: "Invalid channel ID" },
			});
		}

		const channel = metaDal.getChannel(id);
		if (!channel) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Channel not found" },
			});
		}

		// Already dead — purge: delete chunks from spool + record from meta
		if (channel.status === "dead") {
			spoolDal.deleteChunksForChannel(id);
			metaDal.deleteChannel(id);
			return reply.code(200).send({ ok: true, purged: true });
		}

		if (!sessionManager.destroyChannel(id)) {
			// Channel exists in DB but not in SessionManager's in-memory map
			// (e.g. orphaned after hub restart). Mark dead directly.
			metaDal.updateChannelStatus(id, "dead");
		}
		return reply.code(200).send({ ok: true });
	});
}
