/**
 * The service worker of the installable PWA (#561), served by the hub at `/sw.js`.
 *
 * `vite.config.ts` builds this file on its own, after the app, into a single
 * classic script at the root of `dist/`: a worker registered from `/` controls
 * exactly what the hub serves, and a classic script loads in every browser that
 * has service workers. The build it belongs to is baked in, so each build's
 * worker differs from the last by at least that, and the browser installs it as
 * an update.
 *
 * What it does with requests is in `worker-routing.ts`. Here are only its events:
 * - **install:** nothing to fetch ahead. Once installed while an older worker
 *   still controls pages, it waits, and the page offers the update (#560).
 * - **message:** a page applying the update asks it to take over now; a page
 *   deciding whether there is an update at all asks which build it is.
 * - **activate:** it drops the asset caches of other builds and takes control of
 *   the open pages.
 */

import {
	BUILD_QUERY_MESSAGE,
	handleFetch,
	removeStaleCaches,
	SKIP_WAITING_MESSAGE,
	type WorkerContext,
} from "./worker-routing.js";

/** Defined by the build in `vite.config.ts`: the build this worker belongs to. */
declare const __LASTERM_BUILD__: string;

/*
 * The web package compiles against the DOM library, which has no worker scope,
 * and cannot also take the WebWorker one. These are the parts used here.
 */
interface ExtendableEventLike extends Event {
	waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
	readonly request: Request;
	respondWith(response: Promise<Response>): void;
}

interface MessageEventLike extends ExtendableEventLike {
	readonly data: unknown;
	readonly ports: readonly MessagePort[];
}

interface WorkerScope {
	readonly location: { readonly origin: string };
	readonly caches: CacheStorage;
	readonly clients: { claim(): Promise<void> };
	skipWaiting(): Promise<void>;
	fetch(request: Request): Promise<Response>;
	addEventListener(
		type: "install" | "activate",
		listener: (event: ExtendableEventLike) => void,
	): void;
	addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
	addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

const worker = self as unknown as WorkerScope;

const context: WorkerContext<Request> = {
	build: __LASTERM_BUILD__,
	origin: worker.location.origin,
	fetch: (request) => worker.fetch(request),
	caches: worker.caches,
};

worker.addEventListener("activate", (event) => {
	event.waitUntil(Promise.all([removeStaleCaches(context), worker.clients.claim()]));
});

worker.addEventListener("message", (event) => {
	const type = (event.data as { type?: unknown } | null)?.type;
	if (type === SKIP_WAITING_MESSAGE) {
		event.waitUntil(worker.skipWaiting());
	} else if (type === BUILD_QUERY_MESSAGE) {
		event.ports[0]?.postMessage({ build: __LASTERM_BUILD__ });
	}
});

worker.addEventListener("fetch", (event) => {
	const response = handleFetch(event.request, context, (promise) => event.waitUntil(promise));
	if (response !== null) event.respondWith(response);
});
