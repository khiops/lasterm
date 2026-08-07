import { readFileSync } from "node:fs";
import type { LaunchProfile } from "@lasterm/shared";
import { toSnakeCase, validateShell } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import {
	findWindowsTerminalSettingsPath,
	importWindowsTerminalProfiles,
	parseWindowsTerminalSettings,
} from "../shell-discovery.js";
import type { MetaDAL } from "../storage/meta.js";

// ─── Validation ──────────────────────────────────────────────────────────────

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ENV_MASK_RE = /password|secret|token|key|credential/i;
const ENV_SENTINEL = "********";

function validateCreateBody(body: CreateLaunchProfileBody): string | null {
	if (!body.name || body.name.trim().length === 0) {
		return "name is required";
	}
	if (body.name.length > 100) {
		return "name must be 100 characters or fewer";
	}
	const shellErr = validateShell(body.shell ?? "");
	if (shellErr) return shellErr;
	if (body.args !== undefined) {
		if (!Array.isArray(body.args) || body.args.length > 64) {
			return "args must be an array of at most 64 items";
		}
		for (const arg of body.args) {
			if (typeof arg !== "string" || arg.length > 1024) {
				return "each arg must be a string of at most 1024 characters";
			}
		}
	}
	if (body.cwd !== undefined && body.cwd !== null && body.cwd.length > 1024) {
		return "cwd must be 1024 characters or fewer";
	}
	if (body.env !== undefined && body.env !== null) {
		const entries = Object.entries(body.env);
		if (entries.length > 100) return "env must have at most 100 entries";
		for (const [k, v] of entries) {
			if (k.length > 256) return "env key must be 256 characters or fewer";
			if (v.length > 4096) return "env value must be 4096 characters or fewer";
		}
	}
	if (body.color !== undefined && body.color !== null && !COLOR_RE.test(body.color)) {
		return "color must be in hex format #rrggbb";
	}
	if (body.icon_value !== undefined && body.icon_value !== null && body.icon_value.length > 256) {
		return "icon_value must be 256 characters or fewer";
	}
	if (
		body.mode !== undefined &&
		body.mode !== null &&
		body.mode !== "shell" &&
		body.mode !== "process"
	) {
		return "mode must be 'shell' or 'process'";
	}
	if (
		body.supported_os !== undefined &&
		body.supported_os !== null &&
		!["linux", "darwin", "windows", "any"].includes(body.supported_os)
	) {
		return "supported_os must be 'linux', 'darwin', 'windows', or 'any'";
	}
	if (
		body.icon_type !== undefined &&
		body.icon_type !== null &&
		!["auto", "emoji", "image"].includes(body.icon_type)
	) {
		return "icon_type must be 'auto', 'emoji', or 'image'";
	}
	return null;
}

// ─── Env masking (INV-12) ────────────────────────────────────────────────────

function maskEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env) return env;
	const masked: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		masked[k] = ENV_MASK_RE.test(k) ? ENV_SENTINEL : v;
	}
	return masked;
}

function maskProfile(profile: LaunchProfile): LaunchProfile {
	const masked = maskEnv(profile.env);
	const { env: _env, ...rest } = profile;
	return {
		...rest,
		...(masked !== undefined && { env: masked }),
	} as LaunchProfile;
}

// ─── Wire format helpers ─────────────────────────────────────────────────────

/**
 * Convert a LaunchProfile to the snake_case wire format.
 * The `env` object keys are environment variable names (e.g. MY_VAR) and must
 * NOT be run through camelToSnake — we extract and re-inject them after toSnakeCase.
 */
function profileToWire(profile: LaunchProfile): unknown {
	const masked = maskProfile(profile);
	const { env, ...rest } = masked;
	const wire = toSnakeCase(rest) as Record<string, unknown>;
	// Re-inject env with original keys preserved (env var names are not camelCase)
	if (env !== undefined) {
		wire.env = env;
	}
	return wire;
}

// ─── Body interfaces ─────────────────────────────────────────────────────────

interface CreateLaunchProfileBody {
	name: string;
	shell: string;
	args?: string[];
	cwd?: string | null;
	env?: Record<string, string> | null;
	mode?: "shell" | "process" | null;
	elevated?: boolean | null;
	supported_os?: "linux" | "darwin" | "windows" | "any" | null;
	icon_type?: "auto" | "emoji" | "image" | null;
	icon_value?: string | null;
	color?: string | null;
	profile_overrides?: Record<string, unknown> | null;
	sort_order?: number | null;
}

interface UpdateLaunchProfileBody {
	name?: string;
	shell?: string;
	args?: string[] | null;
	cwd?: string | null;
	env?: Record<string, string> | null;
	mode?: "shell" | "process";
	elevated?: boolean;
	supported_os?: "linux" | "darwin" | "windows" | "any";
	icon_type?: "auto" | "emoji" | "image";
	icon_value?: string | null;
	color?: string | null;
	profile_overrides?: Record<string, unknown> | null;
	sort_order?: number;
}

