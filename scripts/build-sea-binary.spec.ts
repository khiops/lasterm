import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const _ROOT = resolve(__dirname, "..");

// ────────────────────────────────────────────────────────────────────────────
// Test 1: generates valid sea-config.json
// ────────────────────────────────────────────────────────────────────────────

describe("buildSeaConfigJson generates valid sea-config.json structure", () => {
	it("includes main, output, assets, disableExperimentalSEAWarning, useCodeCache", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/abs/path/agent.cjs",
			outputBinary: "/abs/path/lasterm-agent",
			name: "lasterm-agent",
			nativeAddons: { "pty.node": "/abs/path/pty.node" },
			extraAssets: { VERSION: "/abs/path/VERSION" },
			useCodeCache: true,
			disableExperimentalSEAWarning: true,
		};

		const result = buildSeaConfigJson(cfg, "/abs/path/sea-prep.blob");

		expect(result).toMatchObject({
			main: "/abs/path/agent.cjs",
			output: "/abs/path/sea-prep.blob",
			disableExperimentalSEAWarning: true,
			useCodeCache: true,
		});

		// Assets must include both nativeAddons and extraAssets
		expect(result.assets).toMatchObject({
			"pty.node": "/abs/path/pty.node",
			VERSION: "/abs/path/VERSION",
		});
	});

	it("defaults disableExperimentalSEAWarning and useCodeCache to true", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/a/entry.cjs",
			outputBinary: "/a/out",
			name: "test",
			nativeAddons: {},
		};

		const result = buildSeaConfigJson(cfg, "/a/blob");
		expect(result.disableExperimentalSEAWarning).toBe(true);
		expect(result.useCodeCache).toBe(true);
	});

	it("allows overriding defaults to false", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/a/entry.cjs",
			outputBinary: "/a/out",
			name: "test",
			nativeAddons: {},
			useCodeCache: false,
			disableExperimentalSEAWarning: false,
		};

		const result = buildSeaConfigJson(cfg, "/a/blob");
		expect(result.useCodeCache).toBe(false);
		expect(result.disableExperimentalSEAWarning).toBe(false);
	});

	it("handles empty nativeAddons and no extraAssets", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/a/entry.cjs",
			outputBinary: "/a/out",
			name: "test",
			nativeAddons: {},
		};

		const result = buildSeaConfigJson(cfg, "/a/blob");
		expect(result.assets).toEqual({});
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Child processes run without a shell
// ────────────────────────────────────────────────────────────────────────────

describe("run", () => {
	it("passes an argument containing a space as one argument", async () => {
		const { run } = await import("./build-sea-binary.js");
		// A checkout under a profile such as C:\Users\Jane Doe. With the shell
		// Windows used to get, cmd.exe split this path in two.
		const argument = join(tmpdir(), "Jane Doe", "lasterm checkout", "sea-prep.blob");
		const check = `process.exit(process.argv.length === 2 && process.argv[1] === ${JSON.stringify(argument)} ? 0 : 3)`;

		expect(() => run(process.execPath, ["-e", check, argument], "argument check")).not.toThrow();
	});

	it("reports a child's failure with its exit code", async () => {
		const { run } = await import("./build-sea-binary.js");
		expect(() => run(process.execPath, ["-e", "process.exit(3)"], "failing child")).toThrow(
			/failing child exited with code 3/,
		);
	});
});

