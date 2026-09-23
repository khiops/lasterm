import { describe, expect, it } from "vitest";
import { getSchemaForCategoryScope, settingsSchema, toStoreParams } from "./settingsSchema.js";

describe("settingsSchema", () => {
	describe("getSchemaForCategoryScope", () => {
		it("should return all terminal settings for global scope", () => {
			const result = getSchemaForCategoryScope("terminal", "global");
			expect(result.length).toBeGreaterThan(0);
			expect(result.every((d) => d.category === "terminal")).toBe(true);
		});

		it("should return only cascaded terminal settings for host scope", () => {
			const result = getSchemaForCategoryScope("terminal", "host");
			expect(result.every((d) => d.scopes.includes("host"))).toBe(true);
			// Should include cascaded fields like fontSize
			expect(result.some((d) => d.key === "fontSize")).toBe(true);
			// Should NOT include title settings (global only)
			expect(result.some((d) => d.key === "source")).toBe(false);
		});

		it("should return only cascaded terminal settings for channel scope", () => {
			const result = getSchemaForCategoryScope("terminal", "channel");
			expect(result.every((d) => d.scopes.includes("channel"))).toBe(true);
			expect(result.some((d) => d.key === "fontFamily")).toBe(true);
			expect(result.some((d) => d.key === "source")).toBe(false);
			expect(result.some((d) => d.key === "windowTitle")).toBe(false);
		});

		it("should return tabs settings only for global scope", () => {
			const result = getSchemaForCategoryScope("tabs", "global");
			expect(result.length).toBeGreaterThan(0);
			expect(getSchemaForCategoryScope("tabs", "host")).toHaveLength(0);
			expect(getSchemaForCategoryScope("tabs", "channel")).toHaveLength(0);
		});

		it("should return panes settings only for global scope", () => {
			const result = getSchemaForCategoryScope("panes", "global");
			expect(result.length).toBeGreaterThan(0);
			expect(getSchemaForCategoryScope("panes", "host")).toHaveLength(0);
			expect(getSchemaForCategoryScope("panes", "channel")).toHaveLength(0);
		});

		it("should return search settings only for global scope", () => {
			const result = getSchemaForCategoryScope("search", "global");
			expect(result.length).toBeGreaterThan(0);
			expect(getSchemaForCategoryScope("search", "host")).toHaveLength(0);
			expect(getSchemaForCategoryScope("search", "channel")).toHaveLength(0);
		});

		it("should return startup settings only for global scope", () => {
			const result = getSchemaForCategoryScope("startup", "global");
			expect(result.length).toBeGreaterThan(0);
			expect(getSchemaForCategoryScope("startup", "host")).toHaveLength(0);
			expect(getSchemaForCategoryScope("startup", "channel")).toHaveLength(0);
		});

		it("should return empty array for unknown category", () => {
			expect(getSchemaForCategoryScope("unknown", "global")).toHaveLength(0);
		});

		it("should return empty array for unknown scope", () => {
			expect(getSchemaForCategoryScope("terminal", "unknown")).toHaveLength(0);
		});
	});

	describe("schema integrity", () => {
		it("all settings have valid types", () => {
			const validTypes = ["text", "number", "select", "toggle", "range", "color", "font"];
			for (const def of settingsSchema) {
				expect(validTypes).toContain(def.type);
			}
		});

		it("select settings have options", () => {
			for (const def of settingsSchema.filter((d) => d.type === "select")) {
				expect(def.options?.length).toBeGreaterThan(0);
			}
		});

		it("number settings have min and max", () => {
			for (const def of settingsSchema.filter((d) => d.type === "number")) {
				expect(def.min).toBeDefined();
				expect(def.max).toBeDefined();
			}
		});

		it("all settings have at least one scope", () => {
			for (const def of settingsSchema) {
				expect(def.scopes.length).toBeGreaterThan(0);
			}
		});

		it("all settings have a valid category", () => {
			const validCategories = ["terminal", "tabs", "panes", "channels", "search", "startup"];
			for (const def of settingsSchema) {
				expect(validCategories).toContain(def.category);
			}
		});

		it("all settings have a valid section", () => {
			const validSections = ["terminal", "tabs", "panes", "channels", "search", "startup", "title"];
			for (const def of settingsSchema) {
				expect(validSections).toContain(def.section);
			}
		});

		it("keys are unique within each section", () => {
			const seen = new Map<string, Set<string>>();
			for (const def of settingsSchema) {
				if (!seen.has(def.section)) seen.set(def.section, new Set());
				const sectionKeys = seen.get(def.section) as Set<string>;
				expect(
					sectionKeys.has(def.key),
					`Duplicate key "${def.key}" in section "${def.section}"`,
				).toBe(false);
				sectionKeys.add(def.key);
			}
		});
	});

	describe("toStoreParams", () => {
		it("maps terminal section directly", () => {
			const result = toStoreParams({
				key: "fontSize",
				label: "Font Size",
				type: "number",
				category: "terminal",
				section: "terminal",
				scopes: ["global", "host", "channel"],
			});
			expect(result).toEqual({ storeSection: "terminal", storeKey: "fontSize" });
		});

		it("maps tabs section to ui with dotted key", () => {
			const result = toStoreParams({
				key: "closeButton",
				label: "Close Button",
				type: "toggle",
				category: "tabs",
				section: "tabs",
				scopes: ["global"],
			});
			expect(result).toEqual({ storeSection: "ui", storeKey: "tabs.closeButton" });
		});

		it("maps title section to ui with dotted key", () => {
			const result = toStoreParams({
				key: "source",
				label: "Title Source",
				type: "select",
				category: "terminal",
				section: "title",
				scopes: ["global"],
			});
			expect(result).toEqual({ storeSection: "ui", storeKey: "title.source" });
		});

		it("maps search section to ui with dotted key", () => {
			const result = toStoreParams({
				key: "position",
				label: "Search Position",
				type: "select",
				category: "search",
				section: "search",
				scopes: ["global"],
			});
			expect(result).toEqual({ storeSection: "ui", storeKey: "search.position" });
		});

		it("maps panes section to ui with dotted key", () => {
			const result = toStoreParams({
				key: "maxPanes",
				label: "Max Panes",
				type: "number",
				category: "panes",
				section: "panes",
				scopes: ["global"],
			});
			expect(result).toEqual({ storeSection: "ui", storeKey: "panes.maxPanes" });
		});

		it("maps startup section to ui with dotted key", () => {
			const result = toStoreParams({
				key: "autoOpenWelcome",
				label: "Auto-open Welcome Tab",
				type: "toggle",
				category: "startup",
				section: "startup",
				scopes: ["global"],
			});
			expect(result).toEqual({
				storeSection: "ui",
				storeKey: "startup.autoOpenWelcome",
			});
		});
	});
});

