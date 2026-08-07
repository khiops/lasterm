/**
 * sea-addon-loader.ts — hub
 *
 * Native addon bootstrap for Node Single Executable Applications (SEA).
 * Hub-specific entry point: lists the addons embedded in the hub SEA binary
 * and calls initSeaAddons() once at startup.
 *
 * Shared helpers (detectSea, getAddonCacheDir, extractAddonToDir, dlopenAddon,
 * loadNativeAddon) live in @lasterm/shared.
 *
 * Must be called via initSeaAddons() BEFORE any module that imports
 * better-sqlite3.
 */

import { createRequire } from "node:module";
import {
	detectSea,
	getAddonCacheDir,
	loadNativeAddon,
} from "@lasterm/shared/dist/sea-addon-loader.js";

// Re-export shared helpers so existing callers/tests that import from this
// file continue to work unchanged.
export {
	detectSea,
	dlopenAddon,
	extractAddonToDir,
	getAddonCacheDir,
	loadNativeAddon,
} from "@lasterm/shared/dist/sea-addon-loader.js";

/** Names of .node assets embedded in the hub SEA binary. */
const SEA_ADDON_ASSETS: readonly string[] = ["better_sqlite3.node"] as const;

/**
 * Called once at hub startup (before any better-sqlite3 imports).
 *
 * In SEA mode: extracts all embedded .node addons to the cache dir and
 * pre-loads them so subsequent require('better-sqlite3') calls resolve.
 *
 * In normal Node.js mode: complete no-op.
 */
export function initSeaAddons(): void {
	if (!detectSea()) {
		// Normal Node.js execution — native addons load via standard require().
		return;
	}

	const req = createRequire(import.meta.url);
	const seaMod = req("node:sea") as {
		getRawAsset: (name: string) => ArrayBuffer;
		getAsset?: (name: string, encoding: BufferEncoding) => string;
	};

	// Read the package version from SEA asset manifest (injected at build time).
	// Fall back to "0.0.0" if not present so we don't crash startup.
	let version = "0.0.0";
	try {
		if (typeof seaMod.getAsset === "function") {
			version = seaMod.getAsset("VERSION", "utf8").trim();
		}
	} catch {
		// Non-fatal: use default version.
	}

	const cacheDir = getAddonCacheDir(version);

	for (const assetName of SEA_ADDON_ASSETS) {
		try {
			loadNativeAddon(assetName, cacheDir, seaMod);
		} catch (err) {
			// Extraction or dlopen failure is fatal — the hub cannot function
			// without SQLite support. Let the process crash with a clear message.
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`[lasterm-hub] fatal: failed to load SEA addon '${assetName}': ${msg}\n`,
			);
			process.exit(1);
		}
	}
}
