/**
 * installed-addon.ts
 *
 * How the hub's single executable loads the native addons installed beside it
 * (#889). The executable carries a manifest written when it was built: the
 * name, size and SHA-256 of each addon. At startup each addon is opened once,
 * from the executable's own directory, judged on that descriptor, and loaded
 * through it where the system allows. Nothing is written to disk.
 *
 * What must hold is that only the addon the executable was built with runs in
 * it. The actor is another account able to change a file in the install
 * directory; a process running as the same user already has everything a
 * substituted addon would give it, and root is trusted.
 *
 * - The install directory is the executable's. Whoever can replace a file
 *   there can replace the executable itself, and Windows already searches that
 *   directory first for the executable's own libraries, so the directory is
 *   trusted exactly as far as the executable is. Under `Program Files\
 *   WindowsApps` (the Store's install), no user account can change it at all.
 * - Every addon is authenticated before it is loaded: the digest read through
 *   the descriptor it was opened with must be the manifest's. A size match
 *   proves nothing (#128).
 * - The digest leaves out what an Authenticode signature changes, and nothing
 *   else: the CheckSum, the certificate table's directory entry, and the table
 *   appended at the end of the file. The Microsoft Store signs the executables
 *   of a package it ingests (#718); a library it signed is still the one built.
 *   Neither field nor the table is mapped as code.
 * - On POSIX the file must give nobody write access the executable does not
 *   already give them: owned by this account, root or the executable's owner,
 *   and writable by group or others only where the executable is too.
 * - On Linux the addon is loaded through /proc/self/fd/N, so what dlopen maps
 *   is the file that was hashed. Windows cannot do that; what it relies on
 *   instead is written out at loadVerifiedAddon.
 */

import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The SEA asset that holds the manifest. */
export const ADDON_MANIFEST_ASSET = "addons.json";

// O_NOFOLLOW refuses a link at the leaf; O_NONBLOCK keeps a FIFO planted there
// from blocking the open. Neither exists on Windows, where the leaf is
// inspected with lstat instead.
const OPEN_NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_NON_BLOCKING = constants.O_NONBLOCK ?? 0;

/** What the build recorded for one addon: see addonDigest. */
export interface AddonDigest {
	/** Bytes covered by the digest: the file as built. */
	readonly size: number;
	/** SHA-256 of those bytes, lowercase hex, with the signing fields zeroed. */
	readonly sha256: string;
}

/** Addon file name → what it must hold. */
export type AddonManifest = Readonly<Record<string, AddonDigest>>;

/** Thrown when an addon beside the executable is not the one it was built with. */
export class AddonRefusedError extends Error {
	readonly code = "LASTERM_ADDON_REFUSED";

	/**
	 * @param addonPath - The file refused.
	 * @param reason    - Why, as a predicate of the file ("is missing").
	 */
	constructor(
		readonly addonPath: string,
		readonly reason: string,
	) {
		super(
			`refusing the native addon ${addonPath}: it ${reason}. Each addon must be the file built with this executable, in its directory: reinstall or rebuild the hub`,
		);
		this.name = "AddonRefusedError";
	}
}

/**
 * Read a manifest, refusing anything but the shape the build writes: an object
 * mapping `<name>.node` file names to a positive size and a SHA-256.
 */
export function parseAddonManifest(text: string): AddonManifest {
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("the addon manifest is not a JSON object");
	}
	const manifest: Record<string, AddonDigest> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (!isAddonFileName(name)) {
			throw new Error(`the addon manifest names ${JSON.stringify(name)}, not a .node file name`);
		}
		const entry = value as Partial<AddonDigest> | null;
		if (
			entry === null ||
			typeof entry !== "object" ||
			Object.keys(entry).sort().join() !== "sha256,size" ||
			!Number.isSafeInteger(entry.size) ||
			(entry.size as number) <= 0 ||
			typeof entry.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.sha256)
		) {
			throw new Error(`the addon manifest's entry for ${name} is not a size and a SHA-256`);
		}
		manifest[name] = { size: entry.size as number, sha256: entry.sha256 };
	}
	return manifest;
}

/** The manifest this executable was built with, from its SEA asset. */
export function readAddonManifest(sea: {
	getAsset?: (name: string, encoding: BufferEncoding) => string;
}): AddonManifest {
	let text: string | undefined;
	try {
		text = sea.getAsset?.(ADDON_MANIFEST_ASSET, "utf8");
	} catch {
		// Reported below: the asset is absent.
	}
	if (text === undefined) {
		throw new Error(
			`this executable carries no ${ADDON_MANIFEST_ASSET} asset; it was not packaged correctly`,
		);
	}
	return parseAddonManifest(text);
}

