import { describe, expect, it } from "vitest";
import { isDisplayableIconImage } from "./host-icon.js";

describe("isDisplayableIconImage", () => {
	it("accepts a raster data URI", () => {
		expect(isDisplayableIconImage("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
		expect(isDisplayableIconImage("data:image/webp;base64,UklGRg==")).toBe(true);
	});

	it("refuses a web address, which a page can never load (#208)", () => {
		expect(isDisplayableIconImage("https://example.com/icon.png")).toBe(false);
		expect(isDisplayableIconImage("http://127.0.0.1:4100/public/icon.png")).toBe(false);
	});

	it("refuses anything else", () => {
		expect(isDisplayableIconImage("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
		expect(isDisplayableIconImage("")).toBe(false);
		expect(isDisplayableIconImage(null)).toBe(false);
	});
});
