/**
 * pe-imports.spec.ts
 *
 * The import table reader build.yml runs on every Windows binary it produces,
 * which refuses one that needs the Visual C++ runtime (#924). PE files are built
 * here byte by byte, so the cases run on any platform; one more reads the Node
 * executable running the suite, on Windows.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main, peImports, VC_RUNTIME_DLL, vcRuntimeImports } from "./pe-imports.ts";

const SCRIPT = fileURLToPath(new URL("./pe-imports.ts", import.meta.url));

// The layout `pe` writes: the PE header at 0x40, one section mapped at RVA
// 0x1000 from file offset 0x200, holding the import descriptors, then the
// delay-load ones, then the DLL names.
const PE_HEADER = 0x40;
const OPTIONAL_HEADER = PE_HEADER + 24;
const SECTION_RVA = 0x1000;
const SECTION_FILE = 0x200;

interface Layout {
	/** PE32+, a 64-bit image, unless false. */
	plus?: boolean;
	imports?: string[];
	delayed?: string[];
	/** Each delay-load descriptor's attributes: 1, it holds RVAs, as linkers write. */
	delayAttributes?: number;
}

/** A PE file importing `imports` and delay-loading `delayed`, in that order. */
function pe({ plus = true, imports = [], delayed = [], delayAttributes = 1 }: Layout = {}) {
	const delayTable = (imports.length + 1) * 20;
	let free = delayTable + (delayed.length + 1) * 32;
	const length = [...imports, ...delayed].reduce((total, name) => total + name.length + 1, free);
	const section = new Uint8Array(length);
	const s = new DataView(section.buffer);
	/** Writes `text` and its NUL at the next free byte, and returns its RVA. */
	const name = (text: string) => {
		const at = free;
		section.set(Buffer.from(`${text}\0`, "latin1"), at);
		free += text.length + 1;
		return SECTION_RVA + at;
	};
	for (const [i, dll] of imports.entries()) s.setUint32(i * 20 + 12, name(dll), true);
	for (const [i, dll] of delayed.entries()) {
		s.setUint32(delayTable + i * 32, delayAttributes, true);
		s.setUint32(delayTable + i * 32 + 4, name(dll), true);
	}

	const image = new Uint8Array(SECTION_FILE + section.length);
	const v = new DataView(image.buffer);
	const directories = OPTIONAL_HEADER + (plus ? 112 : 96);
	const sectionHeader = directories + 16 * 8;
	v.setUint16(0, 0x5a4d, true); // MZ
	v.setUint32(0x3c, PE_HEADER, true);
	v.setUint32(PE_HEADER, 0x4550, true); // PE\0\0
	v.setUint16(PE_HEADER + 4, plus ? 0x8664 : 0x14c, true);
	v.setUint16(PE_HEADER + 6, 1, true);
	v.setUint16(PE_HEADER + 20, sectionHeader - OPTIONAL_HEADER, true);
	v.setUint16(OPTIONAL_HEADER, plus ? 0x20b : 0x10b, true);
	v.setUint32(directories - 4, 16, true);
	if (imports.length > 0) v.setUint32(directories + 1 * 8, SECTION_RVA, true);
	if (delayed.length > 0) v.setUint32(directories + 13 * 8, SECTION_RVA + delayTable, true);
	v.setUint32(sectionHeader + 8, section.length, true);
	v.setUint32(sectionHeader + 12, SECTION_RVA, true);
	v.setUint32(sectionHeader + 16, section.length, true);
	v.setUint32(sectionHeader + 20, SECTION_FILE, true);
	image.set(section, SECTION_FILE);
	return image;
}

