import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SystemFontFamily, SystemFontFile } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildSignedPublicAssetUrl } from "../asset-token.js";

/**
 * Fonts installed on the hub's machine, listed and served without an upload (#100).
 *
 * On a local hub these are the user's own fonts. Served by the hub, they also
 * reach every other client of it. Only files found by the scan can be served:
 * a request names an opaque id, never a path.
 */

/** Formats a browser loads through @font-face. Collections (.ttc) are not among them. */
const SYSTEM_FONT_TYPES = new Map([
	[".ttf", "font/ttf"],
	[".otf", "font/otf"],
]);
const MAX_SCAN_DEPTH = 4;
const MAX_FONT_FILES = 5000;
const MAX_NAME_TABLE_BYTES = 1 << 20;
const SCAN_TTL_MS = 5 * 60_000;
const FILE_NAME = /^([0-9a-f]{32})(\.ttf|\.otf)$/;

export function systemFontDirectories(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string[] {
	if (platform === "win32") {
		const directories: string[] = [];
		const windows = env.WINDIR ?? env.SystemRoot;
		if (windows) directories.push(path.win32.join(windows, "Fonts"));
		if (env.LOCALAPPDATA) {
			directories.push(path.win32.join(env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts"));
		}
		return directories;
	}
	if (platform === "darwin") {
		return ["/System/Library/Fonts", "/Library/Fonts", path.posix.join(home, "Library", "Fonts")];
	}
	const dataHome = env.XDG_DATA_HOME || path.posix.join(home, ".local", "share");
	return [
		"/usr/share/fonts",
		"/usr/local/share/fonts",
		path.posix.join(dataHome, "fonts"),
		path.posix.join(home, ".fonts"),
	];
}

export interface FontFaceInfo {
	readonly family: string;
	readonly fullName: string | null;
	readonly postscriptName: string | null;
	readonly weight: number;
	readonly style: "normal" | "italic";
	readonly monospace: boolean;
}

/** Reads `length` bytes at `offset`; fewer when the file ends first. */
export type ReadAt = (offset: number, length: number) => Promise<Buffer>;

const WANTED_NAMES = new Set([1, 2, 4, 6, 16, 17]);

/**
 * Parse the name table, preferring Windows Unicode US English, then any Windows
 * Unicode language, then Macintosh Roman English.
 */
function readNames(table: Buffer | null): Map<number, string> {
	const names = new Map<number, string>();
	if (!table || table.length < 6) return names;
	const count = table.readUInt16BE(2);
	const storage = table.readUInt16BE(4);
	const ranks = new Map<number, number>();
	for (let i = 0; i < count; i++) {
		const at = 6 + i * 12;
		if (at + 12 > table.length) break;
		const platform = table.readUInt16BE(at);
		const encoding = table.readUInt16BE(at + 2);
		const language = table.readUInt16BE(at + 4);
		const id = table.readUInt16BE(at + 6);
		const length = table.readUInt16BE(at + 8);
		const start = storage + table.readUInt16BE(at + 10);
		if (!WANTED_NAMES.has(id) || start + length > table.length) continue;
		const windows = platform === 3 && (encoding === 1 || encoding === 10) && length % 2 === 0;
		const mac = platform === 1 && encoding === 0 && language === 0;
		const rank = windows ? (language === 0x409 ? 3 : 2) : mac ? 1 : 0;
		if (rank <= (ranks.get(id) ?? 0)) continue;
		const bytes = table.subarray(start, start + length);
		const value = (
			windows ? Buffer.from(bytes).swap16().toString("utf16le") : bytes.toString("latin1")
		).trim();
		if (!value) continue;
		names.set(id, value);
		ranks.set(id, rank);
	}
	return names;
}

function weightFromSubfamily(subfamily: string): number {
	const name = subfamily.toLowerCase().replace(/[\s_-]/g, "");
	if (name.includes("thin")) return 100;
	if (name.includes("extralight") || name.includes("ultralight")) return 200;
	if (name.includes("semibold") || name.includes("demibold")) return 600;
	if (name.includes("extrabold") || name.includes("ultrabold")) return 800;
	if (name.includes("black") || name.includes("heavy")) return 900;
	if (name.includes("bold")) return 700;
	if (name.includes("medium")) return 500;
	if (name.includes("light")) return 300;
	return 400;
}

/** Family, style and pitch of one OpenType or TrueType font, from its own tables. */
export async function readFontFaceInfo(readAt: ReadAt): Promise<FontFaceInfo | null> {
	const header = await readAt(0, 12);
	if (header.length < 12) return null;
	const version = header.readUInt32BE(0);
	// TrueType, CFF ("OTTO") and Apple TrueType ("true"). Collections and WOFF are refused.
	if (version !== 0x00010000 && version !== 0x4f54544f && version !== 0x74727565) return null;
	const numTables = header.readUInt16BE(4);
	if (numTables === 0 || numTables > 512) return null;
	const directory = await readAt(12, numTables * 16);
	if (directory.length < numTables * 16) return null;
	const tables = new Map<string, { offset: number; length: number }>();
	for (let i = 0; i < numTables; i++) {
		const at = i * 16;
		tables.set(directory.toString("latin1", at, at + 4), {
			offset: directory.readUInt32BE(at + 8),
			length: directory.readUInt32BE(at + 12),
		});
	}
	const table = async (tag: string, limit: number): Promise<Buffer | null> => {
		const entry = tables.get(tag);
		if (!entry || entry.length === 0 || entry.length > MAX_NAME_TABLE_BYTES) return null;
		const wanted = Math.min(entry.length, limit);
		const bytes = await readAt(entry.offset, wanted);
		return bytes.length === wanted ? bytes : null;
	};

	const names = readNames(await table("name", MAX_NAME_TABLE_BYTES));
	const family = names.get(16) ?? names.get(1);
	if (!family) return null;
	const subfamily = names.get(17) ?? names.get(2) ?? "";
	const os2 = await table("OS/2", 64);
	const post = await table("post", 16);
	const weightClass = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 0;
	const italic =
		os2 && os2.length >= 64
			? (os2.readUInt16BE(62) & 0x0201) !== 0
			: /italic|oblique/i.test(subfamily);
	return {
		family,
		fullName: names.get(4) ?? null,
		postscriptName: names.get(6) ?? null,
		weight: weightClass >= 1 && weightClass <= 1000 ? weightClass : weightFromSubfamily(subfamily),
		style: italic ? "italic" : "normal",
		monospace: post !== null && post.length >= 16 && post.readUInt32BE(12) !== 0,
	};
}

async function readFontFile(file: string): Promise<FontFaceInfo | null> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, "r");
		const opened = handle;
		return await readFontFaceInfo(async (offset, length) => {
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await opened.read(buffer, 0, length, offset);
			return buffer.subarray(0, bytesRead);
		});
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export interface SystemFontEntry {
	readonly path: string;
	readonly type: string;
}

export interface SystemFontScan {
	readonly families: SystemFontFamily[];
	readonly files: ReadonlyMap<string, SystemFontEntry>;
}

/** Find the fonts under `directories`, grouped by family, monospace or not. */
export async function scanSystemFonts(directories: readonly string[]): Promise<SystemFontScan> {
	const files = new Map<string, SystemFontEntry>();
	const families = new Map<string, { monospace: boolean; files: SystemFontFile[] }>();
	let budget = MAX_FONT_FILES;

	const add = async (file: string, extension: string, type: string): Promise<void> => {
		const info = await readFontFile(file);
		if (!info) return;
		const id = createHash("sha256").update(file).digest("hex").slice(0, 32);
		if (files.has(id)) return;
		const family = families.get(info.family) ?? { monospace: false, files: [] };
		// The same face installed twice, per user and machine-wide: the first one found wins.
		if (family.files.some((face) => face.weight === info.weight && face.style === info.style)) {
			return;
		}
		files.set(id, { path: file, type });
		family.monospace ||= info.monospace;
		family.files.push({
			weight: info.weight,
			style: info.style,
			url: buildSignedPublicAssetUrl("system-fonts", `${id}${extension}`),
			localNames: [
				...new Set([info.fullName, info.postscriptName].filter((name) => name !== null)),
			],
		});
		families.set(info.family, family);
	};

	const visit = async (directory: string, depth: number): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (budget <= 0) return;
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (depth < MAX_SCAN_DEPTH) await visit(file, depth + 1);
				continue;
			}
			const extension = path.extname(entry.name).toLowerCase();
			const type = SYSTEM_FONT_TYPES.get(extension);
			if (!type) continue;
			// A link to a file is followed, a link to a directory is not: no cycles.
			if (!entry.isFile()) {
				if (!entry.isSymbolicLink()) continue;
				try {
					if (!(await stat(file)).isFile()) continue;
				} catch {
					continue;
				}
			}
			budget--;
			await add(file, extension, type);
		}
	};

	for (const directory of directories) await visit(directory, 0);

	return {
		files,
		families: [...families.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([family, { monospace, files: faces }]) => ({
				family,
				monospace,
				files: faces.sort((a, b) => a.weight - b.weight || a.style.localeCompare(b.style)),
			})),
	};
}

