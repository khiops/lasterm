import { type ChildProcess, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
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
		// Settled, not all: every extractor that fails is reported, and none of
		// the failures is left unhandled while the loop below runs.
		const exits = Promise.allSettled(workers.map(waitForExit)).finally(() => {
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
		const failures = (await exits).flatMap((exit) =>
			exit.status === "rejected" ? [String(exit.reason)] : [],
		);
		expect(failures).toEqual([]);
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

describe.skipIf(windows)("the runtime-directory fallback", () => {
	/**
	 * A cache laid out as getAddonCacheDir lays it out, under a home of its
	 * own, and a runtime directory beside it standing in for XDG_RUNTIME_DIR.
	 */
	function layout() {
		const base = makeTempDir();
		const cacheHome = join(base, "cache-home");
		const lastermCache = join(cacheHome, "lasterm");
		const runtime = join(base, "run");
		mkdirSync(cacheHome, { mode: 0o700 });
		mkdirSync(runtime, { mode: 0o700 });
		const below = join("addons", "1.2.3", "linux-x64");
		return {
			base,
			cacheHome,
			lastermCache,
			runtime,
			cacheDir: join(lastermCache, below),
			fallback: join(runtime, "lasterm", below),
			options: { ownedFrom: lastermCache, runtimeDir: runtime },
		};
	}

	it("extracts under the runtime directory when a directory outside lasterm's is loose, and says so once", () => {
		const { cacheHome, lastermCache, cacheDir, fallback, options } = layout();
		// What a umask of 002 leaves behind for a user with a private group.
		chmodSync(cacheHome, 0o775);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const asset = Buffer.from("the embedded addon");
		const first = openCachedAddon("addon.node", cacheDir, asset, options);
		closeSync(first.fd);
		closeSync(openCachedAddon("addon.node", cacheDir, asset, options).fd);
		expect(first.path).toBe(join(fallback, "addon.node"));
		expect(readFileSync(first.path)).toEqual(asset);
		expect(existsSync(lastermCache)).toBe(false);
		expect(stderr).toHaveBeenCalledTimes(1);
		const line = String(stderr.mock.calls[0]?.[0]);
		expect(line).toContain(fallback);
		expect(line).toContain(`${cacheHome} is writable by its group (mode 0775)`);
		expect(line).toContain(`chmod go-w ${cacheHome}`);
		expect(line).toContain("XDG_CACHE_HOME");
	});

	it("loads the addon from the runtime-directory fallback", () => {
		const { cacheHome, cacheDir, fallback, options } = layout();
		chmodSync(cacheHome, 0o775);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const exports = loadNativeAddon("better_sqlite3.node", cacheDir, seaWith(realAddon()), options);
		expect(typeof exports.Database).toBe("function");
		expect(existsSync(join(fallback, "better_sqlite3.node"))).toBe(true);
	});

	// Root owns what a root test creates, and root is trusted.
	it.skipIf(root)("refuses to start when the fallback is refused too, naming both places", () => {
		const { cacheHome, runtime, cacheDir, fallback, options } = layout();
		const someoneElse = (process.geteuid?.() ?? 0) + 1;
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const error = catchError(() =>
			openCachedAddon("addon.node", cacheDir, Buffer.from("addon"), {
				...options,
				uid: someoneElse,
			}),
		);
		expect(error).toBeInstanceOf(UnsafeAddonCacheError);
		const message = (error as Error).message;
		expect(message).toContain(cacheDir);
		expect(message).toContain(fallback);
		expect(existsSync(join(cacheHome, "lasterm"))).toBe(false);
		expect(existsSync(join(runtime, "lasterm"))).toBe(false);
		expect(stderr).not.toHaveBeenCalled();
	});

	it("refuses to start when there is no runtime directory, naming both", () => {
		const { cacheHome, cacheDir, options } = layout();
		chmodSync(cacheHome, 0o775);
		const error = catchError(() =>
			openCachedAddon("addon.node", cacheDir, Buffer.from("addon"), {
				...options,
				runtimeDir: null,
			}),
		);
		expect(error).toBeInstanceOf(UnsafeAddonCacheError);
		expect((error as Error).message).toContain(cacheDir);
		expect((error as Error).message).toContain("XDG_RUNTIME_DIR is not set");
	});

	it("does not fall back from a refusal inside lasterm's own tree", () => {
		const { lastermCache, runtime, cacheDir, options } = layout();
		mkdirSync(lastermCache, { mode: 0o700 });
		// Not a umask: nothing of lasterm's own is ever a file where a directory goes.
		writeFileSync(join(lastermCache, "addons"), "");
		const error = catchError(() =>
			openCachedAddon("addon.node", cacheDir, Buffer.from("addon"), options),
		);
		expect(error).toBeInstanceOf(UnsafeAddonCacheError);
		expect((error as UnsafeAddonCacheError).withinLastermTree).toBe(true);
		expect(existsSync(join(runtime, "lasterm"))).toBe(false);
	});
});

describe("abandoned temporaries", () => {
	it("are removed even when the cached addon is already current", () => {
		const cacheDir = makeTempDir();
		const asset = Buffer.from("complete");
		openAndClose("addon.node", cacheDir, asset);
		// Windows judges by whether the file is held open, POSIX by whether the
		// pid in its name is alive; this one fails both.
		const orphan = join(cacheDir, "addon.node.2147483.0123456789abcdef.tmp");
		writeFileSync(orphan, "interrupted");
		openAndClose("addon.node", cacheDir, asset);
		expect(existsSync(orphan)).toBe(false);
	});

	it.skipIf(windows)("are kept while the process named in them is alive", () => {
		const cacheDir = makeTempDir();
		const live = join(cacheDir, `addon.node.${process.pid}.fedcba9876543210.tmp`);
		writeFileSync(live, "in progress");
		openAndClose("addon.node", cacheDir, Buffer.from("complete"));
		expect(existsSync(live)).toBe(true);
	});

	it.runIf(windows)("are kept while a writer holds them open, whatever pid they name", () => {
		const cacheDir = makeTempDir();
		const live = join(cacheDir, "addon.node.2147483.fedcba9876543210.tmp");
		const writer = openSync(live, "wx");
		try {
			openAndClose("addon.node", cacheDir, Buffer.from("complete"));
			expect(existsSync(live)).toBe(true);
		} finally {
			closeSync(writer);
		}
	});

	it.runIf(windows)("are removed when nothing holds them, though their pid was reused", () => {
		const cacheDir = makeTempDir();
		// This process is alive, but it is not writing this file: a pid Windows
		// handed out again after the extraction that named it was killed.
		const orphan = join(cacheDir, `addon.node.${process.pid}.0123456789abcdef.tmp`);
		writeFileSync(orphan, "interrupted");
		openAndClose("addon.node", cacheDir, Buffer.from("complete"));
		expect(existsSync(orphan)).toBe(false);
	});

	it("leave alone files that are not this addon's temporaries", () => {
		const cacheDir = makeTempDir();
		const others = [
			"addon.node.backup",
			"addon.node.2147483.tmp",
			"addon.node.2147483.0123456789ABCDEF.tmp",
			"other.node.2147483.0123456789abcdef.tmp",
		].map((name) => join(cacheDir, name));
		for (const other of others) writeFileSync(other, "not ours");
		openAndClose("addon.node", cacheDir, Buffer.from("complete"));
		for (const other of others) expect(existsSync(other)).toBe(true);
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
		stdio: ["ignore", "ignore", "pipe"],
	});
}

/**
 * Resolves when `child` exits 0. Otherwise rejects with its exit code or
 * signal and everything it wrote to stderr, which is the only trace of why an
 * extractor failed.
 */
function waitForExit(child: ChildProcess): Promise<void> {
	const stderr: Buffer[] = [];
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		// "close" rather than "exit": it comes after stderr has been read to its end.
		child.once("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			const output = Buffer.concat(stderr).toString("utf8").trim();
			reject(
				new Error(
					`extractor pid ${child.pid} exited ${code ?? `on signal ${signal}`}; its stderr:\n${output.length > 0 ? output : "(empty)"}`,
				),
			);
		});
	});
}
