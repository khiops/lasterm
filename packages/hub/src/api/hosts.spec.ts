import { describe, expect, it } from "vitest";
import {
	type CreateHostBody,
	MAX_ICON_IMAGE_LENGTH,
	validateCreateHost,
	validateHostColor,
	validateIconImage,
} from "./hosts.js";

// The rules POST /api/hosts applies, asserted where they live so a broken one
// fails under its own name. routes.spec.ts keeps one test per route proving the
// route consults them.

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
