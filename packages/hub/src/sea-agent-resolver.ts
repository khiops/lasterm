/**
 * sea-agent-resolver.ts
 *
 * Resolves the path to the lasterm-agent binary when the hub is running as a
 * Node Single Executable Application (SEA).
 *
 * In normal Node.js mode the hub spawns the agent via its compiled JS entry
 * point (packages/agent/dist/main.js). In SEA mode that source tree is not
 * present, so we look for a co-located lasterm-agent binary instead.
 *
 * Search order:
 *   1. Same directory as the hub binary (process.execPath)
 *   2. PATH — resolved via `which` (Linux/macOS) or `where` (Windows)
 *
 * Returns null if the agent binary cannot be located.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Binary extension — empty on Linux/macOS, .exe on Windows. */
const EXE_EXT = process.platform === "win32" ? ".exe" : "";

/** Canonical agent binary name (without extension). */
const AGENT_BINARY_NAME = `lasterm-agent${EXE_EXT}`;

/**
 * Check whether PATH contains the given binary name.
 * Uses `which` on Linux/macOS and `where` on Windows.
 *
 * @returns Absolute path to the binary, or null if not found.
 */
function findInPath(binaryName: string): string | null {
	const cmd = process.platform === "win32" ? "where" : "which";
	try {
		const result = spawnSync(cmd, [binaryName], {
			stdio: "pipe",
			encoding: "utf8",
			timeout: 5_000,
		});
		if (result.status === 0 && result.stdout) {
			// `where` may return multiple lines; take the first one.
			const line = result.stdout.trim().split(/\r?\n/)[0]?.trim();
			if (line && existsSync(line)) {
				return line;
			}
		}
	} catch {
		// Ignore errors — treat as not found.
	}
	return null;
}

/**
 * Resolve the absolute path to the lasterm-agent binary.
 *
 * Search order:
 *   1. Same directory as the hub binary (process.execPath)
 *   2. PATH
 *
 * @returns Absolute path to the binary, or null if not found.
 */
export function resolveAgentBinaryPath(): string | null {
	// 1. Co-located with the hub binary
	const hubDir = dirname(process.execPath);
	const coLocated = join(hubDir, AGENT_BINARY_NAME);
	if (existsSync(coLocated)) {
		return coLocated;
	}

	// 2. PATH
	const fromPath = findInPath(AGENT_BINARY_NAME);
	if (fromPath !== null) {
		return fromPath;
	}

	return null;
}

// Export internals for testing
export { AGENT_BINARY_NAME as _AGENT_BINARY_NAME, findInPath as _findInPath };
