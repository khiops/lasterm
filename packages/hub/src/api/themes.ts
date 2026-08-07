import type { LastermTheme } from "@lasterm/shared";
import { THEME_NAME_REGEX } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { ThemeManager } from "../theme-manager.js";
import { ThemeError } from "../theme-manager.js";

export function registerThemeRoutes(server: FastifyInstance, themeManager: ThemeManager): void {
	// ─── Theme CRUD ──────────────────────────────────────────────────────────

	server.get("/api/themes", async () => {
		return themeManager.list();
	});

	server.get<{ Params: { name: string } }>("/api/themes/:name", async (request, reply) => {
		const { name } = request.params;
		if (!THEME_NAME_REGEX.test(name)) {
			return reply.code(400).send({
				error: { code: "INVALID_NAME", message: `Invalid theme name: ${name}` },
			});
		}
		const theme = await themeManager.get(name);
		if (!theme) {
			return reply.code(404).send({
				error: { code: "THEME_NOT_FOUND", message: `Theme "${name}" not found` },
			});
		}
		return theme;
	});

	server.post("/api/themes", async (request, reply) => {
		const body = request.body as Record<string, unknown> | null;
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			return reply.code(400).send({
				error: { code: "INVALID_THEME", message: "Request body must be a theme object" },
			});
		}

		const name = body.name as string | undefined;
		if (typeof name !== "string") {
			return reply.code(400).send({
				error: { code: "INVALID_THEME", message: "Theme name is required" },
			});
		}

		// Check for duplicate
		const existing = await themeManager.get(name);
		if (existing) {
			return reply.code(409).send({
				error: { code: "THEME_EXISTS", message: `Theme "${name}" already exists` },
			});
		}

		try {
			await themeManager.save(body as unknown as LastermTheme);
			return reply.code(201).send({ name });
		} catch (err) {
			if (err instanceof ThemeError) {
				return reply.code(400).send({
					error: { code: err.code, message: err.message },
				});
			}
			throw err;
		}
	});

	server.put<{ Params: { name: string } }>("/api/themes/:name", async (request, reply) => {
		const { name } = request.params;
		const body = request.body as Record<string, unknown> | null;
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			return reply.code(400).send({
				error: { code: "INVALID_THEME", message: "Request body must be a theme object" },
			});
		}

		try {
			await themeManager.save({ ...body, name } as unknown as LastermTheme);
			return reply.code(200).send({ name });
		} catch (err) {
			if (err instanceof ThemeError) {
				return reply.code(400).send({
					error: { code: err.code, message: err.message },
				});
			}
			throw err;
		}
	});

	server.delete<{ Params: { name: string } }>("/api/themes/:name", async (request, reply) => {
		const { name } = request.params;

		try {
			await themeManager.delete(name);
			return reply.code(204).send();
		} catch (err) {
			if (err instanceof ThemeError) {
				if (err.code === "INVALID_NAME") {
					return reply.code(400).send({
						error: { code: err.code, message: err.message },
					});
				}
				if (err.code === "BUNDLED_THEME") {
					return reply.code(409).send({
						error: { code: err.code, message: err.message },
					});
				}
			}
			throw err;
		}
	});
}
