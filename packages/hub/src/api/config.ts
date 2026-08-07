import type { TerminalProfile } from "@lasterm/shared";
import {
	DEFAULT_PROFILE,
	ELEVATION_CONFIG_KEYS,
	ELEVATION_METHODS_DARWIN,
	ELEVATION_METHODS_LINUX,
	ELEVATION_METHODS_WINDOWS,
	TERMINAL_PROFILE_KEYS,
	UI_CONFIG_SECTIONS,
	UI_SECTION_KEYS,
} from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { ConfigResolver } from "../config.js";
import type { MetaDAL } from "../storage/meta.js";

interface ProfilePatchBody {
	profile: Partial<TerminalProfile>;
}

const APPEARANCE_KEYS = ["theme", "autoSwitch", "opacity", "scrollbar"] as const;

const UI_VALUE_VALIDATORS: Record<string, Record<string, (v: unknown) => boolean>> = {
	tabs: {
		closeButton: (v) => typeof v === "boolean",
		newTabPosition: (v) => v === "end" || v === "afterActive",
		confirmCloseAll: (v) => typeof v === "boolean",
		confirmCloseOthers: (v) => typeof v === "boolean",
	},
	panes: {
		maxPanes: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1,
		defaultSplitDirection: (v) => v === "horizontal" || v === "vertical",
	},
	channels: {
		defaultShell: (v) => typeof v === "string",
		defaultGroupName: (v) => typeof v === "string",
		autoGroup: (v) => v === "none" || v === "first",
	},
	startup: {
		autoOpenWelcome: (v) => typeof v === "boolean",
	},
	title: {
		source: (v) => v === "dynamic" || v === "static" || v === "process",
		staticTitle: (v) => typeof v === "string",
		maxLength: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1,
		truncation: (v) => v === "end" || v === "middle" || v === "start",
		prefix: (v) => typeof v === "string",
		windowTitle: (v) => typeof v === "boolean",
		windowFormat: (v) => typeof v === "string",
	},
	search: {
		position: (v) => v === "top-right" || v === "bottom-right" || v === "bottom-bar",
		highlightOnClose: (v) => v === "clear" || v === "fade" || v === "persist",
		scrollbarMarkers: (v) => typeof v === "boolean",
		historySize: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100,
	},
	layout: {
		hostRailWidth: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
		sidebarWidth: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0,
	},
};

