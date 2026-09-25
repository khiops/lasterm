import { describe, expect, it, vi } from "vitest";
import {
	type AssetCache,
	type AssetCaches,
	assetCacheName,
	handleFetch,
	isCacheableAsset,
	type RoutedRequest,
	removeStaleCaches,
	routeRequest,
	type WorkerContext,
} from "./worker-routing.js";

const ORIGIN = "https://127.0.0.1:4100";
const BUILD = "abc1234";
const APP_JS = "console.log('app');";

interface FakeRequest extends RoutedRequest {
	readonly headers: Headers;
}

function request(
	path: string,
	init: { method?: string; mode?: string; headers?: Record<string, string>; origin?: string } = {},
): FakeRequest {
	return {
		method: init.method ?? "GET",
		url: `${init.origin ?? ORIGIN}${path}`,
		mode: init.mode ?? "no-cors",
		headers: new Headers(init.headers),
	};
}

function navigation(path: string): FakeRequest {
	return request(path, { mode: "navigate" });
}

function fileResponse(
	body: string,
	contentType: string,
	init: { status?: number; cacheControl?: string } = {},
): Response {
	const headers: Record<string, string> = { "Content-Type": contentType };
	if (init.cacheControl !== undefined) headers["Cache-Control"] = init.cacheControl;
	return new Response(body, { status: init.status ?? 200, headers });
}

/** Caches held in memory, keyed by URL, as the browser's are. */
function memoryCaches() {
	const stores = new Map<string, Map<string, Response>>();
	const open = vi.fn(async (name: string): Promise<AssetCache<FakeRequest>> => {
		let store = stores.get(name);
		if (store === undefined) {
			store = new Map();
			stores.set(name, store);
		}
		const entries = store;
		return {
			match: async (req) => entries.get(req.url)?.clone(),
			put: async (req, res) => {
				entries.set(req.url, res);
			},
		};
	});
	const caches: AssetCaches<FakeRequest> = {
		open,
		keys: async () => [...stores.keys()],
		delete: async (name) => stores.delete(name),
	};
	return { caches, stores, open };
}

function worker(fetch: (req: FakeRequest) => Promise<Response>) {
	const memory = memoryCaches();
	const fetchSpy = vi.fn(fetch);
	const context: WorkerContext<FakeRequest> = {
		build: BUILD,
		origin: ORIGIN,
		fetch: fetchSpy,
		caches: memory.caches,
	};
	const pending: Promise<unknown>[] = [];
	async function handle(req: FakeRequest): Promise<Response | null> {
		const response = handleFetch(req, context, (promise) => pending.push(promise));
		if (response === null) return null;
		const answered = await response;
		await Promise.all(pending);
		return answered;
	}
	return { handle, context, fetch: fetchSpy, ...memory };
}

function cached(stores: Map<string, Map<string, Response>>, path: string): Response | undefined {
	return stores.get(assetCacheName(BUILD))?.get(`${ORIGIN}${path}`);
}

