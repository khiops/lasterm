import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";
import {
	type EmbeddedFile,
	registerEmbeddedWebUi,
	registerWebUiDirectory,
	webUiCacheControl,
} from "./web-ui-files.js";

const INDEX_HTML = "<!doctype html><title>lasterm</title>";
const APP_JS = "console.log('app');";
const MANIFEST = JSON.stringify({ name: "Lasterm", start_url: "/", display: "standalone" });
const WORKER_JS = "self.addEventListener('fetch', () => {});";

const IMMUTABLE = "public, max-age=31536000, immutable";

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close();
	for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function embedded(): Map<string, EmbeddedFile> {
	const file = (content: string, contentType: string): EmbeddedFile => ({
		buf: Buffer.from(content),
		contentType,
	});
	return new Map([
		["/index.html", file(INDEX_HTML, "text/html")],
		["/assets/index-abc123.js", file(APP_JS, "application/javascript")],
		["/manifest.webmanifest", file(MANIFEST, "application/manifest+json")],
		["/sw.js", file(WORKER_JS, "application/javascript")],
	]);
}

async function embeddedHub(): Promise<FastifyInstance> {
	const app = Fastify();
	apps.push(app);
	registerEmbeddedWebUi(app, embedded());
	await app.ready();
	return app;
}

async function diskHub(): Promise<FastifyInstance> {
	const dir = makeTempDir("lasterm-web-ui-");
	dirs.push(dir);
	mkdirSync(join(dir, "assets"));
	writeFileSync(join(dir, "index.html"), INDEX_HTML);
	writeFileSync(join(dir, "assets", "index-abc123.js"), APP_JS);
	writeFileSync(join(dir, "manifest.webmanifest"), MANIFEST);
	writeFileSync(join(dir, "sw.js"), WORKER_JS);
	const app = Fastify();
	apps.push(app);
	await registerWebUiDirectory(app, dir);
	await app.ready();
	return app;
}

describe("the web UI's cache headers (#561)", () => {
	it("keeps hashed assets for good, and revalidates what a new build must reach at once", () => {
		expect(webUiCacheControl("/assets/index-abc123.js")).toBe(IMMUTABLE);
		expect(webUiCacheControl("/")).toBe("no-cache");
		expect(webUiCacheControl("/index.html")).toBe("no-cache");
		expect(webUiCacheControl("/sw.js")).toBe("no-cache");
		expect(webUiCacheControl("/manifest.webmanifest")).toBe("no-cache");
		expect(webUiCacheControl("/icons/icon-192.png")).toBe("public, max-age=3600");
	});
});

describe.each([
	["from the SEA's embedded files", embeddedHub],
	["from a static directory on disk", diskHub],
])("the web UI served %s", (_where, hub) => {
	it("answers an asset this build does not have with a 404, never the SPA page", async () => {
		const app = await hub();
		const res = await app.inject({ method: "GET", url: "/assets/index-older99.js" });

		expect(res.statusCode).toBe(404);
		expect(res.headers["content-type"]).not.toMatch(/text\/html/);
		expect(res.body).not.toContain(INDEX_HTML);
	});

	it("serves the manifest as a web app manifest, revalidated on every load", async () => {
		const app = await hub();
		const res = await app.inject({ method: "GET", url: "/manifest.webmanifest" });

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toMatch(/^application\/manifest\+json/);
		expect(res.headers["cache-control"]).toBe("no-cache");
		expect(res.json()).toMatchObject({ name: "Lasterm" });
	});

	it("serves the worker as a script, revalidated on every load", async () => {
		const app = await hub();
		const res = await app.inject({ method: "GET", url: "/sw.js" });

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toMatch(/^application\/javascript/);
		expect(res.headers["cache-control"]).toBe("no-cache");
	});

	it("serves a hashed asset as immutable, and the entry page as no-cache", async () => {
		const app = await hub();
		const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
		const page = await app.inject({ method: "GET", url: "/" });

		expect(asset.statusCode).toBe(200);
		expect(asset.headers["cache-control"]).toBe(IMMUTABLE);
		expect(page.statusCode).toBe(200);
		expect(page.body).toBe(INDEX_HTML);
		expect(page.headers["cache-control"]).toBe("no-cache");
	});
});

describe("the SEA's SPA fallback", () => {
	it("still answers a path with no file outside /assets/ with index.html", async () => {
		const app = await embeddedHub();
		const res = await app.inject({ method: "GET", url: "/some/client/route" });

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toMatch(/^text\/html/);
		expect(res.body).toBe(INDEX_HTML);
	});
});