// ─── Route registration ──────────────────────────────────────────────────────

export function registerLaunchProfileRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
	// GET /api/launch-profiles?limit=N&offset=M
	server.get<{ Querystring: { limit?: string; offset?: string } }>(
		"/api/launch-profiles",
		async (request) => {
			const rawLimit = request.query.limit;
			const rawOffset = request.query.offset;
			const limit = rawLimit !== undefined ? Number.parseInt(rawLimit, 10) : undefined;
			const offset = rawOffset !== undefined ? Number.parseInt(rawOffset, 10) : undefined;

			if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
				return {
					error: { code: "VALIDATION_ERROR", message: "limit must be between 1 and 1000" },
				};
			}
			if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
				return { error: { code: "VALIDATION_ERROR", message: "offset must be >= 0" } };
			}

			if (limit !== undefined) {
				const total = metaDal.countLaunchProfiles();
				const data = metaDal.listLaunchProfiles(limit, offset ?? 0).map(profileToWire);
				return { data, total, limit, offset: offset ?? 0 };
			}
			return metaDal.listLaunchProfiles().map(profileToWire);
		},
	);

	// PUT /api/launch-profiles/order — reorder launch profiles
	// Alias: POST /api/launch-profiles/reorder (kept for backward compatibility)
	// MUST be before /:id to avoid param collision.
	const reorderHandler = async (
		request: { body: { ids: string[] } },
		reply: { code: (n: number) => { send: (v: unknown) => unknown } },
	) => {
		const { ids } = request.body;
		if (!Array.isArray(ids)) {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: "ids must be an array" },
			});
		}
		metaDal.reorderLaunchProfiles(ids);
		return reply.code(204).send(null);
	};

	server.put<{ Body: { ids: string[] } }>("/api/launch-profiles/order", reorderHandler);
	// Backward-compat alias — original method was POST
	server.post<{ Body: { ids: string[] } }>("/api/launch-profiles/reorder", reorderHandler);

	// POST /api/launch-profiles
	server.post<{ Body: CreateLaunchProfileBody }>("/api/launch-profiles", async (request, reply) => {
		const body = request.body;

		const validationError = validateCreateBody(body);
		if (validationError) {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: validationError },
			});
		}

		// Duplicate name check (case-insensitive via COLLATE NOCASE in DB)
		const existing = metaDal.getLaunchProfileByName(body.name.trim());
		if (existing) {
			return reply.code(409).send({
				error: {
					code: "CONFLICT",
					message: "A launch profile with this name already exists",
				},
			});
		}

		const profile = metaDal.createLaunchProfile({
			name: body.name.trim(),
			shell: body.shell.trim(),
			mode: body.mode ?? "shell",
			elevated: body.elevated ?? false,
			supportedOs: body.supported_os ?? "any",
			iconType: body.icon_type ?? "auto",
			sortOrder: body.sort_order ?? 0,
			...(body.args !== undefined && body.args !== null && { args: body.args }),
			...(body.cwd !== undefined && body.cwd !== null && { cwd: body.cwd }),
			...(body.env !== undefined && body.env !== null && { env: body.env }),
			...(body.icon_value !== undefined &&
				body.icon_value !== null && { iconValue: body.icon_value }),
			...(body.color !== undefined && body.color !== null && { color: body.color }),
			...(body.profile_overrides !== undefined &&
				body.profile_overrides !== null && {
					profileOverrides: body.profile_overrides as NonNullable<
						LaunchProfile["profileOverrides"]
					>,
				}),
		});

		return reply.code(201).send(profileToWire(profile));
	});

	// GET /api/launch-profiles/:id
	server.get<{ Params: { id: string } }>("/api/launch-profiles/:id", async (request, reply) => {
		const profile = metaDal.getLaunchProfile(request.params.id);
		if (!profile) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Launch profile not found" },
			});
		}
		return profileToWire(profile);
	});

	// PUT /api/launch-profiles/:id
	server.put<{ Params: { id: string }; Body: UpdateLaunchProfileBody }>(
		"/api/launch-profiles/:id",
		async (request, reply) => {
			const existing = metaDal.getLaunchProfile(request.params.id);
			if (!existing) {
				return reply.code(404).send({
					error: { code: "NOT_FOUND", message: "Launch profile not found" },
				});
			}

			const body = request.body;

			// Validate shell if provided
			if (body.shell !== undefined) {
				const shellErr = validateShell(body.shell);
				if (shellErr) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: shellErr },
					});
				}
			}

			// Validate name if provided
			if (body.name !== undefined) {
				if (!body.name || body.name.trim().length === 0 || body.name.length > 100) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: "name must be 1-100 characters",
						},
					});
				}
				// Duplicate check (excluding self)
				const conflict = metaDal.getLaunchProfileByName(body.name.trim());
				if (conflict && conflict.id !== request.params.id) {
					return reply.code(409).send({
						error: {
							code: "CONFLICT",
							message: "A launch profile with this name already exists",
						},
					});
				}
			}

			// Validate color if provided
			if (body.color !== undefined && body.color !== null && !COLOR_RE.test(body.color)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "color must be in hex format #rrggbb" },
				});
			}

			// Validate args if provided
			if (body.args !== undefined && body.args !== null) {
				if (!Array.isArray(body.args) || body.args.length > 64) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: "args must be an array of at most 64 items",
						},
					});
				}
				for (const arg of body.args) {
					if (typeof arg !== "string" || arg.length > 1024) {
						return reply.code(400).send({
							error: {
								code: "VALIDATION_ERROR",
								message: "each arg must be a string of at most 1024 characters",
							},
						});
					}
				}
			}

			// Build update object — only include fields present in request body.
			// exactOptionalPropertyTypes: never assign undefined to optional keys — use delete.
			const updates: Partial<LaunchProfile> = {
				...(body.name !== undefined && { name: body.name.trim() }),
				...(body.shell !== undefined && { shell: body.shell.trim() }),
				...(body.mode !== undefined && { mode: body.mode }),
				...(body.elevated !== undefined && { elevated: body.elevated }),
				...(body.supported_os !== undefined && { supportedOs: body.supported_os }),
				...(body.icon_type !== undefined && { iconType: body.icon_type }),
				...(body.sort_order !== undefined && { sortOrder: body.sort_order }),
				...(body.icon_value != null && { iconValue: body.icon_value }),
				...(body.color != null && { color: body.color }),
				...(body.cwd != null && { cwd: body.cwd }),
			};

			// args: null means clear (set to empty, DAL will store null in DB)
			if ("args" in body) {
				if (body.args != null) {
					updates.args = body.args;
				}
				// null/undefined means clear: DAL checks "args" in updates and stores null
			}

			// profile_overrides: null means clear
			if ("profile_overrides" in body) {
				if (body.profile_overrides != null) {
					updates.profileOverrides = body.profile_overrides as NonNullable<
						LaunchProfile["profileOverrides"]
					>;
				}
				// null means clear
			}

			// env: sentinel handling (INV-12)
			if ("env" in body && body.env != null) {
				const existingEnv = existing.env ?? {};
				const mergedEnv: Record<string, string> = {};
				for (const [k, v] of Object.entries(body.env)) {
					// If value is the sentinel, preserve the existing DB value
					mergedEnv[k] = v === ENV_SENTINEL ? (existingEnv[k] ?? v) : v;
				}
				updates.env = mergedEnv;
			}
			// env: null means clear — leave updates.env absent so DAL stores null

			const updated = metaDal.updateLaunchProfile(request.params.id, updates);
			if (!updated) {
				return reply.code(404).send({
					error: { code: "NOT_FOUND", message: "Launch profile not found" },
				});
			}

			return profileToWire(updated);
		},
	);

	// DELETE /api/launch-profiles/:id
	server.delete<{ Params: { id: string } }>("/api/launch-profiles/:id", async (request, reply) => {
		const count = metaDal.countLaunchProfiles();
		if (count === 1) {
			return reply.code(400).send({
				error: { code: "LAST_PROFILE", message: "Cannot delete the last launch profile" },
			});
		}
		const deleted = metaDal.deleteLaunchProfile(request.params.id);
		if (!deleted) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Launch profile not found" },
			});
		}
		return reply.code(204).send();
	});

	// POST /api/launch-profiles/import-windows-terminal
	// Import profiles from Windows Terminal's settings.json.
	// Only available on Windows; returns 501 on other platforms.
	server.post("/api/launch-profiles/import-windows-terminal", async (_request, reply) => {
		if (process.platform !== "win32") {
			return reply.code(501).send({
				error: {
					code: "NOT_SUPPORTED",
					message: "Windows Terminal import is only available on Windows",
				},
			});
		}

		const settingsPath = findWindowsTerminalSettingsPath();
		if (!settingsPath) {
			return reply.code(404).send({
				error: {
					code: "NOT_FOUND",
					message: "Windows Terminal settings.json not found",
				},
			});
		}

		let settingsJson: string;
		try {
			settingsJson = readFileSync(settingsPath, "utf8");
		} catch {
			return reply.code(500).send({
				error: {
					code: "READ_ERROR",
					message: "Failed to read Windows Terminal settings.json",
				},
			});
		}

		const wtProfiles = parseWindowsTerminalSettings(settingsJson);
		const result = importWindowsTerminalProfiles(metaDal, wtProfiles);

		return reply.code(200).send({
			imported: result.imported,
			skipped: result.skipped,
			profiles: result.profiles.map(profileToWire),
		});
	});
}
