import { describe, expect, it } from "vitest";
import {
	isValidDimensions,
	isValidEnv,
	isValidInputData,
	isValidUlid,
	MAX_ENV_COUNT,
	MAX_INPUT_SIZE,
	sshPortFromText,
	validateCustomCommand,
	validateShell,
} from "./validation.js";

describe("isValidUlid", () => {
	it("accepts a valid ULID", () => {
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(true);
	});

	it("accepts lowercase ULID", () => {
		expect(isValidUlid("01arz3ndektsv4rrffq69g5fav")).toBe(true);
	});

	it("rejects empty string", () => {
		expect(isValidUlid("")).toBe(false);
	});

	it("rejects wrong length (25 chars)", () => {
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBe(false);
	});

	it("rejects wrong length (27 chars)", () => {
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVX")).toBe(false);
	});

	it("rejects invalid characters (I, L, O, U are excluded from Crockford base32)", () => {
		// 'I' is not valid in Crockford base32
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQI9G5FAV")).toBe(false);
		// 'L' is not valid
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQL9G5FAV")).toBe(false);
		// 'O' is not valid
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQO9G5FAV")).toBe(false);
		// 'U' is not valid
		expect(isValidUlid("01ARZ3NDEKTSV4RRFFQU9G5FAV")).toBe(false);
	});

	it("rejects non-string types", () => {
		expect(isValidUlid(123)).toBe(false);
		expect(isValidUlid(null)).toBe(false);
		expect(isValidUlid(undefined)).toBe(false);
		expect(isValidUlid({})).toBe(false);
		expect(isValidUlid([])).toBe(false);
	});
});

describe("isValidDimensions", () => {
	it("accepts valid dimensions", () => {
		expect(isValidDimensions(80, 24)).toBe(true);
	});

	it("accepts boundary values (1x1)", () => {
		expect(isValidDimensions(1, 1)).toBe(true);
	});

	it("accepts boundary values (500x500)", () => {
		expect(isValidDimensions(500, 500)).toBe(true);
	});

	it("rejects zero cols", () => {
		expect(isValidDimensions(0, 24)).toBe(false);
	});

	it("rejects zero rows", () => {
		expect(isValidDimensions(80, 0)).toBe(false);
	});

	it("rejects negative values", () => {
		expect(isValidDimensions(-1, 24)).toBe(false);
		expect(isValidDimensions(80, -1)).toBe(false);
	});

	it("rejects values above 500", () => {
		expect(isValidDimensions(501, 24)).toBe(false);
		expect(isValidDimensions(80, 501)).toBe(false);
	});

	it("rejects non-integer values", () => {
		expect(isValidDimensions(80.5, 24)).toBe(false);
		expect(isValidDimensions(80, 24.5)).toBe(false);
	});

	it("rejects non-number types", () => {
		expect(isValidDimensions("80", 24)).toBe(false);
		expect(isValidDimensions(80, "24")).toBe(false);
		expect(isValidDimensions(null, 24)).toBe(false);
		expect(isValidDimensions(80, undefined)).toBe(false);
	});
});

describe("isValidInputData", () => {
	it("accepts valid Uint8Array", () => {
		expect(isValidInputData(new Uint8Array([72, 101, 108]))).toBe(true);
	});

	it("accepts empty Uint8Array", () => {
		expect(isValidInputData(new Uint8Array(0))).toBe(true);
	});

	it("accepts Uint8Array at max size", () => {
		expect(isValidInputData(new Uint8Array(MAX_INPUT_SIZE))).toBe(true);
	});

	it("rejects Uint8Array exceeding max size", () => {
		expect(isValidInputData(new Uint8Array(MAX_INPUT_SIZE + 1))).toBe(false);
	});

	it("rejects non-Uint8Array types", () => {
		expect(isValidInputData("hello")).toBe(false);
		expect(isValidInputData(Buffer.from("hello"))).toBe(true); // Buffer extends Uint8Array
		expect(isValidInputData(123)).toBe(false);
		expect(isValidInputData(null)).toBe(false);
		expect(isValidInputData(undefined)).toBe(false);
		expect(isValidInputData([1, 2, 3])).toBe(false);
	});
});

