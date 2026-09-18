/**
 * Runs before every hub and scripts spec file (vitest `setupFiles`): the file
 * starts with its state, configuration and cache directories in a temporary
 * root, so a spec that never isolates them, or a child process it starts,
 * cannot touch the developer's own hub (#333). Specs that need a fresh root per
 * test still call usePlatformDirs themselves.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { usePlatformDirs } from "./platform-dirs.fixture.js";

const root = mkdtempSync(join(tmpdir(), "lasterm-spec-"));
const restore = usePlatformDirs({
	state: join(root, "state"),
	config: join(root, "config"),
	cache: join(root, "cache"),
});

afterAll(() => {
	restore();
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	} catch {
		// A handle Windows has not released yet leaves the directory in the
		// system temp folder; failing the spec file over it would be noise.
	}
});