export function registerConfigRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	configResolver: ConfigResolver,
	sessionManager?: { broadcastDisplayTitles(): void },
): void {
	// GET /api/config/defaults — Layer 1 built-in defaults
	server.get("/api/config/defaults", async () => {
		return DEFAULT_PROFILE;
	});

	// GET /api/config/ui — UI behavioral configuration
	server.get("/api/config/ui", async () => {
		return configResolver.uiConfig;
	});

	// GET /api/config/cascade?host_id=X&channel_id=Y — full 4-layer cascade
	server.get<{
		Querystring: { host_id?: string; channel_id?: string };
	}>("/api/config/cascade", async (request) => {
		const { host_id, channel_id } = request.query;
		return configResolver.getCascade(host_id, channel_id);
	});

	// PUT /api/config/global — write terminal keys to config.toml
	server.put<{ Body: { terminal?: Record<string, unknown> } }>(
		"/api/config/global",
		async (request, reply) => {
			const body = request.body as Record<string, unknown> | null;
			const terminal = body?.terminal;
			if (!terminal || typeof terminal !== "object") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "body.terminal must be an object" },
				});
			}

			for (const key of Object.keys(terminal as Record<string, unknown>)) {
				if (!(TERMINAL_PROFILE_KEYS as readonly string[]).includes(key)) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: `Unknown terminal key: ${key}` },
					});
				}
			}

			for (const [key, value] of Object.entries(terminal as Record<string, unknown>)) {
				await configResolver.saveGlobalTerminal(key, value);
			}

			return { ok: true };
		},
	);

	// PUT /api/config/ui — write UI section keys to config.toml
	server.put<{ Body: Record<string, Record<string, unknown>> }>(
		"/api/config/ui",
		async (request, reply) => {
			const body = request.body as Record<string, unknown> | null;
			if (!body || typeof body !== "object") {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "body must be an object" },
				});
			}

			for (const section of Object.keys(body)) {
				if (!(UI_CONFIG_SECTIONS as readonly string[]).includes(section)) {
					return reply.code(400).send({
						error: {
							code: "VALIDATION_ERROR",
							message: `Unknown UI section: ${section}`,
						},
					});
				}
				const sectionData = body[section];
				if (typeof sectionData !== "object" || sectionData === null) continue;

				// Validate individual keys within the section
				const allowedKeys = UI_SECTION_KEYS[section];
				if (allowedKeys) {
					for (const [key, value] of Object.entries(sectionData as Record<string, unknown>)) {
						if (!allowedKeys.includes(key)) {
							return reply.code(400).send({
								error: {
									code: "VALIDATION_ERROR",
									message: `Unknown key "${key}" in UI section "${section}"`,
								},
							});
						}
						const validator = UI_VALUE_VALIDATORS[section]?.[key];
						if (validator && !validator(value)) {
							return reply.code(400).send({
								error: {
									code: "INVALID_VALUE",
									message: `Invalid value for "${section}.${key}": ${JSON.stringify(value)}`,
								},
							});
						}
					}
				}

				for (const [key, value] of Object.entries(sectionData as Record<string, unknown>)) {
					await configResolver.saveGlobalKey(section, key, value);
				}
			}

			// Re-broadcast displayTitles if the title config section was changed
			if (sessionManager && Object.keys(body).includes("title")) {
				sessionManager.broadcastDisplayTitles();
			}

			return { ok: true };
		},
	);

	// PUT /api/config/appearance — write appearance keys to config.toml
	server.put("/api/config/appearance", async (request, reply) => {
		const body = request.body as Record<string, unknown> | null;
		if (!body || typeof body !== "object") {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: "body must be an object" },
			});
		}

		for (const key of Object.keys(body)) {
			if (!(APPEARANCE_KEYS as readonly string[]).includes(key)) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: `Unknown appearance key: ${key}`,
					},
				});
			}
		}

		for (const [key, value] of Object.entries(body)) {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				// Nested object (autoSwitch, opacity, scrollbar) — write each sub-key
				for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
					await configResolver.saveGlobalKey(`appearance.${key}`, subKey, subValue);
				}
			} else {
				// Flat key (theme)
				await configResolver.saveGlobalKey("appearance", key, value);
			}
		}

		return { ok: true };
	});

	// GET /api/hosts/:id/profile — read raw host profile_json
	server.get<{ Params: { id: string } }>("/api/hosts/:id/profile", async (request, reply) => {
		const { id } = request.params;
		const host = metaDal.getHost(id);
		if (!host) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Host not found" },
			});
		}
		const profileRaw = metaDal.getHostProfile(id);
		return { profile: profileRaw ? JSON.parse(profileRaw) : {} };
	});

	// PATCH /api/hosts/:id/profile — update host Layer 3 profile
	server.patch<{ Params: { id: string }; Body: ProfilePatchBody }>(
		"/api/hosts/:id/profile",
		async (request, reply) => {
			const { id } = request.params;

			const host = metaDal.getHost(id);
			if (!host) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Host not found" } });
			}

			const { profile } = request.body;
			if (profile === undefined || typeof profile !== "object" || Array.isArray(profile)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "body.profile must be an object" },
				});
			}

			for (const key of Object.keys(profile as Record<string, unknown>)) {
				if (key !== null && !(TERMINAL_PROFILE_KEYS as readonly string[]).includes(key)) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: `Unknown profile key: ${key}` },
					});
				}
			}

			const existingRaw = metaDal.getHostProfile(id);
			const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
			const merged: Record<string, unknown> = {
				...existing,
				...(profile as Record<string, unknown>),
			};
			for (const key of Object.keys(profile as Record<string, unknown>)) {
				if ((profile as Record<string, unknown>)[key] === null) {
					delete merged[key];
				}
			}
			metaDal.updateHostProfile(id, JSON.stringify(merged));

			return reply.code(200).send({ ok: true });
		},
	);

	// GET /api/channels/:id/profile — read raw channel profile_json
	server.get<{ Params: { id: string } }>("/api/channels/:id/profile", async (request, reply) => {
		const { id } = request.params;
		const channel = metaDal.getChannel(id);
		if (!channel) {
			return reply.code(404).send({
				error: { code: "NOT_FOUND", message: "Channel not found" },
			});
		}
		const profileRaw = metaDal.getChannelProfile(id);
		return { profile: profileRaw ? JSON.parse(profileRaw) : {} };
	});

	// GET /api/config/elevation — read current elevation config
	server.get("/api/config/elevation", async () => {
		return configResolver.elevationConfig;
	});

	// PUT /api/config/elevation — write elevation keys to config.toml
	server.put("/api/config/elevation", async (request, reply) => {
		const body = request.body as Record<string, unknown> | null;
		if (!body || typeof body !== "object") {
			return reply.code(400).send({
				error: { code: "VALIDATION_ERROR", message: "body must be an object" },
			});
		}

		for (const key of Object.keys(body)) {
			if (!(ELEVATION_CONFIG_KEYS as readonly string[]).includes(key)) {
				return reply.code(400).send({
					error: {
						code: "VALIDATION_ERROR",
						message: `Unknown elevation key: ${key}`,
					},
				});
			}
		}

		for (const [key, value] of Object.entries(body)) {
			if (key === "methodLinux") {
				if (
					typeof value !== "string" ||
					!(ELEVATION_METHODS_LINUX as readonly string[]).includes(value)
				) {
					return reply.code(400).send({
						error: {
							code: "INVALID_VALUE",
							message: `Invalid value for "${key}": must be one of ${ELEVATION_METHODS_LINUX.join(", ")}`,
						},
					});
				}
			} else if (key === "methodDarwin") {
				if (
					typeof value !== "string" ||
					!(ELEVATION_METHODS_DARWIN as readonly string[]).includes(value)
				) {
					return reply.code(400).send({
						error: {
							code: "INVALID_VALUE",
							message: `Invalid value for "${key}": must be one of ${ELEVATION_METHODS_DARWIN.join(", ")}`,
						},
					});
				}
			} else if (key === "methodWindows") {
				if (
					typeof value !== "string" ||
					!(ELEVATION_METHODS_WINDOWS as readonly string[]).includes(value)
				) {
					return reply.code(400).send({
						error: {
							code: "INVALID_VALUE",
							message: `Invalid value for "methodWindows": must be one of ${ELEVATION_METHODS_WINDOWS.join(", ")}`,
						},
					});
				}
			} else if (
				key === "customCommandLinux" ||
				key === "customCommandDarwin" ||
				key === "customCommandWindows"
			) {
				if (typeof value !== "string" || value.length === 0) {
					return reply.code(400).send({
						error: {
							code: "INVALID_VALUE",
							message: `Invalid value for "${key}": must be a non-empty string`,
						},
					});
				}
			}
			await configResolver.saveGlobalKey("elevation", key, value);
		}

		return { ok: true };
	});

	// PATCH /api/channels/:id/profile — update channel Layer 4 profile
	server.patch<{ Params: { id: string }; Body: ProfilePatchBody }>(
		"/api/channels/:id/profile",
		async (request, reply) => {
			const { id } = request.params;

			const channel = metaDal.getChannel(id);
			if (!channel) {
				return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Channel not found" } });
			}

			const { profile } = request.body;
			if (profile === undefined || typeof profile !== "object" || Array.isArray(profile)) {
				return reply.code(400).send({
					error: { code: "VALIDATION_ERROR", message: "body.profile must be an object" },
				});
			}

			for (const key of Object.keys(profile as Record<string, unknown>)) {
				if (key !== null && !(TERMINAL_PROFILE_KEYS as readonly string[]).includes(key)) {
					return reply.code(400).send({
						error: { code: "VALIDATION_ERROR", message: `Unknown profile key: ${key}` },
					});
				}
			}

			const existingRaw = metaDal.getChannelProfile(id);
			const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
			const merged: Record<string, unknown> = {
				...existing,
				...(profile as Record<string, unknown>),
			};
			for (const key of Object.keys(profile as Record<string, unknown>)) {
				if ((profile as Record<string, unknown>)[key] === null) {
					delete merged[key];
				}
			}
			metaDal.updateChannelProfile(id, JSON.stringify(merged));

			return reply.code(200).send({ ok: true });
		},
	);
}
