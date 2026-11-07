/**
 * retired-addon-cache.ts
 *
 * Removes the native addons that earlier single executables extracted into the
 * cache (#889). Until then every version wrote its addons to
 * `addons/<version>/<platform>-<arch>` under lasterm's cache directory, or under
 * `$XDG_RUNTIME_DIR/lasterm` when the cache was refused, and nothing ever
 * removed a version's directory. The hub now loads them from beside its
 * executable, so those copies only take space.
 *
 * Only lasterm's own files go, judged by where they are and what they are
 * called, never by a recursive delete:
 *
 * - a directory is entered only when it is one (not a link or junction), and
 *   on POSIX owned by this account; a version directory only when its name is
 *   a version, a platform directory only when it reads `<platform>-<arch>`;
 * - in one, only a regular file named after an addon an executable extracted,
 *   or after one of its temporaries, is removed;
 * - a directory is then removed only when empty, which a non-recursive rmdir
 *   decides: anything else left there keeps it. That goes up to `addons`, and
 *   no further.
 *
 * What the running version still extracts itself is kept in its own directory:
 * better-sqlite3's addon, until it goes (#893). A file another process holds is
 * left: Windows refuses to remove a library while it is loaded, and the next
 * start finds it again. It runs at every start of the single executable, after
 * the hub lock, and finds nothing more to do once the first has run.
 */

import { lstatSync, readdirSync, rmdirSync, type Stats, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { lastermDir } from "@lasterm/shared/dist/platform-dirs.js";
import { detectSea, readSeaVersion } from "@lasterm/shared/dist/sea-addon-loader.js";

/** Every addon an executable before #889 extracted. */
const EXTRACTED_ADDONS: readonly string[] = [
	"better_sqlite3.node",
	"lasterm_hub_lock.node",
	"lasterm_tls_identity.node",
];

/** What the extractor of the time named a temporary: `<addon>.<pid>.<16 hex>.tmp`. */
const TEMPORARY = /^([a-z0-9_]+\.node)\.[1-9][0-9]*\.[0-9a-f]{16}\.tmp$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORM = /^[a-z0-9]+-[a-z0-9]+$/;

/**
 * What the running executable still extracts into its own version's directory,
 * which therefore stays: better-sqlite3's addon, until #893 removes it.
 */
export const STILL_EXTRACTED: readonly string[] = ["better_sqlite3.node"];

export interface RetireAddonCacheOptions {
	/** Directories that held an `addons` tree: lasterm's cache root, and the runtime fallback. */
	readonly roots: readonly string[];
	/** The running executable's version. */
	readonly version: string;
	/** Names kept in that version's directory. Defaults to STILL_EXTRACTED. */
	readonly stillExtracted?: readonly string[];
	/** The account whose directories and files are lasterm's, on POSIX. Defaults to the effective uid. */
	readonly uid?: number;
}

/** Remove what earlier executables extracted under each root. Never throws. */
export function retireAddonCache(options: RetireAddonCacheOptions): void {
	const uid = options.uid ?? process.geteuid?.() ?? 0;
	for (const root of options.roots) {
		try {
			retireUnder(path.resolve(root), options, uid);
		} catch {
			// Best effort: a cache left behind costs space, never a start.
		}
	}
}

function retireUnder(root: string, options: RetireAddonCacheOptions, uid: number): void {
	const addons = path.join(root, "addons");
	if (!isOwnDirectory(root, uid) || !isOwnDirectory(addons, uid)) return;
	for (const version of entries(addons)) {
		const versionDir = path.join(addons, version);
		if (!VERSION.test(version) || !isOwnDirectory(versionDir, uid)) continue;
		const kept = new Set(
			version === options.version ? (options.stillExtracted ?? STILL_EXTRACTED) : [],
		);
		for (const platform of entries(versionDir)) {
			const platformDir = path.join(versionDir, platform);
			if (!PLATFORM.test(platform) || !isOwnDirectory(platformDir, uid)) continue;
			for (const entry of entries(platformDir)) {
				const addon = EXTRACTED_ADDONS.includes(entry) ? entry : TEMPORARY.exec(entry)?.[1];
				if (addon === undefined || !EXTRACTED_ADDONS.includes(addon) || kept.has(addon)) continue;
				removeOwnFile(path.join(platformDir, entry), uid);
			}
			removeIfEmpty(platformDir);
		}
		removeIfEmpty(versionDir);
	}
	// The root itself stays: under XDG_RUNTIME_DIR it is also where the local
	// agent's socket goes.
	removeIfEmpty(addons);
}

function entries(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

function lstatIfPresent(entry: string): Stats | undefined {
	try {
		return lstatSync(entry);
	} catch {
		return undefined;
	}
}

/** Windows reports no owner, and a junction's lstat as a link; POSIX must show this account. */
function ownedBy(stat: Stats, uid: number): boolean {
	return process.platform === "win32" || stat.uid === uid;
}

function isOwnDirectory(directory: string, uid: number): boolean {
	const stat = lstatIfPresent(directory);
	if (stat === undefined) return false;
	return stat.isDirectory() && ownedBy(stat, uid);
}

function removeOwnFile(file: string, uid: number): void {
	const stat = lstatIfPresent(file);
	if (stat === undefined || !stat.isFile() || !ownedBy(stat, uid)) return;
	try {
		unlinkSync(file);
	} catch {
		// Held by a process that loaded it, or gone already: the next start looks again.
	}
}

function removeIfEmpty(directory: string): void {
	try {
		rmdirSync(directory);
	} catch {
		// Not empty, gone, or not ours to remove: kept.
	}
}

/**
 * The roots an executable before #889 extracted under: lasterm's cache
 * directory and, on POSIX, the fallback under XDG_RUNTIME_DIR.
 */
export function retiredAddonRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const roots = [lastermDir("cache")];
	const runtime = env.XDG_RUNTIME_DIR;
	if (process.platform !== "win32" && runtime !== undefined && path.isAbsolute(runtime)) {
		roots.push(path.join(runtime, "lasterm"));
	}
	return roots;
}

/**
 * What a hub started by the single executable runs after taking its lock. A
 * hub run from source extracted nothing, and leaves the cache alone.
 */
export function retireAddonCacheOfEarlierVersions(): void {
	if (!detectSea()) return;
	try {
		const sea = createRequire(import.meta.url)("node:sea") as {
			getAsset?: (name: string, encoding: BufferEncoding) => string;
		};
		retireAddonCache({ roots: retiredAddonRoots(), version: readSeaVersion(sea) });
	} catch {
		// Best effort, as above.
	}
}
