import { ELEVATION_METHODS_ALL } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { MetaDAL } from "../storage/meta.js";
import { registerHostCrudRoutes } from "./host-crud.js";
import { registerHostProfileRoutes } from "./host-profiles.js";
import { registerHostSshImportRoutes } from "./host-ssh-import.js";
import { registerHostWelcomeRoutes } from "./host-welcome.js";

export interface CreateHostBody {
	type: "local" | "ssh";
	label: string;
	ssh_host?: string;
	ssh_port?: number;
	ssh_auth?: "agent" | "key" | "password";
	ssh_key_path?: string;
	icon_type?: "auto" | "emoji" | "image";
	icon_value?: string;
	color?: string;
	default_shell?: string;
	default_cwd?: string;
	trust_remote_hints?: "apply" | "ask" | "ignore";
	host_group?: string | null;
	host_group_id?: string | null;
	ssh_config_host?: string | null;
	ssh_user?: string | null;
	keep_alive_seconds?: number;
	history_retention_days?: number;
	profile_json?: string;
	elevation_method?: "sudo" | "doas" | "pkexec" | "gsudo" | "custom" | null;
	custom_command?: string | null;
	os?: "linux" | "darwin" | "windows" | null;
	arch?: "x64" | "arm64" | null;
}

export interface UpdateHostBody {
	type?: "local" | "ssh";
	label?: string;
	ssh_host?: string;
	ssh_port?: number;
	ssh_auth?: "agent" | "key" | "password";
	ssh_key_path?: string;
	icon_type?: "auto" | "emoji" | "image";
	icon_value?: string;
	color?: string;
	default_shell?: string;
	default_cwd?: string;
	trust_remote_hints?: "apply" | "ask" | "ignore";
	host_group?: string | null;
	host_group_id?: string | null;
	ssh_config_host?: string | null;
	ssh_user?: string | null;
	keep_alive_seconds?: number;
	history_retention_days?: number;
	profile_json?: string;
	elevation_method?: "sudo" | "doas" | "pkexec" | "gsudo" | "custom" | null;
	custom_command?: string | null;
	os?: "linux" | "darwin" | "windows" | null;
	arch?: "x64" | "arm64" | null;
}

export function validateCreateHost(body: CreateHostBody): string | null {
	if (!body.label || body.label.trim().length === 0) {
		return "Label is required";
	}
	if (body.label.length > 64) {
		return "Label must be 64 characters or fewer";
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(body.label)) {
		return "Label must contain only alphanumeric characters, dots, dashes, and underscores";
	}
	if (body.type !== "local" && body.type !== "ssh") {
		return "type must be 'local' or 'ssh'";
	}
	if (body.type === "ssh") {
		if (!body.ssh_host || body.ssh_host.includes("\0")) {
			return "ssh_host is required for SSH hosts and must not contain null bytes";
		}
		if (!/^[a-zA-Z0-9@._:-]+$/.test(body.ssh_host)) {
			return "ssh_host must contain only valid hostname characters";
		}
		if (
			body.ssh_auth !== undefined &&
			body.ssh_auth !== "agent" &&
			body.ssh_auth !== "key" &&
			body.ssh_auth !== "password"
		) {
			return "ssh_auth must be 'agent', 'key', or 'password'";
		}
		if (body.ssh_auth === "key" && (!body.ssh_key_path || body.ssh_key_path.trim().length === 0)) {
			return "ssh_key_path is required when ssh_auth is 'key'";
		}
	}
	if (body.ssh_port !== undefined) {
		if (!Number.isInteger(body.ssh_port) || body.ssh_port < 1 || body.ssh_port > 65535) {
			return "ssh_port must be an integer between 1 and 65535";
		}
	}
	if (body.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
		return "color must be in hex format #rrggbb";
	}
	if (
		body.elevation_method !== undefined &&
		body.elevation_method !== null &&
		!(ELEVATION_METHODS_ALL as readonly string[]).includes(body.elevation_method)
	) {
		return `elevation_method must be one of: ${ELEVATION_METHODS_ALL.join(", ")}`;
	}
	if (
		body.os !== undefined &&
		body.os !== null &&
		!["linux", "darwin", "windows"].includes(body.os)
	) {
		return "os must be 'linux', 'darwin', or 'windows'";
	}
	if (body.arch !== undefined && body.arch !== null && !["x64", "arm64"].includes(body.arch)) {
		return "arch must be 'x64' or 'arm64'";
	}
	return null;
}

function validateAndClampVisualProfile(vp: Record<string, unknown>): string | null {
	const hexRe = /^#[0-9a-fA-F]{6}$/;
	const colorsToCheck = [
		(vp.banner as Record<string, unknown> | undefined)?.bgColor,
		(vp.banner as Record<string, unknown> | undefined)?.textColor,
		(vp.border as Record<string, unknown> | undefined)?.color,
		(vp.tint as Record<string, unknown> | undefined)?.color,
	].filter((c): c is string => typeof c === "string" && c !== "");
	for (const c of colorsToCheck) {
		if (!hexRe.test(c)) return `Invalid color value: ${c}`;
	}
	const tint = vp.tint as Record<string, unknown> | undefined;
	if (typeof tint?.opacity === "number" && tint.opacity > 15) {
		tint.opacity = 15;
	}
	return null;
}

/** Validate profile_json: parse if string, check visualProfile colors.
 * Returns an error message string on failure, or null on success. */
export function validateProfileJson(profileJson: string | object | undefined): string | null {
	if (profileJson === undefined) return null;
	let profileObj: Record<string, unknown>;
	try {
		profileObj =
			typeof profileJson === "string"
				? JSON.parse(profileJson)
				: (profileJson as Record<string, unknown>);
	} catch {
		return "Invalid profile_json format";
	}
	if (profileObj?.visualProfile) {
		const colorError = validateAndClampVisualProfile(
			profileObj.visualProfile as Record<string, unknown>,
		);
		if (colorError) return colorError;
	}
	return null;
}

export function registerHostRoutes(server: FastifyInstance, metaDal: MetaDAL): void {
	registerHostCrudRoutes(server, metaDal);
	registerHostWelcomeRoutes(server, metaDal);
	registerHostSshImportRoutes(server, metaDal);
	registerHostProfileRoutes(server, metaDal);
}
