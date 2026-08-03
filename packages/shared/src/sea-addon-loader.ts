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
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";

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
 * Returns the persistent cache directory for SEA addon extractions.
 * Uses the package version as a cache-busting path segment so that
 * upgrades always extract fresh binaries.
 */
export function getAddonCacheDir(version: string): string {
	const base =
		platform() === "win32"
			? join(process.env.LOCALAPPDATA ?? homedir(), "termora", "cache")
			: join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "termora");
	return join(base, "addons", version);
}

/**
 * Extract a single .node asset from the SEA binary to disk.
 * Skips extraction if a file with the correct size already exists (idempotent).
 * New bytes are written beside the destination and atomically renamed into
 * place, so a concurrent loader can only observe the old complete file or the
 * new complete file, never a partially-written addon.
 *
 * @param assetName  - The asset key used in the SEA config (e.g. "better_sqlite3.node").
 * @param cacheDir   - Target directory (created if absent).
 * @param assetData  - Raw bytes of the addon.
 * @returns The absolute path to the extracted .node file.
 */
export function extractAddonToDir(assetName: string, cacheDir: string, assetData: Buffer): string {
	const destPath = join(cacheDir, assetName);

	// Only write if the file doesn't exist or has a different size.
	// We intentionally avoid hash checks for performance — size is sufficient
	// for cache-busting because we version the cache dir.
	let shouldWrite = true;
	if (existsSync(destPath)) {
		try {
			const stat = statSync(destPath);
			if (stat.size === assetData.byteLength) {
				shouldWrite = false;
			}
		} catch {
			// Stat failed — re-extract to be safe.
		}
	}

	if (shouldWrite) {
		mkdirSync(cacheDir, { recursive: true });
		const tempPath = createAddonTempPath(destPath);
		try {
			writeFileSync(tempPath, assetData, { mode: 0o755, flag: "wx" });
			renameSync(tempPath, destPath);
		} catch (error) {
			// On platforms where rename cannot replace an already-loaded file, a
			// racing writer may have already published the identical complete blob.
			// Accept only that exact complete result; never fall back to a direct write.
			try {
				if (statSync(destPath).size === assetData.byteLength) return destPath;
			} catch {
				// Keep the original extraction error below.
			}
			throw error;
		} finally {
			rmSync(tempPath, { force: true });
		}
	}

	return destPath;
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
