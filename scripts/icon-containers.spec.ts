import { describe, expect, it } from "vitest";
import { icnsFile, icoFile, pngSize } from "./icon-containers.js";

/** A PNG signature and IHDR chunk claiming the given size: enough for the containers. */
function fakePng(width: number, height = width): Uint8Array {
	const png = new Uint8Array(33);
	png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const view = new DataView(png.buffer);
	view.setUint32(8, 13);
	png.set([0x49, 0x48, 0x44, 0x52], 12);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return png;
}

describe("pngSize", () => {
	it("reads the IHDR size", () => {
		expect(pngSize(fakePng(48, 32))).toEqual({ width: 48, height: 32 });
	});

	it("refuses what is not a PNG", () => {
		expect(() => pngSize(new Uint8Array(40))).toThrow("Not a PNG");
	});
});

describe("icoFile", () => {
	it("writes one directory entry per image, 256 as 0, pointing at its PNG", () => {
		const images = [fakePng(16), fakePng(256)];
		const ico = icoFile(images);
		const view = new DataView(ico.buffer);
		expect(view.getUint16(2, true)).toBe(1);
		expect(view.getUint16(4, true)).toBe(2);
		expect(ico[6]).toBe(16);
		expect(ico[6 + 16]).toBe(0);
		const secondOffset = view.getUint32(6 + 16 + 12, true);
		expect(secondOffset).toBe(6 + 32 + images[0]!.length);
		expect(view.getUint32(6 + 16 + 8, true)).toBe(images[1]!.length);
		expect(ico.slice(secondOffset, secondOffset + 8)).toEqual(images[1]!.slice(0, 8));
		expect(ico.length).toBe(6 + 32 + 66);
	});

	it("refuses a size the format cannot hold", () => {
		expect(() => icoFile([fakePng(512)])).toThrow("at most 256");
		expect(() => icoFile([fakePng(32, 16)])).toThrow("square");
	});
});

describe("icnsFile", () => {
	it("writes the icns header and one PNG element per size", () => {
		const icns = icnsFile([fakePng(128), fakePng(1024)]);
		const text = (at: number) => String.fromCharCode(...icns.slice(at, at + 4));
		const view = new DataView(icns.buffer);
		expect(text(0)).toBe("icns");
		expect(view.getUint32(4)).toBe(icns.length);
		expect(text(8)).toBe("ic07");
		expect(view.getUint32(12)).toBe(8 + 33);
		expect(text(8 + 41)).toBe("ic10");
	});

	it("refuses a size with no PNG element", () => {
		expect(() => icnsFile([fakePng(64)])).toThrow("No .icns PNG element");
	});
});