describe("postjectCommand", () => {
	it("runs the pinned postject CLI with this Node, not through npx", async () => {
		const { postjectCommand, run } = await import("./build-sea-binary.js");
		const { cmd, args } = postjectCommand(["--help"]);

		expect(cmd).toBe(resolve(process.execPath));
		expect(args[0]?.replaceAll("\\", "/")).toMatch(/\/postject\/dist\/cli\.js$/);
		expect(args.slice(1)).toEqual(["--help"]);
		// It starts without a shell on every platform, Windows included.
		expect(() => run(cmd, args, "postject help")).not.toThrow();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// The Authenticode certificate table of node.exe (#718)
// ────────────────────────────────────────────────────────────────────────────

// A minimal PE file. The DOS header points at the PE header at 0x80; the COFF
// header follows, then at 0x98 the optional header and its 16 data
// directories; filler up to 0x400 stands for the sections. The offsets below
// are worked out from the PE format, not from the code under test.
const OPTIONAL_HEADER = 0x98;
const CHECKSUM = OPTIONAL_HEADER + 64; // 0xd8 in both formats
const LAYOUT = {
	// Data directories at +96 in PE32, +112 in PE32+; entry 4 is 32 bytes in.
	PE32: {
		magic: 0x10b,
		machine: 0x14c,
		optionalHeaderSize: 224,
		count: OPTIONAL_HEADER + 92,
		entry: 0x118,
	},
	"PE32+": {
		magic: 0x20b,
		machine: 0x8664,
		optionalHeaderSize: 240,
		count: OPTIONAL_HEADER + 108,
		entry: 0x128,
	},
} as const;
type PeKind = keyof typeof LAYOUT;
const SECTIONS_END = 0x400;

function syntheticPe(
	kind: PeKind,
	options: { certificate?: number; trailing?: number; directoryCount?: number } = {},
): Buffer {
	const layout = LAYOUT[kind];
	const image = Buffer.alloc(SECTIONS_END, 0xab);
	image.fill(0, 0, OPTIONAL_HEADER + layout.optionalHeaderSize);
	image.writeUInt16LE(0x5a4d, 0); // MZ
	image.writeUInt32LE(0x80, 0x3c); // e_lfanew
	image.writeUInt32LE(0x00004550, 0x80); // PE\0\0
	image.writeUInt16LE(layout.machine, 0x84);
	image.writeUInt16LE(layout.optionalHeaderSize, 0x80 + 20);
	image.writeUInt16LE(layout.magic, OPTIONAL_HEADER);
	image.writeUInt32LE(0x0badc0de, CHECKSUM);
	image.writeUInt32LE(options.directoryCount ?? 16, layout.count);
	if (options.certificate === undefined) return image;

	image.writeUInt32LE(SECTIONS_END, layout.entry);
	image.writeUInt32LE(options.certificate, layout.entry + 4);
	return Buffer.concat([
		image,
		Buffer.alloc(options.certificate, 0xcc),
		// What postject appended after the table in the hub of v0.14.2.
		Buffer.alloc(options.trailing ?? 0, 0xee),
	]);
}

describe("readCertificateDirectory", () => {
	it.each(Object.keys(LAYOUT) as PeKind[])("reads data directory 4 of a %s file", async (kind) => {
		const { readCertificateDirectory } = await import("./build-sea-binary.js");

		expect(readCertificateDirectory(syntheticPe(kind, { certificate: 0x48 }))).toEqual({
			checksumOffset: CHECKSUM,
			entryOffset: LAYOUT[kind].entry,
			tableOffset: SECTIONS_END,
			tableSize: 0x48,
		});
		expect(readCertificateDirectory(syntheticPe(kind))).toMatchObject({
			tableOffset: 0,
			tableSize: 0,
		});
	});

	it("reports no entry when the header has fewer than five data directories", async () => {
		const { readCertificateDirectory } = await import("./build-sea-binary.js");

		expect(readCertificateDirectory(syntheticPe("PE32+", { directoryCount: 4 }))).toEqual({
			checksumOffset: CHECKSUM,
			entryOffset: null,
			tableOffset: 0,
			tableSize: 0,
		});
	});

	it("refuses a file that is not PE", async () => {
		const { readCertificateDirectory } = await import("./build-sea-binary.js");
		const elf = Buffer.alloc(SECTIONS_END);
		elf.write("\x7fELF", 0, "latin1");

		expect(() => readCertificateDirectory(elf)).toThrow(/not a PE file: no MZ signature/);
		expect(() => readCertificateDirectory(syntheticPe("PE32+").subarray(0, 0x100))).toThrow(
			/not a PE file: the optional header ends past its 256 bytes/,
		);
	});
});

describe("stripAuthenticodeSignature and assertNoCertificateTable", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lasterm-pe-"));
		file = join(dir, "node.exe");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each(Object.keys(LAYOUT) as PeKind[])(
		"strips a %s certificate table that ends the file",
		async (kind) => {
			const { assertNoCertificateTable, readCertificateDirectory, stripAuthenticodeSignature } =
				await import("./build-sea-binary.js");
			const signed = syntheticPe(kind, { certificate: 0x48 });
			writeFileSync(file, signed);
			expect(() => assertNoCertificateTable(file)).toThrow(
				/still has a certificate table \(offset 1024, 72 bytes\)/,
			);

			expect(stripAuthenticodeSignature(file)).toBe(0x48);

			const stripped = readFileSync(file);
			const expected = Buffer.from(signed.subarray(0, SECTIONS_END));
			expected.fill(0, LAYOUT[kind].entry, LAYOUT[kind].entry + 8);
			expected.fill(0, CHECKSUM, CHECKSUM + 4);
			expect(stripped.equals(expected)).toBe(true);
			expect(readCertificateDirectory(stripped)).toMatchObject({ tableOffset: 0, tableSize: 0 });
			expect(() => assertNoCertificateTable(file)).not.toThrow();
		},
	);

	it.each([
		["a PE file with an empty certificate directory", syntheticPe("PE32+")],
		["a PE file with no certificate directory", syntheticPe("PE32+", { directoryCount: 4 })],
	])("leaves %s untouched", async (_name, unsigned) => {
		const { assertNoCertificateTable, stripAuthenticodeSignature } = await import(
			"./build-sea-binary.js"
		);
		writeFileSync(file, unsigned);

		expect(stripAuthenticodeSignature(file)).toBe(0);

		expect(readFileSync(file).equals(unsigned)).toBe(true);
		expect(() => assertNoCertificateTable(file)).not.toThrow();
	});

	it("refuses a certificate table that does not end the file, and changes nothing", async () => {
		const { assertNoCertificateTable, stripAuthenticodeSignature } = await import(
			"./build-sea-binary.js"
		);
		// The hub of v0.14.2: node.exe's table, then the resources postject grew.
		const grown = syntheticPe("PE32+", { certificate: 0x48, trailing: 0x200 });
		writeFileSync(file, grown);

		expect(() => stripAuthenticodeSignature(file)).toThrow(
			/certificate table \(offset 1024, 72 bytes\) does not end at the end of the file \(1608 bytes\)/,
		);
		expect(readFileSync(file).equals(grown)).toBe(true);
		expect(() => assertNoCertificateTable(file)).toThrow(/the Microsoft Store could not sign it/);
	});

	it.runIf(process.platform === "win32")(
		"finds the Node running this build signed only at the end of its file, where it can be stripped",
		async () => {
			const { readCertificateDirectory } = await import("./build-sea-binary.js");
			const headers = Buffer.alloc(64 * 1024);
			const fd = openSync(process.execPath, "r");
			try {
				readSync(fd, headers, 0, headers.length, 0);
			} finally {
				closeSync(fd);
			}
			const { tableOffset, tableSize } = readCertificateDirectory(headers);

			// An official Node build is signed; a Node built from source is not.
			if (tableSize > 0) {
				expect(tableOffset + tableSize).toBe(statSync(process.execPath).size);
			}
		},
	);
});
