import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ensurePrivateCacheDir,
	getAddonCacheDir,
	loadNativeAddon,
	openCachedAddon,
	readSeaVersion,
	UnsafeAddonCacheError,
} from "./sea-addon-loader.js";

const windows = process.platform === "win32";
const linux = process.platform === "linux";
const root = !windows && process.geteuid?.() === 0;

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// Windows cannot delete a library this process has loaded, and keeps
			// it until the process exits; the directory stays in the temp folder.
		}
	}
});

describe("openCachedAddon", () => {
	it("never presents a partial addon while concurrent processes extract it", async () => {
		const cacheDir = makeTempDir();
		const assetName = "concurrent.node";
		const data = Buffer.alloc(1024 * 1024, 0xa5);
		const workers = Array.from({ length: 2 }, () =>
			extractInChild(cacheDir, assetName, data.length),
		);
		const destination = join(cacheDir, assetName);
		let observed = 0;
		let complete = false;
		const exits = Promise.all(workers.map(waitForExit)).finally(() => {
			complete = true;
		});

		while (!complete) {
			if (existsSync(destination)) {
				const extracted = readFileSync(destination);
				expect(extracted).toEqual(data);
				observed += 1;
			}
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		await exits;
		expect(observed).toBeGreaterThan(0);
		expect(readFileSync(destination)).toEqual(data);
	}, 20_000);

	it("publishes the embedded bytes and opens them", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		const file = openCachedAddon("addon.node", cacheDir, asset);
		try {
			expect(file.path).toBe(join(cacheDir, "addon.node"));
			expect(readFileSync(file.path)).toEqual(asset);
			expect(fstatSync(file.fd).size).toBe(asset.length);
		} finally {
			closeSync(file.fd);
		}
	});

	it("reuses a cached file that holds exactly the embedded bytes", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		const cached = join(cacheDir, "addon.node");
		writeFileSync(cached, asset, { mode: 0o755 });
		const past = new Date("2020-01-01T00:00:00Z");
		utimesSync(cached, past, past);
		openAndClose("addon.node", cacheDir, asset);
		expect(statSync(cached).mtime).toEqual(past);
	});

	it("replaces a cached file of the right size whose bytes differ", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		writeFileSync(join(cacheDir, "addon.node"), Buffer.alloc(asset.length, 0x41));
		// Mutation caught: the old size check reused this file and dlopen ran it.
		openAndClose("addon.node", cacheDir, asset);
		expect(readFileSync(join(cacheDir, "addon.node"))).toEqual(asset);
	});

	it("replaces a cached file of another size", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		writeFileSync(join(cacheDir, "addon.node"), Buffer.from("a planted, longer library"));
		openAndClose("addon.node", cacheDir, asset);
		expect(readFileSync(join(cacheDir, "addon.node"))).toEqual(asset);
	});

	it.skipIf(root)(
		"refuses a file with the wrong digest that it cannot replace, and loads nothing",
		() => {
			const cacheDir = makeTempDir();
			const asset = Buffer.from("the embedded addon");
			const planted = join(cacheDir, "addon.node");
			writeFileSync(planted, Buffer.alloc(asset.length, 0x41));
			// Windows will not rename over a read-only file; POSIX will not rename
			// into a directory this account cannot write.
			if (windows) chmodSync(planted, 0o444);
			else chmodSync(cacheDir, 0o555);
			const dlopen = vi.spyOn(process, "dlopen").mockImplementation(() => {});
			try {
				expect(() => loadNativeAddon("addon.node", cacheDir, seaWith(asset))).toThrow();
				expect(dlopen).not.toHaveBeenCalled();
			} finally {
				if (windows) chmodSync(planted, 0o666);
				else chmodSync(cacheDir, 0o700);
			}
		},
	);

	it.skipIf(windows)(
		"does not reuse a file group or others may write, however right its bytes",
		() => {
			const cacheDir = makeTempDir();
			const asset = Buffer.from("the embedded addon");
			const planted = join(cacheDir, "addon.node");
			writeFileSync(planted, asset);
			chmodSync(planted, 0o666);
			const plantedInode = statSync(planted).ino;
			openAndClose("addon.node", cacheDir, asset);
			const published = lstatSync(planted);
			expect(published.ino).not.toBe(plantedInode);
			expect(published.mode & 0o022).toBe(0);
		},
	);

	it.skipIf(windows)("does not follow a symbolic link planted at the destination", () => {
		const cacheDir = makeTempDir();
		const elsewhere = join(makeTempDir(), "addon.node");
		const asset = Buffer.from("the embedded addon");
		writeFileSync(elsewhere, asset, { mode: 0o755 });
		symlinkSync(elsewhere, join(cacheDir, "addon.node"));
		openAndClose("addon.node", cacheDir, asset);
		expect(lstatSync(join(cacheDir, "addon.node")).isFile()).toBe(true);
	});

	it.skipIf(windows)("refuses a cache directory another account could change", () => {
		const base = makeTempDir();
		const loose = join(base, "loose");
		mkdirSync(loose);
		chmodSync(loose, 0o777);
		expect(() => openCachedAddon("addon.node", join(loose, "cache"), Buffer.from("addon"))).toThrow(
			UnsafeAddonCacheError,
		);
		expect(existsSync(join(loose, "cache"))).toBe(false);
	});
});

