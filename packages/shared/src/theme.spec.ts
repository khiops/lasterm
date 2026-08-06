import { describe, expect, it } from "vitest";
import type { LastermTheme } from "./theme.js";
import { REQUIRED_COLOR_FIELDS, REQUIRED_UI_FIELDS, validateTheme } from "./theme.js";
import { BUNDLED_THEMES } from "./themes/index.js";

/** Minimal valid dark theme for testing. */
function makeValidTheme(overrides?: Partial<LastermTheme>): Record<string, unknown> {
	const colors: Record<string, string> = {};
	for (const field of REQUIRED_COLOR_FIELDS) {
		colors[field] = "#aabbcc";
	}
	const ui: Record<string, string> = {};
	for (const field of REQUIRED_UI_FIELDS) {
		ui[field] = "#112233";
	}
	return {
		name: "test-theme",
		type: "dark" as const,
		colors,
		ui,
		...overrides,
	};
}

describe("validateTheme", () => {
	it("accepts a valid dark theme", () => {
		const result = validateTheme(makeValidTheme());
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("accepts a valid light theme", () => {
		const result = validateTheme(makeValidTheme({ type: "light" }));
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("rejects missing name", () => {
		const theme = makeValidTheme();
		theme.name = undefined;
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("name"));
	});

	it("rejects name with spaces", () => {
		const result = validateTheme(
			makeValidTheme({ name: "my theme" } as unknown as Partial<LastermTheme>),
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("name"));
	});

	it("rejects name with special characters", () => {
		const result = validateTheme(
			makeValidTheme({ name: "my_theme!" } as unknown as Partial<LastermTheme>),
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("name"));
	});

	it("rejects name with uppercase letters", () => {
		const result = validateTheme(
			makeValidTheme({ name: "MyTheme" } as unknown as Partial<LastermTheme>),
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("name"));
	});

	it("rejects missing type", () => {
		const theme = makeValidTheme();
		theme.type = undefined;
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("type"));
	});

	it("rejects invalid type value", () => {
		const theme = makeValidTheme();
		theme.type = "medium";
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("type"));
	});

	it("rejects missing required color field with specific error", () => {
		const theme = makeValidTheme();
		const colors = { ...(theme.colors as Record<string, string>) };
		colors.red = undefined;
		colors.brightCyan = undefined;
		theme.colors = colors;
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("colors.red"));
		expect(result.errors).toContainEqual(expect.stringContaining("colors.brightCyan"));
	});

	it("rejects invalid hex color in colors with specific error", () => {
		const theme = makeValidTheme();
		(theme.colors as Record<string, string>).foreground = "not-a-color";
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("colors.foreground"));
	});

	it("rejects 3-digit hex shorthand", () => {
		const theme = makeValidTheme();
		(theme.colors as Record<string, string>).foreground = "#abc";
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("colors.foreground"));
	});

	it("accepts 8-digit hex (with alpha)", () => {
		const theme = makeValidTheme();
		(theme.colors as Record<string, string>).foreground = "#aabbccdd";
		const result = validateTheme(theme);
		expect(result.valid).toBe(true);
	});

	it("rejects missing required ui field with specific error", () => {
		const theme = makeValidTheme();
		const ui = { ...(theme.ui as Record<string, string>) };
		ui.accent = undefined;
		ui.badge = undefined;
		theme.ui = ui;
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("ui.accent"));
		expect(result.errors).toContainEqual(expect.stringContaining("ui.badge"));
	});

	it("rejects invalid hex color in ui with specific error", () => {
		const theme = makeValidTheme();
		(theme.ui as Record<string, string>).accent = "rgb(0,0,0)";
		const result = validateTheme(theme);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("ui.accent"));
	});

	it("rejects non-object input", () => {
		expect(validateTheme(null).valid).toBe(false);
		expect(validateTheme(undefined).valid).toBe(false);
		expect(validateTheme("string").valid).toBe(false);
		expect(validateTheme(42).valid).toBe(false);
		expect(validateTheme([]).valid).toBe(false);
	});

	it("rejects partial theme listing all missing fields", () => {
		const result = validateTheme({ name: "partial", type: "dark" });
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual(expect.stringContaining("colors is required"));
		expect(result.errors).toContainEqual(expect.stringContaining("ui is required"));
	});

	it("collects multiple errors in a single pass", () => {
		const result = validateTheme({
			name: "INVALID NAME!",
			type: "unknown",
			colors: { foreground: "bad" },
			ui: {},
		});
		expect(result.valid).toBe(false);
		// At minimum: name error + type error + missing color fields + missing ui fields
		expect(result.errors.length).toBeGreaterThan(4);
	});

	describe("bundled themes", () => {
		const themeEntries = Object.entries(BUNDLED_THEMES);

		it.each(themeEntries)("%s passes validation", (_name, theme) => {
			const result = validateTheme(theme);
			expect(result.errors).toEqual([]);
			expect(result.valid).toBe(true);
		});

		it("has exactly 9 bundled themes", () => {
			expect(themeEntries.length).toBe(9);
		});
	});
});
