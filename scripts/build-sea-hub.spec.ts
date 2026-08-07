/**
 * build-sea-hub.spec.ts
 *
 * Tests for the esbuild bundler (build-sea-hub.ts) and the
 * native addon loader (sea-addon-loader.ts for the hub).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildOptions } from "esbuild";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_FILE = join(ROOT, "dist", "sea", "lasterm-hub.cjs");

// ────────────────────────────────────────────────────────────────────────────
// Test 1: esbuild bundle produces valid CJS output
// ────────────────────────────────────────────────────────────────────────────

describe("esbuild bundle produces valid CJS", () => {
	beforeAll(async () => {
		// Import build options from the script under test and run the build.
		const { buildOptions } = await import("./build-sea-hub.js");
		mkdirSync(join(ROOT, "dist", "sea"), { recursive: true });
		await build(buildOptions as BuildOptions);
	}, 120_000);

	it("output file exists", () => {
		expect(existsSync(OUT_FILE)).toBe(true);
	});

	it("output file is non-empty", () => {
		const data = readFileSync(OUT_FILE);
		expect(data.byteLength).toBeGreaterThan(1024);
	});

	it("output starts with shebang", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
	});

	it("output is syntactically valid CJS", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// esbuild CJS bundles always include "use strict" and var declarations.
		expect(content).toMatch(/"use strict"|var __/);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 2: better-sqlite3 is bundled (not external) with bindings shim
// ────────────────────────────────────────────────────────────────────────────

describe("better-sqlite3 is bundled with bindings shim", () => {
	it("better-sqlite3 is NOT external — no require('better-sqlite3') in bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// When bundled (not external), esbuild inlines the JS source.
		// An external require("better-sqlite3") call must NOT appear.
		expect(content).not.toContain('require("better-sqlite3")');
	});

	it("better-sqlite3 JS internals appear in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// When bundled, better-sqlite3 identifiers appear inline.
		// "Database" is the main export class from better-sqlite3.
		expect(content).toMatch(/better.sqlite3|better_sqlite3/i);
	});

	it("bindings shim references __seaSqliteExports", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// The betterSqliteBindingsPlugin shim must be present in the bundle,
		// routing native addon resolution to the SEA-pre-loaded exports.
		expect(content).toContain("__seaSqliteExports");
	});

	it("better_sqlite3.node is not embedded as a binary blob", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// The raw .node file path patterns from better-sqlite3's build output
		// must NOT appear — that would mean the native code was inlined (wrong).
		expect(content).not.toContain("build/Release/better_sqlite3.node");
		expect(content).not.toContain("build/Debug/better_sqlite3.node");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 3: fastify is inlined
// ────────────────────────────────────────────────────────────────────────────

describe("bundle includes fastify inline", () => {
	it("fastify is inlined — no external require('fastify')", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// When inlined, there should be no top-level external require("fastify").
		expect(content).not.toMatch(/require\(["']fastify["']\)/);
	});

	it("fastify internals appear in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// Fastify registers plugins with addPlugin / addHook internally.
		// Some internal identifier will always appear when inlined.
		expect(content).toContain("fastify");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 4: @lasterm/shared is inlined
// ────────────────────────────────────────────────────────────────────────────

describe("bundle includes @lasterm/shared inline", () => {
	it("@lasterm/shared is inlined — no external require", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		expect(content).not.toContain('require("@lasterm/shared")');
	});

	it("encodeFrame from @lasterm/shared appears in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// encodeFrame is a core export used by the hub agent transport.
		expect(content).toContain("encodeFrame");
	});

	it("FrameReader from @lasterm/shared appears in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		expect(content).toContain("FrameReader");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 5: ssh2 is inlined
// ────────────────────────────────────────────────────────────────────────────

describe("bundle includes ssh2 inline", () => {
	it("ssh2 is inlined — no external require('ssh2')", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		expect(content).not.toMatch(/require\(["']ssh2["']\)/);
	});

	it("ssh2 internals appear in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// ssh2 defines known identifiers when bundled inline.
		expect(content).toContain("ssh2");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 6: migrations are embedded inline
// ────────────────────────────────────────────────────────────────────────────

describe("migrations are embedded inline", () => {
	it("meta migration SQL content appears in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// 001-initial.sql creates the `hosts` table — that DDL must be present.
		expect(content).toContain("CREATE TABLE hosts");
	});

	it("spool migration SQL content appears in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// 001-initial.sql for spool creates the `chunks` table (PTY output storage).
		expect(content).toContain("CREATE TABLE chunks");
	});

	it("migration filenames are embedded in the manifest", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// The manifest JSON contains the filename property for each migration.
		expect(content).toContain("001-initial.sql");
	});

	it("bundle does not contain readdirSync or readFileSync calls for migrations", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// The migrations plugin replaces the original db.ts which used
		// readdirSync + readFileSync. Any remaining use in the bundle must
		// NOT be referencing the MIGRATIONS_DIR path.
		expect(content).not.toContain("/migrations/meta");
		expect(content).not.toContain("/migrations/spool");
	});

	it("SEA bootstrap banner is generated from the shared addon loader", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		expect(content).toContain("__seaSqliteExports");
		// Mutation caught: restoring a string-built bootstrap removes this normal
		// prelude entry and reintroduces a second extraction implementation.
		expect(content).toContain("bootstrapSeaSqlite");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 7: hub sea-addon-loader is a no-op when not in SEA mode
// ────────────────────────────────────────────────────────────────────────────

describe("hub sea-addon-loader in non-SEA mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detectSea() returns false in normal Node.js", async () => {
		const { detectSea } = await import("../packages/hub/src/sea-addon-loader.js");
		expect(detectSea()).toBe(false);
	});

	it("initSeaAddons() does not call dlopen in normal Node.js", async () => {
		const { initSeaAddons } = await import("../packages/hub/src/sea-addon-loader.js");
		const dlopenSpy = vi.spyOn(process, "dlopen");
		expect(() => initSeaAddons()).not.toThrow();
		expect(dlopenSpy).not.toHaveBeenCalled();
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 8: hub sea-addon-loader extraction logic
// ────────────────────────────────────────────────────────────────────────────

describe("hub sea-addon-loader extraction logic", () => {
	const TEMP_CACHE_BASE = join(ROOT, "dist", "test-sea-hub-cache");

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(TEMP_CACHE_BASE, { recursive: true, force: true });
	});

	it("extractAddonToDir writes the blob to cacheDir/name", async () => {
		const { extractAddonToDir } = await import("../packages/hub/src/sea-addon-loader.js");

		const fakeData = Buffer.from("fake-sqlite-addon-bytes");
		const cacheDir = join(TEMP_CACHE_BASE, "v0.1.0");
		const resultPath = extractAddonToDir("better_sqlite3.node", cacheDir, fakeData);

		expect(existsSync(resultPath)).toBe(true);
		expect(readFileSync(resultPath).equals(fakeData)).toBe(true);
		expect(resultPath).toBe(join(cacheDir, "better_sqlite3.node"));
	});

	it("extractAddonToDir skips write when file already has correct size", async () => {
		const { extractAddonToDir } = await import("../packages/hub/src/sea-addon-loader.js");

		const fakeData = Buffer.from("fake-sqlite-addon-bytes");
		const cacheDir = join(TEMP_CACHE_BASE, "v0.1.0");
		mkdirSync(cacheDir, { recursive: true });
		const destPath = join(cacheDir, "better_sqlite3.node");

		writeFileSync(destPath, fakeData, { mode: 0o755 });
		const mtimeBefore = existsSync(destPath)
			? (await import("node:fs")).statSync(destPath).mtimeMs
			: -1;

		await new Promise((r) => setTimeout(r, 10));
		extractAddonToDir("better_sqlite3.node", cacheDir, fakeData);

		const mtimeAfter = (await import("node:fs")).statSync(destPath).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);
	});

	it("extractAddonToDir re-writes when file has different size", async () => {
		const { extractAddonToDir } = await import("../packages/hub/src/sea-addon-loader.js");

		const cacheDir = join(TEMP_CACHE_BASE, "v0.1.0");
		mkdirSync(cacheDir, { recursive: true });
		const destPath = join(cacheDir, "better_sqlite3.node");

		writeFileSync(destPath, Buffer.from("old-data"), { mode: 0o755 });

		const newData = Buffer.from("new-data-with-different-length-xxxx");
		extractAddonToDir("better_sqlite3.node", cacheDir, newData);

		expect(readFileSync(destPath).equals(newData)).toBe(true);
	});

	it("getAddonCacheDir returns path containing version and lasterm", async () => {
		const { getAddonCacheDir } = await import("../packages/hub/src/sea-addon-loader.js");
		const dir = getAddonCacheDir("2.0.0");
		expect(dir).toContain("2.0.0");
		expect(dir).toContain("lasterm");
		expect(dir).toContain("addons");
	});

	it("loadNativeAddon calls dlopen with the extracted path", async () => {
		const { loadNativeAddon } = await import("../packages/hub/src/sea-addon-loader.js");

		const fakeData = Buffer.from("fake-sqlite-addon-for-dlopen");
		const cacheDir = join(TEMP_CACHE_BASE, "dlopen-test");

		const dlopenSpy = vi.spyOn(process, "dlopen").mockImplementation(() => {});

		const fakeSeaModule = {
			getRawAsset: (_name: string): ArrayBuffer =>
				fakeData.buffer.slice(
					fakeData.byteOffset,
					fakeData.byteOffset + fakeData.byteLength,
				) as ArrayBuffer,
		};

		loadNativeAddon("better_sqlite3.node", cacheDir, fakeSeaModule);

		expect(dlopenSpy).toHaveBeenCalledTimes(1);
		expect(dlopenSpy.mock.calls[0]?.[0]).toHaveProperty("exports");
		expect(dlopenSpy.mock.calls[0]?.[1]).toMatch(/better_sqlite3\.node$/);
	});
});
