import type { FontFamily } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	domPublicAssetUrl: vi.fn<(path: string) => Promise<string>>(),
}));

vi.mock("../utils/hub-url.js", () => ({
	domPublicAssetUrl: mocks.domPublicAssetUrl,
	hubBaseUrl: () => "",
}));

import { injectFontFaces } from "./config.js";

const oldFace: FontFamily[] = [
	{
		family: "Old Working Font",
		files: [{ url: "/public/fonts/old.woff2", weight: 400, style: "normal" }],
	},
];

const partiallyResolvableFaces: FontFamily[] = [
	{
		family: "Replacement Font",
		files: [
			{ url: "/public/fonts/working.woff2", weight: 400, style: "normal" },
			{ url: "/public/fonts/broken.woff2", weight: 700, style: "normal" },
		],
	},
];

describe("injectFontFaces", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		mocks.domPublicAssetUrl.mockReset();
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a working face applied when another face cannot be resolved", async () => {
		mocks.domPublicAssetUrl.mockResolvedValueOnce("blob:old-working-font");
		await injectFontFaces(oldFace);
		const previousStyle = document.getElementById("lasterm-fonts");
		if (!previousStyle) throw new Error("expected the existing font style");
		const removePreviousStyle = vi.spyOn(previousStyle, "remove");

		mocks.domPublicAssetUrl.mockImplementation(async (path) => {
			if (path.endsWith("working.woff2")) return "blob:replacement-working-font";
			throw new Error("font file is unavailable");
		});
		await injectFontFaces(partiallyResolvableFaces);

		const style = document.getElementById("lasterm-fonts");
		expect(style).not.toBeNull();
		expect(style).not.toBe(previousStyle);
		expect(style?.textContent).toContain('url("blob:replacement-working-font")');
		expect(style?.textContent).not.toContain("broken.woff2");
		expect(document.head.contains(previousStyle)).toBe(false);
		expect(removePreviousStyle).not.toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old-working-font");
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("failed to resolve custom font Replacement Font"),
			expect.any(Error),
		);
	});
});