// ─── Every setting offered is read by something ──────────────────────────────
//
// Three settings were offered, stored and read by nothing: Max Panes, Default
// Split Direction and Auto-open Welcome Tab. Changing them changed nothing, and
// nobody could tell from the panel. A setting's key must appear in code other
// than the panel, the validators, the config parser and the tests.

describe("settingsSchema — nothing offered in vain", () => {
	// Every source that could act on a setting, as text. The web client, the
	// hub, the shared package, and the desktop shell.
	const sources = import.meta.glob(
		[
			"../../**/*.{ts,vue}",
			"../../../../../hub/src/**/*.ts",
			"../../../../../shared/src/**/*.ts",
			"../../../../desktop/src-tauri/src/**/*.rs",
			"!**/*.spec.ts",
		],
		{ query: "?raw", import: "default", eager: true },
	) as Record<string, string>;

	// Where a key is declared, validated, parsed or tested — not where it acts.
	const notAReader =
		/(settingsSchema\.ts|\/settings\/categories\/.*|hub\/src\/api\/config\.ts|hub\/src\/config\.ts|shared\/src\/config\.ts|shared\/src\/appearance\.ts)$/;
	const code = Object.entries(sources)
		.filter(([path]) => !notAReader.test(path))
		.map(([, text]) => text)
		.join("\n");

	it("reads the sources it searches", () => {
		expect(Object.keys(sources).length).toBeGreaterThan(100);
	});

	for (const setting of settingsSchema) {
		const leaf = setting.key.split(".").at(-1) ?? setting.key;
		it(`${setting.key} is read somewhere`, () => {
			// A whole word, without escapes a formatter may rewrite: `source`
			// must not be found inside `sources`.
			const word = new RegExp(`(^|[^A-Za-z0-9_])${leaf}([^A-Za-z0-9_]|$)`);
			expect(word.test(code)).toBe(true);
		});
	}
});
