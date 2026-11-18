/**
 * The one way the client loads a file the hub serves under `/public` (#194).
 *
 * The desktop webview cannot sign a request its engine issues itself (`<img>`,
 * `@font-face`, `<audio>`), so it fetches the bytes through the pinned relay
 * with its bearer and hands the DOM a blob URL. A blob URL lives until it is
 * revoked, so each one is shared and counted here: every acquire takes a
 * reservation, every handle gives it back once, and the URL is revoked when the
 * last one is given back — never while a handle still holds it.
 *
 * A browser page signs a plain URL with the asset token instead; it fetches
 * nothing here, and its handles release nothing.
 */

import { reactive } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { hubFetch } from "./hub-fetch.js";
import { hubBaseUrl, isTauriRuntime, publicAssetUrl } from "./hub-url.js";

export type AssetKind = "fonts" | "system-fonts" | "sounds" | "wallpapers";

const ASSET_KINDS: ReadonlySet<string> = new Set<AssetKind>([
	"fonts",
	"system-fonts",
	"sounds",
	"wallpapers",
]);

export interface AssetHandle {
	readonly url: string;
	/** Gives this handle's reservation back; later calls do nothing. */
	release(): void;
}

/**
 * The path of a served file, from its kind and its name exactly as the hub
 * stores and lists it. The only place a name is encoded, so a name holding `%`,
 * `#` or spaces is encoded once.
 */
export function assetPath(kind: string, name: string): string {
	if (!ASSET_KINDS.has(kind)) throw new Error(`not a served asset kind: ${kind}`);
	if (name === "" || name === "." || name === ".." || /[/\\]/.test(name)) {
		throw new Error(`not a served asset name: ${JSON.stringify(name)}`);
	}
	return `/public/${kind}/${encodeURIComponent(name)}`;
}

/** The kind and name of a path a hub listing returned (`/api/fonts`). */
export function parseAssetPath(path: string): { kind: AssetKind; name: string } {
	const match = /^\/public\/([^/?#]+)\/([^/?#]+)$/.exec(path);
	if (match === null) throw new Error(`not a served asset path: ${path}`);
	const kind = match[1] as AssetKind;
	const name = decodeURIComponent(match[2] as string);
	// Refuses what `assetPath` refuses, and a segment that was not encoded once.
	if (assetPath(kind, name) !== path) throw new Error(`not a served asset path: ${path}`);
	return { kind, name };
}

/** How many times each path was invalidated; reactive, so a watcher reading it re-runs. */
const versions = reactive(new Map<string, number>());

/** The invalidation count of an asset. Read it in a watcher to re-acquire after an invalidation. */
export function assetVersion(kind: AssetKind, name: string): number {
	return versions.get(assetPath(kind, name)) ?? 0;
}

interface Entry {
	/** Acquires waiting on the fetch plus handles not yet released. */
	reservations: number;
	/** The blob URL once the fetch succeeded, until it is revoked. */
	url: string | null;
	readonly fetched: Promise<string>;
}

/** The current entry of each path. An invalidated entry leaves this map but lives on for its reservations. */
const entries = new Map<string, Entry>();

function revokeWhenUnused(path: string, entry: Entry): void {
	if (entry.reservations !== 0 || entry.url === null) return;
	URL.revokeObjectURL(entry.url);
	entry.url = null;
	if (entries.get(path) === entry) entries.delete(path);
}

function fetchEntry(path: string): Entry {
	const entry: Entry = {
		reservations: 0,
		url: null,
		fetched: (async () => {
			const token = useAuthStore().token;
			const response = await hubFetch(`${hubBaseUrl()}${path}`, {
				headers: { Authorization: `Bearer ${token ?? ""}` },
			});
			if (!response.ok) throw new Error(`could not load ${path}: HTTP ${response.status}`);
			return URL.createObjectURL(await response.blob());
		})(),
	};
	entry.fetched.then(
		(url) => {
			entry.url = url;
		},
		() => {
			// Nothing was created; let the next acquire try again.
			if (entries.get(path) === entry) entries.delete(path);
		},
	);
	return entry;
}

export async function acquireAsset(kind: AssetKind, name: string): Promise<AssetHandle> {
	const path = assetPath(kind, name);
	if (!isTauriRuntime()) {
		const version = versions.get(path) ?? 0;
		return {
			url: publicAssetUrl(path, version === 0 ? undefined : { v: version }),
			release() {},
		};
	}

	let entry = entries.get(path);
	if (entry === undefined) {
		entry = fetchEntry(path);
		entries.set(path, entry);
	}
	const held = entry;
	held.reservations++;
	let url: string;
	try {
		url = await held.fetched;
	} catch (error) {
		held.reservations--;
		throw error;
	}
	// The settle handler above runs before this continuation, so `held.url` is set.
	let released = false;
	return {
		url,
		release() {
			if (released) return;
			released = true;
			held.reservations--;
			revokeWhenUnused(path, held);
		},
	};
}

/**
 * The file behind an asset changed (a same-name upload, a delete). The current
 * entry is detached first, then the version moves, so an acquire made by a
 * watcher the version wakes — synchronously, from inside this call — already
 * fetches anew. Handles of the detached entry keep their URL until released.
 */
export function invalidateAsset(kind: AssetKind, name: string): void {
	const path = assetPath(kind, name);
	const entry = entries.get(path);
	if (entry !== undefined) {
		entries.delete(path);
		revokeWhenUnused(path, entry);
	}
	versions.set(path, (versions.get(path) ?? 0) + 1);
}

/** For tests only: forget every entry and version, revoking nothing. */
export function resetAssetHolderForTests(): void {
	entries.clear();
	versions.clear();
}