describe("isValidEnv", () => {
	it("accepts valid env object", () => {
		expect(isValidEnv({ PATH: "/usr/bin", HOME: "/home/user" })).toBe(true);
	});

	it("accepts null (optional)", () => {
		expect(isValidEnv(null)).toBe(true);
	});

	it("accepts undefined (optional)", () => {
		expect(isValidEnv(undefined)).toBe(true);
	});

	it("accepts empty object", () => {
		expect(isValidEnv({})).toBe(true);
	});

	it("rejects arrays", () => {
		expect(isValidEnv(["a", "b"])).toBe(false);
	});

	it("rejects non-object types", () => {
		expect(isValidEnv("string")).toBe(false);
		expect(isValidEnv(123)).toBe(false);
	});

	it("rejects too many entries", () => {
		const bigEnv: Record<string, string> = {};
		for (let i = 0; i <= MAX_ENV_COUNT; i++) {
			bigEnv[`KEY_${i}`] = "value";
		}
		expect(isValidEnv(bigEnv)).toBe(false);
	});

	it("accepts exactly MAX_ENV_COUNT entries", () => {
		const env: Record<string, string> = {};
		for (let i = 0; i < MAX_ENV_COUNT; i++) {
			env[`KEY_${i}`] = "value";
		}
		expect(isValidEnv(env)).toBe(true);
	});

	it("rejects non-string values", () => {
		expect(isValidEnv({ KEY: 123 })).toBe(false);
		expect(isValidEnv({ KEY: true })).toBe(false);
		expect(isValidEnv({ KEY: null })).toBe(false);
	});

	it("rejects keys longer than 256 characters", () => {
		const longKey = "K".repeat(257);
		expect(isValidEnv({ [longKey]: "value" })).toBe(false);
	});

	it("accepts keys at exactly 256 characters", () => {
		const key = "K".repeat(256);
		expect(isValidEnv({ [key]: "value" })).toBe(true);
	});

	// ── Prototype pollution keys: document accepted behavior ────────────
	// These keys look dangerous (prototype pollution vectors) but are safe here:
	// isValidEnv validates the shape of env vars passed to node-pty's spawn(),
	// which creates a new process with a fresh environment. The object is never
	// used as a prototype or merged into an existing object, so __proto__,
	// constructor, and toString keys are harmless string env var names.

	// In JS, { __proto__: "value" } sets the prototype, not an own property.
	// Object.entries() returns [] for such objects, so isValidEnv sees an empty env and returns true.
	// This is acceptable: the key never reaches child_process.
	it("accepts __proto__ as an env key (sets prototype, not own property — Object.entries is empty)", () => {
		expect(isValidEnv({ __proto__: "value" })).toBe(true);
	});

	it("accepts constructor as an env key (safe: no prototype chain manipulation)", () => {
		expect(isValidEnv({ constructor: "value" })).toBe(true);
	});

	it("accepts toString as an env key (safe: object is consumed as key-value pairs only)", () => {
		expect(isValidEnv({ toString: "value" })).toBe(true);
	});

	it("rejects values longer than 8192 characters", () => {
		const longValue = "V".repeat(8193);
		expect(isValidEnv({ KEY: longValue })).toBe(false);
	});

	it("accepts values at exactly 8192 characters", () => {
		const value = "V".repeat(8192);
		expect(isValidEnv({ KEY: value })).toBe(true);
	});
});

