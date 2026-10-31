import type { Host } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import {
	type CreateHostBody,
	MAX_ICON_IMAGE_LENGTH,
	type UpdateHostBody,
	validateCreateHost,
	validateHostColor,
	validateIconImage,
	validateProfileJson,
	validateSshPort,
	validateUpdateHost,
} from "./hosts.js";

// The rules POST and PUT /api/hosts apply, asserted where they live so a
// broken one fails under its own name. routes.spec.ts keeps tests per route
// proving the route consults them.

/** A body as a client sends it: JSON, which the interface does not police. */
function body(fields: Record<string, unknown>): CreateHostBody {
	return fields as unknown as CreateHostBody;
}

describe("validateCreateHost", () => {
	it("accepts a local host with a label", () => {
		expect(validateCreateHost(body({ type: "local", label: "my-local" }))).toBeNull();
	});

	it("accepts an SSH host with every field it checks", () => {
		const host = body({
			type: "ssh",
			label: "prod-server",
			ssh_host: "192.168.1.100",
			ssh_port: 2222,
			ssh_auth: "key",
			ssh_key_path: "/home/user/.ssh/id_ed25519",
			color: "#ff0000",
			os: "linux",
			arch: "arm64",
		});
		expect(validateCreateHost(host)).toBeNull();
	});

	it("refuses a host without a label", () => {
		expect(validateCreateHost(body({ type: "local" }))).toBe("Label is required");
	});

	it("refuses an SSH host without ssh_host", () => {
		expect(validateCreateHost(body({ type: "ssh", label: "ssh-no-host" }))).toBe(
			"ssh_host is required for SSH hosts and must not contain null bytes",
		);
	});

	it("refuses a color that is not #rrggbb", () => {
		expect(
			validateCreateHost(body({ type: "local", label: "color-bad", color: "notacolor" })),
		).toBe("color must be in hex format #rrggbb");
	});

	it("refuses an os it does not know", () => {
		expect(validateCreateHost(body({ type: "local", label: "bad-os", os: "bsd" }))).toBe(
			"os must be 'linux', 'darwin', or 'windows'",
		);
	});

	it("refuses an arch it does not know", () => {
		expect(validateCreateHost(body({ type: "local", label: "bad-arch", arch: "riscv" }))).toBe(
			"arch must be 'x64' or 'arm64'",
		);
	});

	it("refuses key auth without a key path, or with a blank one", () => {
		for (const ssh_key_path of [undefined, null, "", "  "]) {
			const host = { type: "ssh", label: "key", ssh_host: "10.0.0.1", ssh_auth: "key" };
			expect(validateCreateHost(body({ ...host, ssh_key_path }))).toBe(
				"ssh_key_path is required when ssh_auth is 'key'",
			);
		}
	});

	// A text column took a number or a boolean as text, and failed the write on
	// an object (#795).
	it("refuses a text field of another type, and takes text or null", () => {
		const fields = [
			"ssh_host",
			"ssh_key_path",
			"ssh_user",
			"ssh_config_host",
			"ssh_proxy_host_id",
			"ssh_proxy_spec",
			"icon_value",
			"default_cwd",
			"host_group_id",
			"profile_json",
			"custom_command",
		];
		for (const field of fields) {
			for (const value of [5, true, {}, ["text"]]) {
				expect(validateCreateHost(body({ type: "local", label: "typed", [field]: value }))).toBe(
					`${field} must be a string or null`,
				);
			}
			for (const value of ["text", null]) {
				expect(
					validateCreateHost(body({ type: "local", label: "typed", [field]: value })),
				).toBeNull();
			}
		}
	});

	// Each column's CHECK refused it with a 500, after the request was taken (#795).
	it("refuses a value outside a field's choices, whatever the host's type", () => {
		const refused: Array<[Record<string, unknown>, string]> = [
			[{ ssh_auth: "token" }, "ssh_auth must be 'agent', 'key', or 'password'"],
			[{ icon_type: "svg" }, "icon_type must be 'auto', 'emoji', or 'image'"],
			[{ icon_type: null }, "icon_type must be 'auto', 'emoji', or 'image'"],
			[{ trust_remote_hints: "always" }, "trust_remote_hints must be 'apply', 'ask', or 'ignore'"],
			[
				{ elevation_method: "su" },
				"elevation_method must be one of: sudo, doas, pkexec, gsudo, custom",
			],
		];
		for (const [field, message] of refused) {
			expect(validateCreateHost(body({ type: "local", label: "chosen", ...field }))).toBe(message);
		}
	});

	// "no" was stored as a yes: any value but null counted as one (#795).
	it("refuses an ssh_remote_daemon that is not a boolean or null", () => {
		for (const ssh_remote_daemon of ["no", 0, {}]) {
			expect(validateCreateHost(body({ type: "local", label: "daemon", ssh_remote_daemon }))).toBe(
				"ssh_remote_daemon must be boolean or null",
			);
		}
	});

	it("refuses a label that is not text", () => {
		expect(validateCreateHost(body({ type: "local", label: 7 }))).toBe("Label is required");
	});
});

