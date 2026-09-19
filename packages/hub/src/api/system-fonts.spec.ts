import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ReadAt,
	readFontFaceInfo,
	registerSystemFontRoutes,
	SystemFontCatalog,
	scanSystemFonts,
	systemFontDirectories,
} from "./system-fonts.js";

// ─── Synthetic fonts: just the tables the reader looks at ───────────────────

interface NameRecord {
	readonly id: number;
	readonly value: string;
	readonly platform?: 1 | 3;
	readonly language?: number;
}

function nameTable(records: readonly NameRecord[]): Buffer {
	const strings: Buffer[] = [];
	const directory = Buffer.alloc(12 * records.length);
	let offset = 0;
	records.forEach((record, i) => {
		const platform = record.platform ?? 3;
		const bytes =
			platform === 3
				? Buffer.from(record.value, "utf16le").swap16()
				: Buffer.from(record.value, "latin1");
		const at = 12 * i;
		directory.writeUInt16BE(platform, at);
		directory.writeUInt16BE(platform === 3 ? 1 : 0, at + 2);
		directory.writeUInt16BE(record.language ?? (platform === 3 ? 0x409 : 0), at + 4);
		directory.writeUInt16BE(record.id, at + 6);
		directory.writeUInt16BE(bytes.length, at + 8);
		directory.writeUInt16BE(offset, at + 10);
		strings.push(bytes);
		offset += bytes.length;
	});
	const header = Buffer.alloc(6);
	header.writeUInt16BE(records.length, 2);
	header.writeUInt16BE(6 + directory.length, 4);
	return Buffer.concat([header, directory, ...strings]);
}

function os2Table(weight: number, italic: boolean): Buffer {
	const table = Buffer.alloc(78);
	table.writeUInt16BE(weight, 4);
	table.writeUInt16BE(italic ? 0x0001 : 0x0040, 62);
	return table;
}

function postTable(fixedPitch: boolean): Buffer {
	const table = Buffer.alloc(32);
	table.writeUInt32BE(0x00030000, 0);
	table.writeUInt32BE(fixedPitch ? 1 : 0, 12);
	return table;
}

function sfnt(tables: Record<string, Buffer>, version = 0x00010000): Buffer {
	const tags = Object.keys(tables).sort();
	const header = Buffer.alloc(12 + 16 * tags.length);
	header.writeUInt32BE(version, 0);
	header.writeUInt16BE(tags.length, 4);
	const bodies: Buffer[] = [];
	let offset = header.length;
	tags.forEach((tag, i) => {
		const body = tables[tag] as Buffer;
		const at = 12 + 16 * i;
		header.write(tag.padEnd(4, " "), at, "latin1");
		header.writeUInt32BE(offset, at + 8);
		header.writeUInt32BE(body.length, at + 12);
		const padded = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
		bodies.push(padded);
		offset += padded.length;
	});
	return Buffer.concat([header, ...bodies]);
}

function font(options: {
	family: string;
	subfamily?: string;
	typographicFamily?: string;
	weight?: number;
	italic?: boolean;
	monospace?: boolean;
}): Buffer {
	const records: NameRecord[] = [
		{ id: 1, value: options.family },
		{ id: 2, value: options.subfamily ?? "Regular" },
		{ id: 4, value: `${options.family} ${options.subfamily ?? "Regular"}` },
		{ id: 6, value: `${options.family.replace(/\s/g, "")}-${options.subfamily ?? "Regular"}` },
	];
	if (options.typographicFamily) records.push({ id: 16, value: options.typographicFamily });
	return sfnt({
		name: nameTable(records),
		"OS/2": os2Table(options.weight ?? 400, options.italic ?? false),
		post: postTable(options.monospace ?? false),
	});
}

