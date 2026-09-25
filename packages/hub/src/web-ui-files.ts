/**
 * How the hub serves the web UI's files, from disk or from the SEA's embedded
 * manifest alike (#561).
 *
 * The UI is an installable PWA whose service worker keeps every file under
 * `/assets/` for good, on the promise that a name there always means the same
 * content. The hub keeps that promise in two ways:
 * - its cache headers say so: hashed assets are immutable, while the files a new
 *   build must reach at once (`index.html`, the worker, the manifest) are
 *   revalidated on every load;
 * - a file missing under `/assets/` is a 404, never the SPA's `index.html`,
 *   which a cache would otherwise hold under a script's name.
 */

import type { FastifyInstance, FastifyReply } from "fastify";

/** Where Vite puts the files it names after a hash of their content. */
export const HASHED_ASSETS_PREFIX = "/assets/";

/** The service worker's URL: at the root, so its scope is everything the hub serves. */
export const SERVICE_WORKER_PATH = "/sw.js";

/** The Cache-Control a file of the web UI is served with, by its URL path. */
export function webUiCacheControl(pathname: string): string {
	// The hash changes with the content, so the URL is the cache key.
	if (pathname.startsWith(HASHED_ASSETS_PREFIX)) return "public, max-age=31536000, immutable";
	// Revalidated on every load, so a new build is picked up at once: the entry
	// page names the new assets, the worker is the next version of itself, and
	// the manifest is what an installed app is named and drawn from.
	if (pathname === "/" || pathname.endsWith(".html")) return "no-cache";
	if (pathname === SERVICE_WORKER_PATH || pathname.endsWith(".webmanifest")) return "no-cache";
	return "public, max-age=3600";
}

/** Whether `pathname` names a hashed asset, which must never be answered with the SPA page. */
export function isHashedAssetPath(pathname: string): boolean {
	return pathname.startsWith(HASHED_ASSETS_PREFIX);
}

function requestPathname(reply: FastifyReply): string {
	return new URL(reply.request.url, "http://localhost").pathname;
}

/**
 * Serve the web UI from `staticDir` on disk: the hub run from source after
 * `pnpm build:embed`. `@fastify/static` knows each file's content type,
 * `.webmanifest` included, and with `wildcard: false` it serves only the files it
 * found, so a missing asset gets the ordinary 404.
 */
export async function registerWebUiDirectory(
	server: FastifyInstance,
	staticDir: string,
): Promise<void> {
	const fastifyStatic = (await import("@fastify/static")).default;
	await server.register(fastifyStatic, {
		root: staticDir,
		prefix: "/",
		wildcard: false,
		// Set below from the policy above, rather than one max-age for every file.
		cacheControl: false,
		setHeaders: (reply) => {
			reply.header("Cache-Control", webUiCacheControl(requestPathname(reply)));
		},
	});
}

/** A file of the embedded web UI, decoded once. */
export interface EmbeddedFile {
	readonly buf: Buffer;
	readonly contentType: string;
}

/**
 * Serve the web UI from memory: the SEA, which has no `static/` on disk. A path
 * with no file is the SPA's `index.html`, so a reload on a client-side route
 * works, except under `/assets/`, `/api/` and `/ws`, which have no page to give.
 */
export function registerEmbeddedWebUi(
	app: FastifyInstance,
	fileMap: ReadonlyMap<string, EmbeddedFile>,
): void {
	const indexEntry = fileMap.get("/index.html");

	// Catch-all route for all non-API, non-WS requests.
	// Must be registered AFTER API routes so it doesn't shadow them.
	app.get("/*", async (request, reply) => {
		const pathname = new URL(request.url, "http://localhost").pathname;

		// No /api/* or /ws route matched: a 404, not a page.
		if (pathname.startsWith("/api/") || pathname === "/api") {
			return reply.code(404).send({ error: "NOT_FOUND", message: "No such API route" });
		}
		if (pathname === "/ws" || pathname.startsWith("/ws/")) {
			return reply.code(404).send({ error: "NOT_FOUND", message: "WebSocket endpoint" });
		}

		const fileKey = pathname === "/" ? "/index.html" : pathname;
		const file = fileMap.get(fileKey);
		if (file) {
			return reply
				.header("Content-Type", file.contentType)
				.header("Cache-Control", webUiCacheControl(pathname))
				.send(file.buf);
		}

		// An asset this build does not have: a page left over from an older build
		// asking for its chunks. Its loader must see the failure (#560), and a cache
		// must not keep `index.html` under the script's name (#561).
		if (isHashedAssetPath(pathname)) {
			return reply.code(404).send({ error: "NOT_FOUND", message: "No such asset in this build" });
		}

		if (indexEntry) {
			return reply
				.header("Content-Type", "text/html")
				.header("Cache-Control", webUiCacheControl("/index.html"))
				.send(indexEntry.buf);
		}

		// No index.html available — this shouldn't happen if the manifest is valid.
		return reply.code(404).send({ error: "NOT_FOUND", message: "index.html not in SEA manifest" });
	});
}
