import { ELEVATION_METHODS_ALL, type Host } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import type { SessionManager } from "../session/session-manager.js";
import type { MetaDAL } from "../storage/meta.js";
import { registerHostCrudRoutes } from "./host-crud.js";
import { registerHostProfileRoutes } from "./host-profiles.js";
import { registerHostSshImportRoutes } from "./host-ssh-import.js";
import { registerHostWelcomeRoutes } from "./host-welcome.js";
import type { AnnounceHostsChange } from "./hosts-changed.js";

export interface CreateHostBody {
	type: "local" | "ssh";
	label: string;
	ssh_host?: string;
	/** null stores none: the host is reached on 22. */
	ssh_port?: number | null;
	ssh_auth?: "agent" | "key" | "password";
	ssh_key_path?: string | null;
	icon_type?: "auto" | "emoji" | "image";
	/** null stores none (#659). */
	icon_value?: string | null;
	/** null stores none: the colour then comes from the label (#659). */
	color?: string | null;
	default_shell?: string | null;
	default_cwd?: string;
	trust_remote_hints?: "apply" | "ask" | "ignore";
	host_group_id?: string | null;
	ssh_config_host?: string | null;
	ssh_user?: string | null;
	ssh_proxy_host_id?: string | null;
	ssh_proxy_spec?: string | null;
	ssh_remote_daemon?: boolean | null;
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
	/** null clears it, back to 22: the dialog's emptied Port (#792). */
	ssh_port?: number | null;
	ssh_auth?: "agent" | "key" | "password";
	/** null clears it: the dialog leaves it out once the auth is not a key (#792). */
	ssh_key_path?: string | null;
	icon_type?: "auto" | "emoji" | "image";
	/** null clears it: the dialog's Remove (#659). */
	icon_value?: string | null;
	/** null clears it, back to the colour the label gives: the dialog's Reset (#659). */
	color?: string | null;
	/** null clears it, as `ssh_user` does: the dialog's emptied field (#792). */
	default_shell?: string | null;
	default_cwd?: string;
	trust_remote_hints?: "apply" | "ask" | "ignore";
	host_group_id?: string | null;
	ssh_config_host?: string | null;
	ssh_user?: string | null;
	ssh_proxy_host_id?: string | null;
	ssh_proxy_spec?: string | null;
	ssh_remote_daemon?: boolean | null;
	profile_json?: string;
	elevation_method?: "sudo" | "doas" | "pkexec" | "gsudo" | "custom" | null;
	custom_command?: string | null;
	os?: "linux" | "darwin" | "windows" | null;
	arch?: "x64" | "arm64" | null;
}

/**
 * A host's colour is #rrggbb, or null for none: the colour then comes from the
 * label. Refusing null left a colour the user had reset stored (#659).
 */
export function validateHostColor(color: unknown): string | null {
	if (color === undefined || color === null) return null;
	if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) {
		return "color must be in hex format #rrggbb";
	}
	return null;
}

/**
 * A host's SSH port is an integer from 1 to 65535, or null for none: the host
 * is then reached on 22. Refusing null left a port the user had emptied in
 * Edit Host stored (#792).
 */
export function validateSshPort(port: unknown): string | null {
	if (port === undefined || port === null) return null;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		return "ssh_port must be an integer between 1 and 65535";
	}
	return null;
}

/** The longest image icon accepted: a small picture, never a stored file. */
export const MAX_ICON_IMAGE_LENGTH = 65_536;

/**
 * An image icon must be something a client can display. Pages load images only
 * from the hub or from data: and blob: URIs, so a remote URL never loads (#208):
 * an image icon is a base64 data URI of a raster format, bounded in size.
 */
export function validateIconImage(
	iconType: string | undefined,
	iconValue: string | null | undefined,
): string | null {
	if (iconType !== "image" || iconValue == null || iconValue === "") return null;
	if (iconValue.length > MAX_ICON_IMAGE_LENGTH) {
		return `an image icon must be at most ${MAX_ICON_IMAGE_LENGTH} characters`;
	}
	if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(iconValue)) {
		return "an image icon must be a data:image/png, jpeg, gif or webp URI: pick an image file";
	}
	return null;
}