function isAddonFileName(name: string): boolean {
	return path.basename(name) === name && /^[A-Za-z0-9_.-]+\.node$/.test(name) && name !== ".node";
}

/** Who may have written the addon without that being a new risk. POSIX only. */
export interface AddonTrust {
	/** Accounts whose files are trusted: this account, root and the executable's owner. */
	readonly owners: readonly number[];
	/** The executable's mode and group: write access it grants, an addon may grant too. */
	readonly executable: { readonly mode: number; readonly gid: number };
}

/** The trust of the running executable, from its own file. */
export function executableTrust(executablePath: string = process.execPath): AddonTrust {
	const executable = statSync(executablePath);
	return {
		owners: [process.geteuid?.() ?? 0, 0, executable.uid],
		executable: { mode: executable.mode, gid: executable.gid },
	};
}

/**
 * An addon whose bytes were authenticated through `fd`, which is still open.
 * Hand it to loadVerifiedAddon, or close `fd`.
 */
export interface VerifiedAddon {
	readonly path: string;
	readonly fd: number;
}

/**
 * Open `addonPath` and return its descriptor once that descriptor shows the
 * expected addon; otherwise throw AddonRefusedError, with nothing left open.
 * `trust` left undefined is the running executable's on POSIX; Windows reports
 * no owner and no DACL, and checks none, as for auth.json (#200).
 */
