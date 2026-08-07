import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LastermTheme } from "@lasterm/shared";
import { BUNDLED_THEME_NAMES, BUNDLED_THEMES } from "@lasterm/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeError, ThemeManager } from "./theme-manager.js";

const VALID_CUSTOM_THEME: LastermTheme = {
	name: "test-custom",
	type: "dark",
	colors: {
		foreground: "#f8f8f2",
		background: "#282a36",
		cursor: "#f8f8f2",
		selectionBackground: "#44475a",
		black: "#21222c",
		red: "#ff5555",
		green: "#50fa7b",
		yellow: "#f1fa8c",
		blue: "#bd93f9",
		magenta: "#ff79c6",
		cyan: "#8be9fd",
		white: "#f8f8f2",
		brightBlack: "#6272a4",
		brightRed: "#ff6e6e",
		brightGreen: "#69ff94",
		brightYellow: "#ffffa5",
		brightBlue: "#d6acff",
		brightMagenta: "#ff92df",
		brightCyan: "#a4ffff",
		brightWhite: "#ffffff",
	},
	ui: {
		tabBar: "#21222c",
		tabActive: "#282a36",
		tabInactive: "#21222c",
		tabHover: "#343746",
		sidebar: "#21222c",
		sidebarText: "#f8f8f2",
		sidebarActive: "#343746",
		hostRail: "#191a21",
		border: "#191a21",
		accent: "#bd93f9",
		badge: "#ff5555",
		scrollbarThumb: "#6272a4",
		scrollbarTrack: "#00000000",
		searchHighlight: "#f1fa8c40",
		searchHighlightActive: "#f1fa8caa",
	},
};

let tempDir: string;
let manager: ThemeManager;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "lasterm-theme-test-"));
	manager = new ThemeManager(tempDir);
});

// No afterEach cleanup needed — OS cleans tmpdir

describe("ThemeManager", () => {
	describe("init()", () => {
		it("creates themes dir and copies bundled themes", async () => {
			await manager.init();

			const themesDir = join(tempDir, "themes");
			const files = await readdir(themesDir);

			for (const name of BUNDLED_THEME_NAMES) {
				expect(files).toContain(`${name}.json`);
			}
		});

		it("preserves existing files (copy-if-missing)", async () => {
			// First init — copies bundled themes
			await manager.init();

			// Overwrite one bundled theme file with custom content
			const draculaPath = join(tempDir, "themes", "dracula.json");
			const customContent = JSON.stringify({ ...BUNDLED_THEMES.dracula, author: "Modified" });
			await writeFile(draculaPath, customContent, "utf-8");

			// Second init — should NOT overwrite the modified file
			await manager.init();

			const raw = await readFile(draculaPath, "utf-8");
			const parsed = JSON.parse(raw) as LastermTheme;
			expect(parsed.author).toBe("Modified");
		});
	});

	describe("list()", () => {
		it("returns all valid themes", async () => {
			await manager.init();

			const themes = await manager.list();
			expect(themes.length).toBeGreaterThanOrEqual(BUNDLED_THEME_NAMES.size);

			for (const name of BUNDLED_THEME_NAMES) {
				expect(themes.find((t) => t.name === name)).toBeTruthy();
			}
		});

		it("skips invalid JSON files", async () => {
			await manager.init();

			// Write an invalid JSON file
			await writeFile(join(tempDir, "themes", "broken.json"), "not valid json", "utf-8");

			const themes = await manager.list();
			// Should still have all bundled themes and no "broken" entry
			expect(themes.find((t) => t.name === "broken")).toBeUndefined();
			expect(themes.length).toBeGreaterThanOrEqual(BUNDLED_THEME_NAMES.size);
		});
	});

	describe("get()", () => {
		it("returns theme by name", async () => {
			await manager.init();

			const theme = await manager.get("dracula");
			expect(theme).not.toBeNull();
			expect(theme?.name).toBe("dracula");
			expect(theme?.type).toBe("dark");
		});

		it("returns null for missing theme", async () => {
			await manager.init();

			const theme = await manager.get("nonexistent");
			expect(theme).toBeNull();
		});

		it("returns null for path traversal names", async () => {
			await manager.init();

			expect(await manager.get("../../etc/passwd")).toBeNull();
			expect(await manager.get("../evil")).toBeNull();
			expect(await manager.get("foo/bar")).toBeNull();
			expect(await manager.get("UPPERCASE")).toBeNull();
		});
	});

	describe("save()", () => {
		it("writes valid theme to disk", async () => {
			await manager.init();

			await manager.save(VALID_CUSTOM_THEME);

			const raw = await readFile(join(tempDir, "themes", "test-custom.json"), "utf-8");
			const parsed = JSON.parse(raw) as LastermTheme;
			expect(parsed.name).toBe("test-custom");
			expect(parsed.type).toBe("dark");
		});

		it("rejects invalid theme", async () => {
			await manager.init();

			const invalid = { name: "bad", type: "dark" } as unknown as LastermTheme;
			await expect(manager.save(invalid)).rejects.toThrow(ThemeError);
		});

		it("rejects invalid name", async () => {
			await manager.init();

			const badName = { ...VALID_CUSTOM_THEME, name: "INVALID NAME!" };
			await expect(manager.save(badName)).rejects.toThrow(ThemeError);
			try {
				await manager.save(badName);
			} catch (err) {
				expect(err).toBeInstanceOf(ThemeError);
				expect((err as ThemeError).code).toBe("INVALID_NAME");
			}
		});
	});

	describe("delete()", () => {
		it("removes custom theme file", async () => {
			await manager.init();
			await manager.save(VALID_CUSTOM_THEME);

			// Verify it exists
			const before = await manager.get("test-custom");
			expect(before).not.toBeNull();

			await manager.delete("test-custom");

			const after = await manager.get("test-custom");
			expect(after).toBeNull();
		});

		it("rejects bundled theme with specific error", async () => {
			await manager.init();

			try {
				await manager.delete("dracula");
				expect.fail("Should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ThemeError);
				expect((err as ThemeError).code).toBe("BUNDLED_THEME");
			}
		});

		it("rejects path traversal names", async () => {
			await manager.init();

			try {
				await manager.delete("../evil");
				expect.fail("Should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(ThemeError);
				expect((err as ThemeError).code).toBe("INVALID_NAME");
			}
		});
	});

	describe("isBundled()", () => {
		it("returns true for bundled theme names", () => {
			for (const name of BUNDLED_THEME_NAMES) {
				expect(manager.isBundled(name)).toBe(true);
			}
		});

		it("returns false for custom theme names", () => {
			expect(manager.isBundled("my-custom-theme")).toBe(false);
		});
	});
});
