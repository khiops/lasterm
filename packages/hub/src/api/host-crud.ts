import { ELEVATION_METHODS_ALL, toSnakeCase, validateCustomCommand } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { MetaDAL } from "../storage/meta.js";
import type { CreateHostBody, UpdateHostBody } from "./hosts.js";
import { validateCreateHost, validateProfileJson } from "./hosts.js";

export function registerHostCrudRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
	// GET /api/hosts?limit=N&offset=M
	server.get<{ Querystring: { limit?: string; offset?: string } }>(
		"/api/hosts",
		async (request) => {
			const rawLimit = request.query.limit;
			const rawOffset = request.query.offset;
			const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : undefined;
			const offset = rawOffset !== undefined ? Number.parseInt(rawOffset, 10) : undefined;

			if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
				return { error: { code: "VALIDATION_ERROR", message: "limit must be between 1 and 1000" } };
			}
			if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
				return { error: { code: "VALIDATION_ERROR", message: "offset must be >= 0" } };
			}

			if (limit !== undefined) {
				const total = metaDal.countHosts();
				const data = metaDal.listHosts(limit, offset ?? 0);
				return { data: toSnakeCase(data), total, limit, offset: offset ?? 0 };
			}
			return toSnakeCase(metaDal.listHosts());
		},
	);

	// POST /api/hosts
	server.post<{ Body: CreateHostBody }>("/api/hosts", async (request, reply) => {
		const body = request.body;

		const validationError = validateCreateHost(body);
		if (validationError) {
			return reply
				.code(400)
				.send({ error: { code: "VALIDATION_ERROR", message: validationError } });
		}

		// Validate custom_command if provided (AUD-012)
		if (body.custom_command != null) {
			try {
				validateCustomCommand(body.custom_command);
			} catch (err) {
				const e = err as { code: string; message: string };
				return reply.code(400).send({ error: { code: e.code, message: e.message } });
			}
		}

		// Validate visual profile colors in profile_json (INV-09)
		const profileJsonError = validateProfileJson(body.profile_json);
		if (profileJsonError) {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: profileJsonError },
			});
		}

		// Duplicate label check
		const existing = metaDal.getHostByLabel(body.label.trim());
		if (existing) {
			return reply
				.code(409)
				.send({ error: { code: "CONFLICT", message: "Host with this label already exists" } });
		}

		// Build create input conditionally to satisfy exactOptionalPropertyTypes
		const host = metaDal.createHost({
			type: body.type,
			label: body.label.trim(),
			...(body.ssh_host !== undefined && { sshHost: body.ssh_host }),
			...(body.ssh_port !== undefined && { sshPort: body.ssh_port }),
			...(body.ssh_auth !== undefined && { sshAuth: body.ssh_auth }),
			...(body.ssh_key_path !== undefined && { sshKeyPath: body.ssh_key_path }),
			...(body.icon_type !== undefined && { iconType: body.icon_type }),
			...(body.icon_value !== undefined && { iconValue: body.icon_value }),
			...(body.color !== undefined && { color: body.color }),
			...(body.trust_remote_hints !== undefined && { trustRemoteHints: body.trust_remote_hints }),
			...(body.default_shell !== undefined && { defaultShell: body.default_shell }),
			...(body.default_cwd !== undefined && { defaultCwd: body.default_cwd }),
			...(body.host_group !== undefined && { hostGroup: body.host_group }),
			...(body.host_group_id !== undefined && { hostGroupId: body.host_group_id }),
			...(body.ssh_config_host !== undefined && { sshConfigHost: body.ssh_config_host }),
			...(body.ssh_user !== undefined && { sshUser: body.ssh_user }),
			...(body.keep_alive_seconds !== undefined && { keepAliveSeconds: body.keep_alive_seconds }),
			...(body.history_retention_days !== undefined && {
				historyRetentionDays: body.history_retention_days,
			}),
			...(body.profile_json !== undefined && { profileJson: body.profile_json }),
			...(body.elevation_method !== undefined && { elevationMethod: body.elevation_method }),
			...(body.custom_command !== undefined && { customCommand: body.custom_command }),
			...(body.os !== undefined && { os: body.os }),
			...(body.arch !== undefined && { arch: body.arch }),
		});

		return reply.code(201).send(toSnakeCase(host));
	});

	// PUT /api/hosts/order — reorder hosts within a group
	// Alias: PUT /api/hosts/reorder (kept for backward compatibility)
	// MUST be registered before /:id to avoid "order"/"reorder" matching as a host ID param.
	for (const url of ["/api/hosts/order", "/api/hosts/reorder"]) {
		server.put<{ Body: { group_id: string | null; host_ids: string[] } }>(
			url,
			async (request, reply) => {
				const { group_id, host_ids } = request.body;
				if (!Array.isArray(host_ids) || host_ids.length === 0) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: "host_ids must be a non-empty array",
						},
					});
				}
				metaDal.reorderHosts(group_id ?? null, host_ids);
				return reply.code(204).send();
			},
		);
	}

	// GET /api/hosts/:id
	server.get<{ Params: { id: string } }>("/api/hosts/:id", async (request, reply) => {
		const host = metaDal.getHost(request.params.id);
		if (!host) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
		}
		return toSnakeCase(host);
	});

	// PUT /api/hosts/:id
	server.put<{ Params: { id: string }; Body: UpdateHostBody }>(
		"/api/hosts/:id",
		async (request, reply) => {
			const host = metaDal.getHost(request.params.id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}

			const body = request.body;

			// Validate color if provided
			if (body.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "color must be in hex format #rrggbb" },
				});
			}

			// Validate ssh_port if provided
			if (body.ssh_port !== undefined) {
				if (!Number.isInteger(body.ssh_port) || body.ssh_port < 1 || body.ssh_port > 65535) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: "ssh_port must be between 1 and 65535" },
					});
				}
			}

			// Validate visual profile colors (INV-09)
			const profileJsonError = validateProfileJson(body.profile_json);
			if (profileJsonError) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: profileJsonError },
				});
			}

			// Validate label if provided
			if (body.label !== undefined) {
				if (body.label.trim().length === 0 || body.label.length > 64) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: "Label must be 1-64 characters" },
					});
				}
				if (!/^[a-zA-Z0-9._-]+$/.test(body.label)) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message:
								"Label must contain only alphanumeric characters, dots, dashes, and underscores",
						},
					});
				}
				// Duplicate label check (excluding self)
				const labelConflict = metaDal.getHostByLabel(body.label.trim());
				if (labelConflict && labelConflict.id !== request.params.id) {
					return reply
						.code(409)
						.send({ error: { code: "CONFLICT", message: "Host with this label already exists" } });
				}
			}

			// Build a partial update — only include fields present in the request body.
			// MetaDAL's updateHost uses `camel in input` to detect which columns to SET,
			// so passing `key: undefined` would incorrectly NULL out required columns.
			const updateInput: Parameters<typeof metaDal.updateHost>[1] = {};
			if (body.type !== undefined) updateInput.type = body.type;
			if (body.label !== undefined) updateInput.label = body.label.trim();
			if (body.ssh_host !== undefined) updateInput.sshHost = body.ssh_host;
			if (body.ssh_port !== undefined) updateInput.sshPort = body.ssh_port;
			if (body.ssh_auth !== undefined) updateInput.sshAuth = body.ssh_auth;
			if (body.ssh_key_path !== undefined) updateInput.sshKeyPath = body.ssh_key_path;
			if (body.icon_type !== undefined) updateInput.iconType = body.icon_type;
			if (body.icon_value !== undefined) updateInput.iconValue = body.icon_value;
			if (body.color !== undefined) updateInput.color = body.color;
			if (body.trust_remote_hints !== undefined)
				updateInput.trustRemoteHints = body.trust_remote_hints;
			if (body.default_shell !== undefined) updateInput.defaultShell = body.default_shell;
			if (body.default_cwd !== undefined) updateInput.defaultCwd = body.default_cwd;
			if (body.host_group !== undefined) updateInput.hostGroup = body.host_group;
			if (body.host_group_id !== undefined) updateInput.hostGroupId = body.host_group_id;
			if (body.ssh_config_host !== undefined) updateInput.sshConfigHost = body.ssh_config_host;
			if (body.ssh_user !== undefined) updateInput.sshUser = body.ssh_user;
			if (body.keep_alive_seconds !== undefined)
				updateInput.keepAliveSeconds = body.keep_alive_seconds;
			if (body.history_retention_days !== undefined)
				updateInput.historyRetentionDays = body.history_retention_days;
			if (body.profile_json !== undefined) updateInput.profileJson = body.profile_json;
			if (body.elevation_method !== undefined) {
				if (
					body.elevation_method !== null &&
					!(ELEVATION_METHODS_ALL as readonly string[]).includes(body.elevation_method)
				) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: `elevation_method must be one of: ${ELEVATION_METHODS_ALL.join(", ")}`,
						},
					});
				}
				updateInput.elevationMethod = body.elevation_method;
			}
			if (body.custom_command !== undefined) {
				// Validate custom_command if non-null (AUD-012)
				if (body.custom_command != null) {
					try {
						validateCustomCommand(body.custom_command);
					} catch (err) {
						const e = err as { code: string; message: string };
						return reply.code(400).send({ error: { code: e.code, message: e.message } });
					}
				}
				updateInput.customCommand = body.custom_command;
			}
			if (body.os !== undefined) {
				if (body.os !== null && !["linux", "darwin", "windows"].includes(body.os)) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: "os must be 'linux', 'darwin', or 'windows'",
						},
					});
				}
				updateInput.os = body.os;
			}
			if (body.arch !== undefined) {
				if (body.arch !== null && !["x64", "arm64"].includes(body.arch)) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: "arch must be 'x64' or 'arm64'" },
					});
				}
				updateInput.arch = body.arch;
			}

			const updated = metaDal.updateHost(request.params.id, updateInput);

			return toSnakeCase(updated);
		},
	);

	// DELETE /api/hosts/:id
	server.delete<{ Params: { id: string } }>("/api/hosts/:id", async (request, reply) => {
		const hostId = request.params.id;
		// Check existence before cascade to return proper 404
		const existing = metaDal.getHost(hostId);
		if (!existing) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
		}
		// Cascade-delete dependents: cache_index → channels → sessions
		// channel_groups has ON DELETE CASCADE in schema but we do it explicitly for safety
		metaDal.deleteCascadeForHost(hostId);
		const deleted = metaDal.deleteHost(hostId);
		if (!deleted) {
			return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
		}
		return reply.code(204).send();
	});

	// POST /api/hosts/:id/duplicate — duplicate a host
	server.post<{ Params: { id: string } }>("/api/hosts/:id/duplicate", async (request, reply) => {
		const result = metaDal.duplicateHost(request.params.id);
		if (!result) {
			return reply.code(400).send({
				error: {
					code: "VALIDATION_ERROR",
					message: "Host not found or cannot be duplicated",
				},
			});
		}
		return reply.code(201).send(toSnakeCase(result));
	});
}
