/**
 * build-sea-hub.spec.ts
 *
 * Tests for the esbuild bundler (build-sea-hub.ts) and the
 * native addon loader (sea-addon-loader.ts for the hub).
 *
 * What the bundle holds is read from the metafile esbuild returns, and what it
 * does from running it. The executable packaged from it is run by
 * sea-hub-e2e.spec.ts: its SQLite, its addons and the cache it clears.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readMigrationFiles } from "../packages/hub/src/storage/migration-files.js";
import { describeOpenDatabases } from "../packages/hub/src/storage/open-databases.fixture.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_FILE = join(ROOT, "dist", "sea", "lasterm-hub.cjs");

/**
 * What the bundle may leave to the runtime besides Node's own modules: each is
 * required inside a try by the package that wants it, which goes on without it.
 * The executable has no node_modules, so anything else it requires fails there.
 */
const OPTIONAL_MODULES = new Set([
	// ssh2's CPU detection, and its own native crypto, never built here (allowBuilds).
	"cpu-features",
	"./crypto/build/Release/sshcrypto.node",
	// ws's native helpers.
	"bufferutil",
	"utf-8-validate",
]);

// ────────────────────────────────────────────────────────────────────────────
// Test 1: the bundle runs on its own, as the executable runs it
// ────────────────────────────────────────────────────────────────────────────

describe("the bundle build-sea-hub.ts writes", () => {
	let metafile: Metafile | undefined;

	beforeAll(async () => {
		const { buildOptions } = await import("./build-sea-hub.js");
		mkdirSync(join(ROOT, "dist", "sea"), { recursive: true });
		// Gone first, so what runs below is this build's output, not an earlier one.
		rmSync(OUT_FILE, { force: true });
		({ metafile } = await build({ ...buildOptions, metafile: true }));
	}, 120_000);

	// Mutations caught: a build that writes nothing where packaging takes it; a
	// bundle in any format but CommonJS, which Node SEA requires; one that never
	// calls main(); one that requires a package a directory without node_modules
	// lacks, as the executable does.
	it("runs as CommonJS from a directory with no node_modules: agent status --json answers", () => {
		const dir = mkdtempSync(join(tmpdir(), "lasterm-bundle-"));
		// Nor a NODE_PATH: the shim pnpm installs for vitest sets one into its store.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "NODE_PATH"),
		);
		try {
			const bundle = join(dir, "lasterm-hub.cjs");
			copyFileSync(OUT_FILE, bundle);
			const result = spawnSync(process.execPath, [bundle, "agent", "status", "--json"], {
				cwd: dir,
				env,
				encoding: "utf8",
				timeout: 60_000,
				windowsHide: true,
			});
			const said = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
			expect(result.error, said).toBeUndefined();
			expect(result.status, said).toBe(0);
			expect(JSON.parse(result.stdout), said).toMatchObject({
				hub_version: expect.any(String),
				targets: expect.any(Array),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	// Mutations caught: fastify, ssh2, @lasterm/shared, or any other package,
	// left external, where the executable cannot load it, including one that only
	// a path the run above does not take requires.
	it("leaves to the runtime only Node's built-in modules, and modules its packages do without", () => {
		const left = Object.values(metafile!.outputs)
			.flatMap((output) => output.imports)
			.filter((entry) => entry.external && !isBuiltin(entry.path))
			.map((entry) => entry.path);
		expect([...new Set(left)].filter((path) => !OPTIONAL_MODULES.has(path))).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Test 2: the executable opens its databases with storage/db.ts itself (#745)
// ────────────────────────────────────────────────────────────────────────────

const STORAGE_SOURCE = join(ROOT, "packages", "hub", "src", "storage");

/**
 * A hub module as the executable bundles it, with the build's own options,
 * plugins and banner, then loaded from a directory of its own, as far from the
 * sources as the executable is. Left out: the call to main(), which belongs to
 * the CLI entry. SQLite is node:sqlite, a built-in module, required here as the
 * executable requires it.
 */
async function bundleAsTheExecutable<T>(source: string): Promise<T> {
	const { buildOptions } = await import("./build-sea-hub.js");
	const dir = mkdtempSync(join(tmpdir(), "lasterm-bundled-"));
	try {
		const outfile = join(dir, `${basename(source)}.cjs`);
		await build({
			...buildOptions,
			entryPoints: [source],
			outfile,
			footer: {},
			logLevel: "silent",
		});
		return createRequire(import.meta.url)(outfile) as T;
	} finally {
		rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
	}
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

	// Mutation caught: a build that leaves the migrations on disk, beside a
	// module the executable has no directory for.
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
// Test 3: hub sea-addon-loader tells a run from source from the executable
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