describe("validateCustomCommand", () => {
	// ── Valid cases ────────────────────────────────────────────────────────────

	it("accepts /usr/bin/sudo", () => {
		expect(() => validateCustomCommand("/usr/bin/sudo")).not.toThrow();
	});

	it("accepts /usr/local/bin/doas", () => {
		expect(() => validateCustomCommand("/usr/local/bin/doas")).not.toThrow();
	});

	it("accepts Windows path C:\\Windows\\System32\\gsudo.exe", () => {
		expect(() => validateCustomCommand("C:\\Windows\\System32\\gsudo.exe")).not.toThrow();
	});

	it("accepts Windows path with spaces C:\\Program Files\\gsudo\\gsudo.exe", () => {
		expect(() => validateCustomCommand("C:\\Program Files\\gsudo\\gsudo.exe")).not.toThrow();
	});

	// ── Invalid characters ─────────────────────────────────────────────────────

	it("rejects semicolon in path", () => {
		expect(() => validateCustomCommand("/usr/bin/sudo;rm -rf /")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("invalid characters") }),
		);
	});

	it("rejects pipe in path", () => {
		expect(() => validateCustomCommand("/usr/bin/sudo|cat /etc/passwd")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("invalid characters") }),
		);
	});

	it("rejects dollar sign in path", () => {
		expect(() => validateCustomCommand("/usr/bin/$sudo")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("invalid characters") }),
		);
	});

	// ── ASCII-only ─────────────────────────────────────────────────────────────

	it("rejects non-ASCII characters", () => {
		expect(() => validateCustomCommand("/usr/bin/südo")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("ASCII characters") }),
		);
	});

	// ── Absolute path ──────────────────────────────────────────────────────────

	it("rejects relative path 'sudo'", () => {
		expect(() => validateCustomCommand("sudo")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("absolute path") }),
		);
	});

	it("rejects relative path './sudo'", () => {
		expect(() => validateCustomCommand("./sudo")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("absolute path") }),
		);
	});

	// ── Path traversal ─────────────────────────────────────────────────────────

	it("rejects path traversal /usr/bin/../../../etc/shadow", () => {
		expect(() => validateCustomCommand("/usr/bin/../../../etc/shadow")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("path traversal") }),
		);
	});

	it("rejects path ending with /..", () => {
		expect(() => validateCustomCommand("/usr/bin/..")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("path traversal") }),
		);
	});

	it("rejects Windows path traversal C:\\foo\\..\\..\\Windows\\System32\\cmd.exe", () => {
		expect(() => validateCustomCommand("C:\\foo\\..\\..\\Windows\\System32\\cmd.exe")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("path traversal") }),
		);
	});

	// ── Empty / length ─────────────────────────────────────────────────────────

	it("rejects empty string", () => {
		expect(() => validateCustomCommand("")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("empty") }),
		);
	});

	it("rejects string exceeding 4096 characters", () => {
		const longPath = `/${"a".repeat(4096)}`;
		expect(() => validateCustomCommand(longPath)).toThrow(
			expect.objectContaining({ message: expect.stringContaining("maximum length") }),
		);
	});

	it("accepts string at exactly 4096 characters", () => {
		const path = `/${"a".repeat(4095)}`;
		expect(() => validateCustomCommand(path)).not.toThrow();
	});

	// ── Null bytes ─────────────────────────────────────────────────────────────

	it("rejects null bytes", () => {
		expect(() => validateCustomCommand("/usr/bin/sudo\0evil")).toThrow(
			expect.objectContaining({ message: expect.stringContaining("invalid characters") }),
		);
	});

	// ── Error code ────────────────────────────────────────────────────────────

	it("throws structured error with code INVALID_CUSTOM_COMMAND", () => {
		expect(() => validateCustomCommand("sudo")).toThrow(
			expect.objectContaining({ code: "INVALID_CUSTOM_COMMAND" }),
		);
	});
});

