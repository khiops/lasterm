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

		it("should return search settings for global scope, and only scrollbar markers below it", () => {
			const result = getSchemaForCategoryScope("search", "global");
			expect(result.length).toBeGreaterThan(1);
			for (const scope of ["host", "channel"]) {
				expect(getSchemaForCategoryScope("search", scope).map((d) => d.key)).toEqual([
					"scrollbarMarkers",
				]);
			}
		});

		it("should return startup settings only for global scope", () => {
			const result = getSchemaForCategoryScope("startup", "global");
			expect(result.length).toBeGreaterThan(0);
			expect(getSchemaForCategoryScope("startup", "host")).toHaveLength(0);
			expect(getSchemaForCategoryScope("startup", "channel")).toHaveLength(0);
		});

		// File transfer (#835): the upload keys at every scope they apply to, the
		// host's two left out per terminal, the files panel's globally.
		it("should return the file-transfer keys each scope holds", () => {
			const keys = (scope: string) =>
				getSchemaForCategoryScope("transfer", scope).map((d) => d.key);
			const perTerminal = [
				"transferDrop",
				"transferConfirmDrop",
				"transferOnConflict",
				"transferFollowCwd",
			];
			const perHost = [...perTerminal, "transferFallbackDir", "transferVerify"];
			expect(keys("channel")).toEqual(perTerminal);
			expect(keys("host")).toEqual(perHost);
			expect(keys("global")).toEqual([
				...perHost,
				"panelSide",
				"openOnDrag",
				"maxConcurrent",
				"showHidden",
			]);
		});

		it("should store the files panel's keys in [transfer]", () => {
			const panelSide = settingsSchema.find((d) => d.key === "panelSide");
			expect(panelSide && toStoreParams(panelSide)).toEqual({
				storeSection: "ui",
				storeKey: "transfer.panelSide",
			});
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
			const validCategories = [
				"terminal",
				"tabs",
				"panes",
				"channels",
				"search",
				"startup",
				"transfer",
			];
			for (const def of settingsSchema) {
				expect(validCategories).toContain(def.category);
			}
		});

		it("all settings have a valid section", () => {
			const validSections = [
				"terminal",
				"tabs",
				"panes",
				"channels",
				"search",
				"startup",
				"title",
				"transfer",
			];
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

	// Settings wrote `[search] scrollbar_markers`, and the terminals read
	// `[terminal] scrollbar_markers`: the toggle changed nothing (#614). It is
	// the terminal key, cascaded like the others, shown under Search.
	describe("Scrollbar Markers", () => {
		const markers = settingsSchema.find((d) => d.key === "scrollbarMarkers");

		it("writes the terminal profile's key, at every scope", () => {
			expect(markers).toMatchObject({
				category: "search",
				section: "terminal",
				scopes: ["global", "host", "channel"],
			});
			if (!markers) return;
			expect(toStoreParams(markers)).toEqual({
				storeSection: "terminal",
				storeKey: "scrollbarMarkers",
			});
		});

		it("is the only setting of that name", () => {
			expect(settingsSchema.filter((d) => d.key === "scrollbarMarkers")).toHaveLength(1);
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

// Where each setting is stored, written out: the key the readers read it under (#937). Renaming a
// setting in the schema without its readers makes the panel write a key nothing reads; the reader
// specs inject these same keys directly, so this table is what ties the panel to them.
const STORED_AT: Record<string, string> = {
	"terminal.fontFamily": "terminal:fontFamily",
	"terminal.fontSize": "terminal:fontSize",
	"terminal.cursorStyle": "terminal:cursorStyle",
	"terminal.scrollback": "terminal:scrollback",
	"terminal.bellSound": "terminal:bellSound",
	"terminal.bellCustomFile": "terminal:bellCustomFile",
	"terminal.bellBadge": "terminal:bellBadge",
	"terminal.pasteWarning": "terminal:pasteWarning",
	"terminal.whenEnded": "terminal:whenEnded",
	"panes.keepEnded": "ui:panes.keepEnded",
	"title.source": "ui:title.source",
	"title.staticTitle": "ui:title.staticTitle",
	"title.maxLength": "ui:title.maxLength",
	"title.windowTitle": "ui:title.windowTitle",
	"tabs.closeButton": "ui:tabs.closeButton",
	"tabs.newTabPosition": "ui:tabs.newTabPosition",
	"tabs.scope": "ui:tabs.scope",
	"tabs.hostMarker": "ui:tabs.hostMarker",
	"tabs.confirmCloseAll": "ui:tabs.confirmCloseAll",
	"tabs.confirmCloseOthers": "ui:tabs.confirmCloseOthers",
	"panes.maxPanes": "ui:panes.maxPanes",
	"search.position": "ui:search.position",
	"search.highlightOnClose": "ui:search.highlightOnClose",
	"terminal.scrollbarMarkers": "terminal:scrollbarMarkers",
	"search.historySize": "ui:search.historySize",
	"channels.defaultGroupName": "ui:channels.defaultGroupName",
	"channels.autoGroup": "ui:channels.autoGroup",
	"startup.autoOpenWelcome": "ui:startup.autoOpenWelcome",
	"terminal.transferDrop": "terminal:transferDrop",
	"terminal.transferConfirmDrop": "terminal:transferConfirmDrop",
	"terminal.transferOnConflict": "terminal:transferOnConflict",
	"terminal.transferFollowCwd": "terminal:transferFollowCwd",
	"terminal.transferFallbackDir": "terminal:transferFallbackDir",
	"terminal.transferVerify": "terminal:transferVerify",
	"transfer.panelSide": "ui:transfer.panelSide",
	"transfer.openOnDrag": "ui:transfer.openOnDrag",
	"transfer.maxConcurrent": "ui:transfer.maxConcurrent",
	"transfer.showHidden": "ui:transfer.showHidden",
};

describe("settingsSchema — where each setting is stored (#937)", () => {
	it("stores every setting under the key its readers read, and offers no other", () => {
		const offered = Object.fromEntries(
			settingsSchema.map((d) => {
				const { storeSection, storeKey } = toStoreParams(d);
				return [`${d.section}.${d.key}`, `${storeSection}:${storeKey}`];
			}),
		);
		expect(offered).toEqual(STORED_AT);
	});
});

describe("settingsSchema — a paste of several lines (#1015)", () => {
	it("offers pasteWarning in Terminal, its three values, at every scope", () => {
		const def = settingsSchema.find((d) => d.key === "pasteWarning");
		expect(def).toMatchObject({ type: "select", category: "terminal", section: "terminal" });
		expect(def?.scopes).toEqual(["global", "host", "channel"]);
		expect(def?.options?.map((o) => o.value)).toEqual(["auto", "always", "never"]);
		for (const scope of ["global", "host", "channel"] as const) {
			expect(
				getSchemaForCategoryScope("terminal", scope).some((d) => d.key === "pasteWarning"),
			).toBe(true);
		}
	});
});