/** One scan shared by concurrent requests, redone after a few minutes. */
export class SystemFontCatalog {
	private scan: { readonly at: number; readonly result: Promise<SystemFontScan> } | null = null;

	constructor(
		private readonly directories: () => readonly string[] = () => systemFontDirectories(),
		private readonly now: () => number = Date.now,
	) {}

	private current(): Promise<SystemFontScan> {
		const at = this.now();
		if (!this.scan || at - this.scan.at > SCAN_TTL_MS) {
			this.scan = { at, result: scanSystemFonts(this.directories()) };
		}
		return this.scan.result;
	}

	async families(): Promise<SystemFontFamily[]> {
		return (await this.current()).families;
	}

	/** The file behind a served name (`<id>.ttf`), if the scan found it. */
	async file(name: string): Promise<SystemFontEntry | undefined> {
		const match = FILE_NAME.exec(name);
		if (!match?.[1] || !match[2]) return undefined;
		const entry = (await this.current()).files.get(match[1]);
		return entry && SYSTEM_FONT_TYPES.get(match[2]) === entry.type ? entry : undefined;
	}
}

export function registerSystemFontRoutes(
	server: FastifyInstance,
	catalog: SystemFontCatalog = new SystemFontCatalog(),
): void {
	server.get("/api/fonts/system", async () => catalog.families());

	server.get(
		"/public/system-fonts/:file",
		async (request: FastifyRequest<{ Params: { file: string } }>, reply: FastifyReply) => {
			const entry = await catalog.file(request.params.file);
			if (!entry) {
				return reply
					.code(404)
					.send({ error: { code: "FONT_NOT_FOUND", message: "No such system font" } });
			}
			return reply
				.type(entry.type)
				.header("Cache-Control", "private, max-age=86400")
				.send(createReadStream(entry.path));
		},
	);
}
