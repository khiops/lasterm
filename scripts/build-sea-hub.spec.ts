/**
 * build-sea-hub.spec.ts
 *
 * Tests for the esbuild bundler (build-sea-hub.ts) and the
 * native addon loader (sea-addon-loader.ts for the hub).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import type { BuildOptions } from "esbuild";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readMigrationFiles } from "../packages/hub/src/storage/migration-files.js";
import { describeOpenDatabases } from "../packages/hub/src/storage/open-databases.fixture.js";

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
// Test 2: SQLite is node:sqlite, built into the Node the executable embeds (#893)
// ────────────────────────────────────────────────────────────────────────────

describe("SQLite comes from node:sqlite", () => {
	it("requires node:sqlite, which the executable's own Node provides", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// One require for storage/sqlite.ts, one in the spool checkpoint worker's source.
		expect(content.split('require("node:sqlite")').length - 1).toBe(2);
	});

	it("bundles no SQLite addon, nor a prelude to extract one", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// Mutation caught: a hub module importing better-sqlite3 again, which
		// bundles its lib/ and its addon finder, or the SQLite prelude coming back.
		expect(content).not.toContain('require("better-sqlite3")');
		expect(content).not.toContain("PREBUILD_PLATFORMS");
		expect(content).not.toContain("getPrebuildPath");
		// The addon's name appears once: in the list of what earlier executables
		// extracted, which retired-addon-cache.ts removes from the cache (#889).
		// Another mention is the addon coming back.
		expect(content.split("better_sqlite3.node").length - 1).toBe(1);
		expect(content).toContain("retireAddonCacheOfEarlierVersions");
		expect(content).not.toContain("__seaSqliteExports");
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
		// 021-baseline.sql creates the `hosts` table — that DDL must be present.
		expect(content).toContain("CREATE TABLE hosts");
	});

	it("spool migration SQL content appears in the bundle", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// 001-initial.sql for spool creates the `chunks` table (PTY output storage).
		expect(content).toContain("CREATE TABLE chunks");
	});

	it("migration filenames are embedded in the manifest", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// The manifest JSON contains the filename property for each migration,
		// whose number the runner compares with schema_version.
		expect(content).toContain("021-baseline.sql");
		expect(content).toContain("001-initial.sql");
	});

	it("bundle does not contain readdirSync or readFileSync calls for migrations", () => {
		const content = readFileSync(OUT_FILE, "utf8");
		// The migrations plugin replaces storage/migration-files.ts, which reads
		// them with readdirSync + readFileSync. Any remaining use in the bundle
		// must NOT be referencing the migrations directory.
		expect(content).not.toContain("/migrations/meta");
		expect(content).not.toContain("/migrations/spool");
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 7: the executable opens its databases with storage/db.ts itself (#745)
// ────────────────────────────────────────────────────────────────────────────

const STORAGE_SOURCE = join(ROOT, "packages", "hub", "src", "storage");

/**
 * A hub module as the executable bundles it, with the build's own options and
 * plugins, then loaded. Left out: the prelude and the call to main(), which
 * belong to the CLI entry. SQLite is node:sqlite, a built-in module, required
 * here as the executable requires it.
 */
async function bundleAsTheExecutable<T>(source: string): Promise<T> {
	const { buildOptions } = await import("./build-sea-hub.js");
	const result = await build({
		...buildOptions,
		entryPoints: [source],
		write: false,
		banner: {},
		footer: {},
		logLevel: "silent",
	});
	const code = result.outputFiles?.[0]?.text;
	if (code === undefined) throw new Error(`bundling ${source} produced no output`);
	const module = { exports: {} };
	compileFunction(code, ["module", "exports", "require"], { filename: `${source}.bundled.cjs` })(
		module,
		module.exports,
		createRequire(source),
	);
	return module.exports as T;
}

describe("the executable's database module is storage/db.ts (#745)", () => {
	let db: typeof import("../packages/hub/src/storage/db.js") | undefined;

	beforeAll(async () => {
		db = await bundleAsTheExecutable(join(STORAGE_SOURCE, "db.ts"));
	}, 60_000);

	// Mutation caught: a module in db.ts's place, as the build had until #745.
	it("bundles db.ts whole, with the exports it has", async () => {
		const source = await import("../packages/hub/src/storage/db.js");
		expect(Object.keys(db!).sort()).toEqual(Object.keys(source).sort());
	});

	it("reads the migrations embedded when it was built, the files the hub reads from disk", async () => {
		const embedded = await bundleAsTheExecutable<
			typeof import("../packages/hub/src/storage/migration-files.js")
		>(join(STORAGE_SOURCE, "migration-files.ts"));
		for (const set of ["meta", "spool"] as const) {
			expect(readMigrationFiles(set).length, set).toBeGreaterThan(0);
			expect(embedded.readMigrationFiles(set), set).toEqual(readMigrationFiles(set));
		}
	});

	describeOpenDatabases("db.ts as the executable bundles it", () => db!.openDatabases);
});

// ────────────────────────────────────────────────────────────────────────────
// Test 8: hub sea-addon-loader tells a run from source from the executable
// ────────────────────────────────────────────────────────────────────────────

describe("hub sea-addon-loader in non-SEA mode", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detectSea() returns false in normal Node.js", async () => {
		const { detectSea } = await import("../packages/hub/src/sea-addon-loader.js");
		expect(detectSea()).toBe(false);
	});
});
