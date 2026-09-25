/**
 * What the service worker does with a request (#561), apart from the worker's
 * own events, so that it can be tested without a browser.
 *
 * The worker is there to make the UI installable and to answer when the hub
 * does not, never to decide which UI a page runs: the hub is the source of truth
 * for that (#132). So it holds very little:
 * - **Navigations** go to the network first, every time. A stale `index.html` is
 *   never served while the hub answers, and nothing caches one. With no hub, the
 *   page is a small "hub unreachable" one built here, not the browser's error.
 * - **`/assets/*`** is cache-first. Vite names every file there after a hash of
 *   its content, so a name is never reused for other content. Only a response
 *   that is plainly the file asked for is kept: a 200, of the type its extension
 *   says, not redirected.
 * - **Everything else goes to the network untouched**: `/api/*`, `/ws` (a
 *   WebSocket handshake never reaches a worker, and the path is left alone all
 *   the same), the asset-token files under `/public/*`, anything carrying
 *   credentials, and the few root files (the worker itself, the manifest, the
 *   icons), which the browser's HTTP cache already handles.
 */

/** Every cache this worker makes starts with this; a cache without it is not ours. */
export const ASSET_CACHE_PREFIX = "lasterm-assets-";

/** Page → waiting worker: take over now. */
export const SKIP_WAITING_MESSAGE = "lasterm:skip-waiting";

/** Page → worker, with a port to answer on: which build is this worker? */
export const BUILD_QUERY_MESSAGE = "lasterm:build";

export type Route = "navigation" | "asset" | "network";

/** The part of a `Request` the routing reads. */
export interface RoutedRequest {
	readonly method: string;
	readonly url: string;
	readonly mode: string;
	readonly headers: { has(name: string): boolean };
}

/** The part of a `Response` the cache rule reads. */
export interface CandidateResponse {
	readonly status: number;
	readonly type: string;
	readonly redirected: boolean;
	readonly headers: { get(name: string): string | null };
}

export interface AssetCache<R> {
	match(request: R): Promise<Response | undefined>;
	put(request: R, response: Response): Promise<void>;
}

export interface AssetCaches<R> {
	open(name: string): Promise<AssetCache<R>>;
	keys(): Promise<string[]>;
	delete(name: string): Promise<boolean>;
}

export interface WorkerContext<R extends RoutedRequest> {
	/** The build this worker was made with; it names the asset cache. */
	readonly build: string;
	/** The hub's origin: the worker's own. */
	readonly origin: string;
	readonly fetch: (request: R) => Promise<Response>;
	readonly caches: AssetCaches<R>;
}