/** A host's label: what the rail and `lasterm` name it by. */
export function validateHostLabel(label: unknown): string | null {
	if (typeof label !== "string" || label.trim().length === 0) {
		return "Label is required";
	}
	if (label.length > 64) {
		return "Label must be 64 characters or fewer";
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(label)) {
		return "Label must contain only alphanumeric characters, dots, dashes, and underscores";
	}
	return null;
}

/** The address of an SSH host, as a client gives it. */
function validateSshHostAddress(sshHost: unknown): string | null {
	if (typeof sshHost !== "string" || sshHost === "" || sshHost.includes("\0")) {
		return "ssh_host is required for SSH hosts and must not contain null bytes";
	}
	if (!/^[a-zA-Z0-9@._:-]+$/.test(sshHost)) {
		return "ssh_host must contain only valid hostname characters";
	}
	return null;
}

/**
 * The fields a host keeps as text, each cleared by null (#659, #792). JSON
 * carries any value, and the column took a number or a boolean as text, or
 * failed the write on an object (#795).
 */
const HOST_TEXT_FIELDS = [
	"ssh_host",
	"ssh_key_path",
	"ssh_user",
	"ssh_config_host",
	"ssh_proxy_host_id",
	"ssh_proxy_spec",
	"icon_value",
	"default_shell",
	"default_cwd",
	"host_group_id",
	"profile_json",
	"custom_command",
] as const;

/**
 * The fields a host keeps as one of a few values. null clears the nullable
 * ones; the others always hold one, and their column's CHECK answered
 * anything else with a 500 (#795).
 */
const HOST_CHOICES: ReadonlyArray<{
	field: string;
	values: readonly string[];
	nullable: boolean;
	message: string;
}> = [
	{
		field: "ssh_auth",
		values: ["agent", "key", "password"],
		nullable: true,
		message: "ssh_auth must be 'agent', 'key', or 'password'",
	},
	{
		field: "icon_type",
		values: ["auto", "emoji", "image"],
		nullable: false,
		message: "icon_type must be 'auto', 'emoji', or 'image'",
	},
	{
		field: "trust_remote_hints",
		values: ["apply", "ask", "ignore"],
		nullable: false,
		message: "trust_remote_hints must be 'apply', 'ask', or 'ignore'",
	},
	{
		field: "elevation_method",
		values: ELEVATION_METHODS_ALL,
		nullable: true,
		message: `elevation_method must be one of: ${ELEVATION_METHODS_ALL.join(", ")}`,
	},
	{
		field: "os",
		values: ["linux", "darwin", "windows"],
		nullable: true,
		message: "os must be 'linux', 'darwin', or 'windows'",
	},
	{
		field: "arch",
		values: ["x64", "arm64"],
		nullable: true,
		message: "arch must be 'x64' or 'arm64'",
	},
];

/**
 * The rule each field a client sends keeps on its own, whatever the rest of
 * the host: POST checks the fields of the host it creates, PUT those an edit
 * changes (#795). What a field needs from the others is `validateSshSignIn`'s.
 */
function validateHostFields(fields: Record<string, unknown>): string | null {
	for (const field of HOST_TEXT_FIELDS) {
		const value = fields[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			return `${field} must be a string or null`;
		}
	}
	for (const { field, values, nullable, message } of HOST_CHOICES) {
		const value = fields[field];
		if (value === undefined || (nullable && value === null)) continue;
		if (typeof value !== "string" || !values.includes(value)) return message;
	}
	const daemon = fields.ssh_remote_daemon;
	if (daemon !== undefined && daemon !== null && typeof daemon !== "boolean") {
		return "ssh_remote_daemon must be boolean or null";
	}
	return validateSshPort(fields.ssh_port) ?? validateHostColor(fields.color);
}

