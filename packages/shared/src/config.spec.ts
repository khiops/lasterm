import { describe, expect, it } from "vitest";
import { deepMerge, UI_SECTION_KEYS } from "./config.js";

describe("deepMerge", () => {
	it("scalar overwrite: later source wins", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1, b: 2 }, { b: 99 });
		expect(result).toEqual({ a: 1, b: 99 });
	});

	it("nested object merge: recursive deep merge", () => {
		const result = deepMerge<Record<string, unknown>>(
			{ theme: { bg: "black", fg: "white" } },
			{ theme: { fg: "red" } },
		);
		expect(result).toEqual({ theme: { bg: "black", fg: "red" } });
	});

	it("null key removal: null in source removes key from result", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1, b: 2 }, { b: null });
		expect(result).not.toHaveProperty("b");
		expect(result.a).toBe(1);
	});

	it("array replacement: arrays replace, not merge", () => {
		const result = deepMerge<Record<string, unknown>>(
			{ colors: ["red", "green"] },
			{ colors: ["blue"] },
		);
		expect(result.colors).toEqual(["blue"]);
	});

	it("undefined source skip: undefined values are ignored", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, { a: undefined });
		expect(result.a).toBe(1);
	});

	it("multi-source cascade: 4+ sources, last wins for scalars", () => {
		const result = deepMerge<Record<string, unknown>>(
			{ a: 1, b: 2, c: 3, d: 4 }, // layer 1: built-in defaults
			{ b: 20, nested: { x: 1 } }, // layer 2: config.toml
			{ c: 300, nested: { y: 2 } }, // layer 3: host profile
			{ d: 4000, nested: { x: 99, z: 3 } }, // layer 4: channel profile
		);
		expect(result.a).toBe(1);
		expect(result.b).toBe(20);
		expect(result.c).toBe(300);
		expect(result.d).toBe(4000);
		expect(result.nested).toEqual({ x: 99, y: 2, z: 3 });
	});

	it("empty source handling: null source is gracefully skipped", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, null, { b: 2 });
		expect(result).toEqual({ a: 1, b: 2 });
	});

	it("empty source handling: undefined source is gracefully skipped", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, undefined, { b: 2 });
		expect(result).toEqual({ a: 1, b: 2 });
	});

	it("empty source handling: all-null/undefined sources returns empty object", () => {
		const result = deepMerge<Record<string, unknown>>(null, undefined);
		expect(result).toEqual({});
	});

	it("non-object type at root: non-object scalar source key overwrites nested", () => {
		// When source value is not a plain object, it overwrites regardless
		const result = deepMerge<Record<string, unknown>>(
			{ settings: { a: 1 } },
			{ settings: "string-override" as unknown },
		);
		expect(result.settings).toBe("string-override");
	});

	it("nested null removal propagates: null removes nested key", () => {
		type Cfg = { profile: { fontFamily?: string; fontSize?: number } };
		const result = deepMerge<Cfg>(
			{ profile: { fontFamily: "Mono", fontSize: 14 } },
			{ profile: { fontSize: null as unknown as number } },
		);
		expect((result.profile as Record<string, unknown>).fontFamily).toBe("Mono");
		expect(result.profile).not.toHaveProperty("fontSize");
	});

	it("new key from later source: merges keys not present in earlier sources", () => {
		const result = deepMerge<Record<string, unknown>>({ a: 1 }, { b: 2 });
		expect(result).toEqual({ a: 1, b: 2 });
	});
});

// The keys PUT /api/config/ui takes, by section. The hub route keeps one test
// proving it refuses a key that is not listed here.
describe("UI_SECTION_KEYS", () => {
	// Every split names its direction, so a default had nowhere to apply: the
	// setting was offered, stored, and read by nothing. It is no longer taken.
	it("no longer lists panes.defaultSplitDirection", () => {
		expect(UI_SECTION_KEYS.panes).not.toContain("defaultSplitDirection");
	});
});
