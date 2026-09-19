import type { SystemFontFamily } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { cssString, filterSystemFonts, systemFontFaceRules } from "./system-fonts.js";

const FAMILIES: SystemFontFamily[] = [
	{
		family: "Cascadia Code",
		monospace: true,
		files: [
			{
				weight: 400,
				style: "normal",
				url: "/public/system-fonts/aaa.ttf?asset_token=t",
				localNames: ["Cascadia Code Regular", "CascadiaCode-Regular"],
			},
			{
				weight: 700,
				style: "italic",
				url: "/public/system-fonts/bbb.otf?asset_token=t",
				localNames: [],
			},
		],
	},
	{ family: "Segoe UI", monospace: false, files: [] },
	{ family: 'Odd "Name"', monospace: true, files: [] },
];

describe("systemFontFaceRules (#100)", () => {
	it("tries the client's own copy before downloading the hub's", () => {
		const css = systemFontFaceRules(FAMILIES, (url) => `https://hub${url}`);
		expect(css).toContain('font-family: "Cascadia Code";');
		expect(css).toContain(
			'src: local("Cascadia Code Regular"), local("CascadiaCode-Regular"), ' +
				'url("https://hub/public/system-fonts/aaa.ttf?asset_token=t") format("truetype");',
		);
		expect(css).toContain(
			'src: url("https://hub/public/system-fonts/bbb.otf?asset_token=t") format("opentype");',
		);
		expect(css).toContain("font-weight: 700;\n\tfont-style: italic;");
	});

	it("leaves imported families to their own rules", () => {
		expect(systemFontFaceRules(FAMILIES, (url) => url, new Set(["Cascadia Code"]))).toBe("");
	});
});

describe("cssString", () => {
	it("escapes what would end the string", () => {
		expect(cssString('Odd "Name" \\ x')).toBe('"Odd \\"Name\\" \\\\ x"');
		expect(cssString("line\nbreak")).toBe('"line break"');
	});
});

describe("filterSystemFonts (#100)", () => {
	it("shows monospace families by default and all of them on request", () => {
		expect(filterSystemFonts(FAMILIES, "", true).map((f) => f.family)).toEqual([
			"Cascadia Code",
			'Odd "Name"',
		]);
		expect(filterSystemFonts(FAMILIES, "", false)).toHaveLength(3);
	});

	it("matches a search anywhere in the name, ignoring case", () => {
		expect(filterSystemFonts(FAMILIES, "  CODE ", true).map((f) => f.family)).toEqual([
			"Cascadia Code",
		]);
		expect(filterSystemFonts(FAMILIES, "segoe", true)).toEqual([]);
	});
});
