/**
 * sea-addon-loader.ts — hub
 *
 * Native addon bootstrap for Node Single Executable Applications (SEA).
 * Hub-specific entry point: lists the addons embedded in the hub SEA binary
 * and calls initSeaAddons() once at startup.
 *
 * Shared helpers (detectSea, getAddonCacheDir, openCachedAddon, loadCachedAddon,
 * loadNativeAddon) live in @lasterm/shared.
 *
 * SQLite is not among these addons: the hub uses node:sqlite, built into the
 * Node the executable embeds (#893).
 */

import { createRequire } from "node:module";
import {
	detectSea,
	getAddonCacheDir,
	loadNativeAddon,
	readSeaVersion,
} from "@lasterm/shared/dist/sea-addon-loader.js";

// Re-export shared helpers so existing callers/tests that import from this
// file continue to work unchanged.
export {
	detectSea,
	dlopenAddon,
	getAddonCacheDir,
	loadCachedAddon,
	loadNativeAddon,
	openCachedAddon,
	readSeaVersion,
} from "@lasterm/shared/dist/sea-addon-loader.js";

/** Names of .node assets embedded in the hub SEA binary. */
const SEA_ADDON_ASSETS: readonly string[] = ["lasterm_tls_identity.node"] as const;

/**
 * In SEA mode: extracts all embedded .node addons to the cache dir and
 * pre-loads them.
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

	let cacheDir: string;
	try {
		cacheDir = getAddonCacheDir(readSeaVersion(seaMod));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[lasterm-hub] fatal: ${msg}\n`);
		process.exit(1);
	}

	for (const assetName of SEA_ADDON_ASSETS) {
		try {
			loadNativeAddon(assetName, cacheDir, seaMod);
		} catch (err) {
			// Extraction or dlopen failure is fatal — the hub cannot function
			// without its addons. Let the process crash with a clear message.
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`[lasterm-hub] fatal: failed to load SEA addon '${assetName}': ${msg}\n`,
			);
			process.exit(1);
		}
	}
}