export function openInstalledAddon(
	addonPath: string,
	expected: AddonDigest,
	trust: AddonTrust | undefined = process.platform === "win32" ? undefined : executableTrust(),
): VerifiedAddon {
	let before: BigIntStats | undefined;
	let fd: number;
	try {
		if (process.platform === "win32") {
			// Node cannot open a file on Windows without following a link or
			// junction, so the entry is inspected first and the handle compared
			// with it below.
			before = lstatSync(addonPath, { bigint: true });
			if (!before.isFile()) throw new AddonRefusedError(addonPath, "is not a regular file");
		}
		fd = openSync(addonPath, constants.O_RDONLY | OPEN_NO_FOLLOW | OPEN_NON_BLOCKING);
	} catch (error) {
		if (error instanceof AddonRefusedError) throw error;
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new AddonRefusedError(addonPath, "is missing");
		if (code === "ELOOP") throw new AddonRefusedError(addonPath, "is a symbolic link");
		throw new AddonRefusedError(addonPath, `cannot be opened (${code ?? String(error)})`);
	}
	try {
		const stat = fstatSync(fd, { bigint: true });
		if (before !== undefined && (stat.dev !== before.dev || stat.ino !== before.ino)) {
			throw new AddonRefusedError(addonPath, "was replaced while it was being opened");
		}
		if (!stat.isFile()) throw new AddonRefusedError(addonPath, "is not a regular file");
		// Windows synthesises the mode bits from the read-only attribute and
		// reports uid 0: there is nothing to judge.
		const untrusted =
			trust === undefined || process.platform === "win32"
				? undefined
				: untrustedReason(stat, trust);
		if (untrusted !== undefined) throw new AddonRefusedError(addonPath, untrusted);
		const actual = addonDigest(fd, Number(stat.size), expected.size);
		if (actual === undefined || actual.sha256 !== expected.sha256) {
			throw new AddonRefusedError(
				addonPath,
				`does not hold the bytes this executable was built with (${expected.size} bytes, SHA-256 ${expected.sha256})`,
			);
		}
		return { path: addonPath, fd };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function untrustedReason(stat: BigIntStats, trust: AddonTrust): string | undefined {
	const uid = Number(stat.uid);
	if (!trust.owners.includes(uid)) {
		return `is owned by uid ${uid}, which is neither this account, root nor the executable's owner`;
	}
	const mode = Number(stat.mode);
	const shown = (mode & 0o7777).toString(8).padStart(4, "0");
	if ((mode & 0o002) !== 0 && (trust.executable.mode & 0o002) === 0) {
		return `is writable by others (mode ${shown}), and the executable is not`;
	}
	if (
		(mode & 0o020) !== 0 &&
		((trust.executable.mode & 0o020) === 0 || Number(stat.gid) !== trust.executable.gid)
	) {
		return `is writable by its group (mode ${shown}), and the executable is not writable by that group`;
	}
	return undefined;
}

/**
 * Load a file openInstalledAddon authenticated, and take ownership of its
 * descriptor.
 *
 * On Linux, dlopen is given /proc/self/fd/N rather than the name. That opens
 * the inode the descriptor refers to, so what is mapped is the file that was
 * hashed, whatever the name has come to mean since. The descriptor is never
 * closed afterwards: glibc recognises an already-loaded library by the name it
 * was opened with before it looks at the file, so a later dlopen of the same
 * /proc/self/fd/N for a different addon, after the number was reused, would
 * return this one.
 *
 * Windows' LoadLibrary accepts only a name, which it resolves again. Node opens
 * a file either with full sharing, which lets another process rename or delete
 * it, or with none, which would shut LoadLibrary out too, so the window cannot
 * be closed from here. It is narrowed: the verified handle is held across the
 * load, and while it is open NTFS refuses to rename any directory above the
 * file. The name can then come to mean another file only through the install
 * directory's own entries, or a write to the file, by an account whose ACL
 * allows it there: one that could replace the executable just as well. Under
 * `Program Files\WindowsApps` that is no user account.
 */
export function loadVerifiedAddon(file: VerifiedAddon): Record<string, unknown> {
	const throughDescriptor = descriptorPath(file.fd);
	if (throughDescriptor !== undefined) {
		try {
			return dlopen(throughDescriptor);
		} catch (error) {
			// Nothing was loaded through it, so the number may be reused.
			closeSync(file.fd);
			throw error;
		}
	}
	try {
		return dlopen(file.path);
	} finally {
		closeSync(file.fd);
	}
}

export interface InstalledAddonOptions {
	/** Where the addons are installed. Defaults to the executable's directory. */
	readonly directory?: string;
	/** What they must hold. Defaults to the manifest the executable carries. */
	readonly manifest?: AddonManifest;
	/** Defaults to executableTrust() on POSIX; Windows checks no owner. */
	readonly trust?: AddonTrust;
}

/**
 * Load the addon `name` installed beside the running executable, once it is
 * shown to be the one the manifest records. A name the manifest does not list
 * is an error: the executable was built without it.
 */
export function loadInstalledAddon(
	name: string,
	options: InstalledAddonOptions = {},
): Record<string, unknown> {
	if (!isAddonFileName(name)) {
		throw new Error(`addon name ${JSON.stringify(name)} is not a .node file name`);
	}
	const manifest = options.manifest ?? readAddonManifest(seaModule());
	const expected = manifest[name];
	if (expected === undefined) {
		throw new Error(`this executable's ${ADDON_MANIFEST_ASSET} lists no addon named ${name}`);
	}
	const directory = options.directory ?? path.dirname(process.execPath);
	return loadVerifiedAddon(openInstalledAddon(path.join(directory, name), expected, options.trust));
}

/** Where an installed addon is looked for: beside the running executable. */
export function installedAddonPath(name: string): string {
	return path.join(path.dirname(process.execPath), name);
}

function seaModule(): { getAsset?: (name: string, encoding: BufferEncoding) => string } {
	const req = createRequire(import.meta.url);
	return req("node:sea") as { getAsset?: (name: string, encoding: BufferEncoding) => string };
}

function dlopen(addonPath: string): Record<string, unknown> {
	const mod = { exports: {} as Record<string, unknown> };
	process.dlopen(mod, addonPath);
	return mod.exports;
}

/** /proc/self/fd/N when it opens the file `fd` holds (Linux with /proc mounted). */
function descriptorPath(fd: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	const candidate = `/proc/self/fd/${fd}`;
	try {
		const viaProc = statSync(candidate, { bigint: true });
		const held = fstatSync(fd, { bigint: true });
		return viaProc.dev === held.dev && viaProc.ino === held.ino ? candidate : undefined;
	} catch {
		return undefined;
	}
}

// ─── The digest ───────────────────────────────────────────────────────────────

/** Bytes read from the start of a file to find a PE file's headers. */
const PE_HEADER_BYTES = 64 * 1024;
/** IMAGE_DIRECTORY_ENTRY_SECURITY: the data directory of the certificate table. */
const CERTIFICATE_DIRECTORY = 4;
/** Signing pads the file to a multiple of 8 bytes before it appends the table. */
const CERTIFICATE_ALIGNMENT = 8;

/** Where signing writes in a PE file. */
interface SigningFields {
	/** File offset of the optional header's CheckSum. */
	readonly checksumOffset: number;
	/** File offset of data directory 4, or undefined when the header has none. */
	readonly entryOffset: number | undefined;
	/** The certificate table: a file offset and a size, both 0 when unsigned. */
	readonly tableOffset: number;
	readonly tableSize: number;
}

/**
 * The digest of an addon, read through `fd`: the SHA-256 of its first `size`
 * bytes, with the two header fields signing sets read as zero when it is a PE
 * file. `size` is the file's own size, or, for a PE file carrying a
 * certificate table, where that table starts.
 *
 * With `expectedSize` (what the build recorded), the file may carry more than
 * those bytes in one way only: a PE file's certificate table, at the end of
 * the file, after at most 7 zero bytes of padding. That is how a signature
 * added after the build looks. Anything else gives undefined, as does a file
 * shorter than expected.
 *
 * Exported for the build, which writes the manifest from the same function.
 */
export function addonDigest(
	fd: number,
	fileSize: number,
	expectedSize?: number,
): AddonDigest | undefined {
	const headers = Buffer.alloc(Math.min(PE_HEADER_BYTES, fileSize));
	const headerBytes = readFully(fd, headers, 0);
	const fields = signingFields(headers.subarray(0, headerBytes));
	let size = fileSize;
	if (fields !== undefined && (fields.tableOffset !== 0 || fields.tableSize !== 0)) {
		// Authenticode keeps the table last; one anywhere else is not a signature.
		if (fields.tableOffset === 0 || fields.tableOffset + fields.tableSize !== fileSize) {
			return undefined;
		}
		size = fields.tableOffset;
	}
	if (expectedSize !== undefined) {
		if (size < expectedSize || size - expectedSize >= CERTIFICATE_ALIGNMENT) return undefined;
		if (size !== expectedSize) {
			if (fields === undefined || fields.tableSize === 0) return undefined;
			const padding = Buffer.alloc(size - expectedSize);
			if (readFully(fd, padding, expectedSize) !== padding.length) return undefined;
			if (padding.some((byte) => byte !== 0)) return undefined;
		}
		size = expectedSize;
	}

	const zeroed: Array<[number, number]> = [];
	if (fields !== undefined) {
		zeroed.push([fields.checksumOffset, 4]);
		if (fields.entryOffset !== undefined) zeroed.push([fields.entryOffset, 8]);
	}
	const hash = createHash("sha256");
	const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(size, 1 << 20)));
	for (let offset = 0; offset < size; ) {
		const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
		if (read === 0) return undefined;
		const piece = chunk.subarray(0, read);
		for (const [start, length] of zeroed) {
			const from = Math.max(start, offset);
			const to = Math.min(start + length, offset + read);
			if (from < to) piece.fill(0, from - offset, to - offset);
		}
		hash.update(piece);
		offset += read;
	}
	return { size, sha256: hash.digest("hex") };
}

