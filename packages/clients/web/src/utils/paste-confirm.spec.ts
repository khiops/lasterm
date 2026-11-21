import { describe, expect, it } from "vitest";
import { pasteFirstLines, pasteLineCount, pasteWarningAsks } from "./paste-confirm.js";

describe("pasteLineCount (#1015)", () => {
	it("counts lines as a paste runs them", () => {
		expect(pasteLineCount("a")).toBe(1);
		expect(pasteLineCount("a\n")).toBe(1);
		expect(pasteLineCount("a\r\n")).toBe(1);
		expect(pasteLineCount("a\r")).toBe(1);
		expect(pasteLineCount("a\nb")).toBe(2);
		expect(pasteLineCount("a\n\n")).toBe(2);
		expect(pasteLineCount("a\rb")).toBe(2);
		expect(pasteLineCount("a\r\nb\r\nc")).toBe(3);
	});

	it("stops counting at the limit given", () => {
		expect(pasteLineCount("a\nb\nc\nd", 2)).toBe(2);
	});
});

describe("pasteFirstLines (#1015)", () => {
	it("gives the first lines without their breaks, the final break not starting one", () => {
		expect(pasteFirstLines("a\r\nb\rc\nd\ne", 3)).toEqual(["a", "b", "c"]);
		expect(pasteFirstLines("a\nb\n", 3)).toEqual(["a", "b"]);
		expect(pasteFirstLines("a\n\n", 3)).toEqual(["a", ""]);
	});

	it("keeps each line to the units it is asked for", () => {
		expect(pasteFirstLines(`${"x".repeat(10)}\n${"y".repeat(3)}`, 3, 4)).toEqual(["xxxx", "yyy"]);
	});
});

describe("pasteWarningAsks (#1015)", () => {
	it("asks by the setting, an unknown value being auto", () => {
		expect(pasteWarningAsks("auto", false)).toBe(true);
		expect(pasteWarningAsks("auto", true)).toBe(false);
		expect(pasteWarningAsks("always", true)).toBe(true);
		expect(pasteWarningAsks("never", false)).toBe(false);
		expect(pasteWarningAsks("sometimes", false)).toBe(true);
		expect(pasteWarningAsks(undefined, false)).toBe(true);
	});
});