describe("loadNativeAddon", () => {
	it("loads the embedded addon through the cache", () => {
		const cacheDir = makeTempDir();
		const exports = loadNativeAddon("better_sqlite3.node", cacheDir, seaWith(realAddon()));
		expect(typeof exports.Database).toBe("function");
	});

	it.runIf(linux)("hands dlopen the file it verified, not the name", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("the embedded addon");
		const destination = join(cacheDir, "addon.node");
		let loaded: Buffer | undefined;
		let loadedFrom = "";
		vi.spyOn(process, "dlopen").mockImplementation((_module, filename) => {
			// The name is repointed after the check and before the load; what
			// dlopen opens must still be the file that was authenticated.
			const swap = join(cacheDir, "swap");
			writeFileSync(swap, Buffer.alloc(asset.length, 0x41), { mode: 0o755 });
			renameSync(swap, destination);
			loadedFrom = filename;
			loaded = readFileSync(filename);
		});
		loadNativeAddon("addon.node", cacheDir, seaWith(asset));
		expect(loadedFrom).toMatch(/^\/proc\/self\/fd\/\d+$/);
		expect(loaded).toEqual(asset);
	});

	it.runIf(windows)(
		"holds the verified file open across the load, so no directory above it can be renamed",
		() => {
			const base = makeTempDir();
			const cacheDir = join(base, "addons", "cache");
			let renameError: NodeJS.ErrnoException | undefined;
			let loadedFrom = "";
			vi.spyOn(process, "dlopen").mockImplementation((_module, filename) => {
				loadedFrom = filename;
				try {
					renameSync(join(base, "addons"), join(base, "elsewhere"));
				} catch (error) {
					renameError = error as NodeJS.ErrnoException;
				}
			});
			loadNativeAddon("addon.node", cacheDir, seaWith(Buffer.from("the embedded addon")));
			expect(loadedFrom).toBe(join(cacheDir, "addon.node"));
			expect(renameError?.code).toBe("EPERM");
		},
	);
});

describe.skipIf(windows)("ensurePrivateCacheDir", () => {
	it("creates missing directories that only this account can write", () => {
		const base = makeTempDir();
		const target = join(base, "a", "b");
		ensurePrivateCacheDir(target);
		expect(statSync(join(base, "a")).mode & 0o077).toBe(0);
		expect(statSync(target).mode & 0o077).toBe(0);
	});

	it("refuses a directory its group may write, before creating anything below it", () => {
		const base = makeTempDir();
		const loose = join(base, "loose");
		mkdirSync(loose);
		chmodSync(loose, 0o775);
		const error = catchError(() => ensurePrivateCacheDir(join(loose, "cache")));
		expect(error).toBeInstanceOf(UnsafeAddonCacheError);
		expect((error as UnsafeAddonCacheError).directory).toBe(loose);
		expect(existsSync(join(loose, "cache"))).toBe(false);
	});

	it("refuses a directory others may write unless it is sticky", () => {
		const base = makeTempDir();
		const shared = join(base, "shared");
		mkdirSync(shared);
		chmodSync(shared, 0o777);
		expect(() => ensurePrivateCacheDir(join(shared, "cache"))).toThrow(UnsafeAddonCacheError);
		// Sticky, as /tmp is: others may add entries but not replace this account's.
		chmodSync(shared, 0o1777);
		ensurePrivateCacheDir(join(shared, "cache"));
		expect(statSync(join(shared, "cache")).isDirectory()).toBe(true);
	});

	// Root owns what a root test creates, and root is trusted.
	it.skipIf(root)("refuses a directory owned by another account", () => {
		const base = makeTempDir();
		const someoneElse = (process.geteuid?.() ?? 0) + 1;
		const error = catchError(() =>
			ensurePrivateCacheDir(join(base, "cache"), { uid: someoneElse }),
		);
		expect(error).toBeInstanceOf(UnsafeAddonCacheError);
		expect(base.startsWith((error as UnsafeAddonCacheError).directory)).toBe(true);
	});

	it("follows a symbolic link when every directory it leads through is private", () => {
		const base = makeTempDir();
		mkdirSync(join(base, "real"), { mode: 0o700 });
		symlinkSync(join(base, "real"), join(base, "link"));
		ensurePrivateCacheDir(join(base, "link", "cache"));
		expect(statSync(join(base, "real", "cache")).isDirectory()).toBe(true);
	});

	it("refuses a symbolic link that leads into a directory another account may write", () => {
		const base = makeTempDir();
		const open = join(base, "open");
		mkdirSync(open);
		chmodSync(open, 0o777);
		symlinkSync("open", join(base, "link"));
		const error = catchError(() => ensurePrivateCacheDir(join(base, "link", "cache")));
		expect(error).toBeInstanceOf(UnsafeAddonCacheError);
		expect((error as UnsafeAddonCacheError).directory).toBe(open);
	});

	it("tightens a loose directory inside lasterm's own cache tree instead of refusing it", () => {
		const base = makeTempDir();
		const own = join(base, "lasterm");
		mkdirSync(own);
		chmodSync(own, 0o775);
		ensurePrivateCacheDir(join(own, "addons"), { ownedFrom: own });
		expect(statSync(own).mode & 0o7777).toBe(0o755);
	});

	it("refuses a component that is not a directory", () => {
		const base = makeTempDir();
		writeFileSync(join(base, "file"), "");
		expect(() => ensurePrivateCacheDir(join(base, "file", "cache"))).toThrow(UnsafeAddonCacheError);
	});
});

