import { describe, expect, it } from "vitest";
import {
	type EnvironmentEntry,
	inheritedEntries,
	toEntries,
	toMap,
} from "./environmentSettings.js";

describe("environment settings", () => {
	it("reads a layer's map as rows, in the order they will be read", () => {
		expect(toEntries({ PATH: "/usr/bin", EDITOR: "hx" })).toEqual([
			{ name: "EDITOR", value: "hx" },
			{ name: "PATH", value: "/usr/bin" },
		]);
	});

	// profile_json is data: it may hold anything, and an editor that throws on
	// it is an editor nobody can use to fix it.
	it("reads nothing out of what is not a map of strings", () => {
		expect(toEntries(null)).toEqual([]);
		expect(toEntries("PATH=/usr/bin")).toEqual([]);
		expect(toEntries({ PORT: 4100, "": "unnamed", OK: "yes" })).toEqual([
			{ name: "OK", value: "yes" },
		]);
	});

	it("drops the empty row an editor always has at the end", () => {
		const rows: EnvironmentEntry[] = [
			{ name: "EDITOR", value: "hx" },
			{ name: "  ", value: "" },
			{ name: "", value: "orphan" },
		];

		expect(toMap(rows)).toEqual({ EDITOR: "hx" });
	});

	// A map holds a name once; the editor has to say which value that is.
	it("keeps the last value when a name is written twice", () => {
		expect(
			toMap([
				{ name: "LANG", value: "C" },
				{ name: "LANG", value: "fr_FR.UTF-8" },
			]),
		).toEqual({ LANG: "fr_FR.UTF-8" });
	});

	it("shows what the scopes above contribute, and not what this one sets", () => {
		const resolved = { EDITOR: "hx", LANG: "fr_FR.UTF-8", PAGER: "less" };
		const own = { EDITOR: "hx", PAGER: "less" };

		expect(inheritedEntries(resolved, own)).toEqual([{ name: "LANG", value: "fr_FR.UTF-8" }]);
	});

	it("shows the whole resolved environment for a scope that sets none", () => {
		expect(inheritedEntries({ LANG: "C" }, undefined)).toEqual([{ name: "LANG", value: "C" }]);
	});
});
