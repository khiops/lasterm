/**
 * pe-imports.ts
 *
 * Reads the DLLs a Windows executable or DLL imports (a `.node` addon is a DLL),
 * and refuses one that needs the Visual C++ runtime (#924).
 *
 * Rust links the C runtime dynamically on Windows unless told otherwise, so its
 * binaries imported VCRUNTIME140.dll. Windows does not ship that DLL: the Visual
 * C++ Redistributable installs it, and nothing installs the redistributable with
 * Lasterm. On a Windows without it, the hub could not load its lock addon and
 * the Store app did not start. .cargo/config.toml now links the runtime
 * statically, and build.yml runs this on every Windows binary it produces, so a
 * build that brings such an import back fails in the job that made it.
 *
 * The Universal CRT (ucrtbase.dll, api-ms-win-crt-*.dll) ships with Windows 10
 * and later, and msvcrt.dll and msvcp_win.dll are Windows' own: those pass.
 *
 * Both the import directory and the delay-load one are read: a delay-loaded DLL
 * that is missing fails at the first call into it instead of at load time.
 *
 * It imports nothing but Node built-ins and runs under Node's own type
 * stripping, so a job needs no dependency installed to run it.
 *
 * Usage:
 *   node scripts/pe-imports.ts <file>...
 *
 * Prints each file's imports, and exits 1 when a file imports a Visual C++
 * runtime DLL or is not a PE file it can read.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The DLLs a PE file names, each list in the order of its directory. */
export interface PeImports {
	/** The import directory's: the loader loads them with the file. */
	imports: string[];
	/** The delay-load import directory's: loaded at the first call into each. */
	delayed: string[];
}

/**
 * The Visual C++ runtime's DLLs, which the redistributable installs and Windows
 * does not: vcruntime (the C runtime; vcruntime140_1.dll holds x64's C++
 * exception handling), msvcp (the C++ standard library), msvcr (the C runtime
 * before Visual C++ 2015), and the concurrency, OpenMP and C++/CX runtimes.
 * Windows' own msvcrt.dll and msvcp_win.dll have no digit after the prefix.
 */
export const VC_RUNTIME_DLL = /^(?:vcruntime|msvcp|msvcr|concrt|vcomp|vccorlib)\d.*\.dll$/i;

const MZ = 0x5a4d;
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const PE32 = 0x10b;
const PE32_PLUS = 0x20b;
const IMPORT_DIRECTORY = 1;
const DELAY_IMPORT_DIRECTORY = 13;
const SECTION_HEADER_SIZE = 40;
const IMPORT_DESCRIPTOR_SIZE = 20;
const DELAY_DESCRIPTOR_SIZE = 32;

const hex = (value: number) => `0x${value.toString(16)}`;

