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
 *
 * What the cache guarantees is that only the embedded addon is executed from
 * it (#216). The actor that matters is a different local account able to write
 * a directory on the path to the cache. A process running as the same user is
 * out of scope: it can already read auth.json, rewrite the state and kill the
 * hub, so substituting an addon gains it nothing. Root is trusted.
 *
 * - Every file is authenticated before it is loaded: its SHA-256, read through
 *   the descriptor it was opened with, must be the embedded asset's. A size
 *   match proves nothing (#128).
 * - On Linux (and any other POSIX system) the directory chain is examined
 *   before the cache is used, and a chain another account could change is
 *   not used: the addons go to a fallback under XDG_RUNTIME_DIR instead, and
 *   the start fails only when that is unusable too. See ensurePrivateCacheDir
 *   and privateAddonDir.
 * - On Linux the addon is loaded through that descriptor, so what dlopen maps
 *   is the file that was hashed. Windows cannot do that, and what it relies on
 *   instead is written out at loadVerifiedAddon.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	renameSync,
	type Stats,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { lastermDir } from "./platform-dirs.js";

// O_NOFOLLOW refuses a link at the leaf; O_NONBLOCK keeps a FIFO planted there
// from blocking the open. Neither exists on Windows, where the leaf is
// inspected with lstat instead.
const OPEN_NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_NON_BLOCKING = constants.O_NONBLOCK ?? 0;

/** The sticky bit, which fs.constants does not name. */
const S_ISVTX = 0o1000;

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
	return path.join(lastermDir("cache"), "addons", version, `${process.platform}-${process.arch}`);
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

/** Thrown when a directory on the path to the addon cache is not private to this account. */
export class UnsafeAddonCacheError extends Error {
	readonly code = "LASTERM_ADDON_CACHE_UNSAFE";

	/**
	 * @param directory - The directory or link that was refused.
	 * @param reason    - Why, as a predicate of `directory` ("is writable by its group …").
	 * @param withinLastermTree - Whether it lies in lasterm's own directory,
	 *   where a refusal means something other than a loose umask.
	 * @param message   - Replaces the default message, for a refusal of two places.
	 */
	constructor(
		readonly directory: string,
		readonly reason: string,
		readonly withinLastermTree = false,
		message?: string,
	) {
		super(
			message ??
				`refusing the native addon cache: ${directory} ${reason}, so another account could replace the code this process loads. Every directory on the way to the cache must belong to this account or root and be writable by neither group nor others unless it is sticky: fix ${directory}, or set XDG_CACHE_HOME to a directory that meets this`,
		);
		this.name = "UnsafeAddonCacheError";
	}
}

/** What tests substitute for the process's own environment. */
export interface AddonCacheOptions {
	/** lasterm's own cache root. Defaults to lastermDir("cache"). */
	readonly ownedFrom?: string | undefined;
	/**
	 * The runtime directory the fallback goes under. Defaults to
	 * XDG_RUNTIME_DIR when that is an absolute path; null means there is none.
	 */
	readonly runtimeDir?: string | null;
	/** The account the directories must be private to. Defaults to the effective uid. */
	readonly uid?: number;
}

/**
 * An addon file whose bytes were authenticated through `fd`, which is still
 * open. Hand it to loadVerifiedAddon, or close `fd`.
 */
export interface VerifiedAddonFile {
	readonly path: string;
	readonly fd: number;
}

interface ExpectedAddon {
	readonly size: number;
	readonly sha256: Buffer;
}

/**
 * Put the embedded addon in the cache and open it, authenticated.
 *
 * A file already at the destination is reused only when the descriptor opened
 * on it shows the embedded asset's SHA-256 and, on POSIX, a regular file this
 * account (or root) owns and nobody else may write. Anything else is replaced:
 * new bytes are written beside the destination and atomically renamed into
 * place, so a concurrent loader can only observe the old complete file or the
 * new complete file, never a partially-written addon. The published file is
 * then opened and authenticated like a cached one, and that descriptor is what
 * the caller loads.
 *
 * @param assetName  - The asset key used in the SEA config (e.g. "better_sqlite3.node").
 * @param cacheDir   - Target directory (created if absent, examined before use).
 * @param assetData  - Raw bytes of the addon, as embedded in the executable.
 * @param options    - Substitutes for the environment, for tests.
 */
export function openCachedAddon(
	assetName: string,
	cacheDir: string,
	assetData: Buffer,
	options: AddonCacheOptions = {},
): VerifiedAddonFile {
	if (path.basename(assetName) !== assetName || assetName === "." || assetName === "..") {
		throw new Error(`addon asset name ${JSON.stringify(assetName)} is not a single file name`);
	}
	const dir = privateAddonDir(path.resolve(cacheDir), options);
	const uid = options.uid ?? process.geteuid?.() ?? 0;
	const destPath = path.join(dir, assetName);
	const expected: ExpectedAddon = { size: assetData.length, sha256: sha256(assetData) };
	removeAbandonedTemporaries(dir, assetName);

	const cached = openIfAuthentic(destPath, expected, uid);
	if (cached !== undefined) return { path: destPath, fd: cached };

	let renameError = publish(destPath, assetData);
	if ((renameError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
		// The temporary went before it could be renamed: a cleanup that could not
		// see this process running took it (see removeAbandonedTemporaries).
		// Writing it once more costs one extraction; failing would cost the start.
		renameError = publish(destPath, assetData);
	}
	// On platforms where rename cannot replace an already-loaded file, a racing
	// writer may have already published the identical complete blob, so the
	// destination is authenticated whether or not this rename succeeded. Only
	// that exact result is accepted; there is never a fallback to a direct write.
	const published = openIfAuthentic(destPath, expected, uid);
	if (published !== undefined) return { path: destPath, fd: published };
	if (renameError !== undefined) throw renameError;
	throw new Error(
		`the addon just written to ${destPath} does not hold the embedded bytes; something else is writing to the addon cache`,
	);
}

/**
 * Load a file openCachedAddon authenticated, and take ownership of its
 * descriptor.
 *
 * On Linux, dlopen is given /proc/self/fd/N rather than the name. That opens
 * the inode the descriptor refers to, so what is mapped is the file that was
 * hashed, whatever the name has come to mean since. The descriptor is never
 * closed afterwards: glibc recognises an already-loaded library by the name it
 * was opened with before it looks at the file, so a later dlopen of the same
 * /proc/self/fd/N for a different addon, after the number was reused, would
 * return this one.
 *
 * Windows' LoadLibrary accepts only a name, which it resolves again. Node opens
 * a file either with full sharing, which lets another process rename or delete
 * it, or with none, which would shut LoadLibrary out too, so the window cannot
 * be closed from here. It is narrowed: the verified handle is held across the
 * load, and while it is open NTFS refuses to rename any directory above the
 * file. The name can then come to mean another file only through the cache
 * directory's own entries — the file renamed or deleted and another put in its
 * place — or through a write to the file. Who may do either is decided by the
 * ACLs of that directory and that file, which nothing here can read (see
 * ensurePrivateCacheDir); with the default ACL of %LOCALAPPDATA% that is this
 * user, administrators and SYSTEM.
 */
export function loadVerifiedAddon(file: VerifiedAddonFile): Record<string, unknown> {
	const throughDescriptor = descriptorPath(file.fd);
	if (throughDescriptor !== undefined) return dlopenAddon(throughDescriptor);
	try {
		return dlopenAddon(file.path);
	} finally {
		closeSync(file.fd);
	}
}

/** Put the embedded addon in the cache, authenticate it, and load it. */
export function loadCachedAddon(
	assetName: string,
	cacheDir: string,
	assetData: Buffer,
	options: AddonCacheOptions = {},
): Record<string, unknown> {
	return loadVerifiedAddon(openCachedAddon(assetName, cacheDir, assetData, options));
}

/**
 * Load a native .node addon from an absolute path using process.dlopen().
 * This is equivalent to require('./addon.node') for native modules, and checks
 * nothing about the file: use loadCachedAddon for anything taken from the
 * addon cache.
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
	options: AddonCacheOptions = {},
): Record<string, unknown> {
	return loadCachedAddon(name, cacheDir, Buffer.from(seaModule.getRawAsset(name)), options);
}

/**
 * The directory the addons are extracted to: `cacheDir` when its chain is
 * private, and otherwise the same path under XDG_RUNTIME_DIR.
 *
 * A directory refused outside lasterm's own tree is most often a loose umask
 * rather than an attack: with a user-private group, Debian and Ubuntu run with
 * 002, and a ~/.cache that pip, npm or mkdir -p creates there is 0775 although
 * nobody else is in the group. Nothing here can tell those cases apart — group
 * membership can come from NSS, LDAP or anything else — so the cache is not
 * used, and the addons go to $XDG_RUNTIME_DIR/lasterm/<the same path below
 * lasterm's cache root>, walked by the same rules. On systemd that directory
 * is a tmpfs, 0700 and owned by the user, so the cost is one extraction per
 * boot. One line on stderr says why and how to stop it.
 *
 * A refusal inside lasterm's own tree is not a umask, since loose directories
 * of this account's there are tightened, and it is thrown as it is. So is one
 * the fallback cannot answer: no runtime directory, or one refused too.
 */
function privateAddonDir(dir: string, options: AddonCacheOptions): string {
	const uid = options.uid ?? process.geteuid?.() ?? 0;
	const ownedFrom = "ownedFrom" in options ? options.ownedFrom : lastermCacheRoot();
	let refusal: UnsafeAddonCacheError;
	try {
		ensurePrivateCacheDir(dir, { ownedFrom, uid });
		return dir;
	} catch (error) {
		if (!(error instanceof UnsafeAddonCacheError) || error.withinLastermTree) throw error;
		refusal = error;
	}

	// Only a directory of lasterm's cache has a counterpart under the runtime
	// directory; any other is refused as it is.
	const below = ownedFrom === undefined ? undefined : path.relative(path.resolve(ownedFrom), dir);
	if (below === undefined || escapes(below)) throw refusal;
	const runtimeDir = options.runtimeDir === undefined ? runtimeDirFromEnv() : options.runtimeDir;
	if (runtimeDir === null) {
		throw refusedTwice(
			dir,
			refusal,
			"under XDG_RUNTIME_DIR",
			"XDG_RUNTIME_DIR is not set to an absolute path",
		);
	}
	const fallbackRoot = path.join(runtimeDir, "lasterm");
	const fallback = path.join(fallbackRoot, below);
	try {
		ensurePrivateCacheDir(fallback, { ownedFrom: fallbackRoot, uid });
	} catch (error) {
		if (!(error instanceof UnsafeAddonCacheError)) throw error;
		throw refusedTwice(dir, refusal, fallback, `${error.directory} ${error.reason}`);
	}
	warnOnce(
		`[lasterm] loading native addons from ${fallback}, extracted again after each reboot, instead of the cache ${dir}: ${refusal.directory} ${refusal.reason}. To use the cache, ${remedy(refusal)}.`,
	);
	return fallback;
}

function refusedTwice(
	dir: string,
	refusal: UnsafeAddonCacheError,
	fallback: string,
	fallbackReason: string,
): UnsafeAddonCacheError {
	return new UnsafeAddonCacheError(
		refusal.directory,
		refusal.reason,
		false,
		`refusing both places for native addons, since another account could replace the code this process loads from either. The cache ${dir}: ${refusal.directory} ${refusal.reason}. The fallback ${fallback}: ${fallbackReason}. To start, ${remedy(refusal)}`,
	);
}

function remedy(refusal: UnsafeAddonCacheError): string {
	const tighten = refusal.reason.startsWith(WRITABLE_BY)
		? `remove that write access (chmod go-w ${refusal.directory}) or `
		: "";
	return `${tighten}set XDG_CACHE_HOME to a directory where every component belongs to this account or root and is writable by neither group nor others unless sticky`;
}

function runtimeDirFromEnv(): string | null {
	const value = process.env.XDG_RUNTIME_DIR;
	return value !== undefined && path.isAbsolute(value) ? value : null;
}

function escapes(relative: string): boolean {
	return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Write `line` to stderr once per process. The flag lives on globalThis because
 * the single executable bundles this module twice — once in the better-sqlite3
 * prelude and once in the hub — and both load from the same cache.
 */
function warnOnce(line: string): void {
	const key = Symbol.for("lasterm.addonCache.warned");
	const globals = globalThis as typeof globalThis & { [key: symbol]: Set<string> | undefined };
	const warned = globals[key] ?? new Set<string>();
	globals[key] = warned;
	if (warned.has(line)) return;
	warned.add(line);
	process.stderr.write(`${line}\n`);
}

export interface PrivateCacheDirOptions {
	/**
	 * lasterm's own cache root. A directory at or below it that this account
	 * owns and group or others may write is tightened instead of refused: an
	 * earlier version created these directories with the process umask, which is
	 * 002 for a user with a private group on several distributions.
	 */
	readonly ownedFrom?: string | undefined;
	/** The account the chain must be private to. Defaults to the effective uid; tests substitute it. */
	readonly uid?: number;
}

/**
 * Create `dir` if it is missing and, on POSIX, refuse it unless no account
 * other than this one and root can change what it contains.
 *
 * The walk starts at the filesystem root and looks up one component at a time.
 * Every directory it looks a name up in must be owned by this account or root
 * and be writable by neither group nor others, unless it carries the sticky
 * bit. Every entry it passes through — directory or symbolic link — must be
 * owned by this account or root, which is what makes a sticky directory safe
 * to cross: others may add entries there, but not replace ours. A symbolic
 * link is followed, its target walked the same way, so a home reached through
 * one (/home -> /var/home) is accepted when every directory involved is
 * private. A missing directory is created 0700. A refusal says whether it
 * fell inside lasterm's own tree; openCachedAddon falls back to the runtime
 * directory for one that did not (see privateAddonDir).
 *
 * Checked top-down, the result stays true after the walk: another account
 * cannot change the entries of a directory it cannot write, nor the mode or
 * owner of one it does not own, so the names checked here resolve the same way
 * when they are used. The group bits of a directory carrying a POSIX ACL are
 * its ACL mask, so a named user or group granted write shows as group-writable
 * and is refused. ACL models the mode bits do not reflect (NFSv4 ACLs, for
 * one) are not read.
 *
 * Windows is not examined. Node reports neither the owner nor the DACL of a
 * file there — the uid is always 0 and the mode bits are synthesised from the
 * read-only attribute — so it cannot tell whether another account may write a
 * directory. Links and junctions on the path are not examined either: whoever
 * could plant one could equally rename a real directory, so without the ACL
 * neither says anything. The cache relies on the profile's default ACL, as
 * auth.json does (#200). A cache redirected into a directory other accounts
 * may write, which is what folders created at the root of a drive usually
 * are, is not detected.
 */
export function ensurePrivateCacheDir(dir: string, options: PrivateCacheDirOptions = {}): void {
	const target = path.resolve(dir);
	if (process.platform === "win32") {
		mkdirSync(target, { recursive: true });
		return;
	}
	const uid = options.uid ?? process.geteuid?.() ?? 0;
	const ownedIndex = ownedComponentIndex(target, options.ownedFrom);
	const root = path.parse(target).root;
	inspectDirectory(root, lstatSync(root), uid, false);

	const resolved: string[] = [];
	const pending = components(target).map((name, index) => ({ name, owned: index >= ownedIndex }));
	let links = 0;
	for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
		if (next.name === ".") continue;
		if (next.name === "..") {
			resolved.pop();
			continue;
		}
		const candidate = path.join(root, ...resolved, next.name);
		let stat = lstatIfPresent(candidate);
		if (stat === undefined) {
			try {
				mkdirSync(candidate, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			stat = lstatSync(candidate);
		}
		if (stat.isSymbolicLink()) {
			requireTrustedOwner(candidate, stat, uid, "symbolic link", next.owned);
			links += 1;
			if (links > 40) {
				throw new UnsafeAddonCacheError(target, "resolves through more than 40 symbolic links");
			}
			const link = readlinkSync(candidate);
			// An absolute target restarts at the root, which is already checked.
			if (path.isAbsolute(link)) resolved.length = 0;
			// What a link points to is not lasterm's to tighten, whatever the
			// link itself is called.
			pending.unshift(...components(link).map((name) => ({ name, owned: false })));
			continue;
		}
		inspectDirectory(candidate, stat, uid, next.owned);
		resolved.push(next.name);
	}
}

const WRITABLE_BY = "is writable by";

function inspectDirectory(directory: string, stat: Stats, uid: number, owned: boolean): void {
	if (!stat.isDirectory()) {
		throw new UnsafeAddonCacheError(directory, "is not a directory", owned);
	}
	requireTrustedOwner(directory, stat, uid, "directory", owned);
	if ((stat.mode & 0o022) === 0 || (stat.mode & S_ISVTX) !== 0) return;
	if (owned && stat.uid === uid) {
		chmodSync(directory, stat.mode & 0o7777 & ~0o022);
		const tightened = lstatSync(directory);
		if (tightened.isDirectory() && (tightened.mode & 0o022) === 0) return;
	}
	const who = (stat.mode & 0o002) !== 0 ? "others" : "its group";
	throw new UnsafeAddonCacheError(
		directory,
		`${WRITABLE_BY} ${who} (mode ${(stat.mode & 0o7777).toString(8).padStart(4, "0")}) and is not sticky`,
		owned,
	);
}

function requireTrustedOwner(
	entry: string,
	stat: Stats,
	uid: number,
	kind: string,
	owned: boolean,
): void {
	if (stat.uid === uid || stat.uid === 0) return;
	throw new UnsafeAddonCacheError(
		entry,
		`is a ${kind} owned by uid ${stat.uid}, which is neither this account nor root`,
		owned,
	);
}

/** Index of the first component of `target` inside `ownedFrom`, or Infinity when it is outside. */
function ownedComponentIndex(target: string, ownedFrom: string | undefined): number {
	if (ownedFrom === undefined) return Number.POSITIVE_INFINITY;
	const owned = path.resolve(ownedFrom);
	const relative = path.relative(owned, target);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return Number.POSITIVE_INFINITY;
	}
	return components(owned).length - 1;
}

function components(value: string): string[] {
	return value.split(path.sep).filter((name) => name.length > 0);
}

function lstatIfPresent(entry: string): Stats | undefined {
	try {
		return lstatSync(entry);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function lastermCacheRoot(): string | undefined {
	try {
		return lastermDir("cache");
	} catch {
		// Without a resolvable cache root nothing is tightened; a loose
		// directory is then refused like any other.
		return undefined;
	}
}

/**
 * How many times openIfAuthentic looks at an entry that was replaced between
 * its lstat and its open, which only Windows does. A concurrent extraction
 * replaces the entry when it publishes, so each attempt past the first needs
 * one more process publishing inside the window between two system calls.
 */
const REPLACED_ENTRY_ATTEMPTS = 8;

/** What openAuthenticOnce returns when the entry it opened is not the one it inspected. */
const REPLACED: unique symbol = Symbol("replaced");

/**
 * Open `filePath` and return the descriptor when it holds exactly the expected
 * addon, judged on that descriptor; otherwise return undefined.
 *
 * On Windows the entry is inspected before it is opened, and a concurrent
 * extraction replaces it in between whenever it renames its own copy into
 * place (#563). That copy was written from the same embedded bytes, and it is
 * checked like any other, so the name is looked at again rather than the load
 * failing.
 */
function openIfAuthentic(
	filePath: string,
	expected: ExpectedAddon,
	uid: number,
): number | undefined {
	for (let attempt = 1; ; attempt++) {
		const opened = openAuthenticOnce(filePath, expected, uid);
		if (opened !== REPLACED) return opened;
		if (attempt === REPLACED_ENTRY_ATTEMPTS) return undefined;
	}
}

function openAuthenticOnce(
	filePath: string,
	expected: ExpectedAddon,
	uid: number,
): number | typeof REPLACED | undefined {
	let before: BigIntStats | undefined;
	let fd: number;
	try {
		if (process.platform === "win32") {
			// Node cannot open a file on Windows without following a link or
			// junction, so the entry is inspected first and the handle compared
			// with it below.
			before = lstatSync(filePath, { bigint: true });
			if (!before.isFile()) return undefined;
		}
		fd = openSync(filePath, constants.O_RDONLY | OPEN_NO_FOLLOW | OPEN_NON_BLOCKING);
	} catch {
		return undefined;
	}
	let replaced = false;
	try {
		const stat = fstatSync(fd, { bigint: true });
		replaced = before !== undefined && (stat.dev !== before.dev || stat.ino !== before.ino);
		if (!replaced && isTrustedFile(stat, expected.size, uid) && digestMatches(fd, expected)) {
			return fd;
		}
	} catch {
		// Unreadable is not authentic.
	}
	closeSync(fd);
	return replaced ? REPLACED : undefined;
}

function isTrustedFile(stat: BigIntStats, size: number, uid: number): boolean {
	if (!stat.isFile() || stat.size !== BigInt(size)) return false;
	if (process.platform === "win32") return true;
	return (stat.uid === BigInt(uid) || stat.uid === 0n) && (stat.mode & 0o022n) === 0n;
}

function digestMatches(fd: number, expected: ExpectedAddon): boolean {
	const hash = createHash("sha256");
	const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(expected.size, 1 << 20)));
	let offset = 0;
	while (offset < expected.size) {
		const read = readSync(fd, chunk, 0, Math.min(chunk.length, expected.size - offset), offset);
		if (read === 0) return false;
		hash.update(chunk.subarray(0, read));
		offset += read;
	}
	return hash.digest().equals(expected.sha256);
}

function sha256(data: Buffer): Buffer {
	return createHash("sha256").update(data).digest();
}

/** /proc/self/fd/N when it opens the file `fd` holds (Linux with /proc mounted). */
function descriptorPath(fd: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	const candidate = `/proc/self/fd/${fd}`;
	try {
		const viaProc = statSync(candidate, { bigint: true });
		const held = fstatSync(fd, { bigint: true });
		return viaProc.dev === held.dev && viaProc.ino === held.ino ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Write `data` beside `destPath` and rename it into place. Returns the rename
 * error, if any, for the caller to weigh against what is at the destination.
 */
function publish(destPath: string, data: Buffer): unknown {
	const tempPath = createAddonTempPath(destPath);
	const fd = openSync(tempPath, "wx", 0o755);
	let renamed = false;
	try {
		for (let offset = 0; offset < data.length; ) {
			offset += writeSync(fd, data, offset, data.length - offset);
		}
		// The temporary stays open until it is renamed or removed. On Windows an
		// open handle is how a later start tells an extraction still in progress
		// from one that was killed; see removeAbandonedTemporaries.
		try {
			renameSync(tempPath, destPath);
			renamed = true;
			return undefined;
		} catch (error) {
			return error;
		}
	} finally {
		// Removed before its handle is closed: once closed, another start's
		// cleanup can hold it with the exclusive open it probes with, and the
		// removal would then fail with EPERM and replace the rename error the
		// caller weighs. A removal that fails anyway leaves a leftover for the
		// next cleanup, which is no reason to fail this load.
		if (!renamed) removeIfPresent(tempPath);
		closeSync(fd);
	}
}

function removeIfPresent(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Gone already, or left for the next cleanup; see publish.
	}
}

function createAddonTempPath(destPath: string): string {
	for (let attempt = 0; attempt < 32; attempt++) {
		const candidate = `${destPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error(`Could not allocate a temporary addon path beside ${destPath}`);
}

const TEMPORARY_SUFFIX = /^([1-9][0-9]*)\.[0-9a-f]{16}\.tmp$/;

/**
 * Remove the temporaries an interrupted extraction left beside the addon.
 * A process killed between writing and renaming leaves a complete binary, and
 * nothing else ever looks at it again; repeated, that fills the volume. This
 * runs on every load, including when the cached addon is already current, so
 * a temporary is not stranded because the destination was published by
 * someone else.
 *
 * A temporary another process is still writing is never removed. On Windows
 * that is the one still open: its writer holds it from creation until the
 * rename, and a killed process holds nothing, so an exclusive open succeeds
 * only on an abandoned one — however its pid has been reused since. POSIX
 * offers Node no such probe, so there the pid in the name decides: a leftover
 * whose pid now belongs to a live process waits until that process ends, and a
 * writer this process cannot see — in another pid namespace, or on another
 * machine sharing the directory — looks abandoned. Its extraction then writes
 * the file again rather than failing (see openCachedAddon).
 */
function removeAbandonedTemporaries(dir: string, assetName: string): void {
	const prefix = `${assetName}.`;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const match = TEMPORARY_SUFFIX.exec(entry.slice(prefix.length));
		if (match === null) continue;
		const tempPath = path.join(dir, entry);
		const inUse = process.platform === "win32" ? isHeldOpen(tempPath) : isRunning(Number(match[1]));
		if (inUse) continue;
		try {
			unlinkSync(tempPath);
		} catch {
			// Gone already, or taken by another cleanup: either way not ours to report.
		}
	}
}

/**
 * libuv's flag for an open that shares nothing (FILE_SHARE_* all clear), which
 * Node passes through but does not name in fs.constants.
 */
const UV_FS_O_EXLOCK = 0x10000000;

function isHeldOpen(file: string): boolean {
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | UV_FS_O_EXLOCK);
	} catch (error) {
		// EBUSY is a sharing violation: somebody holds it. Anything else except
		// its disappearance is treated the same way, since the rule is never to
		// remove what might be in use.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	closeSync(fd);
	return false;
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
