import type { Host } from "@lasterm/shared";
import { toSnakeCase } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { MetaDAL } from "../storage/meta.js";

/**
 * Infer the OS of a host for launch profile filtering.
 *
 * Resolution order:
 * 1. Agent-reported shells (discoveredShells): infer from path patterns.
 * 2. Local host: use process.platform.
 * 3. SSH host without HELLO data: 'unknown' (show all profiles).
 *
 * @param host  The host record from meta.db.
 */
export function resolveHostOs(host: Host): string {
	// Prefer explicitly stored OS (set after auto-detect on first SSH connect)
	if (host.os != null) return host.os;
	if (host.discoveredShells && host.discoveredShells.length > 0) {
		const hasWindowsShells = host.discoveredShells.some(
			(s) => s.includes("\\") || s.toLowerCase().endsWith(".exe"),
		);
		if (hasWindowsShells) return "windows";
		const hasMacPaths = host.discoveredShells.some(
			(s) => s.includes("/usr/local/") || s.includes("/opt/homebrew/"),
		);
		if (hasMacPaths) return "darwin";
		return "linux";
	}
	if (host.type === "local") {
		if (process.platform === "win32") return "windows";
		if (process.platform === "darwin") return "darwin";
		return "linux";
	}
	return "unknown";
}

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

	// PUT /api/hosts/:id/profiles/:profileId — upsert override
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
		return reply.code(204).send();
	});

	// DELETE /api/hosts/:id/profiles/:profileId — remove override
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
			return reply.code(204).send();
		},
	);
}