/** Paths the hub answers itself, whose responses belong to a session or a credential. */
function isHubEndpoint(pathname: string): boolean {
	return ["/api", "/ws", "/public"].some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/** A request carrying a credential of either kind the hub accepts. */
function carriesCredential(request: RoutedRequest, url: URL): boolean {
	return request.headers.has("authorization") || url.searchParams.has("asset_token");
}

/** What the worker does with `request`, on a hub served from `origin`. */
export function routeRequest(request: RoutedRequest, origin: string): Route {
	if (request.method !== "GET") return "network";
	const url = new URL(request.url);
	if (url.origin !== origin) return "network";
	if (isHubEndpoint(url.pathname)) return "network";
	if (carriesCredential(request, url)) return "network";
	if (request.mode === "navigate") return "navigation";
	// A range is part of a file, which a cache keyed by URL would hand out whole.
	if (request.headers.has("range")) return "network";
	if (url.pathname.startsWith("/assets/")) return "asset";
	return "network";
}

/** The content types a file under `/assets/` may be served with, by extension. */
const ASSET_TYPES: Readonly<Record<string, readonly string[]>> = {
	".js": ["application/javascript", "text/javascript"],
	".mjs": ["application/javascript", "text/javascript"],
	".css": ["text/css"],
	".woff2": ["font/woff2"],
	".woff": ["font/woff"],
	".ttf": ["font/ttf"],
	".otf": ["font/otf"],
	".svg": ["image/svg+xml"],
	".png": ["image/png"],
	".jpg": ["image/jpeg"],
	".jpeg": ["image/jpeg"],
	".gif": ["image/gif"],
	".webp": ["image/webp"],
	".ico": ["image/x-icon", "image/vnd.microsoft.icon"],
	".wasm": ["application/wasm"],
	".json": ["application/json"],
};

function extensionOf(pathname: string): string {
	const name = pathname.slice(pathname.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Whether `response` is plainly the file `url` names, and may be kept for good.
 * A hub that answers a missing asset with its `index.html` (an SPA fallback)
 * sends a 200 of the wrong type, and keeping that under a script's name would
 * break the page until the cache is cleared.
 */
export function isCacheableAsset(url: string, response: CandidateResponse): boolean {
	if (response.status !== 200 || response.redirected) return false;
	// Same-origin, as fetched ("basic"), or made in the worker ("default").
	if (response.type !== "basic" && response.type !== "default") return false;
	if (/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")) return false;
	const expected = ASSET_TYPES[extensionOf(new URL(url).pathname)];
	if (expected === undefined) return false;
	const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
	return type !== undefined && expected.includes(type);
}

export function assetCacheName(build: string): string {
	return `${ASSET_CACHE_PREFIX}${build}`;
}

const HUB_UNREACHABLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#181825">
<title>Lasterm: hub unreachable</title>
<style>
html, body { margin: 0; height: 100%; background: #1e1e2e; color: #cdd6f4; font: 14px/1.5 system-ui, sans-serif; }
main { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 0 16px; text-align: center; }
h1 { margin: 0; font-size: 16px; font-weight: 600; }
p { margin: 0; max-width: 36em; color: #a6adc8; }
a { color: #89b4fa; }
button { padding: 4px 14px; border: 1px solid #89b4fa; border-radius: 4px; background: #89b4fa; color: #11111b; font: inherit; font-size: 13px; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>Lasterm cannot reach its hub</h1>
<p>The hub that serves this app is not answering. This page reloads by itself as soon as it does.</p>
<p>If the hub is running, the browser may be refusing its certificate: <a href="/api/health">open the hub's health check</a> to see what the browser says.</p>
<button type="button" id="retry">Retry now</button>
</main>
<script>
document.getElementById("retry").addEventListener("click", function () { location.reload(); });
setInterval(function () {
	fetch("/api/health", { cache: "no-store" }).then(function (response) {
		if (response.ok) location.reload();
	}, function () {});
}, 5000);
</script>
</body>
</html>
`;

/**
 * The page a navigation gets when the hub does not answer. It is built here
 * rather than cached, so there is nothing of an older build to go stale, and it
 * polls the hub's health check to reload once the hub is back.
 */
export function hubUnreachablePage(): Response {
	return new Response(HUB_UNREACHABLE_HTML, {
		status: 503,
		statusText: "Hub Unreachable",
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		},
	});
}

async function networkFirst<R extends RoutedRequest>(
	request: R,
	context: WorkerContext<R>,
): Promise<Response> {
	try {
		// Whatever the hub answers is the answer, an error status included.
		return await context.fetch(request);
	} catch {
		return hubUnreachablePage();
	}
}

async function cacheFirst<R extends RoutedRequest>(
	request: R,
	context: WorkerContext<R>,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
	// A browser that refuses storage still gets its file, from the network.
	const cache = await context.caches.open(assetCacheName(context.build)).catch(() => null);
	const cached = await cache?.match(request).catch(() => undefined);
	if (cached !== undefined) return cached;

	const response = await context.fetch(request);
	if (cache !== null && isCacheableAsset(request.url, response)) {
		// A full disk costs the cache, never the response.
		waitUntil(cache.put(request, response.clone()).catch(() => {}));
	}
	return response;
}

/**
 * The worker's answer to `request`, or null to leave it to the browser, which
 * then fetches it as if there were no worker.
 */
export function handleFetch<R extends RoutedRequest>(
	request: R,
	context: WorkerContext<R>,
	waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> | null {
	switch (routeRequest(request, context.origin)) {
		case "navigation":
			return networkFirst(request, context);
		case "asset":
			return cacheFirst(request, context, waitUntil);
		case "network":
			return null;
	}
}

/**
 * Drop the asset caches of other builds, once this worker is the active one.
 * Caches this worker did not make are left alone.
 */
export async function removeStaleCaches<R extends RoutedRequest>(
	context: WorkerContext<R>,
): Promise<void> {
	const current = assetCacheName(context.build);
	const stale = (await context.caches.keys()).filter(
		(name) => name.startsWith(ASSET_CACHE_PREFIX) && name !== current,
	);
	await Promise.all(stale.map((name) => context.caches.delete(name)));
}
