import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ADDON_MANIFEST_ASSET,
	type AddonDigest,
	AddonRefusedError,
	type AddonTrust,
	addonDigest,
	loadInstalledAddon,
	openInstalledAddon,
	parseAddonManifest,
	readAddonManifest,
} from "./installed-addon.js";

const windows = process.platform === "win32";
const linux = process.platform === "linux";
const uid = process.geteuid?.() ?? 0;

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// Windows keeps a library this process loaded until the process exits.
		}
	}
});

describe("parseAddonManifest", () => {
	const sha256 = "a".repeat(64);

	it("reads what the build writes", () => {
		const manifest = parseAddonManifest(
			JSON.stringify({ "lasterm_hub_lock.node": { size: 12, sha256 } }, null, 2),
		);
		expect(manifest).toEqual({ "lasterm_hub_lock.node": { size: 12, sha256 } });
	});

	it.each([
		["an array", "[]"],
		["null", "null"],
		["a name with a directory", JSON.stringify({ "../x.node": { size: 1, sha256 } })],
		["a name that is not a .node file", JSON.stringify({ "x.dll": { size: 1, sha256 } })],
		["a size of 0", JSON.stringify({ "x.node": { size: 0, sha256 } })],
		["a size that is not an integer", JSON.stringify({ "x.node": { size: 1.5, sha256 } })],
		["a digest in capitals", JSON.stringify({ "x.node": { size: 1, sha256: "A".repeat(64) } })],
		["a short digest", JSON.stringify({ "x.node": { size: 1, sha256: "a".repeat(63) } })],
		["an extra field", JSON.stringify({ "x.node": { size: 1, sha256, path: "/x" } })],
	])("refuses %s", (_what, text) => {
		expect(() => parseAddonManifest(text)).toThrow();
	});
});

describe("readAddonManifest", () => {
	it("reads the manifest asset the executable carries", () => {
		const text = JSON.stringify({ "x.node": { size: 3, sha256: "b".repeat(64) } });
		const manifest = readAddonManifest({
			getAsset: (name) => {
				expect(name).toBe(ADDON_MANIFEST_ASSET);
				return text;
			},
		});
		expect(manifest["x.node"]?.size).toBe(3);
	});

	it("names the asset an executable built without one lacks", () => {
		expect(() =>
			readAddonManifest({
				getAsset: () => {
					throw new Error("No such asset");
				},
			}),
		).toThrow(`no ${ADDON_MANIFEST_ASSET} asset`);
		expect(() => readAddonManifest({})).toThrow(`no ${ADDON_MANIFEST_ASSET} asset`);
	});
});

describe("addonDigest", () => {
	it("is the SHA-256 of a file that is not a PE file", () => {
		const data = Buffer.from("\x7fELF the bytes of a library");
		const digest = digestOf(writeTemp("lib.node", data));
		expect(digest).toEqual({
			size: data.length,
			sha256: createHash("sha256").update(data).digest("hex"),
		});
	});

	it("still matches a PE file after an Authenticode signature is added", () => {
		const built = peFile();
		const recorded = digestOf(writeTemp("built.node", built));
		const signed = sign(built, 3);
		expect(signed.length).toBeGreaterThan(built.length);
		expect(digestOf(writeTemp("signed.node", signed), recorded!.size)).toEqual(recorded);
	});

	it("refuses a PE file whose table does not end the file", () => {
		const built = peFile();
		const recorded = digestOf(writeTemp("built.node", built))!;
		const signed = Buffer.concat([sign(built, 3), Buffer.from("after the table")]);
		expect(digestOf(writeTemp("trailing.node", signed), recorded.size)).toBeUndefined();
	});

	it("refuses padding before the table that is not zeros, or 8 bytes or more", () => {
		const built = peFile(4093);
		const recorded = digestOf(writeTemp("built.node", built))!;
		const signed = sign(built, 3);
		signed[built.length] = 0x41;
		expect(digestOf(writeTemp("dirty.node", signed), recorded.size)).toBeUndefined();
		const padded = sign(Buffer.concat([built, Buffer.alloc(8)]), 0);
		expect(digestOf(writeTemp("padded.node", padded), recorded.size)).toBeUndefined();
	});

	it("refuses bytes appended to a file that carries no table", () => {
		const data = Buffer.from("\x7fELF the bytes of a library");
		const recorded = digestOf(writeTemp("lib.node", data))!;
		const longer = Buffer.concat([data, Buffer.alloc(1)]);
		expect(digestOf(writeTemp("longer.node", longer), recorded.size)).toBeUndefined();
	});

	it("covers every byte of a PE file but the two signing fields", () => {
		const built = peFile();
		const recorded = digestOf(writeTemp("built.node", built))!;
		const changed = Buffer.from(built);
		changed[PE_BODY + 10] = (changed[PE_BODY + 10] ?? 0) ^ 1;
		expect(digestOf(writeTemp("changed.node", changed), recorded.size)?.sha256).not.toBe(
			recorded.sha256,
		);
	});
});

