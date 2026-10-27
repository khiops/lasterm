/**
 * build-sea-binary.ts
 *
 * Generic Node.js Single Executable Application (SEA) binary builder.
 *
 * Reusable by both agent and hub.
 *
 * Workflow:
 *   1. Write a temp sea-config.json next to the entry script.
 *   2. node --experimental-sea-config <config>  →  sea-prep.blob
 *   3. cp $(which node) <output>
 *   4. Remove Node's own signature: codesign --remove-signature on macOS, the
 *      Authenticode certificate table on Windows.
 *   5. node <postject cli> <output> NODE_SEA_BLOB <blob> --sentinel-fuse ...
 *      On Windows, then check that the output has no certificate table.
 *   6. chmod +x on Linux/macOS
 *   7. Print final binary size.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface SeaBuildConfig {
	/** Path to the bundled .cjs entry point */
	entryScript: string;
	/** Output binary path (e.g. dist/sea/lasterm-agent) */
	outputBinary: string;
	/** Name for the binary (used in logs) */
	name: string;
	/** Native addon assets: { assetName: filePath } */
	nativeAddons: Record<string, string>;
	/** Extra assets to embed (e.g. VERSION file) */
	extraAssets?: Record<string, string>;
	/** Enable V8 code cache for faster startup (default: true) */
	useCodeCache?: boolean;
	/** Disable the experimental SEA warning (default: true) */
	disableExperimentalSEAWarning?: boolean;
}

/** The sentinel fuse string required by postject. */
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/**
 * Run a child process synchronously, without a shell, so every argument
 * reaches the child as one argument whatever it contains. `cmd` must be a real
 * executable: a `.cmd` shim such as `npx` cannot start on Windows this way.
 * Throws a descriptive Error if the process exits with a non-zero code.
 */
