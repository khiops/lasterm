/**
 * sea-addon-loader.ts
 *
 * Shared utilities for native addon bootstrap in Node Single Executable
 * Applications (SEA).
 *
 * In SEA mode, .node binary addons are embedded as asset blobs and cannot be
 * loaded directly via require(). This module provides helpers to detect SEA
 * mode, compute a versioned cache directory, extract blobs to disk, and load
 * them via process.dlopen().
 *
 * In normal Node.js mode (no SEA), detectSea() returns false and the rest is
 * unused.
 *
 * Each package (hub, agent) imports these helpers and supplies its own
 * SEA_ADDON_ASSETS list + initSeaAddons() entry point.
 */

import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { lastermDir } from "./platform-dirs.js";

/** Detect whether we are running inside a Node SEA binary. */
export function detectSea(): boolean {
	try {
		// node:sea is only available in Node 21.7+ / 20.12+
		// In older Node or normal execution, this throws or returns false.
		const req = createRequire(import.meta.url);
		const seaMod = req("node:sea") as { isSea?: () => boolean };
		return typeof seaMod.isSea === "function" && seaMod.isSea();
	} catch {
		return false;
	}
}

/**
 * Returns the persistent cache directory for SEA addon extractions: one per
 * version, platform and architecture, so an upgrade extracts fresh binaries
 * and two installations sharing a profile never reuse each other's (#128).
 */
export function getAddonCacheDir(version: string): string {
	return join(lastermDir("cache"), "addons", version, `${process.platform}-${process.arch}`);
}

/**
 * The version the executable was built with, from its embedded `VERSION`
 * asset. A missing or empty one is an error: it used to read as "0.0.0" and
 * send every such build to one shared cache directory (#128).
 */
export function readSeaVersion(sea: {
	getAsset?: (name: string, encoding: BufferEncoding) => string;
}): string {
	let version = "";
	try {
		version = sea.getAsset?.("VERSION", "utf8").trim() ?? "";
	} catch {
		// Reported below: the asset is absent.
	}
	if (version.length === 0) {
		throw new Error("this executable carries no VERSION asset; it was not packaged correctly");
	}
	return version;
}

/**
 * Extract a single .node asset from the SEA binary to disk.
 * A file already at the destination is reused only when its bytes are the
 * embedded asset's: a size match proves nothing about what would be loaded
 * (#128, #216). New bytes are written beside the destination and atomically
 * renamed into place, so a concurrent loader can only observe the old complete
 * file or the new complete file, never a partially-written addon.
 *
 * @param assetName  - The asset key used in the SEA config (e.g. "better_sqlite3.node").
 * @param cacheDir   - Target directory (created if absent).
 * @param assetData  - Raw bytes of the addon.
 * @returns The absolute path to the extracted .node file.
 */
export function extractAddonToDir(assetName: string, cacheDir: string, assetData: Buffer): string {
	const destPath = join(cacheDir, assetName);
	if (holdsExactly(destPath, assetData)) return destPath;

	mkdirSync(cacheDir, { recursive: true });
	removeOrphanedTemporaries(destPath);
	const tempPath = createAddonTempPath(destPath);
	try {
		writeFileSync(tempPath, assetData, { mode: 0o755, flag: "wx" });
		renameSync(tempPath, destPath);
	} catch (error) {
		// On platforms where rename cannot replace an already-loaded file, a
		// racing writer may have already published the identical complete blob.
		// Accept only that exact result; never fall back to a direct write.
		if (holdsExactly(destPath, assetData)) return destPath;
		throw error;
	} finally {
		rmSync(tempPath, { force: true });
	}
	return destPath;
}

/** True when `path` is a readable file whose bytes are exactly `expected`. */
function holdsExactly(path: string, expected: Buffer): boolean {
	try {
		return readFileSync(path).equals(expected);
	} catch {
		return false;
	}
}

/**
 * Remove temporaries an interrupted extraction left beside `destPath`. Each is
 * named after the process that wrote it, and only one whose writer is gone is
 * removed, so a concurrent extraction keeps its own (#128, from #130).
 */
function removeOrphanedTemporaries(destPath: string): void {
	const prefix = `${basename(destPath)}.`;
	let entries: string[];
	try {
		entries = readdirSync(dirname(destPath));
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
		const pid = Number(entry.slice(prefix.length).split(".")[0]);
		if (!Number.isInteger(pid) || pid <= 0 || isRunning(pid)) continue;
		rmSync(join(dirname(destPath), entry), { force: true });
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function createAddonTempPath(destPath: string): string {
	for (let attempt = 0; attempt < 32; attempt++) {
		const candidate = `${destPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not allocate a temporary addon path beside ${destPath}`);
}

/**
 * Load a native .node addon from an absolute path using process.dlopen().
 * This is equivalent to require('./addon.node') for native modules.
 */
export function dlopenAddon(addonPath: string): Record<string, unknown> {
	// process.dlopen expects a module-like object and modifies its exports.
	const mod = { exports: {} as Record<string, unknown> };
	process.dlopen(mod, addonPath);
	return mod.exports;
}

/**
 * Load a native addon: extract from SEA assets to cache dir, then dlopen.
 *
 * @param name      - Asset name (e.g. "better_sqlite3.node").
 * @param cacheDir  - Pre-computed cache directory path.
 * @param seaModule - Injected SEA module interface (for testability).
 */
export function loadNativeAddon(
	name: string,
	cacheDir: string,
	seaModule: { getRawAsset: (name: string) => ArrayBuffer },
): Record<string, unknown> {
	const blob = seaModule.getRawAsset(name);
	const data = Buffer.from(blob);
	const addonPath = extractAddonToDir(name, cacheDir, data);
	return dlopenAddon(addonPath);
}