describe("peImports", () => {
	// Mutation caught: a name read at another offset of the descriptor, or a
	// list that stops after the first entry.
	it("lists a 64-bit image's imports in the order of its import directory", () => {
		const image = pe({
			imports: ["KERNEL32.dll", "VCRUNTIME140.dll", "api-ms-win-crt-heap-l1-1-0.dll"],
		});

		expect(peImports(image)).toEqual({
			imports: ["KERNEL32.dll", "VCRUNTIME140.dll", "api-ms-win-crt-heap-l1-1-0.dll"],
			delayed: [],
		});
	});

	// Mutation caught: the data directories taken at PE32+'s offset for every
	// image, which reads a 32-bit one's 16 bytes too far.
	it("reads a 32-bit image, whose data directories come 16 bytes earlier", () => {
		expect(peImports(pe({ plus: false, imports: ["KERNEL32.dll", "MSVCP140.dll"] }))).toEqual({
			imports: ["KERNEL32.dll", "MSVCP140.dll"],
			delayed: [],
		});
	});

	// Mutation caught: the delay-load directory left unread, which lets a
	// delay-loaded runtime through.
	it("lists the delay-loaded DLLs apart", () => {
		const image = pe({ imports: ["KERNEL32.dll"], delayed: ["node.exe", "VCRUNTIME140_1.dll"] });

		expect(peImports(image)).toEqual({
			imports: ["KERNEL32.dll"],
			delayed: ["node.exe", "VCRUNTIME140_1.dll"],
		});
	});

	it("finds nothing in an image without import directories", () => {
		expect(peImports(pe())).toEqual({ imports: [], delayed: [] });
	});

	// Each refusal below is a binary the check would otherwise pass unread.
	it("refuses a file that is not a PE image", () => {
		expect(() => peImports(Buffer.from("\x7fELF and the rest of a Linux binary"))).toThrow(
			"not a PE file: no MZ header",
		);
		const noSignature = pe({ imports: ["KERNEL32.dll"] });
		noSignature[PE_HEADER] = 0;
		expect(() => peImports(noSignature)).toThrow("not a PE file: no PE signature");
		const unknownMagic = pe({ imports: ["KERNEL32.dll"] });
		unknownMagic[OPTIONAL_HEADER] = 0;
		expect(() => peImports(unknownMagic)).toThrow("optional header magic 0x200");
	});

	it("refuses an import directory outside every section", () => {
		const image = pe({ imports: ["KERNEL32.dll"] });
		new DataView(image.buffer).setUint32(OPTIONAL_HEADER + 112 + 8, 0x9000, true);

		expect(() => peImports(image)).toThrow("the import directory at RVA 0x9000 is in no section");
	});

	it("refuses a file cut short", () => {
		const image = pe({ imports: ["KERNEL32.dll", "VCRUNTIME140.dll"] });

		expect(() => peImports(image.subarray(0, OPTIONAL_HEADER + 50))).toThrow(
			`truncated: it ends before offset 0x${(OPTIONAL_HEADER + 112).toString(16)}`,
		);
		expect(() => peImports(image.subarray(0, SECTION_FILE + 20))).toThrow(
			/^truncated: an imported DLL's name at RVA 0x[0-9a-f]+ lies past its end$/,
		);
		expect(() => peImports(image.subarray(0, image.length - 1))).toThrow(
			/an imported DLL's name at RVA 0x[0-9a-f]+ has no terminating NUL/,
		);
	});

	it("refuses a delay-load descriptor in the old, address-based format", () => {
		const image = pe({ delayed: ["VCRUNTIME140.dll"], delayAttributes: 0 });

		expect(() => peImports(image)).toThrow("holds virtual addresses");
	});

	// The bytes of a real linker's output, which the images above only imitate.
	it.runIf(process.platform === "win32")("reads the Node executable running this suite", () => {
		const found = peImports(readFileSync(process.execPath));

		expect(found.imports.map((name) => name.toLowerCase())).toContain("kernel32.dll");
		expect([...found.imports, ...found.delayed].every((name) => /\.(dll|exe)$/i.test(name))).toBe(
			true,
		);
	});
});

describe("the Visual C++ runtime DLLs", () => {
	it.each([
		"VCRUNTIME140.dll",
		"VCRUNTIME140_1.dll",
		"vcruntime140_threads.dll",
		"MSVCP140.dll",
		"msvcp140_2.dll",
		"MSVCP140_ATOMIC_WAIT.dll",
		"MSVCR120.dll",
		"CONCRT140.dll",
		"VCOMP140.DLL",
		"vccorlib140.dll",
	])("refuses %s, which the redistributable installs", (name) => {
		expect(name).toMatch(VC_RUNTIME_DLL);
	});

	it.each([
		"msvcrt.dll",
		"msvcp_win.dll",
		"ucrtbase.dll",
		"api-ms-win-crt-runtime-l1-1-0.dll",
		"KERNEL32.dll",
		"node.exe",
	])("passes %s, which Windows ships", (name) => {
		expect(name).not.toMatch(VC_RUNTIME_DLL);
	});

	it("are looked for among the imported and the delay-loaded DLLs alike", () => {
		expect(
			vcRuntimeImports({
				imports: ["KERNEL32.dll", "VCRUNTIME140.dll"],
				delayed: ["node.exe", "MSVCP140.dll"],
			}),
		).toEqual(["VCRUNTIME140.dll", "MSVCP140.dll"]);
	});
});

