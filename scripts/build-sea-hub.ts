/**
 * build-sea-hub.ts
 *
 * esbuild bundler for the lasterm-hub Node SEA binary.
 *
 * Bundles packages/hub/src/cli.ts into a single CJS file at
 * dist/sea/lasterm-hub.cjs suitable for embedding in a Node SEA blob.
 *
 * Key decisions:
 * - Format: CJS  — Node SEA requires a CJS entry for process.dlopen compat.
 * - SQLite: node:sqlite, built into the Node the executable embeds (#893). It
 *   stays a require() of a built-in module: no addon, nothing to extract.
 * - cpu-features: external + optional — ssh2 optional dep, may not be present.
 * - @lasterm/shared: inlined — workspace package, not a published dep.
 * - Fastify + plugins: inlined — pure JS, no native deps.
 * - ssh2: inlined — pure JS.
 * - Sourcemaps: disabled — SEA doesn't support source-mapped stack traces.
 * - Minify: disabled — easier debugging, size is not critical.
 * - Migrations: embedded inline — the SQL files, as strings, in a module that
 *   replaces storage/migration-files.ts; storage/db.ts itself is bundled as is.
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
import { type BuildOptions, build, type Plugin } from "esbuild";
import {
	type MigrationFile,
	type MigrationSet,
	readMigrationFiles,
} from "../packages/hub/src/storage/migration-files.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const HUB_ENTRY = join(ROOT, "packages", "hub", "src", "cli.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Build hash — injected as LASTERM_BUILD_HASH so build-version.ts picks it up
// ─────────────────────────────────────────────────────────────────────────────

function resolveBuildHash(): string {
	const env = process.env.LASTERM_BUILD_HASH;
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

// Hub semver — injected as LASTERM_VERSION so build-version.ts resolves the
// release version INSIDE the SEA. build-version.ts's package.json fallback uses a
// dynamic require that esbuild does not inline, so without this a packaged hub
// falls back to "0.0.0" and version-aware agent fetch/deploy silently breaks.
// Resolution: LASTERM_VERSION env → the hub package.json version (release CI pins
// it to the tag via the version-consistency guard).
function resolveHubVersion(): string {
	const env = process.env.LASTERM_VERSION;
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
const OUT_DIR = join(ROOT, "dist", "sea");
const OUT_FILE = join(OUT_DIR, "lasterm-hub.cjs");

// ─────────────────────────────────────────────────────────────────────────────
// Plugin: migrations embed
//
// The hub reads its SQL migrations from disk, through one module,
// packages/hub/src/storage/migration-files.ts. The executable has no
// migrations/ directory, so this plugin puts a module in that one's place that
// returns the same files, read with the hub's own readMigrationFiles at build
// time.
//
// Only that module is replaced. The executable opens its databases with
// storage/db.ts itself: owner-only files (#536), the WAL checkpoint on close and
// the migration runner are the ones the hub specs cover. Until #745 this plugin
// replaced db.ts as a whole, with a copy that had none of the first two.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATION_FILES_MODULE = /packages[\\/]hub[\\/]src[\\/]storage[\\/]migration-files\.(ts|js)$/;

/** The module the executable bundles in place of migration-files.ts. */
function embeddedMigrationFilesModule(): string {
	const migrations = {
		meta: readMigrationFiles("meta"),
		spool: readMigrationFiles("spool"),
	} satisfies Record<MigrationSet, MigrationFile[]>;
	return [
		"// Embedded when the executable was built, by scripts/build-sea-hub.ts.",
		`const migrations = ${JSON.stringify(migrations)};`,
		"export function readMigrationFiles(set) {",
		"  return migrations[set] ?? [];",
		"}",
	].join("\n");
}

function migrationsEmbedPlugin(): Plugin {
	return {
		name: "migrations-embed",
		setup(buildContext) {
			buildContext.onLoad({ filter: MIGRATION_FILES_MODULE }, () => ({
				contents: embeddedMigrationFilesModule(),
				loader: "js",
			}));
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
// esbuild config
// ─────────────────────────────────────────────────────────────────────────────

export const buildOptions: BuildOptions = {
	entryPoints: [HUB_ENTRY],
	bundle: true,
	platform: "node",
	target: "node26",
	format: "cjs",
	outfile: OUT_FILE,
	sourcemap: false,
	minify: false,
	external: [
		// cpu-features is an optional dependency of ssh2 for performance.
		// It may not be installed and is not required for correctness.
		"cpu-features",
	],
	// Shim import.meta.url for the ESM-to-CJS bundle.
	// Also inject the build hash so build-version.ts reads it from the env shim.
	define: {
		"import.meta.url": "__importMetaUrl",
		"process.env.LASTERM_BUILD_HASH": JSON.stringify(SEA_BUILD_HASH),
		"process.env.LASTERM_VERSION": JSON.stringify(SEA_VERSION),
	},
	banner: {
		js: [
			"#!/usr/bin/env node",
			"const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
		].join("\n"),
	},
	footer: {
		js: "// SEA auto-invoke: cli.ts exports main() but does not self-invoke.\nmain(process.argv.slice(2)).catch(function(e) { console.error(e); process.exit(1); });",
	},
	plugins: [
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