function readFully(fd: number, buffer: Buffer, position: number): number {
	let filled = 0;
	while (filled < buffer.length) {
		const read = readSync(fd, buffer, filled, buffer.length - filled, position + filled);
		if (read === 0) break;
		filled += read;
	}
	return filled;
}

/**
 * Where signing writes in a PE file, from its first bytes: the DOS header, the
 * PE header it points to, then the PE32 or PE32+ optional header. Anything
 * that is not a PE file, an ELF library for one, gives undefined and is hashed
 * whole.
 */
function signingFields(headers: Buffer): SigningFields | undefined {
	if (headers.length < 0x40 || headers.readUInt16LE(0) !== 0x5a4d) return undefined;
	const peHeader = headers.readUInt32LE(0x3c);
	if (peHeader + 24 + 2 > headers.length || headers.readUInt32LE(peHeader) !== 0x00004550) {
		return undefined;
	}
	const optionalHeaderSize = headers.readUInt16LE(peHeader + 20);
	const optionalHeader = peHeader + 24;
	// NumberOfRvaAndSizes, followed by the data directories, sits 16 bytes
	// further in PE32+, whose ImageBase and stack and heap sizes are 64-bit.
	const magic = headers.readUInt16LE(optionalHeader);
	const directoryCount =
		magic === 0x10b ? optionalHeader + 92 : magic === 0x20b ? optionalHeader + 108 : undefined;
	if (directoryCount === undefined || directoryCount + 4 > headers.length) return undefined;
	const checksumOffset = optionalHeader + 64;
	const entryOffset = directoryCount + 4 + CERTIFICATE_DIRECTORY * 8;
	if (
		headers.readUInt32LE(directoryCount) <= CERTIFICATE_DIRECTORY ||
		entryOffset + 8 > optionalHeader + optionalHeaderSize ||
		entryOffset + 8 > headers.length
	) {
		return { checksumOffset, entryOffset: undefined, tableOffset: 0, tableSize: 0 };
	}
	return {
		checksumOffset,
		entryOffset,
		tableOffset: headers.readUInt32LE(entryOffset),
		tableSize: headers.readUInt32LE(entryOffset + 4),
	};
}
