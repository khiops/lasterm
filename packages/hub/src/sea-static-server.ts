/**
 * sea-static-server.ts
 *
 * In-memory web UI static file serving for Node Single Executable Applications (SEA).
 *
 * When the hub runs as a SEA binary there is no `static/` directory on disk.
 * Instead, all web UI files are embedded in the SEA asset blob as a
 * `static-manifest.json` (built by scripts/package-sea-hub.ts).
 *
 * This module:
 *   - Detects SEA mode via node:sea.isSea()
 *   - Loads the manifest from the SEA asset blob
 *   - Registers a Fastify route that serves the files from memory
 *   - Implements SPA fallback: non-API paths not matching a file → index.html,
 *     except under /assets/, where a missing file is a 404 (#561)
 *
 * In normal Node.js mode (no SEA) this module is a complete no-op.
 * The caller should call registerSeaStaticServing() and check the return value:
 *   - true  → SEA serving is active
 *   - false → not in SEA mode; caller must arrange alternative serving (e.g. @fastify/static)
 */

import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { type EmbeddedFile, registerEmbeddedWebUi } from "./web-ui-files.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** A single file entry in the static manifest. */
interface StaticFileEntry {
	/** Base64-encoded file contents. */
	data: string;
	/** MIME content-type string. */
	contentType: string;
}

/** The full manifest structure embedded as a SEA asset. */
type StaticManifest = Record<string, StaticFileEntry>;

// ────────────────────────────────────────────────────────────────────────────
// SEA detection (mirrors sea-addon-loader.ts)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Check whether the process is running inside a Node SEA binary.
 * Returns false in normal Node.js execution.
 */
function detectSea(): boolean {
	try {
		const req = createRequire(import.meta.url);
		const seaMod = req("node:sea") as { isSea?: () => boolean };
		return typeof seaMod.isSea === "function" && seaMod.isSea();
	} catch {
		return false;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Manifest loading
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load the static manifest from the SEA asset blob.
 * Returns null if the manifest is absent, empty, or malformed.
 */
function loadStaticManifest(): StaticManifest | null {
	try {
		const req = createRequire(import.meta.url);
		const seaMod = req("node:sea") as {
			getRawAsset: (name: string) => ArrayBuffer;
			getAsset?: (name: string, encoding: BufferEncoding) => string;
		};

		let json: string;
		if (typeof seaMod.getAsset === "function") {
			json = seaMod.getAsset("static-manifest.json", "utf8");
		} else {
			// Fallback: decode as UTF-8 from raw bytes
			const raw = seaMod.getRawAsset("static-manifest.json");
			json = Buffer.from(raw).toString("utf8");
		}

		const manifest = JSON.parse(json) as StaticManifest;

		// An empty manifest means the web UI was not embedded.
		if (Object.keys(manifest).length === 0) {
			return null;
		}

		return manifest;
	} catch {
		// Asset missing or malformed — treat as not embedded.
		return null;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// In-memory file map
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build an in-memory Map from the manifest.
 * Keys are normalised URL paths (leading slash, forward slashes).
 * The Buffer for each file is decoded once and cached.
 */
function buildFileMap(manifest: StaticManifest): Map<string, EmbeddedFile> {
	const map = new Map<string, EmbeddedFile>();

	for (const [relativePath, entry] of Object.entries(manifest)) {
		// Normalise: remove leading slash if present, then prepend /
		const key = `/${relativePath.replace(/^\/+/, "")}`;
		const buf = Buffer.from(entry.data, "base64");
		map.set(key, { buf, contentType: entry.contentType });
	}

	return map;
}

// ────────────────────────────────────────────────────────────────────────────
// Fastify route registration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Register in-memory static file serving on `app` using the embedded SEA manifest.
 *
 * Route behaviour is `registerEmbeddedWebUi`'s (`web-ui-files.ts`):
 * - Exact match to `/`          → serve `index.html`
 * - Exact match to known file   → serve that file with correct content-type
 * - `/api/*` or `/ws*`          → 404 (no dedicated route matched)
 * - Missing file under /assets/ → 404, never index.html (#561)
 * - Anything else (SPA routes)  → serve `index.html` for client-side routing
 *
 * @returns true if SEA serving was set up, false if not in SEA mode or manifest is absent.
 */
export async function registerSeaStaticServing(app: FastifyInstance): Promise<boolean> {
	if (!detectSea()) {
		return false;
	}

	const manifest = loadStaticManifest();
	if (manifest === null) {
		app.log.warn(
			"[sea-static-server] running in SEA mode but static-manifest.json is empty or missing — web UI will not be served",
		);
		return false;
	}

	const fileMap = buildFileMap(manifest);

	app.log.info(
		{ files: fileMap.size },
		"[sea-static-server] serving web UI from SEA embedded manifest",
	);

	registerEmbeddedWebUi(app, fileMap);

	return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Exports for testing
// ────────────────────────────────────────────────────────────────────────────

export {
	buildFileMap as _buildFileMap,
	detectSea as _detectSea,
	loadStaticManifest as _loadStaticManifest,
};