/** The DLLs `image`, the bytes of a PE file, imports and delay-loads. */
export function peImports(image: Uint8Array): PeImports {
	const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
	const read = (offset: number, size: 2 | 4): number => {
		if (offset < 0 || offset + size > image.byteLength) {
			throw new Error(`truncated: it ends before offset ${hex(offset + size)}`);
		}
		return size === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
	};

	if (image.byteLength < 0x40 || read(0, 2) !== MZ) throw new Error("not a PE file: no MZ header");
	const pe = read(0x3c, 4);
	if (read(pe, 4) !== PE_SIGNATURE) throw new Error("not a PE file: no PE signature");
	const sectionCount = read(pe + 6, 2);
	const optionalSize = read(pe + 20, 2);
	const optional = pe + 24;
	const magic = read(optional, 2);
	// The data directories follow the fields whose width differs between the two.
	const [countField, directories] =
		magic === PE32_PLUS
			? [optional + 108, optional + 112]
			: magic === PE32
				? [optional + 92, optional + 96]
				: [-1, -1];
	if (countField < 0) throw new Error(`not a PE file: optional header magic ${hex(magic)}`);
	const directoryCount = read(countField, 4);
	const sections = optional + optionalSize;

	/** The RVA of data directory `index`, 0 when the file has none. */
	const directory = (index: number): number => {
		const entry = directories + index * 8;
		if (index >= directoryCount || entry + 8 > sections) return 0;
		return read(entry, 4);
	};

	/** The file offset of the byte at `rva`, which holds `what`. */
	const offsetOf = (rva: number, what: string): number => {
		for (let i = 0; i < sectionCount; i++) {
			const header = sections + i * SECTION_HEADER_SIZE;
			const virtualSize = read(header + 8, 4);
			const virtualAddress = read(header + 12, 4);
			const rawSize = read(header + 16, 4);
			const rawPointer = read(header + 20, 4);
			if (rva < virtualAddress || rva >= virtualAddress + Math.max(virtualSize, rawSize)) continue;
			if (rva - virtualAddress >= rawSize) {
				throw new Error(`${what} at RVA ${hex(rva)} lies past its section's data in the file`);
			}
			return rawPointer + (rva - virtualAddress);
		}
		throw new Error(`${what} at RVA ${hex(rva)} is in no section`);
	};

	/** The NUL-terminated ASCII name at `rva`. */
	const nameAt = (rva: number, what: string): string => {
		const start = offsetOf(rva, what);
		if (start >= image.byteLength) {
			throw new Error(`truncated: ${what} at RVA ${hex(rva)} lies past its end`);
		}
		const end = image.indexOf(0, start);
		if (end < 0) throw new Error(`${what} at RVA ${hex(rva)} has no terminating NUL`);
		return Buffer.from(image.subarray(start, end)).toString("latin1");
	};

	// Each list ends at a descriptor naming no DLL: the all-zero one the linker
	// writes. A read past the end of the file throws instead of looping.
	const imports: string[] = [];
	const importRva = directory(IMPORT_DIRECTORY);
	if (importRva !== 0) {
		for (
			let entry = offsetOf(importRva, "the import directory");
			;
			entry += IMPORT_DESCRIPTOR_SIZE
		) {
			const name = read(entry + 12, 4);
			if (name === 0) break;
			imports.push(nameAt(name, "an imported DLL's name"));
		}
	}

	const delayed: string[] = [];
	const delayRva = directory(DELAY_IMPORT_DIRECTORY);
	if (delayRva !== 0) {
		for (
			let entry = offsetOf(delayRva, "the delay-load import directory");
			;
			entry += DELAY_DESCRIPTOR_SIZE
		) {
			const attributes = read(entry, 4);
			const name = read(entry + 4, 4);
			if (name === 0) break;
			// Bit 0 says the descriptor holds RVAs. Without it, it holds virtual
			// addresses, Visual C++ 6's format, which no current linker writes:
			// refused rather than misread.
			if ((attributes & 1) === 0) {
				throw new Error(
					"a delay-load descriptor holds virtual addresses, an old format this does not read",
				);
			}
			delayed.push(nameAt(name, "a delay-loaded DLL's name"));
		}
	}

	return { imports, delayed };
}

/** The Visual C++ runtime DLLs among `found`'s, imported or delay-loaded. */
export function vcRuntimeImports(found: PeImports): string[] {
	return [...found.imports, ...found.delayed].filter((name) => VC_RUNTIME_DLL.test(name));
}

/**
 * Checks each of `files`, printing its imports through `log` and each refusal
 * through `error`. Returns the exit status: 0 when every file was read and none
 * imports a Visual C++ runtime DLL, 1 otherwise.
 */
export function main(
	files: readonly string[],
	log: (line: string) => void = console.log,
	error: (line: string) => void = console.error,
): number {
	if (files.length === 0) {
		error("::error::pe-imports: usage: node scripts/pe-imports.ts <file>...");
		return 1;
	}
	let status = 0;
	for (const file of files) {
		let found: PeImports;
		try {
			found = peImports(readFileSync(file));
		} catch (cause) {
			error(`::error::${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
			status = 1;
			continue;
		}
		const delayed = found.delayed.length === 0 ? "" : `; delay-loads ${found.delayed.join(", ")}`;
		log(`${file}: imports ${found.imports.join(", ") || "nothing"}${delayed}`);
		const refused = vcRuntimeImports(found);
		if (refused.length > 0) {
			error(
				`::error::${file} imports ${refused.join(", ")}, from the Visual C++ Redistributable, which a Windows without it lacks: link the C runtime statically (#924)`,
			);
			status = 1;
		}
	}
	return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = main(process.argv.slice(2));
}
