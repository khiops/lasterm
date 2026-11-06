import { describe, expect, it } from "vitest";
import { relPathProblem, windowsNameProblem } from "./transfer-protocol.js";

describe("windowsNameProblem", () => {
	it("refuses a device's name, whatever its case and its extension", () => {
		for (const name of [
			"CON",
			"con.txt",
			"Nul.tar.gz",
			"COM1",
			"lpt9.log",
			"AUX",
			"PRN.x",
			"CONOUT$",
		]) {
			expect(windowsNameProblem(name), name).toMatch(/device/);
		}
	});

	it("refuses a trailing dot or space, and the characters no Windows name holds", () => {
		expect(windowsNameProblem("name.")).toMatch(/dot or a space/);
		expect(windowsNameProblem("name ")).toMatch(/dot or a space/);
		for (const name of ["a<b", "a>b", "a:b", 'a"b', "a\\b", "a|b", "a?b", "a*b", "a\u0001b"]) {
			expect(windowsNameProblem(name), name).toMatch(/holds none of/);
		}
	});

	it("takes what Windows takes", () => {
		for (const name of ["console.txt", "CONx", "COM10", ".hidden", "a b", "ünï 日本", "100% $x"]) {
			expect(windowsNameProblem(name), name).toBeNull();
		}
	});
});

describe("relPathProblem", () => {
	it("takes a relative path of names", () => {
		expect(relPathProblem("a/b c/.d")).toBeNull();
		expect(relPathProblem("back\\slash")).toBeNull();
	});

	it("refuses an empty, absolute or dotted path, an empty name, a NUL and a name over 255 bytes", () => {
		expect(relPathProblem("")).toMatch(/empty/);
		expect(relPathProblem("/a")).toMatch(/not relative/);
		expect(relPathProblem("a//b")).toMatch(/empty name/);
		expect(relPathProblem("a/")).toMatch(/empty name/);
		expect(relPathProblem("a/../b")).toMatch(/\.\./);
		expect(relPathProblem("./a")).toMatch(/\.\./);
		expect(relPathProblem("a\0b")).toMatch(/NUL/);
		expect(relPathProblem("é".repeat(128))).toMatch(/255 bytes/);
		expect(relPathProblem("é".repeat(127))).toBeNull();
	});
});
