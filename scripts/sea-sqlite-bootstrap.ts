/**
 * SEA prelude entry for better-sqlite3.
 *
 * build-sea-hub bundles this file into its banner. Keeping this as normal
 * TypeScript means the executable uses the shared extractor rather than a
 * handwritten string copy of its extraction decision.
 */

import { createRequire } from "node:module";
import { getAddonCacheDir, loadNativeAddon } from "../packages/shared/src/sea-addon-loader.js";

interface SeaModule {
	isSea?: () => boolean;
	getRawAsset: (name: string) => ArrayBuffer;
	getAsset?: (name: string, encoding: BufferEncoding) => string;
}

(function bootstrapSeaSqlite(): void {
	const req = createRequire(__filename);
	let sea: SeaModule | undefined;
	try {
		sea = req("node:sea") as SeaModule;
	} catch {
		return;
	}
	if (typeof sea.isSea !== "function" || !sea.isSea()) return;

	let version = "0.0.0";
	try {
		version = sea.getAsset?.("VERSION", "utf8").trim() || version;
	} catch {
		// A missing version only changes the cache location, not startup semantics.
	}

	try {
		const globals = globalThis as typeof globalThis & {
			__seaSqliteExports?: Record<string, unknown>;
		};
		globals.__seaSqliteExports = loadNativeAddon(
			"better_sqlite3.node",
			getAddonCacheDir(version),
			sea,
		);
	} catch (error) {
		process.stderr.write(
			`[lasterm-hub] fatal: cannot extract or load better_sqlite3.node: ${String(error)}\n`,
		);
		process.exit(1);
	}
})();
