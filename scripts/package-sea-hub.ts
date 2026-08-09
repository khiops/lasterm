/**
 * package-sea-hub.ts
 *
 * Hub-specific SEA packaging script.
 *
 * Steps:
 *   1. Build web UI (pnpm -F @lasterm/web build) if static/ doesn't exist
 *   2. Embed web UI (scripts/embed-web.js) if static/ doesn't exist
 *   3. esbuild bundle (build-sea-hub.ts → lasterm-hub.cjs)
 *   4. Create static-files manifest (JSON of all web UI files → static-manifest.json)
 *   5. SEA binary packaging (build-sea-binary.ts → lasterm-hub binary)
 *
 * Usage:
 *   pnpm run package:sea-hub
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { SeaBuildConfig } from "./build-sea-binary.js";
import { buildSeaBinary } from "./build-sea-binary.js";
import { buildOptions } from "./build-sea-hub.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Map a Rust-style target triple (e.g. "x86_64-unknown-linux-gnu") to a Node.js
 * platform string. Used to interpret LASTERM_TARGET_TRIPLE env var.
 */
function tripleToNodePlatform(triple: string | undefined): NodeJS.Platform | undefined {
	if (!triple) return undefined;
	if (triple.includes("linux")) return "linux";
	if (triple.includes("windows") || triple.includes("win32")) return "win32";
	if (triple.includes("apple") || triple.includes("darwin")) return "darwin";
	return undefined;
}

/**
 * Map a Rust-style target triple to a Node.js arch string.
 * Used to interpret LASTERM_TARGET_TRIPLE env var.
 */
function tripleToNodeArch(triple: string | undefined): string | undefined {
	if (!triple) return undefined;
	if (triple.startsWith("x86_64") || triple.startsWith("x64")) return "x64";
	if (triple.startsWith("aarch64") || triple.startsWith("arm64")) return "arm64";
	return undefined;
}

/** Parse --target-platform and --target-arch from CLI args. */
const targetPlatformArg = process.argv
	.find((a) => a.startsWith("--target-platform="))
	?.split("=")[1];
const targetArchArg = process.argv.find((a) => a.startsWith("--target-arch="))?.split("=")[1];
const targetNodeVersionArg = process.argv
	.find((a) => a.startsWith("--node-version="))
	?.split("=")[1];
// Priority: CLI arg > LASTERM_TARGET_TRIPLE env var > host process defaults.
const effectivePlatform =
	(targetPlatformArg as NodeJS.Platform | undefined) ??
	tripleToNodePlatform(process.env.LASTERM_TARGET_TRIPLE) ??
	process.platform;
const effectiveArch =
	targetArchArg ?? tripleToNodeArch(process.env.LASTERM_TARGET_TRIPLE) ?? process.arch;
const effectiveNodeVersion =
	targetNodeVersionArg ?? process.env.LASTERM_NODE_VERSION ?? process.version;
/** Output directory for SEA artefacts. Override with LASTERM_DIST_DIR env var. */
const distDir = process.env.LASTERM_DIST_DIR ?? join(ROOT, "dist", "sea");

/** Binary extension — empty on Linux/macOS, .exe on Windows. */
const EXE_EXT = effectivePlatform === "win32" ? ".exe" : "";

/** Extension → MIME content-type map for web assets. */
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "application/javascript",
	".mjs": "application/javascript",
	".css": "text/css",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".json": "application/json",
	".txt": "text/plain",
	".map": "application/json",
};

/** Resolve MIME type for a given file path. */
export function resolveContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** All extension keys in the content-type map (for testing). */
export const KNOWN_EXTENSIONS = Object.keys(CONTENT_TYPES);

/**
 * Locate the toml-edit-js WASM file from the hub's node_modules.
 * Falls back to root-level node_modules for hoisted installs.
 */
