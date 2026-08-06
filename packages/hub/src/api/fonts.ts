import { existsSync, readdirSync, readFileSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { FontFamily, FontFile } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { buildSignedPublicAssetUrl } from "../asset-token.js";
import { sanitizeFilename } from "./upload-utils.js";

/** Supported font file extensions */
const FONT_EXTENSIONS = new Set([".woff2", ".woff", ".ttf", ".otf"]);

/** Max upload size for font files: 10 MB */
const MAX_FONT_SIZE = 10 * 1024 * 1024;

/** Allowed MIME types for font files */
const ALLOWED_FONT_MIMES = new Set([
	"font/sfnt",
	"font/otf",
	"font/woff",
	"font/woff2",
	"application/font-woff",
	"application/font-woff2",
]);

/**
 * Strip directory components and reject names with traversal sequences.
 * Returns null for any invalid filename.
 */

/** Map common filename suffixes to CSS weight/style */
const WEIGHT_MAP: Record<string, { weight: number; style: string }> = {
	thin: { weight: 100, style: "normal" },
	extralight: { weight: 200, style: "normal" },
	light: { weight: 300, style: "normal" },
	regular: { weight: 400, style: "normal" },
	medium: { weight: 500, style: "normal" },
	semibold: { weight: 600, style: "normal" },
	bold: { weight: 700, style: "normal" },
	extrabold: { weight: 800, style: "normal" },
	black: { weight: 900, style: "normal" },
	thinitalic: { weight: 100, style: "italic" },
	extralightitalic: { weight: 200, style: "italic" },
	lightitalic: { weight: 300, style: "italic" },
	italic: { weight: 400, style: "italic" },
	mediumitalic: { weight: 500, style: "italic" },
	semibolditalic: { weight: 600, style: "italic" },
	bolditalic: { weight: 700, style: "italic" },
	extrabolditalic: { weight: 800, style: "italic" },
	blackitalic: { weight: 900, style: "italic" },
};

/**
 * Read the font family name from a TTF/OTF file's OpenType name table.
 * Returns the typographic family (nameID 16) if present, else family name (nameID 1).
 * Returns null if the file cannot be parsed (e.g. WOFF wrapper or corrupt data).
 */
function readFontFamily(filePath: string): string | null {
	try {
		const buf = readFileSync(filePath);
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

		// WOFF files have a different outer container — skip them (rare for user-dropped files)
		const signature = view.getUint32(0);
		if (signature === 0x774f4646) return null;

		// Read the OpenType offset table
		const offset = 0;
		const numTables = view.getUint16(offset + 4);

		// Find the 'name' table in the table directory
		let nameTableOffset = 0;
		for (let i = 0; i < numTables; i++) {
			const entryOffset = offset + 12 + i * 16;
			const tag =
				String.fromCharCode(view.getUint8(entryOffset)) +
				String.fromCharCode(view.getUint8(entryOffset + 1)) +
				String.fromCharCode(view.getUint8(entryOffset + 2)) +
				String.fromCharCode(view.getUint8(entryOffset + 3));
			if (tag === "name") {
				nameTableOffset = view.getUint32(entryOffset + 8);
				break;
			}
		}

		if (nameTableOffset === 0) return null;

		// Parse the name table header
		const nameCount = view.getUint16(nameTableOffset + 2);
		const stringOffset = nameTableOffset + view.getUint16(nameTableOffset + 4);

		let family: string | null = null;
		let typoFamily: string | null = null;

		for (let i = 0; i < nameCount; i++) {
			const recordOffset = nameTableOffset + 6 + i * 12;
			const platformID = view.getUint16(recordOffset);
			const nameID = view.getUint16(recordOffset + 6);
			const length = view.getUint16(recordOffset + 8);
			const strOff = view.getUint16(recordOffset + 10);

			// Only read nameID 1 (family) and 16 (typographic family)
			if (nameID !== 1 && nameID !== 16) continue;

			const strStart = stringOffset + strOff;
			let name: string;

			if (platformID === 3) {
				// Windows — UTF-16BE
				const chars: string[] = [];
				for (let j = 0; j < length; j += 2) {
					chars.push(String.fromCharCode(view.getUint16(strStart + j)));
				}
				name = chars.join("");
			} else if (platformID === 1) {
				// Macintosh — single-byte encoding (ASCII-compatible for Latin)
				const chars: string[] = [];
				for (let j = 0; j < length; j++) {
					chars.push(String.fromCharCode(view.getUint8(strStart + j)));
				}
				name = chars.join("");
			} else {
				continue;
			}

			if (nameID === 16) typoFamily = name;
			if (nameID === 1) family = name;
		}

		return typoFamily ?? family;
	} catch {
		return null;
	}
}

/**
 * Parse a font file into family + weight/style.
 * Reads the real font family name from the file's OpenType name table.
 * Falls back to a camelCase-splitting heuristic when the file cannot be parsed.
 *
 * Examples (TTF/OTF with name table):
 *   "FiraCodeNerdFont-Regular.ttf"   → family="FiraCode Nerd Font", weight=400, style="normal"
 *   "FiraCodeNerdFont-Bold.ttf"      → family="FiraCode Nerd Font", weight=700, style="normal"
 *   "JetBrainsMono-LightItalic.ttf"  → family="JetBrains Mono", weight=300, style="italic"
 */
function parseFontFile(
	fontsDir: string,
	filename: string,
): { family: string; weight: number; style: string } | null {
	const ext = extname(filename);
	if (!FONT_EXTENSIONS.has(ext.toLowerCase())) return null;

	const base = basename(filename, ext);
	const parts = base.split("-");

	// Family is the first part (before the first dash)
	const familySlug = parts[0];
	if (!familySlug) return null;

	// Try to read the real font family name from the file's name table
	const realName = readFontFamily(join(fontsDir, filename));
	// Fallback: insert spaces before uppercase sequences: "JetBrainsMono" → "JetBrains Mono"
	const family = realName ?? familySlug.replace(/([a-z])([A-Z])/g, "$1 $2");

	// Variant is the second part (after dash), lowercased for lookup
	const variantRaw = parts.slice(1).join("").toLowerCase();
	const variant = WEIGHT_MAP[variantRaw] ?? { weight: 400, style: "normal" };

	return { family, weight: variant.weight, style: variant.style };
}

/**
 * Scan a fonts directory and return grouped font families.
 */
export function scanFonts(fontsDir: string): FontFamily[] {
	if (!existsSync(fontsDir)) return [];

	let entries: string[];
	try {
		entries = readdirSync(fontsDir);
	} catch {
		return [];
	}

	const familyMap = new Map<string, FontFile[]>();

	for (const entry of entries) {
		const parsed = parseFontFile(fontsDir, entry);
		if (!parsed) continue;

		const files = familyMap.get(parsed.family) ?? [];
		files.push({
			style: parsed.style,
			weight: parsed.weight,
			url: buildSignedPublicAssetUrl("fonts", entry),
		});
		familyMap.set(parsed.family, files);
	}

	// Sort families alphabetically, files by weight then style
	const result: FontFamily[] = [];
	for (const [family, files] of [...familyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		files.sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style));
		result.push({ family, files });
	}

	return result;
}