describe("temporaries", () => {
	it("removes a temporary left by a writer that is gone, and keeps a live writer's", () => {
		const cacheDir = makeTempDir();
		const orphan = join(cacheDir, "addon.node.2147483.0123456789abcdef.tmp");
		const live = join(cacheDir, `addon.node.${process.pid}.fedcba9876543210.tmp`);
		writeFileSync(orphan, "interrupted");
		writeFileSync(live, "in progress");
		openAndClose("addon.node", cacheDir, Buffer.from("complete"));
		expect(existsSync(orphan)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});
});

describe("getAddonCacheDir", () => {
	it("keys the cache by version, platform and architecture", () => {
		const dir = getAddonCacheDir("1.2.3");
		expect(dir).toContain("1.2.3");
		expect(dir.endsWith(`${process.platform}-${process.arch}`)).toBe(true);
	});
});

describe("readSeaVersion", () => {
	it("returns the embedded version, trimmed", () => {
		expect(readSeaVersion({ getAsset: () => "0.10.6\n" })).toBe("0.10.6");
	});

	it("refuses an executable without a VERSION asset instead of reading 0.0.0", () => {
		expect(() => readSeaVersion({})).toThrow("no VERSION asset");
		expect(() => readSeaVersion({ getAsset: () => "  " })).toThrow("no VERSION asset");
		expect(() =>
			readSeaVersion({
				getAsset: () => {
					throw new Error("No such asset");
				},
			}),
		).toThrow("no VERSION asset");
	});
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lasterm-sea-addon-"));
	tempDirs.push(dir);
	return dir;
}

function openAndClose(assetName: string, cacheDir: string, asset: Buffer): string {
	const file = openCachedAddon(assetName, cacheDir, asset);
	closeSync(file.fd);
	return file.path;
}

function seaWith(asset: Buffer): { getRawAsset: (name: string) => ArrayBuffer } {
	return {
		getRawAsset: () =>
			asset.buffer.slice(asset.byteOffset, asset.byteOffset + asset.byteLength) as ArrayBuffer,
	};
}

/** A real native addon: the better-sqlite3 binding the hub depends on. */
function realAddon(): Buffer {
	const hubRequire = createRequire(new URL("../../hub/package.json", import.meta.url));
	const packageDir = dirname(hubRequire.resolve("better-sqlite3/package.json"));
	return readFileSync(join(packageDir, "build", "Release", "better_sqlite3.node"));
}

function catchError(action: () => void): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("expected an error");
}

function extractInChild(cacheDir: string, assetName: string, size: number): ChildProcess {
	const moduleUrl = new URL("./sea-addon-loader.ts", import.meta.url).href;
	const program = [
		`import { closeSync } from "node:fs";`,
		`import { openCachedAddon } from ${JSON.stringify(moduleUrl)};`,
		`closeSync(openCachedAddon(${JSON.stringify(assetName)}, ${JSON.stringify(cacheDir)}, Buffer.alloc(${size}, 0xa5)).fd);`,
	].join("\n");
	return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
		stdio: "ignore",
	});
}

function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null) {
			if (child.exitCode === 0) resolve();
			else reject(new Error(`extractor exited ${child.exitCode}`));
			return;
		}
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`extractor exited ${code}`));
		});
	});
}