function reader(bytes: Buffer): ReadAt {
	return async (offset, length) => bytes.subarray(offset, offset + length);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("readFontFaceInfo (#100)", () => {
	it("reads family, names, weight, style and pitch from the font's own tables", async () => {
		const info = await readFontFaceInfo(
			reader(
				font({
					family: "Cascadia Code SemiBold",
					subfamily: "Italic",
					typographicFamily: "Cascadia Code",
					weight: 600,
					italic: true,
					monospace: true,
				}),
			),
		);
		expect(info).toEqual({
			family: "Cascadia Code",
			fullName: "Cascadia Code SemiBold Italic",
			postscriptName: "CascadiaCodeSemiBold-Italic",
			weight: 600,
			style: "italic",
			monospace: true,
		});
	});

	it("prefers the US English Windows name over another language and over the Mac one", async () => {
		const bytes = sfnt({
			name: nameTable([
				{ id: 1, value: "Mac Name", platform: 1 },
				{ id: 1, value: "Nom Français", language: 0x40c },
				{ id: 1, value: "English Name" },
			]),
		});
		expect((await readFontFaceInfo(reader(bytes)))?.family).toBe("English Name");
	});

	it("falls back to the subfamily when the font has no OS/2 table", async () => {
		const bytes = sfnt({
			name: nameTable([
				{ id: 1, value: "Plain" },
				{ id: 2, value: "Bold Oblique" },
			]),
		});
		expect(await readFontFaceInfo(reader(bytes))).toMatchObject({
			family: "Plain",
			weight: 700,
			style: "italic",
			monospace: false,
		});
	});

	it("refuses collections, WOFF and anything without a family name", async () => {
		const collection = Buffer.concat([Buffer.from("ttcf", "latin1"), Buffer.alloc(64)]);
		const woff = Buffer.concat([Buffer.from("wOFF", "latin1"), Buffer.alloc(64)]);
		const nameless = sfnt({ post: postTable(true) });
		for (const bytes of [collection, woff, nameless, Buffer.alloc(4)]) {
			expect(await readFontFaceInfo(reader(bytes))).toBeNull();
		}
	});
});

describe("scanSystemFonts (#100)", () => {
	let root: string | undefined;

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function fixture(): string {
		root = mkdtempSync(join(tmpdir(), "lasterm-system-fonts-"));
		mkdirSync(join(root, "machine", "truetype", "mono"), { recursive: true });
		mkdirSync(join(root, "user"), { recursive: true });
		writeFileSync(
			join(root, "machine", "truetype", "mono", "Mono-Regular.ttf"),
			font({ family: "Test Mono", monospace: true }),
		);
		writeFileSync(
			join(root, "machine", "Mono-Bold.otf"),
			sfnt(
				{
					name: nameTable([
						{ id: 1, value: "Test Mono" },
						{ id: 2, value: "Bold" },
					]),
					"OS/2": os2Table(700, false),
					post: postTable(true),
				},
				0x4f54544f,
			),
		);
		writeFileSync(join(root, "machine", "Sans.ttf"), font({ family: "Test Sans" }));
		// The same face in the per-user directory is not listed twice.
		writeFileSync(join(root, "user", "Sans.ttf"), font({ family: "Test Sans" }));
		writeFileSync(join(root, "machine", "Collection.ttc"), font({ family: "Collected" }));
		writeFileSync(join(root, "machine", "notes.txt"), "not a font");
		writeFileSync(join(root, "machine", "Broken.ttf"), "not a font either");
		return root;
	}

	it("groups the fonts it can serve by family and marks the monospace ones", async () => {
		const directory = fixture();
		const scan = await scanSystemFonts([
			join(directory, "machine"),
			join(directory, "user"),
			join(directory, "missing"),
		]);

		expect(
			scan.families.map(({ family, monospace, files }) => ({
				family,
				monospace,
				faces: files.map((file) => `${file.weight} ${file.style}`),
			})),
		).toEqual([
			{ family: "Test Mono", monospace: true, faces: ["400 normal", "700 normal"] },
			{ family: "Test Sans", monospace: false, faces: ["400 normal"] },
		]);
		expect(scan.files.size).toBe(3);
		const regular = scan.families[0]?.files[0];
		expect(regular?.url).toMatch(/^\/public\/system-fonts\/[0-9a-f]{32}\.ttf\?asset_token=/);
		expect(regular?.localNames).toEqual(["Test Mono Regular", "TestMono-Regular"]);
	});

	it("serves a listed file by its id and nothing else", async () => {
		const directory = fixture();
		const catalog = new SystemFontCatalog(() => [join(directory, "machine")]);
		const server = Fastify();
		registerSystemFontRoutes(server, catalog);
		try {
			const listed = await server.inject({ method: "GET", url: "/api/fonts/system" });
			expect(listed.statusCode).toBe(200);
			const url = listed.json()[0].files[0].url as string;
			const name = new URL(url, "http://hub").pathname.split("/").pop() as string;

			const served = await server.inject({ method: "GET", url: `/public/system-fonts/${name}` });
			expect(served.statusCode).toBe(200);
			expect(served.headers["content-type"]).toBe("font/ttf");
			expect(served.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0, 1, 0, 0]));

			const wrongType = name.replace(/\.ttf$/, ".otf");
			for (const other of [wrongType, `${"0".repeat(32)}.ttf`, "..%2F..%2Fetc%2Fpasswd", "x.ttf"]) {
				const refused = await server.inject({
					method: "GET",
					url: `/public/system-fonts/${other}`,
				});
				expect(refused.statusCode, other).toBe(404);
			}
		} finally {
			await server.close();
		}
	});

	it("scans once for concurrent requests and again after a few minutes", async () => {
		const directory = fixture();
		let scans = 0;
		let now = 0;
		const catalog = new SystemFontCatalog(
			() => {
				scans++;
				return [join(directory, "machine")];
			},
			() => now,
		);
		await Promise.all([catalog.families(), catalog.families()]);
		expect(scans).toBe(1);
		now = 6 * 60_000;
		await catalog.families();
		expect(scans).toBe(2);
	});
});

describe("systemFontDirectories (#100)", () => {
	it("lists the machine-wide and per-user font directories of each platform", () => {
		expect(
			systemFontDirectories(
				"win32",
				{ WINDIR: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
				"C:\\Users\\u",
			),
		).toEqual(["C:\\Windows\\Fonts", "C:\\Users\\u\\AppData\\Local\\Microsoft\\Windows\\Fonts"]);
		expect(systemFontDirectories("linux", {}, "/home/u")).toEqual([
			"/usr/share/fonts",
			"/usr/local/share/fonts",
			"/home/u/.local/share/fonts",
			"/home/u/.fonts",
		]);
		expect(systemFontDirectories("linux", { XDG_DATA_HOME: "/data" }, "/home/u")).toContain(
			"/data/fonts",
		);
	});
});