export function run(cmd: string, args: string[], label: string): void {
	console.log(`[build-sea] ${label}: ${cmd} ${args.join(" ")}`);
	const result = spawnSync(cmd, args, { stdio: "inherit" });
	if (result.error) {
		throw new Error(`[build-sea] ${label} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`[build-sea] ${label} exited with code ${result.status ?? "null"}`);
	}
}

/**
 * The postject invocation: the repository's own postject CLI (a pinned root
 * devDependency) run by this Node. `npx postject` resolved the same file, but
 * npx is a `.cmd` shim on Windows, which needed `shell: true` there; cmd.exe
 * then joined the arguments unquoted, so a path with a space split in two.
 */
export function postjectCommand(args: string[]): { cmd: string; args: string[] } {
	const cli = createRequire(import.meta.url).resolve("postject/dist/cli.js");
	return { cmd: resolveNodeBinary(), args: [cli, ...args] };
}

/**
 * Find the `node` binary that is currently running this script.
 * Returns the absolute real path.
 */
function resolveNodeBinary(): string {
	// process.execPath is always the absolute path to the running node binary.
	return resolve(process.execPath);
}

// ────────────────────────────────────────────────────────────────────────────
// Authenticode on Windows (#718)
//
// node.exe is signed. Its signature is a certificate table that Authenticode
// requires to be the last thing in the file, and postject grows the resources
// after it. The Microsoft Store signs the executables of a package it ingests,
// and signing fails on one whose certificate table is not at the end of the
// file (0x800700C1, ERROR_BAD_EXE_FORMAT). Node's SEA documentation removes
// the signature before injecting, with `signtool remove /s`; this does the
// same without needing the Windows SDK.
// ────────────────────────────────────────────────────────────────────────────

/** IMAGE_DIRECTORY_ENTRY_SECURITY: the data directory of the certificate table. */
const CERTIFICATE_DIRECTORY = 4;
/** Bytes read from the start of a PE file to reach its data directories. */
const PE_HEADER_BYTES = 64 * 1024;

/**
 * What a PE file's headers say about its certificate table. Unlike every other
 * data directory, this one holds a file offset, not an RVA: the table is not
 * loaded into memory.
 */
export interface PeCertificateDirectory {
	/** File offset of the optional header's CheckSum, which signing sets. */
	checksumOffset: number;
	/** File offset of data directory 4, or null when the header has no such entry. */
	entryOffset: number | null;
	/** File offset of the certificate table; 0 when there is none. */
	tableOffset: number;
	/** Size of the certificate table in bytes; 0 when there is none. */
	tableSize: number;
}

/**
 * Locate the certificate table of a PE file from its first bytes: the DOS
 * header, the PE header it points to, then the PE32 or PE32+ optional header.
 */
export function readCertificateDirectory(headers: Uint8Array): PeCertificateDirectory {
	const view = Buffer.from(headers.buffer, headers.byteOffset, headers.byteLength);
	const need = (end: number, what: string): void => {
		if (end > view.length) {
			throw new Error(`[build-sea] not a PE file: ${what} ends past its ${view.length} bytes`);
		}
	};

	need(0x40, "the DOS header");
	if (view.readUInt16LE(0) !== 0x5a4d) {
		throw new Error("[build-sea] not a PE file: no MZ signature");
	}
	const peHeader = view.readUInt32LE(0x3c);
	need(peHeader + 24, "the PE header");
	if (view.readUInt32LE(peHeader) !== 0x00004550) {
		throw new Error(`[build-sea] not a PE file: no PE signature at offset ${peHeader}`);
	}
	const optionalHeaderSize = view.readUInt16LE(peHeader + 20);
	const optionalHeader = peHeader + 24;
	need(optionalHeader + 2, "the optional header");

	// NumberOfRvaAndSizes, followed by the data directories, sits 16 bytes
	// further in PE32+, whose ImageBase and stack and heap sizes are 64-bit.
	const magic = view.readUInt16LE(optionalHeader);
	let directoryCount: number;
	if (magic === 0x10b) {
		directoryCount = optionalHeader + 92;
	} else if (magic === 0x20b) {
		directoryCount = optionalHeader + 108;
	} else {
		throw new Error(
			`[build-sea] not a PE32 or PE32+ file: optional header magic 0x${magic.toString(16)}`,
		);
	}
	need(directoryCount + 4, "the optional header");

	const checksumOffset = optionalHeader + 64;
	if (view.readUInt32LE(directoryCount) <= CERTIFICATE_DIRECTORY) {
		return { checksumOffset, entryOffset: null, tableOffset: 0, tableSize: 0 };
	}
	const entryOffset = directoryCount + 4 + CERTIFICATE_DIRECTORY * 8;
	if (entryOffset + 8 > optionalHeader + optionalHeaderSize) {
		throw new Error(
			`[build-sea] malformed PE file: data directory ${CERTIFICATE_DIRECTORY} lies outside its ${optionalHeaderSize}-byte optional header`,
		);
	}
	need(entryOffset + 8, "the data directories");
	return {
		checksumOffset,
		entryOffset,
		tableOffset: view.readUInt32LE(entryOffset),
		tableSize: view.readUInt32LE(entryOffset + 4),
	};
}

function readFileCertificateDirectory(fd: number): PeCertificateDirectory {
	const headers = Buffer.alloc(PE_HEADER_BYTES);
	const read = readSync(fd, headers, 0, headers.length, 0);
	return readCertificateDirectory(headers.subarray(0, read));
}

/**
 * Remove the Authenticode signature of a PE file, in place: cut the file where
 * its certificate table starts, then zero data directory 4 and the CheckSum,
 * the two header fields signing sets. An unsigned file is left as it is.
 * Throws, changing nothing, when the table does not end at the end of the
 * file: cutting there would drop whatever follows it.
 *
 * @returns the number of bytes removed, 0 for an unsigned file.
 */
export function stripAuthenticodeSignature(path: string): number {
	const fd = openSync(path, "r+");
	try {
		const fileSize = fstatSync(fd).size;
		const directory = readFileCertificateDirectory(fd);
		const { entryOffset, tableOffset, tableSize } = directory;
		if (entryOffset === null || (tableOffset === 0 && tableSize === 0)) {
			return 0;
		}
		if (tableOffset === 0 || tableOffset + tableSize !== fileSize) {
			throw new Error(
				`[build-sea] ${path}: its certificate table (offset ${tableOffset}, ${tableSize} bytes) ` +
					`does not end at the end of the file (${fileSize} bytes), so it cannot be removed safely`,
			);
		}
		ftruncateSync(fd, tableOffset);
		writeSync(fd, Buffer.alloc(8), 0, 8, entryOffset);
		writeSync(fd, Buffer.alloc(4), 0, 4, directory.checksumOffset);
		return tableSize;
	} finally {
		closeSync(fd);
	}
}

/**
 * Fail unless a PE file has no certificate table, the state in which the
 * Microsoft Store can sign it (#718).
 */
export function assertNoCertificateTable(path: string): void {
	const fd = openSync(path, "r");
	try {
		const { tableOffset, tableSize } = readFileCertificateDirectory(fd);
		if (tableOffset !== 0 || tableSize !== 0) {
			throw new Error(
				`[build-sea] ${path} still has a certificate table (offset ${tableOffset}, ${tableSize} bytes), ` +
					"so the Microsoft Store could not sign it",
			);
		}
	} finally {
		closeSync(fd);
	}
}

/**
 * Build a SEA config object for the given SeaBuildConfig.
 * The `output` field points to the blob file (not the binary).
 */
export function buildSeaConfigJson(cfg: SeaBuildConfig, blobPath: string): Record<string, unknown> {
	const assets: Record<string, string> = {};
	for (const [name, filePath] of Object.entries(cfg.nativeAddons)) {
		assets[name] = filePath;
	}
	if (cfg.extraAssets) {
		for (const [name, filePath] of Object.entries(cfg.extraAssets)) {
			assets[name] = filePath;
		}
	}

	return {
		main: cfg.entryScript,
		output: blobPath,
		disableExperimentalSEAWarning: cfg.disableExperimentalSEAWarning ?? true,
		useCodeCache: cfg.useCodeCache ?? true,
		assets,
	};
}

/**
 * Full SEA binary build pipeline.
 *
 * @param cfg  Build configuration
 */
export async function buildSeaBinary(cfg: SeaBuildConfig): Promise<void> {
	const outDir = dirname(cfg.outputBinary);
	mkdirSync(outDir, { recursive: true });

	// ------------------------------------------------------------------
	// 1. Write sea-config.json to a temp location
	// ------------------------------------------------------------------
	const tmpBase = join(tmpdir(), `lasterm-sea-${randomBytes(8).toString("hex")}`);
	mkdirSync(tmpBase, { recursive: true });

	const configPath = join(tmpBase, "sea-config.json");
	const blobPath = join(tmpBase, "sea-prep.blob");

	const seaConfig = buildSeaConfigJson(cfg, blobPath);
	writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
	console.log(`[build-sea] config written to ${configPath}`);

	try {
		// ------------------------------------------------------------------
		// 2. Generate the SEA blob
		// ------------------------------------------------------------------
		const nodeBin = resolveNodeBinary();
		run(nodeBin, ["--experimental-sea-config", configPath], "generate blob");

		// ------------------------------------------------------------------
		// 3. Copy the Node binary running this build to the output location.
		//    The executable embeds it, so it is built on the platform it targets.
		// ------------------------------------------------------------------
		console.log(`[build-sea] copying ${nodeBin} → ${cfg.outputBinary}`);
		copyFileSync(nodeBin, cfg.outputBinary);

		// ------------------------------------------------------------------
		// 4. Strip Node's signature. postject would leave it behind: invalid
		//    on macOS, and on Windows short of the end of the file, where
		//    nothing can sign the executable again (#718)
		// ------------------------------------------------------------------
		if (process.platform === "darwin") {
			run("codesign", ["--remove-signature", cfg.outputBinary], "codesign strip");
		}
		if (process.platform === "win32") {
			const removed = stripAuthenticodeSignature(cfg.outputBinary);
			console.log(
				removed > 0
					? `[build-sea] removed the Authenticode signature of the Node copy (${removed} bytes)`
					: "[build-sea] the Node copy has no Authenticode signature to remove",
			);
		}

		// ------------------------------------------------------------------
		// 5. Inject the SEA blob via postject
		// ------------------------------------------------------------------
		const postjectArgs = [
			cfg.outputBinary,
			"NODE_SEA_BLOB",
			blobPath,
			"--sentinel-fuse",
			SENTINEL_FUSE,
		];
		if (process.platform === "darwin") {
			postjectArgs.push("--macho-segment-name", "NODE_SEA");
		}
		const postject = postjectCommand(postjectArgs);
		run(postject.cmd, postject.args, "postject inject");
		if (process.platform === "win32") {
			assertNoCertificateTable(cfg.outputBinary);
		}

		// ------------------------------------------------------------------
		// 6. chmod +x on Linux/macOS
		// ------------------------------------------------------------------
		if (process.platform !== "win32") {
			chmodSync(cfg.outputBinary, 0o755);
		}

		// ------------------------------------------------------------------
		// 7. Report final binary size
		// ------------------------------------------------------------------
		const stat = statSync(cfg.outputBinary);
		const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
		console.log(`[build-sea] ${cfg.name} binary ready: ${cfg.outputBinary} (${sizeMB} MB)`);
	} finally {
		// Clean up temp files
		try {
			rmSync(tmpBase, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup — don't fail the build over this.
		}
	}
}
