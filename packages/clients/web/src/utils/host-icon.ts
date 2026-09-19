/** The longest data URI the hub accepts for an image icon (hub `MAX_ICON_IMAGE_LENGTH`). */
export const MAX_ICON_IMAGE_LENGTH = 65_536;

/** An image icon is drawn at most this many pixels on its longer side. */
const ICON_IMAGE_SIZE = 64;

/**
 * Whether an image icon can be displayed. Pages load images only from the hub
 * or from data: and blob: URIs, so an icon stored as a web address never loads
 * (#208); only a data: image of a raster format can.
 */
export function isDisplayableIconImage(value: string | null | undefined): boolean {
	return typeof value === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(value);
}

/** Scale a picked image down to icon size and return it as a PNG data URI. */
export async function iconImageFromFile(file: Blob): Promise<string> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, ICON_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("this browser cannot draw the image");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const dataUrl = canvas.toDataURL("image/png");
		if (dataUrl.length > MAX_ICON_IMAGE_LENGTH) {
			throw new Error("the image is still too large at icon size");
		}
		return dataUrl;
	} finally {
		bitmap.close();
	}
}