describe("openInstalledAddon", () => {
	it("hands back the descriptor of a file holding the recorded bytes", () => {
		const data = Buffer.from("the addon as built");
		const file = writeTemp("x.node", data);
		const opened = openInstalledAddon(file, digestOf(file)!, trust());
		try {
			expect(fstatSync(opened.fd).size).toBe(data.length);
			expect(opened.path).toBe(file);
		} finally {
			closeSync(opened.fd);
		}
	});

	it("refuses a missing file, saying so", () => {
		const file = join(makeTempDir(), "x.node");
		expectRefusal(() => openInstalledAddon(file, { size: 1, sha256: "0".repeat(64) }, trust()), {
			path: file,
			reason: "is missing",
		});
	});

	it("refuses a file whose bytes changed, at the same size", () => {
		const data = Buffer.from("the addon as built");
		const file = writeTemp("x.node", data);
		const recorded = digestOf(file)!;
		writeFileSync(file, Buffer.from("the addon as BUILT"));
		expectRefusal(() => openInstalledAddon(file, recorded, trust()), {
			path: file,
			reason: /^does not hold the bytes this executable was built with/,
		});
	});

	it("refuses another file put in its place", () => {
		const dir = makeTempDir();
		const file = writeTemp("x.node", Buffer.from("the addon as built"), dir);
		const recorded = digestOf(file)!;
		const other = writeTemp("other", Buffer.from("another library, longer than the first"), dir);
		renameSync(other, file);
		expectRefusal(() => openInstalledAddon(file, recorded, trust()), {
			path: file,
			reason: /^does not hold the bytes/,
		});
	});

	it("refuses a directory at the addon's name", () => {
		const dir = makeTempDir();
		const file = join(dir, "x.node");
		mkdirSync(file);
		expect(() => openInstalledAddon(file, { size: 1, sha256: "0".repeat(64) }, trust())).toThrow(
			AddonRefusedError,
		);
	});

	it.skipIf(windows)("refuses a symbolic link at the addon's name, even to the right bytes", () => {
		const dir = makeTempDir();
		const real = writeTemp("real.node", Buffer.from("the addon as built"), dir);
		const link = join(dir, "x.node");
		symlinkSync(real, link);
		expectRefusal(() => openInstalledAddon(link, digestOf(real)!, trust()), {
			path: link,
			reason: "is a symbolic link",
		});
	});

	it.skipIf(windows)(
		"refuses a file its group may write when the executable's group may not",
		() => {
			const file = writeTemp("x.node", Buffer.from("the addon as built"));
			chmodSync(file, 0o664);
			expectRefusal(() => openInstalledAddon(file, digestOf(file)!, trust({ mode: 0o755 })), {
				path: file,
				reason: /^is writable by its group \(mode 0664\)/,
			});
			// The same write access the executable grants is no new risk.
			const { gid } = statSync(file);
			closeSync(openInstalledAddon(file, digestOf(file)!, trust({ mode: 0o775, gid })).fd);
		},
	);

	it.skipIf(windows)("refuses a file owned by an account it does not trust", () => {
		const file = writeTemp("x.node", Buffer.from("the addon as built"));
		const stranger: AddonTrust = { owners: [uid + 1], executable: { mode: 0o755, gid: 0 } };
		expectRefusal(() => openInstalledAddon(file, digestOf(file)!, stranger), {
			path: file,
			reason: new RegExp(`^is owned by uid ${uid}, which is neither`),
		});
	});
});

