import { describe, expect, it } from "vitest";
import { downloadRename, withSuffix } from "./download-names.js";

describe("downloadRename (#840)", () => {
	it.each([
		["report.pdf", "report.pdf"],
		["a:b.txt", "a_b.txt"],
		["trail.", "trail"],
		["spaced  ", "spaced"],
		["...", "_"],
		["CON.txt", "CON_.txt"],
		["con", "con_"],
		["com1.tar.gz", "com1_.tar.gz"],
		['say "hi"?', "say _hi__"],
		["tab\there", "tab_here"],
	])("renames %j to %j", (name, renamed) => {
		expect(downloadRename(name)).toBe(renamed);
	});

	it("keeps a renamed name within 255 bytes", () => {
		const renamed = downloadRename(`${"é".repeat(200)}:.txt`);
		expect(new TextEncoder().encode(renamed).length).toBeLessThanOrEqual(255);
		expect(renamed.endsWith(".txt")).toBe(true);
	});
});

describe("withSuffix (#840)", () => {
	it("puts the suffix before the extension, cutting the stem to fit", () => {
		expect(withSuffix("x.txt", " (2)")).toBe("x (2).txt");
		expect(withSuffix("noext", " (3)")).toBe("noext (3)");
		const cut = withSuffix(`${"a".repeat(255)}`, " (2)");
		expect(cut.length).toBe(255);
		expect(cut.endsWith(" (2)")).toBe(true);
	});
});
