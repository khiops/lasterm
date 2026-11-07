/**
 * sea-addon-loader.ts
 *
 * Whether this process is a Node Single Executable Application (SEA): the
 * hub's single executable, as opposed to the hub run from source.
 *
 * The executable used to embed its native addons and extract them to a
 * per-version cache directory at startup. It embeds none now: SQLite is
 * node:sqlite, built into its Node (#893), and the hub lock and the TLS
 * identity are installed beside the executable and loaded from there,
 * checked against digests it embeds (installed-addon.ts, #889). What earlier
 * executables extracted is removed at startup by the hub's
 * retired-addon-cache.ts.
 */

import { createRequire } from "node:module";

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