describe("loadInstalledAddon", () => {
	it("loads a real addon installed beside it", () => {
		const dir = makeTempDir();
		const file = writeTemp("better_sqlite3.node", realAddon(), dir);
		const exports = loadInstalledAddon("better_sqlite3.node", {
			directory: dir,
			manifest: { "better_sqlite3.node": digestOf(file)! },
			trust: trust(),
		});
		expect(typeof exports.Database).toBe("function");
	});

	it("refuses a name its manifest does not list, without opening anything", () => {
		const open = vi.spyOn(process, "dlopen");
		expect(() =>
			loadInstalledAddon("other.node", { directory: makeTempDir(), manifest: {}, trust: trust() }),
		).toThrow("lists no addon named other.node");
		expect(open).not.toHaveBeenCalled();
	});

	it("loads nothing when the file is refused", () => {
		const dir = makeTempDir();
		const file = writeTemp("x.node", Buffer.from("the addon as built"), dir);
		const recorded = digestOf(file)!;
		writeFileSync(file, Buffer.from("something else entirely"));
		const open = vi.spyOn(process, "dlopen");
		expect(() =>
			loadInstalledAddon("x.node", {
				directory: dir,
				manifest: { "x.node": recorded },
				trust: trust(),
			}),
		).toThrow(AddonRefusedError);
		expect(open).not.toHaveBeenCalled();
	});

	it.runIf(linux)("hands dlopen the file it verified, not the name", () => {
		const dir = makeTempDir();
		const asset = Buffer.from("the addon as built");
		const file = writeTemp("x.node", asset, dir);
		const recorded = digestOf(file)!;
		let loaded: Buffer | undefined;
		let loadedFrom = "";
		vi.spyOn(process, "dlopen").mockImplementation((_module, filename) => {
			// The name is repointed after the check and before the load; what
			// dlopen opens must still be the file that was authenticated.
			const swap = join(dir, "swap");
			writeFileSync(swap, Buffer.alloc(asset.length, 0x41), { mode: 0o644 });
			renameSync(swap, file);
			loadedFrom = filename;
			loaded = readFileSync(filename);
		});
		loadInstalledAddon("x.node", {
			directory: dir,
			manifest: { "x.node": recorded },
			trust: trust(),
		});
		expect(loadedFrom).toMatch(/^\/proc\/self\/fd\/\d+$/);
		expect(loaded).toEqual(asset);
	});

	it.runIf(windows)(
		"holds the verified file open across the load, so no directory above it can be renamed",
		() => {
			const base = makeTempDir();
			const dir = join(base, "install", "bin");
			mkdirSync(dir, { recursive: true });
			const file = writeTemp("x.node", Buffer.from("the addon as built"), dir);
			let renameError: NodeJS.ErrnoException | undefined;
			let loadedFrom = "";
			vi.spyOn(process, "dlopen").mockImplementation((_module, filename) => {
				loadedFrom = filename;
				try {
					renameSync(join(base, "install"), join(base, "elsewhere"));
				} catch (error) {
					renameError = error as NodeJS.ErrnoException;
				}
			});
			loadInstalledAddon("x.node", { directory: dir, manifest: { "x.node": digestOf(file)! } });
			expect(loadedFrom).toBe(file);
			expect(renameError?.code).toBe("EPERM");
		},
	);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lasterm-installed-addon-"));
	tempDirs.push(dir);
	return dir;
}

function writeTemp(name: string, data: Buffer, dir = makeTempDir()): string {
	const file = join(dir, name);
	writeFileSync(file, data);
	// Whatever the umask, as a build would install it.
	if (!windows) chmodSync(file, 0o644);
	return file;
}

function digestOf(file: string, expectedSize?: number): AddonDigest | undefined {
	const fd = openSync(file, "r");
	try {
		return addonDigest(fd, fstatSync(fd).size, expectedSize);
	} finally {
		closeSync(fd);
	}
}

/** This account's trust, with an executable of the given mode and group. */
function trust(executable: { mode?: number; gid?: number } = {}): AddonTrust {
	return {
		owners: [uid, 0],
		executable: { mode: executable.mode ?? 0o755, gid: executable.gid ?? -1 },
	};
}

function expectRefusal(action: () => unknown, expected: { path: string; reason: string | RegExp }) {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(AddonRefusedError);
	const refusal = caught as AddonRefusedError;
	expect(refusal.code).toBe("LASTERM_ADDON_REFUSED");
	expect(refusal.addonPath).toBe(expected.path);
	if (typeof expected.reason === "string") expect(refusal.reason).toBe(expected.reason);
	else expect(refusal.reason).toMatch(expected.reason);
	expect(refusal.message).toContain(expected.path);
}

/** A real native addon: the better-sqlite3 prebuild for this platform, which the hub loads. */
function realAddon(): Buffer {
	const hubRequire = createRequire(new URL("../../hub/package.json", import.meta.url));
	const packageDir = dirname(hubRequire.resolve("better-sqlite3/package.json"));
	return readFileSync(join(packageDir, "prebuilds", `${process.platform}-${process.arch}.node`));
}

// A PE32+ file reduced to what signing reads: the DOS header, the PE header,
// and an optional header with its 16 data directories, then a body.
const PE_HEADER = 0x80;
const OPTIONAL_HEADER = PE_HEADER + 24;
const OPTIONAL_HEADER_SIZE = 112 + 16 * 8;
const CHECKSUM = OPTIONAL_HEADER + 64;
const CERTIFICATE_ENTRY = OPTIONAL_HEADER + 112 + 4 * 8;
const PE_BODY = OPTIONAL_HEADER + OPTIONAL_HEADER_SIZE;

function peFile(size = 4096): Buffer {
	const file = Buffer.alloc(size);
	file.write("MZ", 0, "latin1");
	file.writeUInt32LE(PE_HEADER, 0x3c);
	file.write("PE\0\0", PE_HEADER, "latin1");
	file.writeUInt16LE(0x8664, PE_HEADER + 4);
	file.writeUInt16LE(OPTIONAL_HEADER_SIZE, PE_HEADER + 20);
	file.writeUInt16LE(0x20b, OPTIONAL_HEADER);
	file.writeUInt32LE(16, OPTIONAL_HEADER + 108);
	for (let i = PE_BODY; i < size; i++) file[i] = (i * 31) & 0xff;
	return file;
}

/** What signing does to a PE file: a new CheckSum, padding to 8 bytes, then the table, last. */
function sign(file: Buffer, padTo8Extra: number): Buffer {
	const padding = (8 - (file.length % 8)) % 8;
	const table = Buffer.alloc(64 + padTo8Extra * 8, 0x5a);
	const signed = Buffer.concat([file, Buffer.alloc(padding), table]);
	signed.writeUInt32LE(0x1234abcd, CHECKSUM);
	signed.writeUInt32LE(file.length + padding, CERTIFICATE_ENTRY);
	signed.writeUInt32LE(table.length, CERTIFICATE_ENTRY + 4);
	return signed;
}
