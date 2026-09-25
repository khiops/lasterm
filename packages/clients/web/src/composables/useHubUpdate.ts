/**
 * A browser tab that outlived a hub upgrade (#560).
 *
 * A tab loads the UI from the hub once, then runs that JavaScript for as long as
 * it stays open. When the hub is upgraded and restarts, the tab's WebSocket
 * reconnects to the new hub on its own, and the old UI goes on talking to it:
 * messages it does not know, semantics that changed, and chunks whose hashed
 * names the new hub no longer serves. The hub is the source of truth for the UI
 * it serves (#132), so the tab only has to notice, and reload.
 *
 * It notices in two ways:
 * - on every WebSocket connection, it compares this page's build with the one
 *   the hub reports on `/api/health`;
 * - a chunk that fails to load (`vite:preloadError`) is taken for the same news,
 *   since the names of an older build's chunks are what a new hub lacks.
 *
 * A hidden tab reloads at once. A visible one shows a banner and reloads when the
 * user says so, or as soon as it is hidden. A page that came back from such a
 * reload still running the same build (an `index.html` served from a cache, say)
 * does not reload by itself again: it shows the banner.
 *
 * Nothing happens under the desktop runtime, whose UI comes with the app, so a
 * reload would load the same one (#132, #193); nor for a `dev` build on either
 * side.
 *
 * The installable PWA (#561) extends this rather than adding a second path:
 * - a waiting service worker is one more "an update is available":
 *   `signalUpdate()`;
 * - "apply the update" is the `reload` given to `createHubUpdate`, which every
 *   reload here goes through, the banner's and the unattended one alike: that is
 *   where the waiting worker is activated before the page reloads;
 * - `check()` is where a mismatch asks the registration to `update()` first.
 */

import { type Ref, readonly, ref, type WatchSource, watch } from "vue";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";

/** The build of a side that was built with nothing to identify it. */
const DEV_BUILD = "dev";

/**
 * This tab's record of the build it last reloaded from. A page that finds its
 * own build here already reloaded once and came back unchanged, so reloading
 * again by itself would only loop.
 */
export const RELOADED_FROM_KEY = "lasterm:hub-update:reloaded-from";

export interface HubUpdateOptions {
	/** This page's build. Defaults to `VITE_BUILD_HASH`, and to `dev` under the Vite dev server. */
	clientBuild?: string;
	/** The hub's build, or null when it could not be read. Defaults to `/api/health`. */
	fetchHubBuild?: () => Promise<string | null>;
	/** Leave this page for the hub's current UI. Defaults to `location.reload()`. */
	reload?: () => void;
}

export interface HubUpdate {
	/** True while the banner offers the reload. */
	readonly bannerVisible: Readonly<Ref<boolean>>;
	/** Compare this page's build with the hub's, and act on a difference. */
	check(): Promise<void>;
	/** The hub serves a newer UI than this page runs: reload now if hidden, else show the banner. */
	signalUpdate(): void;
	/** Reload onto the hub's UI, as the user asked: the banner's button. */
	applyUpdate(): void;
	/** Check on every connection `connected` reports, and listen for failed chunk loads. Returns a stop. */
	start(connected: WatchSource<boolean>): () => void;
}

/**
 * The Vite dev server replaces modules in place and reloads the page itself. Its
 * hash is the checkout's, which a hub run from the same checkout can disagree with
 * after a commit, without anything having been upgraded.
 */
function pageBuild(): string {
	if (import.meta.env.DEV) return DEV_BUILD;
	return import.meta.env.VITE_BUILD_HASH ?? DEV_BUILD;
}

async function fetchHubBuild(): Promise<string | null> {
	try {
		const res = await hubFetch(`${hubBaseUrl()}/api/health`);
		if (!res.ok) return null;
		const body = (await res.json()) as { build?: unknown };
		return typeof body.build === "string" && body.build.length > 0 ? body.build : null;
	} catch {
		// A hub that does not answer says nothing about its build. The next
		// connection asks again.
		return null;
	}
}

/**
 * Both builds are a commit hash cut to 7 characters, but a build made without
 * `LASTERM_BUILD_HASH` takes `git rev-parse --short` as it comes, which can be longer.
 */
function sameBuild(a: string, b: string): boolean {
	return a.slice(0, 7) === b.slice(0, 7);
}

function readReloadedFrom(): string | null {
	try {
		return window.sessionStorage.getItem(RELOADED_FROM_KEY);
	} catch {
		return null;
	}
}

function writeReloadedFrom(build: string): boolean {
	try {
		window.sessionStorage.setItem(RELOADED_FROM_KEY, build);
		return true;
	} catch {
		return false;
	}
}

function clearReloadedFrom(): void {
	try {
		window.sessionStorage.removeItem(RELOADED_FROM_KEY);
	} catch {
		// Nothing was recorded where nothing can be.
	}
}

export function createHubUpdate(options: HubUpdateOptions = {}): HubUpdate {
	const clientBuild = options.clientBuild ?? pageBuild();
	const readHubBuild = options.fetchHubBuild ?? fetchHubBuild;
	const reload = options.reload ?? (() => window.location.reload());
	const bannerVisible = ref(false);

	function inert(): boolean {
		return isTauriRuntime() || clientBuild === DEV_BUILD;
	}

	/**
	 * Reload with nobody watching, once per build. Without a record of it there is
	 * no telling a first reload from a loop, so none happens.
	 */
	function reloadUnattended(): boolean {
		if (readReloadedFrom() === clientBuild) return false;
		if (!writeReloadedFrom(clientBuild)) return false;
		reload();
		return true;
	}

	function signalUpdate(): void {
		if (inert()) return;
		if (document.hidden && reloadUnattended()) return;
		bannerVisible.value = true;
	}

	function applyUpdate(): void {
		// Asked for, so it happens whatever the record says. Recorded all the same,
		// so no unattended reload follows one that brought the same UI back.
		writeReloadedFrom(clientBuild);
		reload();
	}

	async function check(): Promise<void> {
		if (inert()) return;
		const hubBuild = await readHubBuild();
		if (hubBuild === null || hubBuild === DEV_BUILD) return;
		if (sameBuild(hubBuild, clientBuild)) {
			clearReloadedFrom();
			return;
		}
		console.info(`[hub-update] the hub serves build ${hubBuild}; this page runs ${clientBuild}`);
		signalUpdate();
	}

	function onPreloadError(event: VitePreloadErrorEvent): void {
		if (inert()) return;
		// Handled here, so Vite does not throw it on as well.
		event.preventDefault();
		console.warn("[hub-update] a chunk failed to load; taking it for a hub update:", event.payload);
		signalUpdate();
	}

	function onVisibilityChange(): void {
		if (bannerVisible.value && document.hidden) reloadUnattended();
	}

	function start(connected: WatchSource<boolean>): () => void {
		if (inert()) return () => {};
		const stopWatching = watch(
			connected,
			(isConnected) => {
				if (isConnected) void check();
			},
			{ immediate: true },
		);
		window.addEventListener("vite:preloadError", onPreloadError);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			stopWatching();
			window.removeEventListener("vite:preloadError", onPreloadError);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}

	return {
		bannerVisible: readonly(bannerVisible),
		check,
		signalUpdate,
		applyUpdate,
		start,
	};
}

let appHubUpdate: HubUpdate | null = null;

/** The app's one watcher, shared by the banner and anything else that learns of an update. */
export function useHubUpdate(): HubUpdate {
	appHubUpdate ??= createHubUpdate();
	return appHubUpdate;
}
