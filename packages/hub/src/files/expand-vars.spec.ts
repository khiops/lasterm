// biome-ignore-all lint/suspicious/noTemplateCurlyInString: test data holds literal ${VAR} text, which the hub expands as the agent does
import { describe, expect, it } from "vitest";
import { expandVariables, lookupIn, referencedVariables } from "./expand-vars.js";

/** A lookup in exactly these variables, as the agent's tests give them. */
const env = (variables: Record<string, string>) => lookupIn(variables, false);

// The agent's own cases (crates/lasterm-agent/src/expand.rs): the same text
// must name the same folder in a launch profile's cwd and in the files panel.
describe("expanding a folder's variables as the agent expands a cwd", () => {
	it("expands ${VAR}", () => {
		expect(expandVariables("${HOME}/bin", env({ HOME: "/home/user" }))).toBe("/home/user/bin");
	});

	it("reads \\${VAR} as the text ${VAR}", () => {
		expect(expandVariables("\\${HOME}", env({ HOME: "/home/user" }))).toBe("${HOME}");
	});

	it("reads \\\\${VAR} as a backslash and the value", () => {
		expect(expandVariables("\\\\${HOME}", env({ HOME: "/home/user" }))).toBe("\\/home/user");
	});

	it("keeps a variable with no value as it is", () => {
		expect(expandVariables("${UNDEFINED_LASTERM_TEST_VAR_XYZ}", env({}))).toBe(
			"${UNDEFINED_LASTERM_TEST_VAR_XYZ}",
		);
	});

	it("does not read a value again", () => {
		expect(expandVariables("${INJECT}", env({ INJECT: "${HOME}", HOME: "/home/user" }))).toBe(
			"${HOME}",
		);
	});

	it("leaves an empty text empty", () => {
		expect(expandVariables("", env({}))).toBe("");
	});

	it("does not expand $VAR without braces", () => {
		expect(expandVariables("$VAR", env({ VAR: "value" }))).toBe("$VAR");
	});

	it("expands several variables", () => {
		expect(expandVariables("${USER}@${HOST}", env({ USER: "alice", HOST: "server1" }))).toBe(
			"alice@server1",
		);
	});

	// Past the agent's own tests, what its loop does with the rest.
	// A Windows path is written with the variable first, or its backslash before
	// `${` escapes it, as in a cwd; and `\\` is one backslash there too.
	it("reads \\\\ as one backslash, and keeps any other backslash and an unclosed ${", () => {
		expect(expandVariables("a\\\\b", env({}))).toBe("a\\b");
		expect(
			expandVariables("${USERPROFILE}\\Downloads", env({ USERPROFILE: "C:\\Users\\me" })),
		).toBe("C:\\Users\\me\\Downloads");
		expect(expandVariables("C:\\Users\\${USER}", env({ USER: "me" }))).toBe("C:\\Users${USER}");
		expect(expandVariables("${HOME", env({ HOME: "/h" }))).toBe("${HOME");
		expect(expandVariables("\\${HOME", env({ HOME: "/h" }))).toBe("\\${HOME");
	});
});

describe("the variables a folder names", () => {
	it("are those it would expand, once each, an escaped one not among them", () => {
		expect(referencedVariables("${A}/${B}/\\${C}/${A}/$D")).toEqual(["A", "B"]);
		expect(referencedVariables("/srv/plain")).toEqual([]);
	});
});

describe("a lookup in a map of variables", () => {
	it("reads names exactly, as a POSIX host does", () => {
		const lookup = lookupIn({ Home: "/h" }, false);
		expect(lookup("Home")).toBe("/h");
		expect(lookup("HOME")).toBeUndefined();
	});

	it("reads names without regard to case, as Windows does", () => {
		const lookup = lookupIn(new Map([["UserProfile", "C:\\Users\\me"]]), true);
		expect(lookup("USERPROFILE")).toBe("C:\\Users\\me");
		expect(lookup("userprofile")).toBe("C:\\Users\\me");
		expect(lookup("TEMP")).toBeUndefined();
	});
});