// PUT /api/hosts/:id applies POST's rules to the host as it will be once saved (#795).
describe("validateUpdateHost", () => {
	const stored: Host = {
		id: "01HOST",
		type: "ssh",
		label: "pi",
		sshHost: "10.0.0.1",
		sshAuth: "key",
		sshKeyPath: "/home/pi/.ssh/id_ed25519",
		iconType: "auto",
		trustRemoteHints: "apply",
		sortOrder: 0,
		os: null,
		arch: null,
		createdAt: "2026-10-30T00:00:00.000Z",
		updatedAt: "2026-10-30T00:00:00.000Z",
	};
	const onAgent: Host = { ...stored, sshAuth: "agent" };
	delete onAgent.sshKeyPath;
	const local: Host = { ...stored, type: "local" };
	delete local.sshHost;
	delete local.sshAuth;
	delete local.sshKeyPath;
	const KEY_REQUIRED = "ssh_key_path is required when ssh_auth is 'key'";

	function edit(host: Host, fields: Record<string, unknown>): string | null {
		return validateUpdateHost(host, fields as UpdateHostBody);
	}

	it("refuses key auth with no key path, neither given nor stored", () => {
		expect(edit(onAgent, { ssh_auth: "key" })).toBe(KEY_REQUIRED);
		expect(edit(onAgent, { ssh_auth: "key", ssh_key_path: "" })).toBe(KEY_REQUIRED);
	});

	it("refuses clearing the key path of a host that stays on key auth", () => {
		expect(edit(stored, { ssh_key_path: null })).toBe(KEY_REQUIRED);
		expect(edit(stored, { ssh_key_path: "  " })).toBe(KEY_REQUIRED);
	});

	it("takes key auth with the key path given, or the one stored", () => {
		expect(edit(onAgent, { ssh_auth: "key", ssh_key_path: "/home/pi/.ssh/id_rsa" })).toBeNull();
		expect(edit(stored, { ssh_auth: "key" })).toBeNull();
	});

	// What Edit Host sends once the key gives way to the agent (#793).
	it("takes a switch to the agent with the key path cleared", () => {
		expect(edit(stored, { ssh_auth: "agent", ssh_key_path: null })).toBeNull();
	});

	it("refuses an SSH host left without an address, or a null ssh_auth", () => {
		const noAddress = "ssh_host is required for SSH hosts and must not contain null bytes";
		expect(edit(stored, { ssh_host: null })).toBe(noAddress);
		expect(edit(local, { type: "ssh" })).toBe(noAddress);
		expect(edit(stored, { ssh_auth: null })).toBe("ssh_auth must be 'agent', 'key', or 'password'");
		expect(edit(stored, { type: "local", ssh_host: null, ssh_auth: null })).toBeNull();
	});

	it("checks a new address as POST does, on an SSH host", () => {
		expect(edit(stored, { ssh_host: "two words" })).toBe(
			"ssh_host must contain only valid hostname characters",
		);
		expect(edit(stored, { ssh_host: "pi.local" })).toBeNull();
		expect(edit(local, { ssh_host: "two words" })).toBeNull();
	});

	it("checks each field it is given with POST's rules", () => {
		expect(edit(stored, { label: 7 })).toBe("Label is required");
		expect(edit(stored, { label: "has space" })).toBe(
			"Label must contain only alphanumeric characters, dots, dashes, and underscores",
		);
		expect(edit(stored, { type: "vm" })).toBe("type must be 'local' or 'ssh'");
		expect(edit(stored, { ssh_user: 5 })).toBe("ssh_user must be a string or null");
		expect(edit(stored, { custom_command: true })).toBe("custom_command must be a string or null");
		expect(edit(stored, { ssh_user: null, custom_command: null })).toBeNull();
	});

	// A host stored before this check: an edit of anything else is not refused
	// for a sign-in it leaves as it was.
	it("leaves the sign-in alone when the edit does not touch it", () => {
		const keyless: Host = { ...stored };
		delete keyless.sshKeyPath;
		expect(edit(keyless, { label: "moved", host_group_id: null })).toBeNull();
		expect(edit(keyless, { ssh_auth: "key" })).toBe(KEY_REQUIRED);
	});
});

