import type { TerminalProfile } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { scopedEnv } from "./scoped-env.js";

function profile(env: unknown): TerminalProfile {
	return { env } as unknown as TerminalProfile;
}

describe("scopedEnv", () => {
	it("passes on what the scope declared", () => {
		expect(scopedEnv(profile({ EDITOR: "hx", LANG: "fr_FR.UTF-8" }))).toEqual({
			EDITOR: "hx",
			LANG: "fr_FR.UTF-8",
		});
	});

	it("has nothing to say for a scope that set none", () => {
		expect(scopedEnv(profile(undefined))).toEqual({});
		expect(scopedEnv(null)).toEqual({});
		expect(scopedEnv(undefined)).toEqual({});
	});

	// profile_json is data: a number there was never a variable, and an empty
	// name reaches the platform as a malformed entry.
	it("drops what a shell could not be given", () => {
		expect(scopedEnv(profile({ PORT: 4100, NAME: "keep", "": "unnamed" }))).toEqual({
			NAME: "keep",
		});
	});

	it("survives a profile whose env is not an object at all", () => {
		expect(scopedEnv(profile("PATH=/usr/bin"))).toEqual({});
		expect(scopedEnv(profile(null))).toEqual({});
	});

	// A shell reads Path and PATH as one variable on Windows and as two on
	// Unix; deciding that here would be deciding it for both.
	it("keeps names as they were written", () => {
		expect(scopedEnv(profile({ Path: "a", PATH: "b" }))).toEqual({ Path: "a", PATH: "b" });
	});
});