describe("the command", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	/** Writes each `[name, bytes]` in a new directory, and returns their paths in order. */
	function files<const T extends readonly (readonly [string, Uint8Array])[]>(
		...entries: T
	): { [I in keyof T]: string } {
		const dir = mkdtempSync(join(tmpdir(), "pe-imports-"));
		dirs.push(dir);
		return entries.map(([name, bytes]) => {
			writeFileSync(join(dir, name), bytes);
			return join(dir, name);
		}) as { [I in keyof T]: string };
	}
	function run(paths: string[]) {
		const out: string[] = [];
		const err: string[] = [];
		const status = main(
			paths,
			(line) => out.push(line),
			(line) => err.push(line),
		);
		return { status, out, err };
	}

	it("passes binaries free of the Visual C++ runtime, and prints what each imports", () => {
		const [agent, addon] = files(
			["lasterm-agent.exe", pe({ imports: ["KERNEL32.dll", "ntdll.dll"] })],
			["addon.node", pe({ imports: ["KERNEL32.dll"], delayed: ["node.exe"] })],
		);

		expect(run([agent, addon])).toEqual({
			status: 0,
			out: [
				`${agent}: imports KERNEL32.dll, ntdll.dll`,
				`${addon}: imports KERNEL32.dll; delay-loads node.exe`,
			],
			err: [],
		});
	});

	// Mutation caught: a check that stops at the first refused file, or that
	// returns 0 when a file it could not read was named.
	it("fails on each binary that imports it, and on each it cannot read, and checks the rest", () => {
		const [addon, notPe, clean] = files(
			["addon.node", pe({ imports: ["KERNEL32.dll", "VCRUNTIME140.dll"] })],
			["not-pe.exe", Buffer.from("no image here")],
			["clean.exe", pe({ imports: ["KERNEL32.dll"] })],
		);
		const missing = join(tmpdir(), "pe-imports-missing", "gone.exe");

		const { status, out, err } = run([addon, notPe, missing, clean]);

		expect(status).toBe(1);
		expect(out).toEqual([
			`${addon}: imports KERNEL32.dll, VCRUNTIME140.dll`,
			`${clean}: imports KERNEL32.dll`,
		]);
		expect(err).toHaveLength(3);
		expect(err[0]).toMatch(
			`::error::${addon} imports VCRUNTIME140.dll, from the Visual C++ Redistributable`,
		);
		expect(err[1]).toBe(`::error::${notPe}: not a PE file: no MZ header`);
		expect(err[2]).toMatch(`::error::${missing}: ENOENT`);
	});

	it("fails when no file is named, rather than pass having checked nothing", () => {
		expect(run([])).toEqual({
			status: 1,
			out: [],
			err: ["::error::pe-imports: usage: node scripts/pe-imports.ts <file>..."],
		});
	});

	// build.yml runs it as plain `node scripts/pe-imports.ts`, with no
	// dependency installed: type stripping must take the file as it is.
	it("runs under Node's own type stripping and exits 1 on a refused binary", () => {
		const [refused, clean] = files(
			["refused.node", pe({ imports: ["MSVCP140.dll"] })],
			["clean.node", pe({ imports: ["KERNEL32.dll"] })],
		);

		const failing = spawnSync(process.execPath, [SCRIPT, refused, clean], { encoding: "utf8" });
		expect(failing.status, failing.stderr).toBe(1);
		expect(failing.stderr).toContain(`::error::${refused} imports MSVCP140.dll`);

		const passing = spawnSync(process.execPath, [SCRIPT, clean], { encoding: "utf8" });
		expect(passing.status, passing.stderr).toBe(0);
		expect(passing.stdout).toBe(`${clean}: imports KERNEL32.dll\n`);
	});
});
