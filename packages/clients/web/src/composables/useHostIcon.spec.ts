import { describe, expect, it } from "vitest";
import { getColorFromLabel, getHostColor, getInitials } from "./useHostIcon.js";

describe("getInitials", () => {
	it("returns first letters of two words joined by hyphen", () => {
		expect(getInitials("staging-web")).toBe("SW");
	});

	it("returns first letters of two words joined by underscore", () => {
		expect(getInitials("my_server")).toBe("MS");
	});

	it("returns first letters of two space-separated words", () => {
		expect(getInitials("my server")).toBe("MS");
	});

	it("returns first letters of two words joined by dot", () => {
		expect(getInitials("dev.api")).toBe("DA");
	});

	it("returns first 2 chars uppercased for single word", () => {
		expect(getInitials("production")).toBe("PR");
	});

	it("returns single char uppercased for single-char label", () => {
		expect(getInitials("a")).toBe("A");
	});

	it("returns '?' for empty string", () => {
		expect(getInitials("")).toBe("?");
	});

	it("returns '?' for whitespace-only string", () => {
		expect(getInitials("   ")).toBe("?");
	});

	it("trims whitespace before computing", () => {
		expect(getInitials("  hello world  ")).toBe("HW");
	});

	it("uppercases both letters", () => {
		expect(getInitials("foo-bar")).toBe("FB");
	});
});

describe("getColorFromLabel", () => {
	it("returns a valid hex color string", () => {
		const color = getColorFromLabel("my-host");
		expect(color).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("is deterministic for the same label", () => {
		const a = getColorFromLabel("production");
		const b = getColorFromLabel("production");
		expect(a).toBe(b);
	});

	it("produces different colors for different labels", () => {
		const a = getColorFromLabel("alpha");
		const b = getColorFromLabel("beta");
		// Not guaranteed by spec, but highly likely with djb2 — guard against trivial bugs
		expect(a).not.toBe(b);
	});

	it("returns a hex color for each label in the palette", () => {
		const labels = ["a", "bb", "ccc", "dddd", "eeee", "server-01", "prod-db", "web-frontend"];
		for (const label of labels) {
			expect(getColorFromLabel(label)).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it("handles empty string without throwing", () => {
		const color = getColorFromLabel("");
		expect(color).toMatch(/^#[0-9a-f]{6}$/);
	});
});

describe("getHostColor", () => {
	it("is the colour the host was given", () => {
		expect(getHostColor({ color: "#123456", label: "prod-db" })).toBe("#123456");
	});

	it("is the label's colour when the host has none, as its badge draws it (#659, #663)", () => {
		expect(getHostColor({ label: "prod-db" })).toBe(getColorFromLabel("prod-db"));
		expect(getHostColor({ color: null, label: "prod-db" })).toBe(getColorFromLabel("prod-db"));
		expect(getHostColor({ color: "", label: "prod-db" })).toBe(getColorFromLabel("prod-db"));
	});
});