export function locateTomlWasm(): string {
	// Primary: hub package symlink (pnpm virtual store)
	const hubNodeModules = join(
		ROOT,
		"packages",
		"hub",
		"node_modules",
		"@rainbowatcher",
		"toml-edit-js",
		"index_bg.wasm",
	);
	if (existsSync(hubNodeModules)) {
		return hubNodeModules;
	}

	// Fallback: root-level node_modules (hoisted installs / npm/yarn)
	const rootNodeModules = join(
		ROOT,
		"node_modules",
		"@rainbowatcher",
		"toml-edit-js",
		"index_bg.wasm",
	);
	if (existsSync(rootNodeModules)) {
		return rootNodeModules;
	}

	throw new Error(
		`[package-sea-hub] toml-edit-js WASM not found.\n` +
			`  Checked:\n` +
			`    ${hubNodeModules}\n` +
			`    ${rootNodeModules}\n` +
			`  Run \`pnpm install\` first.`,
	);
}

/**
 * Locate the better-sqlite3 native addon from the hub's node_modules.
 * Falls back to root-level node_modules for hoisted installs.
 */
export function locateBetterSqlite3(): string {
	// Primary: hub package symlink (pnpm virtual store)
	const hubNodeModules = join(
		ROOT,
		"packages",
		"hub",
		"node_modules",
		"better-sqlite3",
		"build",
		"Release",
		"better_sqlite3.node",
	);
	if (existsSync(hubNodeModules)) {
		return hubNodeModules;
	}

	// Fallback: root-level node_modules (hoisted installs / npm/yarn)
	const rootNodeModules = join(
		ROOT,
		"node_modules",
		"better-sqlite3",
		"build",
		"Release",
		"better_sqlite3.node",
	);
	if (existsSync(rootNodeModules)) {
		return rootNodeModules;
	}

	throw new Error(
		`[package-sea-hub] better-sqlite3 addon not found.\n` +
			`  Checked:\n` +
			`    ${hubNodeModules}\n` +
			`    ${rootNodeModules}\n` +
			`  Run \`pnpm install\` to build native addons first.`,
	);
}

/** The build script passes the target-qualified N-API artefact directly to packaging. */
export function locateHubLockAddon(): string {
	const addonPath = process.env.LASTERM_HUB_LOCK_ADDON;
	if (!addonPath || !existsSync(addonPath)) {
		throw new Error(
			"[package-sea-hub] hub lock addon path was not supplied or does not exist. " +
				"Run scripts/build-hub.sh or scripts/build-hub.ps1 instead of package:sea-hub directly.",
		);
	}
	loadHubLockAddon(addonPath, isCrossBuild());
	return addonPath;
}

/** The build script passes the target-qualified TLS identity addon directly to packaging. */
export function locateTlsIdentityAddon(): string {
	const addonPath = process.env.LASTERM_TLS_IDENTITY_ADDON;
	if (!addonPath || !existsSync(addonPath)) {
		throw new Error(
			"[package-sea-hub] TLS identity addon path was not supplied or does not exist. " +
				"Run scripts/build-hub.sh or scripts/build-hub.ps1 instead of package:sea-hub directly.",
		);
	}
	if (!isCrossBuild()) {
		const mod = { exports: {} as Record<string, unknown> };
		process.dlopen(mod, addonPath);
		if (typeof mod.exports.generateTlsIdentity !== "function") {
			throw new Error(
				`[package-sea-hub] TLS identity addon at ${addonPath} has no generator export.`,
			);
		}
	}
	return addonPath;
}

/**
 * True when this build targets something the host cannot execute.
 *
 * `build-hub.sh` and `build-hub.ps1` cross-compile whenever the requested triple
 * differs from the host's, so a build for another architecture produces an addon
 * this process could never load. The check below is skipped there rather than
 * failing a legitimate cross-build.
 */