/** How an SSH host is reached and signs in, its fields already checked one by one. */
interface SshSignIn {
	type: unknown;
	ssh_host: string | null | undefined;
	ssh_auth: string | null | undefined;
	ssh_key_path: string | null | undefined;
}

/**
 * What an SSH host needs to sign in: an address, and the key file when it
 * signs in with a key. POST checks the host it creates, PUT the host as an
 * edit will leave it (#795).
 */
function validateSshSignIn(host: SshSignIn): string | null {
	if (host.type !== "ssh") return null;
	if (!host.ssh_host) {
		return "ssh_host is required for SSH hosts and must not contain null bytes";
	}
	// Left out, none is stored, as an import does; sent as null, it is refused
	// as POST always did.
	if (host.ssh_auth === null) return "ssh_auth must be 'agent', 'key', or 'password'";
	if (host.ssh_auth === "key" && !host.ssh_key_path?.trim()) {
		return "ssh_key_path is required when ssh_auth is 'key'";
	}
	return null;
}

export function validateCreateHost(body: CreateHostBody): string | null {
	const labelError = validateHostLabel(body.label);
	if (labelError) return labelError;
	if (body.type !== "local" && body.type !== "ssh") {
		return "type must be 'local' or 'ssh'";
	}
	const fieldsError = validateHostFields(body as unknown as Record<string, unknown>);
	if (fieldsError) return fieldsError;
	if (body.type === "ssh") {
		const addressError = validateSshHostAddress(body.ssh_host);
		if (addressError) return addressError;
	}
	return validateSshSignIn({
		type: body.type,
		ssh_host: body.ssh_host,
		ssh_auth: body.ssh_auth,
		ssh_key_path: body.ssh_key_path,
	});
}

/** What an SSH host signs in with: an edit of one is checked on the whole host. */
const SIGN_IN_FIELDS = ["type", "ssh_host", "ssh_auth", "ssh_key_path"] as const;

/**
 * POST's rules, for an edit of `stored`. Each field the body brings keeps its
 * own. An edit of the type, the address or the sign-in is checked on the host
 * as it will be once saved, the body's values over the stored ones: key auth
 * needs a key path, given or kept (#795). An edit that changes none of them
 * leaves the sign-in as it was, so a host stored before this check can still
 * be renamed or moved.
 */
export function validateUpdateHost(stored: Host, body: UpdateHostBody): string | null {
	const fields = body as unknown as Record<string, unknown>;
	if (body.label !== undefined) {
		const labelError = validateHostLabel(body.label);
		if (labelError) return labelError;
	}
	if (body.type !== undefined && body.type !== "local" && body.type !== "ssh") {
		return "type must be 'local' or 'ssh'";
	}
	const fieldsError = validateHostFields(fields);
	if (fieldsError) return fieldsError;

	const host: SshSignIn = {
		type: body.type ?? stored.type,
		ssh_host: body.ssh_host !== undefined ? body.ssh_host : stored.sshHost,
		ssh_auth: body.ssh_auth !== undefined ? body.ssh_auth : stored.sshAuth,
		ssh_key_path: body.ssh_key_path !== undefined ? body.ssh_key_path : stored.sshKeyPath,
	};
	if (host.type === "ssh" && body.ssh_host != null) {
		const addressError = validateSshHostAddress(body.ssh_host);
		if (addressError) return addressError;
	}
	if (!SIGN_IN_FIELDS.some((field) => fields[field] !== undefined)) return null;
	return validateSshSignIn(host);
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

/** @param announce Tells every client the hosts changed (#783). */
export function registerHostRoutes(
	server: FastifyInstance,
	metaDal: MetaDAL,
	sessionManager: Pick<SessionManager, "hostIsBeingStopped" | "daemonPolicyWouldBeRevoked">,
	announce: AnnounceHostsChange = () => {},
): void {
	registerHostCrudRoutes(server, metaDal, sessionManager, announce);
	registerHostWelcomeRoutes(server, metaDal);
	registerHostSshImportRoutes(server, metaDal, announce);
	registerHostProfileRoutes(server, metaDal);
}
