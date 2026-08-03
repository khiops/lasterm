import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	detectSea,
	extractAddonToDir,
	getAddonCacheDir,
} from "@termora/shared/dist/sea-addon-loader.js";

const LOCK_FILE_NAME = "hub.lock";
const SEA_ASSET_NAME = "termora_hub_lock.node";

interface NativeHubLock {
	readonly path: string;
}

interface HubLockAddon {
	readonly HubLock: new () => NativeHubLock;
	tryAcquire(path: string): NativeHubLock | null | undefined | false;
}

export class HubAlreadyRunningError extends Error {
	readonly code = "TERMORA_HUB_ALREADY_RUNNING";

	constructor(readonly lockPath: string) {
		super(`TERMORA_HUB_ALREADY_RUNNING: another hub holds ${lockPath}`);
		this.name = "HubAlreadyRunningError";
	}
}

export class HubLockInitializationError extends Error {
	readonly code = "TERMORA_HUB_LOCK_UNAVAILABLE";

	constructor(
		readonly lockPath: string,
		cause: unknown,
	) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`TERMORA_HUB_LOCK_UNAVAILABLE: cannot establish ${lockPath}: ${detail}`);
		this.name = "HubLockInitializationError";
	}
}

/**
 * A handle is retained by the exact authority path it protects. It is never
 * returned as authorization for a later startup attempt: a second entry must
 * acquire its own authority and is refused while this process still holds it.
 */
const heldLocks = new Map<string, NativeHubLock>();

/** The authority file is intentionally independent from atomically-renamed runtime.json. */
export function getHubLockPath(stateDir: string): string {
	return join(stateDir, LOCK_FILE_NAME);
}

/**
 * Acquire the one authoritative hub lock before opening databases or binding a
 * port. A process-global reference gives it process lifetime; normal shutdown
 * lets kernel process teardown release it after every other resource is gone.
 */
export function acquireHubLock(
	stateDir: string,
	options: { loadAddon?: () => HubLockAddon } = {},
): NativeHubLock {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const lockPath = resolve(getHubLockPath(stateDir));
	if (heldLocks.has(lockPath)) throw new HubAlreadyRunningError(lockPath);
	try {
		const addon = (options.loadAddon ?? loadHubLockAddon)();
		const lock = addon.tryAcquire(lockPath);
		if (lock === null) throw new HubAlreadyRunningError(lockPath);
		if (!isLiveHubLockForPath(lock, addon, lockPath)) {
			throw new Error("native addon did not return a live HubLock for the requested path");
		}
		heldLocks.set(lockPath, lock);
		return lock;
	} catch (error) {
		if (error instanceof HubAlreadyRunningError) throw error;
		throw new HubLockInitializationError(lockPath, error);
	}
}

function loadHubLockAddon(): HubLockAddon {
	if (detectSea()) return loadSeaAddon();
	const override = process.env.TERMORA_HUB_LOCK_ADDON;
	const addonPath = override && override.length > 0 ? override : localAddonPath();
	return dlopenAddon(addonPath);
}

function loadSeaAddon(): HubLockAddon {
	const req = createRequire(import.meta.url);
	const sea = req("node:sea") as {
		getRawAsset: (name: string) => ArrayBuffer;
		getAsset?: (name: string, encoding: BufferEncoding) => string;
	};
	let version = "0.0.0";
	try {
		version = sea.getAsset?.("VERSION", "utf8").trim() || version;
	} catch {
		// A missing version only changes the cache location, not lock semantics.
	}
	const addonPath = extractAddonToDir(
		SEA_ASSET_NAME,
		getAddonCacheDir(version),
		Buffer.from(sea.getRawAsset(SEA_ASSET_NAME)),
	);
	return dlopenAddon(addonPath);
}

function localAddonPath(): string {
	const extension = platform() === "win32" ? ".dll" : platform() === "darwin" ? ".dylib" : ".so";
	const filename =
		platform() === "win32" ? "termora_hub_lock.dll" : `libtermora_hub_lock${extension}`;
	const sourceDir = dirname(fileURLToPath(import.meta.url));
	const targetDir = process.env.CARGO_TARGET_DIR ?? resolve(sourceDir, "../../../target");
	return resolve(targetDir, "release", filename);
}

function dlopenAddon(addonPath: string): HubLockAddon {
	const mod = { exports: {} as Record<string, unknown> };
	process.dlopen(mod, addonPath);
	const addon = mod.exports as Partial<HubLockAddon>;
	if (typeof addon.tryAcquire !== "function" || typeof addon.HubLock !== "function") {
		throw new Error(`native addon ${addonPath} does not export HubLock and tryAcquire()`);
	}
	return addon as HubLockAddon;
}

function isLiveHubLockForPath(
	lock: NativeHubLock | null | undefined | false,
	addon: HubLockAddon,
	lockPath: string,
): lock is NativeHubLock {
	return lock instanceof addon.HubLock && lock.path === lockPath;
}
