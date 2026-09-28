/**
 * The two icon containers the desktop bundles need, written from PNG images:
 * no image is re-encoded, each entry holds the PNG as rendered.
 */

/** Width and height of a PNG, from its IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (png.length < 24 || signature.some((byte, i) => png[i] !== byte)) {
		throw new Error("Not a PNG image.");
	}
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * A Windows .ico holding one PNG per size. Windows Vista and later read PNG
 * entries at every size; a width or height of 256 is written as 0, as the
 * format requires.
 */
export function icoFile(images: readonly Uint8Array[]): Uint8Array {
	const count = images.length;
	const headerSize = 6 + 16 * count;
	const total = headerSize + images.reduce((sum, image) => sum + image.length, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint16(0, 0, true); // reserved
	view.setUint16(2, 1, true); // type: icon
	view.setUint16(4, count, true);
	let offset = headerSize;
	images.forEach((image, i) => {
		const { width, height } = pngSize(image);
		if (width !== height || width > 256) {
			throw new Error(`An .ico entry must be square and at most 256 px, got ${width}x${height}.`);
		}
		const entry = 6 + 16 * i;
		view.setUint8(entry, width === 256 ? 0 : width);
		view.setUint8(entry + 1, height === 256 ? 0 : height);
		view.setUint8(entry + 2, 0); // no palette
		view.setUint8(entry + 3, 0); // reserved
		view.setUint16(entry + 4, 1, true); // colour planes
		view.setUint16(entry + 6, 32, true); // bits per pixel
		view.setUint32(entry + 8, image.length, true);
		view.setUint32(entry + 12, offset, true);
		out.set(image, offset);
		offset += image.length;
	});
	return out;
}

/** The PNG-carrying .icns element types, by pixel size. */
const ICNS_TYPES: Readonly<Record<number, string>> = {
	128: "ic07",
	256: "ic08",
	512: "ic09",
	1024: "ic10",
};

/** A macOS .icns holding PNG elements (128, 256, 512 and 1024 px). */
export function icnsFile(images: readonly Uint8Array[]): Uint8Array {
	const elements = images.map((image) => {
		const { width, height } = pngSize(image);
		const type = ICNS_TYPES[width];
		if (width !== height || type === undefined) {
			throw new Error(`No .icns PNG element for ${width}x${height}.`);
		}
		return { type, image };
	});
	const total = 8 + elements.reduce((sum, e) => sum + 8 + e.image.length, 0);
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	const ascii = (at: number, text: string) => {
		for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i);
	};
	ascii(0, "icns");
	view.setUint32(4, total);
	let offset = 8;
	for (const { type, image } of elements) {
		ascii(offset, type);
		view.setUint32(offset + 4, 8 + image.length);
		out.set(image, offset + 8);
		offset += 8 + image.length;
	}
	return out;
}