describe("validateIconImage", () => {
	const PNG =
		"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

	it("accepts an image given as a data URI", () => {
		expect(validateIconImage("image", PNG)).toBeNull();
	});

	it("leaves an icon that is not an image alone", () => {
		expect(validateIconImage("emoji", "🚀")).toBeNull();
	});

	it("refuses a remote URL, which a page can never load", () => {
		expect(validateIconImage("image", "https://example.com/icon.png")).toContain("data:image");
	});

	it("refuses an image larger than the bound", () => {
		expect(validateIconImage("image", `data:image/png;base64,${"A".repeat(70_000)}`)).toBe(
			`an image icon must be at most ${MAX_ICON_IMAGE_LENGTH} characters`,
		);
	});

	it("accepts null, which clears the icon (#659)", () => {
		expect(validateIconImage("auto", null)).toBeNull();
		expect(validateIconImage("image", null)).toBeNull();
	});
});

// PUT /api/hosts/:id applies it too.
describe("validateHostColor", () => {
	it("accepts a #rrggbb colour", () => {
		expect(validateHostColor("#00ff00")).toBeNull();
		expect(validateHostColor("#A0b1C2")).toBeNull();
	});

	it("accepts null, which clears the colour (#659)", () => {
		expect(validateHostColor(null)).toBeNull();
		expect(validateHostColor(undefined)).toBeNull();
		expect(validateCreateHost(body({ type: "local", label: "no-color", color: null }))).toBeNull();
	});

	it("refuses anything else, the empty string included", () => {
		for (const color of ["notacolor", "", "#fff", "00ff00", "#00ff00 ", 0xff00, true]) {
			expect(validateHostColor(color)).toBe("color must be in hex format #rrggbb");
		}
	});
});

// POST and PUT /api/hosts apply it.
describe("validateSshPort", () => {
	it("accepts a port", () => {
		for (const port of [1, 22, 2222, 65535]) expect(validateSshPort(port)).toBeNull();
	});

	// No port is SSH's own, 22: how a new host starts, and an edit clears one (#792).
	it("accepts none, null included", () => {
		expect(validateSshPort(undefined)).toBeNull();
		expect(validateSshPort(null)).toBeNull();
		expect(
			validateCreateHost(
				body({ type: "ssh", label: "no-port", ssh_host: "10.0.0.1", ssh_port: null }),
			),
		).toBeNull();
	});

	it("refuses anything else, the empty string included", () => {
		for (const port of ["", "22", 0, -22, 65536, 22.5, true]) {
			expect(validateSshPort(port)).toBe("ssh_port must be an integer between 1 and 65535");
		}
	});
});

// POST and PUT /api/hosts apply it to profile_json.
describe("validateProfileJson", () => {
	function withBorderColor(color: unknown): string {
		return JSON.stringify({ visualProfile: { border: { style: "subtle", color } } });
	}

	it("accepts a border colour of #rrggbb", () => {
		expect(validateProfileJson(withBorderColor("#123456"))).toBeNull();
	});

	it("accepts a border with no colour, which follows the host's (#663)", () => {
		expect(validateProfileJson(withBorderColor(""))).toBeNull();
		expect(
			validateProfileJson(JSON.stringify({ visualProfile: { border: { style: "subtle" } } })),
		).toBeNull();
	});

	it("refuses a colour that is not #rrggbb", () => {
		expect(validateProfileJson(withBorderColor("red"))).toBe("Invalid color value: red");
	});
});
