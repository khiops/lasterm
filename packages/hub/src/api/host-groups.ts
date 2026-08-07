import type { HostGroup } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { MetaDAL } from "../storage/meta.js";

const NAME_RE = /^[a-zA-Z0-9 _-]{1,32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DIGITS_RE = /^\d+$/;

function hostGroupToResponse(g: HostGroup) {
	return {
		id: g.id,
		name: g.name,
		sort_order: g.sortOrder,
		color: g.color,
		created_at: g.createdAt,
		updated_at: g.updatedAt,
	};
}

export function registerHostGroupRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
	// GET /api/host-groups?limit=N&offset=M
	server.get<{ Querystring: { limit?: string; offset?: string } }>(
		"/api/host-groups",
		async (request, reply) => {
			const rawLimit = request.query.limit;
			const rawOffset = request.query.offset;

			// A5: strict pagination — reject non-integer strings like "10abc"
			if (rawLimit !== undefined && !DIGITS_RE.test(rawLimit)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "limit must be a positive integer" },
				});
			}
			if (rawOffset !== undefined && !DIGITS_RE.test(rawOffset)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "offset must be a non-negative integer" },
				});
			}

			const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : undefined;
			const offset = rawOffset !== undefined ? Number.parseInt(rawOffset, 10) : undefined;

			if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "limit must be between 1 and 1000" },
				});
			}
			if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "offset must be >= 0" },
				});
			}

			if (limit !== undefined) {
				const total = metaDal.countHostGroupEntities();
				const data = metaDal.listHostGroupEntities(limit, offset ?? 0).map(hostGroupToResponse);
				return { data, total, limit, offset: offset ?? 0 };
			}
			return metaDal.listHostGroupEntities().map(hostGroupToResponse);
		},
	);

	// POST /api/host-groups
	server.post<{ Body: { name?: unknown; color?: unknown } }>(
		"/api/host-groups",
		async (request, reply) => {
			// A3: runtime body validation — guard missing/null/non-string fields
			if (!request.body || typeof request.body !== "object") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "request body must be an object" },
				});
			}
			const { name, color } = request.body as { name?: unknown; color?: unknown };

			if (typeof name !== "string") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "name must be a string" },
				});
			}

			// A4: color validation — must be null/undefined or a 6-digit hex color
			if (
				color !== undefined &&
				color !== null &&
				(typeof color !== "string" || !COLOR_RE.test(color))
			) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "color must be null or a hex color like #rrggbb",
					},
				});
			}

			// A1: trim-then-validate — normalize first, validate the trimmed value
			const n = name.trim();
			if (!n || !NAME_RE.test(n)) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "name must be 1-32 characters, alphanumeric with spaces, dashes, underscores",
					},
				});
			}

			try {
				const group = metaDal.createHostGroup(n, (color as string | null | undefined) ?? null);
				return reply.code(201).send(hostGroupToResponse(group));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("UNIQUE constraint failed")) {
					return reply.code(409).send({
						error: { code: "CONFLICT", message: "Host group with this name already exists" },
					});
				}
				throw err;
			}
		},
	);

	// PUT /api/host-groups/order — reorder host groups
	// Alias: PUT /api/host-groups/reorder (kept for backward compatibility)
	// MUST be registered BEFORE /:id to avoid param collision.
	for (const url of ["/api/host-groups/order", "/api/host-groups/reorder"]) {
		server.put<{ Body: { group_ids?: unknown } }>(url, async (request, reply) => {
			// A3: runtime body validation
			if (!request.body || typeof request.body !== "object") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "request body must be an object" },
				});
			}
			const { group_ids } = request.body as { group_ids?: unknown };

			if (!Array.isArray(group_ids) || group_ids.length === 0) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "group_ids must be a non-empty array",
					},
				});
			}

			// A2: reject non-string ids
			for (const id of group_ids) {
				if (typeof id !== "string") {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: "group_ids must contain only string ids" },
					});
				}
			}

			// A2: reject duplicates
			const seen = new Set<string>();
			for (const id of group_ids as string[]) {
				if (seen.has(id)) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: "group_ids must not contain duplicate ids",
						},
					});
				}
				seen.add(id);
			}

			// A2: reject unknown ids — fetch existing ids and validate exact permutation
			const existing = metaDal.listHostGroupEntities();
			const existingIds = new Set(existing.map((g) => g.id));
			for (const id of group_ids as string[]) {
				if (!existingIds.has(id)) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: `group_id not found: ${id}` },
					});
				}
			}

			// A2: require COMPLETE permutation — partial list leaves omitted groups with
			// duplicate sort_order values, breaking ordering invariants.
			if (group_ids.length !== existingIds.size) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "group_ids must include every host group",
					},
				});
			}

			metaDal.reorderHostGroups(group_ids as string[]);
			return reply.code(200).send({ ok: true });
		});
	}

	// PUT /api/host-groups/:id
	server.put<{ Params: { id: string }; Body: { name?: unknown; color?: unknown } }>(
		"/api/host-groups/:id",
		async (request, reply) => {
			// A3: runtime body validation
			if (!request.body || typeof request.body !== "object") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "request body must be an object" },
				});
			}
			const { id } = request.params;
			const { name, color } = request.body as { name?: unknown; color?: unknown };

			if (name !== undefined && typeof name !== "string") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "name must be a string" },
				});
			}

			// A4: color validation
			if (
				color !== undefined &&
				color !== null &&
				(typeof color !== "string" || !COLOR_RE.test(color))
			) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: "color must be null or a hex color like #rrggbb",
					},
				});
			}

			const fields: { name?: string; color?: string | null } = {};

			if (name !== undefined) {
				// A1: trim-then-validate for PUT as well
				const n = (name as string).trim();
				if (!n || !NAME_RE.test(n)) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message:
								"name must be 1-32 characters, alphanumeric with spaces, dashes, underscores",
						},
					});
				}
				fields.name = n;
			}
			if ("color" in (request.body as object))
				fields.color = (color as string | null | undefined) ?? null;

			try {
				const updated = metaDal.updateHostGroup(id, fields);
				if (!updated) {
					return reply.code(404).send({
						error: { code: "NOT_FOUND", message: "Host group not found" },
					});
				}
				return reply.code(200).send(hostGroupToResponse(updated));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("UNIQUE constraint failed")) {
					return reply.code(409).send({
						error: { code: "CONFLICT", message: "Host group with this name already exists" },
					});
				}
				throw err;
			}
		},
	);

	// DELETE /api/host-groups/:id
	server.delete<{ Params: { id: string } }>("/api/host-groups/:id", async (request, reply) => {
		const deleted = metaDal.deleteHostGroupEntity(request.params.id);
		if (!deleted) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Host group not found" },
			});
		}
		return reply.code(204).send();
	});
}