describe("which requests the worker handles (#561)", () => {
	it("takes navigations and hashed assets, and leaves everything else to the browser", () => {
		expect(routeRequest(navigation("/"), ORIGIN)).toBe("navigation");
		expect(routeRequest(navigation("/some/route"), ORIGIN)).toBe("navigation");
		expect(routeRequest(request("/assets/index-abc.js", { mode: "cors" }), ORIGIN)).toBe("asset");
		expect(routeRequest(request("/assets/index-abc.css"), ORIGIN)).toBe("asset");

		expect(routeRequest(request("/sw.js"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/manifest.webmanifest"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/icons/icon-192.png"), ORIGIN)).toBe("network");
	});

	it("never takes the hub's API, even as a navigation", () => {
		expect(routeRequest(request("/api/health"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/api/hosts", { mode: "cors" }), ORIGIN)).toBe("network");
		expect(routeRequest(navigation("/api/health"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/api"), ORIGIN)).toBe("network");
	});

	it("never takes the WebSocket", () => {
		expect(routeRequest(request("/ws"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/ws", { mode: "websocket" }), ORIGIN)).toBe("network");
		expect(routeRequest(navigation("/ws"), ORIGIN)).toBe("network");
	});

	it("never takes anything carrying a credential", () => {
		expect(
			routeRequest(
				request("/assets/index-abc.js", { headers: { Authorization: "Bearer t" } }),
				ORIGIN,
			),
		).toBe("network");
		expect(routeRequest(request("/assets/index-abc.js?asset_token=t"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/public/fonts/mono.woff2?asset_token=t"), ORIGIN)).toBe("network");
		expect(routeRequest(request("/public/wallpapers/a.png"), ORIGIN)).toBe("network");
		// Files behind the asset token are never the worker's, even opened in a tab.
		expect(routeRequest(navigation("/public/wallpapers/a.png"), ORIGIN)).toBe("network");
	});

	it("never takes another origin, another method, or part of a file", () => {
		expect(
			routeRequest(request("/assets/index-abc.js", { origin: "https://127.0.0.1:4200" }), ORIGIN),
		).toBe("network");
		expect(routeRequest(request("/assets/index-abc.js", { method: "POST" }), ORIGIN)).toBe(
			"network",
		);
		expect(routeRequest(request("/assets/index-abc.js", { method: "HEAD" }), ORIGIN)).toBe(
			"network",
		);
		expect(
			routeRequest(request("/assets/index-abc.js", { headers: { Range: "bytes=0-9" } }), ORIGIN),
		).toBe("network");
	});
});

describe("navigations: network first", () => {
	it("serves whatever the hub answers, and caches none of it", async () => {
		const page = fileResponse("<!doctype html>new build", "text/html");
		const { handle, open } = worker(async () => page);

		const response = await handle(navigation("/"));

		expect(await response?.text()).toBe("<!doctype html>new build");
		expect(open).not.toHaveBeenCalled();
	});

	it("serves the hub's error too: the hub answered", async () => {
		const { handle } = worker(async () => fileResponse("gone", "text/plain", { status: 404 }));

		const response = await handle(navigation("/nowhere"));

		expect(response?.status).toBe(404);
	});

	it("asks the hub on every navigation, so an older page is never served while it answers", async () => {
		let build = "one";
		const { handle, fetch } = worker(async () => fileResponse(`page ${build}`, "text/html"));

		expect(await (await handle(navigation("/")))?.text()).toBe("page one");
		build = "two";
		expect(await (await handle(navigation("/")))?.text()).toBe("page two");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("shows the hub-unreachable page when the hub does not answer", async () => {
		const { handle, open } = worker(async () => {
			throw new TypeError("Failed to fetch");
		});

		const response = await handle(navigation("/"));

		expect(response?.status).toBe(503);
		expect(response?.headers.get("content-type")).toMatch(/^text\/html/);
		expect(response?.headers.get("cache-control")).toBe("no-store");
		const html = (await response?.text()) ?? "";
		expect(html).toContain("cannot reach its hub");
		// It comes back by itself once the hub answers its health check.
		expect(html).toContain("/api/health");
		expect(open).not.toHaveBeenCalled();
	});
});

describe("hashed assets: cache first", () => {
	it("fetches a new asset once, keeps it, and serves it from the cache after that", async () => {
		const { handle, fetch, stores } = worker(async () =>
			fileResponse(APP_JS, "application/javascript; charset=utf-8"),
		);

		const first = await handle(request("/assets/index-abc.js"));
		const second = await handle(request("/assets/index-abc.js"));

		expect(await first?.text()).toBe(APP_JS);
		expect(await second?.text()).toBe(APP_JS);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(cached(stores, "/assets/index-abc.js")).toBeDefined();
	});

	it("keeps each build's assets in a cache named for the build", async () => {
		const { handle, stores } = worker(async () => fileResponse("body{}", "text/css"));

		await handle(request("/assets/index-abc.css"));

		expect([...stores.keys()]).toEqual([`lasterm-assets-${BUILD}`]);
	});

	it("does not keep the SPA page an older hub sends for a missing script", async () => {
		const { handle, stores } = worker(async () =>
			fileResponse("<!doctype html>", "text/html; charset=utf-8"),
		);

		const response = await handle(request("/assets/index-old.js"));

		// Passed on as it came, so the loader fails as it would without a worker.
		expect(response?.status).toBe(200);
		expect(cached(stores, "/assets/index-old.js")).toBeUndefined();
	});

	it("does not keep a 404, so the next request asks the hub again", async () => {
		const { handle, fetch, stores } = worker(async () =>
			fileResponse("{}", "application/json", { status: 404 }),
		);

		await handle(request("/assets/index-old.js"));
		await handle(request("/assets/index-old.js"));

		expect(cached(stores, "/assets/index-old.js")).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("answers from the network when the browser refuses storage", async () => {
		const { handle, context } = worker(async () => fileResponse(APP_JS, "application/javascript"));
		context.caches.open = async () => {
			throw new DOMException("denied", "SecurityError");
		};

		const response = await handle(request("/assets/index-abc.js"));

		expect(await response?.text()).toBe(APP_JS);
	});
});

describe("requests the worker leaves to the browser", () => {
	it.each([
		["the API", request("/api/hosts", { mode: "cors", headers: { Authorization: "Bearer t" } })],
		["the health check", request("/api/health")],
		["the WebSocket", request("/ws", { mode: "websocket" })],
		["an asset-token file", request("/public/sounds/bell.ogg?asset_token=t")],
		["the worker itself", request("/sw.js")],
	])("never answers %s, and never caches it", async (_what, req) => {
		const { handle, fetch, open } = worker(async () => fileResponse("{}", "application/json"));

		expect(await handle(req)).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});
});

describe("what makes an asset response worth keeping", () => {
	const url = `${ORIGIN}/assets/index-abc.js`;

	it("a 200 of the type its extension says", () => {
		expect(isCacheableAsset(url, fileResponse(APP_JS, "application/javascript"))).toBe(true);
		expect(isCacheableAsset(url, fileResponse(APP_JS, "text/javascript; charset=utf-8"))).toBe(
			true,
		);
		expect(
			isCacheableAsset(
				`${ORIGIN}/assets/index-abc.css`,
				fileResponse("", "text/css; charset=utf-8"),
			),
		).toBe(true);
	});

	it("not a response of another type", () => {
		expect(isCacheableAsset(url, fileResponse("<!doctype html>", "text/html"))).toBe(false);
		expect(isCacheableAsset(url, fileResponse(APP_JS, "application/octet-stream"))).toBe(false);
		expect(isCacheableAsset(url, fileResponse(APP_JS, ""))).toBe(false);
	});

	it("not another status, a redirect, an opaque answer, or one that says no-store", () => {
		expect(
			isCacheableAsset(url, fileResponse(APP_JS, "application/javascript", { status: 206 })),
		).toBe(false);
		const base = {
			status: 200,
			headers: new Headers({ "Content-Type": "application/javascript" }),
		};
		expect(isCacheableAsset(url, { ...base, type: "basic", redirected: true })).toBe(false);
		expect(isCacheableAsset(url, { ...base, type: "opaque", redirected: false })).toBe(false);
		expect(isCacheableAsset(url, { ...base, type: "basic", redirected: false })).toBe(true);
		expect(
			isCacheableAsset(
				url,
				fileResponse(APP_JS, "application/javascript", { cacheControl: "no-store" }),
			),
		).toBe(false);
	});

	it("not a file whose extension says nothing about its type", () => {
		expect(
			isCacheableAsset(`${ORIGIN}/assets/blob`, fileResponse(APP_JS, "application/javascript")),
		).toBe(false);
	});
});

describe("when a new worker takes over", () => {
	it("drops the asset caches of other builds, and leaves caches it did not make", async () => {
		const { context, stores } = worker(async () => fileResponse("", "text/css"));
		for (const name of ["lasterm-assets-0ld0000", assetCacheName(BUILD), "someone-else"]) {
			await context.caches.open(name);
		}

		await removeStaleCaches(context);

		expect([...stores.keys()].sort()).toEqual([assetCacheName(BUILD), "someone-else"]);
	});
});