function isCrossBuild(): boolean {
	const triple = process.env.LASTERM_TARGET_TRIPLE;
	if (!triple) return false;
	const arch = tripleToNodeArch(triple);
	const targetPlatform = tripleToNodePlatform(triple);
	// An unrecognised triple is not evidence of a cross-build; load and let the
	// loader answer.
	if (arch === undefined || targetPlatform === undefined) return false;
	return arch !== process.arch || targetPlatform !== process.platform;
}

/**
 * Loading proves the file is a usable Node addon, which is the only packaging
 * check bytes cannot fake — and the only one available, since a cross-built
 * artefact cannot be loaded here at all.
 */
export function loadHubLockAddon(addonPath: string, skip = false): void {
	if (skip) return;
	try {
		process.dlopen({ exports: {} }, addonPath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`[package-sea-hub] hub lock addon cannot be loaded: ${addonPath}: ${detail}`);
	}
}

/** Read the hub package version from its package.json. */
function readHubVersion(): string {
	const pkgPath = join(ROOT, "packages", "hub", "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
		version?: string;
	};
	return pkg.version ?? "0.0.0";
}

/** Static file manifest entry. */
export interface StaticFileEntry {
	data: string; // base64-encoded file contents
	contentType: string;
}

/** Manifest structure written to static-manifest.json. */
export type StaticManifest = Record<string, StaticFileEntry>;

/**
 * Walk `dir` recursively and collect all file paths relative to `dir`.
 * Returns sorted list for deterministic output.
 */
function walkDir(dir: string): string[] {
	const results: string[] = [];

	function walk(current: string): void {
		const entries = readdirSync(current, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				results.push(fullPath);
			}
		}
	}

	walk(dir);
	return results.sort();
}

/**
 * Build a static manifest JSON from all files under `staticDir`.
 * Each file is base64-encoded and assigned a MIME content-type.
 *
 * @param staticDir - Absolute path to the web UI static directory.
 * @returns Stringified JSON ready to write to disk.
 */
export function buildStaticManifest(staticDir: string): string {
	const files = walkDir(staticDir);
	const manifest: StaticManifest = {};

	for (const filePath of files) {
		const relativePath = relative(staticDir, filePath).replace(/\\/g, "/");
		const data = readFileSync(filePath);
		manifest[relativePath] = {
			data: data.toString("base64"),
			contentType: resolveContentType(filePath),
		};
	}

	return JSON.stringify(manifest);
}