describe("validateShell", () => {
	// ── Optional field ────────────────────────────────────────────────────────

	it("accepts null (optional field)", () => {
		expect(validateShell(null)).toBeNull();
	});

	it("accepts undefined (optional field)", () => {
		expect(validateShell(undefined)).toBeNull();
	});

	// ── Valid paths ───────────────────────────────────────────────────────────

	it("accepts /bin/bash", () => {
		expect(validateShell("/bin/bash")).toBeNull();
	});

	it("accepts /usr/bin/zsh", () => {
		expect(validateShell("/usr/bin/zsh")).toBeNull();
	});

	it("accepts /usr/local/bin/fish", () => {
		expect(validateShell("/usr/local/bin/fish")).toBeNull();
	});

	it("accepts path with hyphen /usr/bin/my-shell", () => {
		expect(validateShell("/usr/bin/my-shell")).toBeNull();
	});

	it("accepts path with underscore /usr/bin/my_shell", () => {
		expect(validateShell("/usr/bin/my_shell")).toBeNull();
	});

	it("accepts path with dot /usr/bin/shell.v2", () => {
		expect(validateShell("/usr/bin/shell.v2")).toBeNull();
	});

	it("accepts path with space /usr/bin/my shell", () => {
		expect(validateShell("/usr/bin/my shell")).toBeNull();
	});

	it("accepts Windows path C:\\Windows\\System32\\cmd.exe", () => {
		expect(validateShell("C:\\Windows\\System32\\cmd.exe")).toBeNull();
	});

	it("accepts Windows path with forward slash C:/Windows/System32/cmd.exe", () => {
		expect(validateShell("C:/Windows/System32/cmd.exe")).toBeNull();
	});

	// ── Non-string types ──────────────────────────────────────────────────────

	it("rejects number type", () => {
		expect(validateShell(42)).toBe("shell must be a string");
	});

	it("rejects boolean type", () => {
		expect(validateShell(true)).toBe("shell must be a string");
	});

	it("rejects object type", () => {
		expect(validateShell({})).toBe("shell must be a string");
	});

	// ── Empty string ──────────────────────────────────────────────────────────

	it("rejects empty string", () => {
		expect(validateShell("")).toBe("shell must not be empty");
	});

	// ── Length ────────────────────────────────────────────────────────────────

	it("accepts path at exactly 4096 characters", () => {
		const shell = `/${"a".repeat(4095)}`;
		expect(validateShell(shell)).toBeNull();
	});

	it("rejects path exceeding 4096 characters", () => {
		const shell = `/${"a".repeat(4096)}`;
		expect(validateShell(shell)).toBe("shell must be 4096 characters or fewer");
	});

	// ── Null bytes ────────────────────────────────────────────────────────────

	it("rejects null bytes", () => {
		expect(validateShell("/bin/bash\0evil")).toBe("shell contains invalid characters");
	});

	// ── Shell metacharacters ─────────────────────────────────────────────────

	it("rejects semicolon", () => {
		expect(validateShell("/bin/bash;rm -rf /")).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("rejects ampersand", () => {
		expect(validateShell("/bin/bash&cat /etc/passwd")).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("rejects pipe", () => {
		expect(validateShell("/bin/bash|cat")).toBe("shell must be an executable path, not a command");
	});

	it("rejects dollar sign", () => {
		expect(validateShell("/bin/$SHELL")).toBe("shell must be an executable path, not a command");
	});

	it("rejects backtick", () => {
		expect(validateShell("/bin/`id`")).toBe("shell must be an executable path, not a command");
	});

	it("rejects open paren", () => {
		expect(validateShell("/bin/bash(")).toBe("shell must be an executable path, not a command");
	});

	it("rejects close paren", () => {
		expect(validateShell("/bin/bash)")).toBe("shell must be an executable path, not a command");
	});

	it("rejects less-than", () => {
		expect(validateShell("/bin/bash</etc/passwd")).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("rejects greater-than", () => {
		expect(validateShell("/bin/bash>/tmp/out")).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("rejects newline", () => {
		expect(validateShell("/bin/bash\nrm -rf /")).toBe(
			"shell must be an executable path, not a command",
		);
	});

	it("rejects carriage return", () => {
		expect(validateShell("/bin/bash\rrm -rf /")).toBe(
			"shell must be an executable path, not a command",
		);
	});

	// ── Character allowlist ───────────────────────────────────────────────────

	it("rejects non-ASCII characters", () => {
		expect(validateShell("/usr/bin/bäsh")).toBe("shell contains invalid characters");
	});

	it("rejects brackets", () => {
		expect(validateShell("/bin/[bash]")).toBe("shell contains invalid characters");
	});

	// ── Absolute path requirement ─────────────────────────────────────────────

	it("rejects relative path 'bash'", () => {
		expect(validateShell("bash")).toBe("shell must be an absolute path");
	});

	it("rejects relative path './bash'", () => {
		expect(validateShell("./bash")).toBe("shell must be an absolute path");
	});

	it("rejects relative path 'usr/bin/bash'", () => {
		expect(validateShell("usr/bin/bash")).toBe("shell must be an absolute path");
	});

	// ── Path traversal ────────────────────────────────────────────────────────

	it("rejects path traversal /bin/../etc/shadow", () => {
		expect(validateShell("/bin/../etc/shadow")).toBe("shell must not contain path traversal");
	});

	it("rejects path ending with /..", () => {
		expect(validateShell("/bin/..")).toBe("shell must not contain path traversal");
	});

	it("rejects Windows path traversal C:\\foo\\..\\cmd.exe", () => {
		expect(validateShell("C:\\foo\\..\\cmd.exe")).toBe("shell must not contain path traversal");
	});

	it("rejects Windows path ending with \\..", () => {
		expect(validateShell("C:\\Windows\\..")).toBe("shell must not contain path traversal");
	});
});

describe("sshPortFromText (#901)", () => {
	it.each([
		["1", 1],
		["22", 22],
		["2222", 2222],
		["65535", 65535],
		["02222", 2222],
	])("reads %j as %i", (text, port) => {
		expect(sshPortFromText(text)).toBe(port);
	});

	// Mutation: parse with parseInt or Number() and a range check, and `1.5`,
	// `2222abc` or `65535.0000000000000001` pass.
	it.each([
		"",
		"0",
		"-1",
		"+22",
		"1.5",
		"1e",
		"1e3",
		"0x16",
		" 22",
		"22 ",
		"2222abc",
		"70000",
		"65536",
		"65535.0000000000000001",
		"1.0000000000000001",
		"99999999999999999999",
	])("refuses %j", (text) => {
		expect(sshPortFromText(text)).toBeNull();
	});
});
