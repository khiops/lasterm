/**
 * build-sea-hub.ts
 *
 * esbuild bundler for the termora-hub Node SEA binary.
 *
 * Bundles packages/hub/src/cli.ts into a single CJS file at
 * dist/sea/termora-hub.cjs suitable for embedding in a Node SEA blob.
 *
 * Key decisions:
 * - Format: CJS  — Node SEA requires a CJS entry for process.dlopen compat.
 * - better-sqlite3: BUNDLED — its JS is inlined; the native .node binary is
 *   embedded as a SEA asset and pre-loaded by the banner into __seaSqliteExports.
 *   betterSqliteBindingsPlugin() intercepts require('bindings') inside the
 *   better-sqlite3 source and returns __seaSqliteExports instead.
 * - cpu-features: external + optional — ssh2 optional dep, may not be present.
 * - @termora/shared: inlined — workspace package, not a published dep.
 * - Fastify + plugins: inlined — pure JS, no native deps.
 * - ssh2: inlined — pure JS.
 * - Sourcemaps: disabled — SEA doesn't support source-mapped stack traces.
 * - Minify: disabled — easier debugging, size is not critical.
 * - Migrations: embedded inline — SQL files bundled as strings via plugin.
 * - Static web UI: embedded at SEA packaging step, not here.
 *
 * Prerequisites:
 *   Run `pnpm build:embed` BEFORE building the hub SEA bundle if you want
 *   the web UI static files embedded. The esbuild step bundles the JS; the
 *   SEA packaging step (build-sea-binary.ts) embeds the static file manifest.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, buildSync, type Plugin } from "esbuild";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const HUB_ENTRY = join(ROOT, "packages", "hub", "src", "cli.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Build hash — injected as TERMORA_BUILD_HASH so build-version.ts picks it up
// ─────────────────────────────────────────────────────────────────────────────

function resolveBuildHash(): string {
	const env = process.env.TERMORA_BUILD_HASH;
	if (env && env.length > 0) return env.slice(0, 7);
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "dev";
	}
}

const SEA_BUILD_HASH = resolveBuildHash();

// Hub semver — injected as TERMORA_VERSION so build-version.ts resolves the
// release version INSIDE the SEA. build-version.ts's package.json fallback uses a
// dynamic require that esbuild does not inline, so without this a packaged hub
// falls back to "0.0.0" and version-aware agent fetch/deploy silently breaks.
// Resolution: TERMORA_VERSION env → the hub package.json version (release CI pins
// it to the tag via the version-consistency guard).
function resolveHubVersion(): string {
	const env = process.env.TERMORA_VERSION;
	if (env && env.length > 0) return env;
	try {
		const pkg = JSON.parse(
			readFileSync(join(ROOT, "packages", "hub", "package.json"), "utf-8"),
		) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const SEA_VERSION = resolveHubVersion();
const MIGRATIONS_BASE = join(ROOT, "packages", "hub", "src", "storage", "migrations");
const OUT_DIR = join(ROOT, "dist", "sea");
const OUT_FILE = join(OUT_DIR, "termora-hub.cjs");
const SEA_SQLITE_BOOTSTRAP_ENTRY = join(ROOT, "scripts", "sea-sqlite-bootstrap.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Plugin: migrations embed
//
// Intercepts the loading of packages/hub/src/storage/db.ts and replaces the
// filesystem-based migration runner with one that uses SQL strings bundled
// inline at build time.
//
// This preserves the same openDatabases / openTestDatabases exports so no
// other hub code needs to change.
// ─────────────────────────────────────────────────────────────────────────────

function readMigrationsDir(subdir: string): Array<{ file: string; sql: string }> {
	const dir = join(MIGRATIONS_BASE, subdir);
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((f) => /^\d{3}-.*\.sql$/.test(f))
			.sort();
	} catch {
		return [];
	}
	return files.map((file) => ({
		file,
		sql: readFileSync(join(dir, file), "utf-8"),
	}));
}

function migrationsEmbedPlugin(): Plugin {
	return {
		name: "migrations-embed",
		setup(buildContext) {
			buildContext.onLoad(
				{ filter: /packages[\\/]hub[\\/]src[\\/]storage[\\/]db\.(ts|js)$/ },
				() => {
					const metaMigrations = readMigrationsDir("meta");
					const spoolMigrations = readMigrationsDir("spool");

					const metaJson = JSON.stringify(metaMigrations);
					const spoolJson = JSON.stringify(spoolMigrations);

					// Replacement module — preserves the same exports as db.ts
					// but sources SQL from the inline manifests rather than the
					// filesystem. This makes the bundle work in SEA mode where
					// the migrations/ directory is not present on disk.
					const lines = [
						'"use strict";',
						'import Database from "better-sqlite3";',
						'import { join } from "node:path";',
						"",
						"// Embedded migration manifests (generated at build time)",
						`const __metaMigrations = ${metaJson};`,
						`const __spoolMigrations = ${spoolJson};`,
						"",
						"function applyCommonPragmas(db) {",
						'  db.pragma("journal_mode = WAL");',
						'  db.pragma("synchronous = NORMAL");',
						'  db.pragma("foreign_keys = ON");',
						'  db.pragma("busy_timeout = 5000");',
						'  db.pragma("cache_size = -8000");',
						"}",
						"",
						"function applySpoolPragmas(db) {",
						'  const cur = db.pragma("auto_vacuum", { simple: true });',
						"  if (cur !== 2) {",
						'    db.pragma("auto_vacuum = INCREMENTAL");',
						"  }",
						"}",
						"",
						"function runMigrationsFromManifest(db, migrations) {",
						"  const hasSV = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'\").get() !== undefined;",
						"  let currentVersion = 0;",
						"  if (hasSV) {",
						'    const row = db.prepare("SELECT MAX(version) as v FROM schema_version").get();',
						"    currentVersion = row.v ?? 0;",
						"  }",
						"  const parseNum = (f) => Number.parseInt(f.slice(0, 3), 10);",
						"  const last = migrations[migrations.length - 1];",
						"  const latest = migrations.length > 0 && last ? parseNum(last.file) : 0;",
						"  if (currentVersion > latest && latest > 0) {",
						'    console.warn("[storage] DB schema version ahead of latest migration - skipping");',
						"    return;",
						"  }",
						"  for (const { file, sql } of migrations) {",
						"    const num = parseNum(file);",
						"    if (num <= currentVersion) continue;",
						"    const apply = db.transaction(() => {",
						"      db.exec(sql);",
						'      const va = db.prepare("SELECT MAX(version) as v FROM schema_version").get();',
						"      if ((va.v ?? 0) < num) {",
						"        db.prepare(\"INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))\").run(num);",
						"      }",
						"    });",
						"    apply();",
						'    console.info("[storage] Applied migration " + file);',
						"  }",
						"}",
						"",
						"export function openDatabases(dataDir) {",
						'  const metaDb = new Database(join(dataDir, "meta.db"));',
						"  applyCommonPragmas(metaDb);",
						'  metaDb.pragma("wal_autocheckpoint = 1000");',
						'  const spoolDb = new Database(join(dataDir, "spool.db"));',
						"  applySpoolPragmas(spoolDb);",
						"  applyCommonPragmas(spoolDb);",
						'  spoolDb.pragma("wal_autocheckpoint = 2000");',
						"  runMigrationsFromManifest(metaDb, __metaMigrations);",
						"  runMigrationsFromManifest(spoolDb, __spoolMigrations);",
						"  return { meta: metaDb, spool: spoolDb, close() { metaDb.close(); spoolDb.close(); } };",
						"}",
						"",
						"export function openTestDatabases() {",
						'  const metaDb = new Database(":memory:");',
						"  applyCommonPragmas(metaDb);",
						'  metaDb.pragma("wal_autocheckpoint = 1000");',
						'  const spoolDb = new Database(":memory:");',
						"  applySpoolPragmas(spoolDb);",
						"  applyCommonPragmas(spoolDb);",
						'  spoolDb.pragma("wal_autocheckpoint = 2000");',
						"  runMigrationsFromManifest(metaDb, __metaMigrations);",
						"  runMigrationsFromManifest(spoolDb, __spoolMigrations);",
						"  return { meta: metaDb, spool: spoolDb, close() { metaDb.close(); spoolDb.close(); } };",
						"}",
					];

					return { contents: lines.join("\n"), loader: "js" };
				},
			);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin: toml-edit-js shim
//
// @rainbowatcher/toml-edit-js exports shims.js as its main entry, which uses
// top-level await for browser/Deno compat. TLA is incompatible with CJS
// output format.
//
// Fix: redirect all imports of @rainbowatcher/toml-edit-js to its underlying
// index.js, which exports initSync/parse/stringify/edit without TLA.
// The hub already calls initSync() explicitly, so this is safe.
// ─────────────────────────────────────────────────────────────────────────────

function tomlEditShimPlugin(): Plugin {
	return {
		name: "toml-edit-shim",
		setup(buildContext) {
			// Intercept the top-level package import and redirect to index.js.
			buildContext.onResolve({ filter: /^@rainbowatcher\/toml-edit-js$/ }, (_args) => {
				// Resolve the package dynamically so the path stays correct after
				// version updates (avoids hardcoding the pnpm virtual-store path).
				// Anchor to HUB_ENTRY so pnpm resolves via hub's node_modules.
				const req = createRequire(HUB_ENTRY);
				const pkgIndex = req.resolve("@rainbowatcher/toml-edit-js/index");
				return { path: pkgIndex };
			});

			// The WASM file is required by index.js at runtime via initSync().
			// In SEA mode this needs special handling, but for the JS bundle
			// we just need to mark the .wasm as external (it won't be inlined).
			buildContext.onLoad({ filter: /\.wasm$/ }, () => ({
				contents: "module.exports = {};",
				loader: "js",
			}));
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin: ssh2 sshcrypto.node — mark as external
//
// ssh2 ships an optional native crypto addon (sshcrypto.node) for performance.
// It falls back to pure JS if the addon is unavailable.
// We can't bundle .node files, so we mark it external.
// ─────────────────────────────────────────────────────────────────────────────

function sshNativeShimPlugin(): Plugin {
	return {
		name: "ssh-native-shim",
		setup(buildContext) {
			// When ssh2/crypto.js tries to require('./crypto/build/Release/sshcrypto.node')
			// we intercept it and return a null module. The ssh2 code already
			// has a try/catch around this require, so it gracefully falls back.
			buildContext.onLoad({ filter: /sshcrypto\.node$/ }, () => ({
				contents: "module.exports = {};",
				loader: "js",
			}));
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin: import.meta shim (no-op; define handles it globally)
// ─────────────────────────────────────────────────────────────────────────────

function importMetaShimPlugin(): Plugin {
	return {
		name: "import-meta-shim",
		setup(_buildContext) {
			// The `define` option handles import.meta.url globally.
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SEA bootstrap banner
//
// The prelude must execute before the bundled better-sqlite3 wrapper. Bundle a
// normal TypeScript entry here instead of restating extraction as banner strings;
// its extraction call is therefore the same shared implementation as the
// runtime loader.
// ─────────────────────────────────────────────────────────────────────────────

function buildSeaBootstrapBanner(): string {
	const result = buildSync({
		entryPoints: [SEA_SQLITE_BOOTSTRAP_ENTRY],
		bundle: true,
		platform: "node",
		target: "node24",
		format: "cjs",
		write: false,
	});
	const output = result.outputFiles[0]?.text;
	if (!output) throw new Error("[build-sea-hub] SEA SQLite bootstrap produced no output");
	// Wrapped so its bindings are its own. A banner is text prepended to another
	// bundle, and esbuild names imports predictably — `import_node_fs` here and
	// `import_node_fs` there — so sharing one top-level scope let the main bundle's
	// lazily-initialised declaration of the same name reach the prelude, which then
	// read `existsSync` off `undefined` and killed the executable at startup.
	return [
		"// -- SEA native addon bootstrap (generated) --",
		"(function(){",
		output,
		"})();",
		"// -- end SEA bootstrap --",
	].join("\n");
}

const SEA_BOOTSTRAP_BANNER = buildSeaBootstrapBanner();

// ─────────────────────────────────────────────────────────────────────────────
// Plugin: better-sqlite3 bindings shim
//
// better-sqlite3's JS code calls require('bindings')('better_sqlite3.node')
// to locate its native addon. In SEA mode there is no node_modules on disk,
// so the bindings package fails with ENOENT.
//
// Fix: intercept the 'bindings' import when it originates from better-sqlite3
// and return a shim that reads from __seaSqliteExports — the global populated
// by the SEA bootstrap banner above (process.dlopen on the extracted .node).
//
// In non-SEA (dev) mode the shim is never reached because better-sqlite3 is
// not external anymore; esbuild bundles its JS, but the bindings call still
// goes through this shim. The shim checks for __seaSqliteExports first and
// falls back to node-gyp-build so dev mode continues to work.
// ─────────────────────────────────────────────────────────────────────────────

function betterSqliteBindingsPlugin(): Plugin {
	return {
		name: "better-sqlite3-bindings-shim",
		setup(buildContext) {
			// Intercept the 'bindings' package that better-sqlite3 uses to locate
			// its native addon. In SEA mode, the addon is pre-loaded by the banner
			// bootstrap into __seaSqliteExports. In non-SEA mode, this shim is never
			// reached because the original bindings package resolves normally.
			//
			// The banner bootstrap detects SEA mode and calls process.dlopen()
			// on the extracted better_sqlite3.node, storing the result in
			// __seaSqliteExports. This plugin makes sure the JS wrapper code
			// in better-sqlite3 receives those exports instead of trying to
			// load the .node file from disk via the bindings package.
			buildContext.onResolve({ filter: /^bindings$/ }, (args) => {
				// Only intercept when required from better-sqlite3
				if (args.importer.includes("better-sqlite3")) {
					return { path: "bindings", namespace: "sea-bindings-shim" };
				}
				return undefined; // Let other packages use bindings normally
			});

			buildContext.onLoad({ filter: /^bindings$/, namespace: "sea-bindings-shim" }, () => ({
				contents: `
					module.exports = function(name) {
						// globalThis.__seaSqliteExports is populated by the generated SEA bootstrap
						// in build-sea-hub.ts (process.dlopen on the extracted .node file).
						// This shim is only reached in the SEA bundle — in development the
						// real 'bindings' package resolves the .node file from node_modules.
						if (typeof globalThis.__seaSqliteExports !== 'undefined') {
							return globalThis.__seaSqliteExports;
						}
						// Guard: if somehow reached outside SEA (should not happen in prod),
						// throw a clear error rather than silently returning undefined.
						throw new Error('[termora-hub] better-sqlite3 bindings shim: __seaSqliteExports not set. Is the SEA bootstrap banner running?');
					};
				`,
				loader: "js",
			}));
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// esbuild config
// ─────────────────────────────────────────────────────────────────────────────

export const buildOptions: BuildOptions = {
	entryPoints: [HUB_ENTRY],
	bundle: true,
	platform: "node",
	target: "node24",
	format: "cjs",
	outfile: OUT_FILE,
	sourcemap: false,
	minify: false,
	external: [
		// cpu-features is an optional dependency of ssh2 for performance.
		// It may not be installed and is not required for correctness.
		// NOTE: better-sqlite3 is NOT external — it is bundled and its native
		// addon resolution is intercepted by betterSqliteBindingsPlugin so that
		// in SEA mode it reads from __seaSqliteExports (pre-loaded by the banner).
		"cpu-features",
	],
	// Shim import.meta.url for the ESM-to-CJS bundle.
	// Also inject the build hash so build-version.ts reads it from the env shim.
	define: {
		"import.meta.url": "__importMetaUrl",
		"process.env.TERMORA_BUILD_HASH": JSON.stringify(SEA_BUILD_HASH),
		"process.env.TERMORA_VERSION": JSON.stringify(SEA_VERSION),
	},
	banner: {
		js: [
			"#!/usr/bin/env node",
			"const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
			SEA_BOOTSTRAP_BANNER,
		].join("\n"),
	},
	footer: {
		js: "// SEA auto-invoke: cli.ts exports main() but does not self-invoke.\nmain(process.argv.slice(2)).catch(function(e) { console.error(e); process.exit(1); });",
	},
	plugins: [
		betterSqliteBindingsPlugin(), // must be first — intercepts 'bindings' before other plugins see it
		migrationsEmbedPlugin(),
		tomlEditShimPlugin(),
		sshNativeShimPlugin(),
		importMetaShimPlugin(),
	],
	logLevel: "info",
};

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });

	console.log(`[build-sea-hub] bundling ${HUB_ENTRY}`);
	console.log(`[build-sea-hub] output  → ${OUT_FILE}`);

	// Warn if web UI has not been embedded yet.
	const staticDir = join(ROOT, "packages", "hub", "static");
	try {
		readdirSync(staticDir);
	} catch {
		console.warn(
			"[build-sea-hub] WARNING: packages/hub/static/ not found.",
			"Run `pnpm build:embed` to embed the web UI before SEA packaging.",
		);
	}

	const result = await build(buildOptions);

	if (result.errors.length > 0) {
		console.error("[build-sea-hub] build failed:");
		for (const err of result.errors) {
			console.error(" ", err.text);
		}
		process.exit(1);
	}

	console.log("[build-sea-hub] done.");
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err: unknown) => {
		console.error("[build-sea-hub] fatal:", err);
		process.exit(1);
	});
}
