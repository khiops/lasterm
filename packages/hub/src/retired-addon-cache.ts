/**
 * retired-addon-cache.ts
 *
 * Removes the native addons that earlier single executables extracted into the
 * cache. Until #889 and #893 every version wrote its addons, the hub lock, the
 * TLS identity and better-sqlite3, to `addons/<version>/<platform>-<arch>`
 * under lasterm's cache directory, or under `$XDG_RUNTIME_DIR/lasterm` when
 * the cache was refused, and nothing ever removed a version's directory. The
 * executable now extracts nothing: SQLite is node:sqlite, and the other two are
 * loaded from beside it. Those copies only take space.
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
 * A file another process holds is left: Windows refuses to remove a library
 * an earlier hub still running has loaded, and the next start finds it again.
 * It runs at every start of the single executable, after the hub lock, and
 * finds nothing more to do once the first has run.
 */

import { lstatSync, readdirSync, rmdirSync, type Stats, unlinkSync } from "node:fs";
import path from "node:path";
import { lastermDir } from "@lasterm/shared/dist/platform-dirs.js";
import { detectSea } from "@lasterm/shared/dist/sea-addon-loader.js";

/** Every addon an executable extracted, before #889 and #893. */
const EXTRACTED_ADDONS: readonly string[] = [
	"better_sqlite3.node",
	"lasterm_hub_lock.node",
	"lasterm_tls_identity.node",
];

/** What the extractor of the time named a temporary: `<addon>.<pid>.<16 hex>.tmp`. */
const TEMPORARY = /^([a-z0-9_]+\.node)\.[1-9][0-9]*\.[0-9a-f]{16}\.tmp$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLATFORM = /^[a-z0-9]+-[a-z0-9]+$/;

export interface RetireAddonCacheOptions {
	/** Directories that held an `addons` tree: lasterm's cache root, and the runtime fallback. */
	readonly roots: readonly string[];
	/** The account whose directories and files are lasterm's, on POSIX. Defaults to the effective uid. */
	readonly uid?: number;
}

/** Remove what earlier executables extracted under each root. Never throws. */
export function retireAddonCache(options: RetireAddonCacheOptions): void {
	const uid = options.uid ?? process.geteuid?.() ?? 0;
	for (const root of options.roots) {
		try {
			retireUnder(path.resolve(root), uid);
		} catch {
			// Best effort: a cache left behind costs space, never a start.
		}
	}
}

function retireUnder(root: string, uid: number): void {
	const addons = path.join(root, "addons");
	if (!isOwnDirectory(root, uid) || !isOwnDirectory(addons, uid)) return;
	for (const version of entries(addons)) {
		const versionDir = path.join(addons, version);
		if (!VERSION.test(version) || !isOwnDirectory(versionDir, uid)) continue;
		for (const platform of entries(versionDir)) {
			const platformDir = path.join(versionDir, platform);
			if (!PLATFORM.test(platform) || !isOwnDirectory(platformDir, uid)) continue;
			for (const entry of entries(platformDir)) {
				const addon = EXTRACTED_ADDONS.includes(entry) ? entry : TEMPORARY.exec(entry)?.[1];
				if (addon === undefined || !EXTRACTED_ADDONS.includes(addon)) continue;
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
 * The roots an earlier executable extracted under: lasterm's cache directory
 * and, on POSIX, the fallback under XDG_RUNTIME_DIR.
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
 * hub run from source never extracted anything, and leaves the cache alone.
 */
export function retireAddonCacheOfEarlierVersions(): void {
	if (!detectSea()) return;
	try {
		retireAddonCache({ roots: retiredAddonRoots() });
	} catch {
		// Best effort, as above.
	}
}