/**
 * Register the font routes.
 */
export function registerFontRoutes(server: FastifyInstance, configDir: string): void {
	const fontsDir = join(configDir, "fonts");

	server.get("/api/fonts", async () => {
		return scanFonts(fontsDir);
	});

	// POST /api/fonts — upload a font file
	server.post("/api/fonts", async (request: FastifyRequest, reply: FastifyReply) => {
		const file = await request.file();
		if (!file) {
			return reply.code(400).send({ error: { code: "NO_FILE", message: "No file uploaded" } });
		}

		const sanitized = sanitizeFilename(file.filename);
		if (!sanitized) {
			return reply
				.code(400)
				.send({ error: { code: "INVALID_FILENAME", message: "Invalid filename" } });
		}

		if (!FONT_EXTENSIONS.has(extname(sanitized).toLowerCase())) {
			return reply
				.code(400)
				.send({ error: { code: "UNSUPPORTED_TYPE", message: "Unsupported file type" } });
		}

		const buffer = await file.toBuffer();

		// Defense-in-depth size check (plugin limit fires first for large uploads)
		if (buffer.length > MAX_FONT_SIZE) {
			return reply.code(413).send({
				error: { code: "FILE_TOO_LARGE", message: "Font file exceeds 10 MB limit" },
			});
		}

		// Magic-byte MIME validation
		const detectedType = await fileTypeFromBuffer(buffer);

		// TTF/OTF fallback: file-type may not detect these; check OpenType magic bytes directly
		// TrueType: 0x00010000, CFF/OTF: 0x4F54544F ("OTTO")
		const isTtfMagic =
			buffer.length >= 4 &&
			((buffer[0] === 0x00 && buffer[1] === 0x01 && buffer[2] === 0x00 && buffer[3] === 0x00) ||
				(buffer[0] === 0x4f && buffer[1] === 0x54 && buffer[2] === 0x54 && buffer[3] === 0x4f));

		if (!isTtfMagic && (!detectedType || !ALLOWED_FONT_MIMES.has(detectedType.mime))) {
			return reply.code(400).send({
				error: {
					code: "INVALID_FILE_TYPE",
					message: `File content does not match an allowed font type (detected: ${detectedType?.mime ?? "unknown"})`,
				},
			});
		}

		const target = join(fontsDir, sanitized);

		// Directory containment check
		if (!resolve(target).startsWith(resolve(fontsDir))) {
			return reply.code(400).send({ error: { code: "INVALID_PATH", message: "Invalid filename" } });
		}

		// Duplicate check — fonts are deduplicated by filename
		if (existsSync(target)) {
			return reply.code(409).send({
				error: { code: "DUPLICATE", message: "A font with this filename already exists" },
			});
		}

		await writeFile(target, buffer);
		return scanFonts(fontsDir);
	});

	// DELETE /api/fonts/:family — delete all files belonging to a font family
	server.delete(
		"/api/fonts/:family",
		async (request: FastifyRequest<{ Params: { family: string } }>, reply: FastifyReply) => {
			const { family } = request.params;

			const families = scanFonts(fontsDir);
			const match = families.find((f) => f.family === family);

			if (!match) {
				return reply.code(404).send({
					error: { code: "FONT_FAMILY_NOT_FOUND", message: `Font family "${family}" not found` },
				});
			}

			for (const fontFile of match.files) {
				const pathname = new URL(fontFile.url, "http://localhost").pathname;
				const filename = decodeURIComponent(pathname.replace(/^\/public\/fonts\//, ""));
				const target = join(fontsDir, filename);

				// Containment check — never escape fontsDir
				if (!resolve(target).startsWith(resolve(fontsDir))) continue;

				try {
					await unlink(target);
				} catch (err: unknown) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
			}

			return reply.code(204).send();
		},
	);
}
