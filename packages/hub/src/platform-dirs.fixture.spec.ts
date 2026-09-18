import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigDir, getStateDir } from "./cli.js";
import { usePlatformDirs } from "./platform-dirs.fixture.js";

describe("usePlatformDirs", () => {
	it("moves the directories the hub resolves on this platform", () => {
		const root = join(tmpdir(), "lasterm-platform-dirs");
		const restore = usePlatformDirs({ state: join(root, "state"), config: join(root, "config") });
		try {
			expect(getStateDir()).toBe(join(root, "state", "lasterm"));
			expect(getConfigDir()).toBe(join(root, "config", "lasterm"));
		} finally {
			restore();
		}
	});

	it("deletes on restore a variable that was unset, rather than storing 'undefined'", () => {
		const saved = process.env.XDG_CACHE_HOME;
		delete process.env.XDG_CACHE_HOME;
		try {
			const restore = usePlatformDirs({ cache: join(tmpdir(), "lasterm-cache") });
			expect(process.env.XDG_CACHE_HOME).toBe(join(tmpdir(), "lasterm-cache"));
			restore();
			expect("XDG_CACHE_HOME" in process.env).toBe(false);
		} finally {
			if (saved !== undefined) process.env.XDG_CACHE_HOME = saved;
		}
	});

	it("starts every spec file outside the developer's real directories", () => {
		// platform-dirs.setup.ts ran before this file.
		expect(getStateDir().startsWith(tmpdir())).toBe(true);
		expect(getConfigDir().startsWith(tmpdir())).toBe(true);
	});
});