async function main(): Promise<void> {
	console.log("[package-sea-hub] starting hub SEA packaging...");

	const staticDir = join(ROOT, "packages", "hub", "static");

	// ------------------------------------------------------------------
	// Step 1 & 2: Build + embed web UI if static/ doesn't exist
	// ------------------------------------------------------------------
	if (!existsSync(staticDir)) {
		console.log("[package-sea-hub] step 1/5: building web UI (pnpm -F @lasterm/web build)");
		const webBuild = spawnSync("pnpm", ["-F", "@lasterm/web", "build"], {
			stdio: "inherit",
			cwd: ROOT,
			shell: false,
		});
		if (webBuild.status !== 0) {
			console.error("[package-sea-hub] web UI build failed (exit code:", webBuild.status, ")");
			process.exit(1);
		}

		console.log("[package-sea-hub] step 2/5: embedding web UI (scripts/embed-web.js)");
		const embedScript = join(ROOT, "scripts", "embed-web.js");
		const embed = spawnSync(process.execPath, [embedScript], {
			stdio: "inherit",
			cwd: ROOT,
			shell: false,
		});
		if (embed.status !== 0) {
			console.error("[package-sea-hub] web UI embed failed (exit code:", embed.status, ")");
			process.exit(1);
		}
	} else {
		console.log("[package-sea-hub] step 1/5: web UI already built — skipping");
		console.log("[package-sea-hub] step 2/5: web UI already embedded — skipping");
	}

	// ------------------------------------------------------------------
	// Step 3: esbuild bundle (hub TS → lasterm-hub.cjs)
	// ------------------------------------------------------------------
	console.log("[package-sea-hub] step 3/5: esbuild bundle");
	const esbuildResult = await build(buildOptions);
	if (esbuildResult.errors.length > 0) {
		console.error("[package-sea-hub] esbuild failed:");
		for (const err of esbuildResult.errors) {
			console.error("  ", err.text);
		}
		process.exit(1);
	}
	console.log("[package-sea-hub] esbuild bundle complete");

	// ------------------------------------------------------------------
	// Step 4: Create static-files manifest
	// ------------------------------------------------------------------
	console.log("[package-sea-hub] step 4/5: building static file manifest");
	mkdirSync(distDir, { recursive: true });

	const staticManifestPath = join(distDir, "static-manifest.json");

	if (!existsSync(staticDir)) {
		console.warn(
			"[package-sea-hub] WARNING: packages/hub/static/ not found — " +
				"web UI will NOT be embedded in the SEA binary. " +
				"Run `pnpm build:embed` before packaging to include the web UI.",
		);
		// Write an empty manifest so the SEA asset is always present.
		writeFileSync(staticManifestPath, JSON.stringify({}), "utf8");
	} else {
		console.log(`[package-sea-hub] scanning static dir: ${staticDir}`);
		const manifestJson = buildStaticManifest(staticDir);
		writeFileSync(staticManifestPath, manifestJson, "utf8");
		const sizeMB = (Buffer.byteLength(manifestJson, "utf8") / (1024 * 1024)).toFixed(1);
		console.log(`[package-sea-hub] static manifest written: ${staticManifestPath} (${sizeMB} MB)`);
	}

	// ------------------------------------------------------------------
	// Step 5: SEA binary packaging
	// ------------------------------------------------------------------
	console.log("[package-sea-hub] step 5/5: SEA binary packaging");

	const betterSqlite3Path = locateBetterSqlite3();
	const hubLockAddonPath = locateHubLockAddon();
	const tlsIdentityAddonPath = locateTlsIdentityAddon();
	const tomlWasmPath = locateTomlWasm();
	const version = readHubVersion();

	console.log(`[package-sea-hub] better-sqlite3 addon: ${betterSqlite3Path}`);
	console.log(`[package-sea-hub] hub lock addon:      ${hubLockAddonPath}`);
	console.log(`[package-sea-hub] TLS identity addon:  ${tlsIdentityAddonPath}`);
	console.log(`[package-sea-hub] toml-edit WASM:        ${tomlWasmPath}`);
	console.log(`[package-sea-hub] hub version: ${version}`);

	const outputBinary = join(distDir, `lasterm-hub${EXE_EXT}`);

	// Write VERSION asset file.
	const versionFilePath = join(distDir, "VERSION");
	writeFileSync(versionFilePath, version, "utf8");

	const seaCfg: SeaBuildConfig = {
		entryScript: join(ROOT, "dist", "sea", "lasterm-hub.cjs"),
		outputBinary,
		name: "lasterm-hub",
		nativeAddons: {
			"better_sqlite3.node": betterSqlite3Path,
			"lasterm_hub_lock.node": hubLockAddonPath,
			"lasterm_tls_identity.node": tlsIdentityAddonPath,
		},
		extraAssets: {
			VERSION: versionFilePath,
			"static-manifest.json": staticManifestPath,
			"toml_edit.wasm": tomlWasmPath,
		},
		useCodeCache: true,
		disableExperimentalSEAWarning: true,
		targetPlatform: effectivePlatform,
		targetArch: effectiveArch,
		targetNodeVersion: effectiveNodeVersion,
	};

	await buildSeaBinary(seaCfg);

	console.log("[package-sea-hub] packaging complete.");
	console.log(`[package-sea-hub] binary: ${outputBinary}`);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((err: unknown) => {
		console.error("[package-sea-hub] fatal:", err);
		process.exit(1);
	});
}
