// Input validation helpers for protocol messages

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function isValidUlid(id: unknown): id is string {
	return typeof id === "string" && ULID_RE.test(id);
}

export function isValidDimensions(cols: unknown, rows: unknown): boolean {
	return (
		typeof cols === "number" &&
		typeof rows === "number" &&
		Number.isInteger(cols) &&
		Number.isInteger(rows) &&
		cols >= 1 &&
		cols <= 500 &&
		rows >= 1 &&
		rows <= 500
	);
}

/**
 * The SSH port a text names: a whole number from 1 to 65535, written in digits
 * only. Anything else is null (#901), where parseInt read `1.5` as 1 and
 * `2222abc` as 2222, and Number() rounds `65535.0000000000000001` into range.
 */
export function sshPortFromText(text: string): number | null {
	if (!/^[0-9]+$/.test(text)) return null;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : null;
}

export const MAX_INPUT_SIZE = 65_536; // 64 KB

export function isValidInputData(data: unknown): data is Uint8Array {
	return data instanceof Uint8Array && data.byteLength <= MAX_INPUT_SIZE;
}

export const MAX_ENV_COUNT = 256;

export function isValidEnv(env: unknown): env is Record<string, string> | null | undefined {
	if (env == null) return true; // optional
	if (typeof env !== "object" || Array.isArray(env)) return false;
	const entries = Object.entries(env as Record<string, unknown>);
	if (entries.length > MAX_ENV_COUNT) return false;
	return entries.every(
		([k, v]) =>
			typeof k === "string" &&
			typeof v === "string" &&
			k.length <= 256 &&
			(v as string).length <= 8192,
	);
}

// ─── Custom elevation command validation ─────────────────────────────────────

/**
 * Validates a custom elevation command path.
 * Throws a structured error if invalid.
 *
 * Rules:
 * - Must not be empty
 * - Length: 1–4096 characters
 * - ASCII-only (no bytes > 127)
 * - No null bytes
 * - Character allowlist: [a-zA-Z0-9/\\._ :-]
 * - Absolute path: starts with / (Unix) or X:\ (Windows drive letter)
 * - No .. path traversal segments
 */
export function validateCustomCommand(cmd: string): void {
	if (!cmd || cmd.length === 0) {
		throw { code: "INVALID_CUSTOM_COMMAND", message: "custom_command must not be empty" };
	}

	if (cmd.length > 4096) {
		throw { code: "INVALID_CUSTOM_COMMAND", message: "custom_command exceeds maximum length" };
	}

	// ASCII-only check
	for (let i = 0; i < cmd.length; i++) {
		if (cmd.charCodeAt(i) > 127) {
			throw {
				code: "INVALID_CUSTOM_COMMAND",
				message: "custom_command must contain only ASCII characters",
			};
		}
	}

	// Null bytes check (charCode 0)
	if (cmd.includes("\0")) {
		throw { code: "INVALID_CUSTOM_COMMAND", message: "custom_command contains invalid characters" };
	}

	// Character allowlist: a-zA-Z0-9 / \ . _ (space) : -
	const allowlistRegex = /^[a-zA-Z0-9/\\._ :-]+$/;
	if (!allowlistRegex.test(cmd)) {
		throw { code: "INVALID_CUSTOM_COMMAND", message: "custom_command contains invalid characters" };
	}

	// Absolute path check
	const isUnixAbsolute = cmd.startsWith("/");
	const isWindowsAbsolute = /^[A-Za-z]:[/\\]/.test(cmd);
	if (!isUnixAbsolute && !isWindowsAbsolute) {
		throw { code: "INVALID_CUSTOM_COMMAND", message: "custom_command must be an absolute path" };
	}

	// Path traversal check (segment-aware)
	if (/(?:^|[/\\])\.\.[/\\]/.test(cmd) || cmd.endsWith("/..") || cmd.endsWith("\\..")) {
		throw {
			code: "INVALID_CUSTOM_COMMAND",
			message: "custom_command must not contain path traversal",
		};
	}
}

/**
 * Validates a shell executable path for the SPAWN handler.
 * Returns an error message string, or null if valid.
 *
 * Rules:
 * - Optional field — null/undefined is allowed (hub will use default shell)
 * - Must be a non-empty string
 * - Length: 1–4096 characters
 * - No null bytes
 * - No shell metacharacters: ; & | $ ` ( ) < > \n \r
 * - No path traversal (..)
 * - Must be an absolute path: starts with / (Unix) or drive letter (Windows)
 * - Character allowlist: a-zA-Z0-9 / \ . _ - (space) :
 */
export function validateShell(shell: unknown): string | null {
	if (shell == null) return null; // optional field

	if (typeof shell !== "string") {
		return "shell must be a string";
	}

	if (shell.length === 0) {
		return "shell must not be empty";
	}

	if (shell.length > 4096) {
		return "shell must be 4096 characters or fewer";
	}

	// Null bytes
	if (shell.includes("\0")) {
		return "shell contains invalid characters";
	}

	// Shell metacharacters (injection risk even with execvp)
	const metaRe = /[;&|$`()<>\n\r]/;
	if (metaRe.test(shell)) {
		return "shell must be an executable path, not a command";
	}

	// Character allowlist: alphanumeric, / \ . _ - (space) :
	const allowlistRe = /^[a-zA-Z0-9/\\._ :-]+$/;
	if (!allowlistRe.test(shell)) {
		return "shell contains invalid characters";
	}

	// Must be an absolute path
	const isUnixAbsolute = shell.startsWith("/");
	const isWindowsAbsolute = /^[A-Za-z]:[/\\]/.test(shell);
	if (!isUnixAbsolute && !isWindowsAbsolute) {
		return "shell must be an absolute path";
	}

	// Path traversal check (segment-aware)
	if (/(?:^|[/\\])\.\.[/\\]/.test(shell) || shell.endsWith("/..") || shell.endsWith("\\..")) {
		return "shell must not contain path traversal";
	}

	return null;
}
