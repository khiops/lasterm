/**
 * build-version.ts
 *
 * Resolves the build hash at startup:
 *   1. LASTERM_BUILD_HASH env var (set by CI or SEA esbuild define)
 *   2. `git rev-parse --short HEAD` (dev mode fallback)
 *   3. "dev" (if git is unavailable)
 *
 * Resolves the semver version at startup:
 *   1. LASTERM_VERSION env var (set by CI or SEA esbuild define)
 *   2. package.json `version` field (dev mode fallback)
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

function resolveGitHash(): string {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return "dev";
	}
}

/**
 * Returns the 7-char build hash for this process.
 * Cached after first call — safe to call repeatedly.
 */
export const BUILD_HASH: string = (() => {
	const env = process.env.LASTERM_BUILD_HASH;
	if (env && env.length > 0) {
		// Trim to 7 chars in case a full SHA was passed
		return env.slice(0, 7);
	}
	return resolveGitHash();
})();

function resolvePackageVersion(): string {
	try {
		const require = createRequire(import.meta.url);
		// The hub package.json sits one level above this file (packages/hub/),
		// from both src/ (dev/tsx) and dist/ (compiled). In the SEA the version is
		// injected via the LASTERM_VERSION esbuild define, so this require is the
		// source-run path only.
		const pkg = require("../package.json") as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Returns the semver version string for this hub process.
 * Cached after first call — safe to call repeatedly.
 * Resolution order: LASTERM_VERSION env → package.json → "0.0.0"
 */
export const HUB_VERSION: string = (() => {
	const env = process.env.LASTERM_VERSION;
	if (env && env.length > 0) {
		return env;
	}
	return resolvePackageVersion();
})();
