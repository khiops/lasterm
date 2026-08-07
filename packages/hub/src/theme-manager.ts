import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LastermTheme } from "@lasterm/shared";
import {
	BUNDLED_THEME_NAMES,
	BUNDLED_THEMES,
	THEME_NAME_REGEX,
	validateTheme,
} from "@lasterm/shared";

export class ThemeManager {
	private readonly themesDir: string;

	constructor(configDir: string) {
		this.themesDir = join(configDir, "themes");
	}

	/**
	 * Ensure themes directory exists and copy bundled themes that are missing.
	 */
	async init(): Promise<void> {
		await mkdir(this.themesDir, { recursive: true });

		for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
			const filePath = join(this.themesDir, `${name}.json`);
			try {
				await readFile(filePath);
				// File exists — do not overwrite (copy-if-missing)
			} catch {
				await writeFile(filePath, JSON.stringify(theme, null, "\t"), "utf-8");
			}
		}
	}

	/**
	 * List all valid themes from the themes directory.
	 * Invalid JSON files are silently skipped with a warning log.
	 */
	async list(): Promise<LastermTheme[]> {
		const themes: LastermTheme[] = [];

		let entries: string[];
		try {
			entries = await readdir(this.themesDir);
		} catch {
			return themes;
		}

		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;

			try {
				const raw = await readFile(join(this.themesDir, entry), "utf-8");
				const parsed: unknown = JSON.parse(raw);
				const result = validateTheme(parsed);
				if (result.valid) {
					themes.push(parsed as LastermTheme);
				}
			} catch {
				// skip invalid files
			}
		}

		return themes;
	}

	/**
	 * Get a specific theme by name.
	 * Returns null if the file is missing or invalid.
	 */
	async get(name: string): Promise<LastermTheme | null> {
		if (!THEME_NAME_REGEX.test(name)) return null;
		try {
			const raw = await readFile(join(this.themesDir, `${name}.json`), "utf-8");
			const parsed: unknown = JSON.parse(raw);
			const result = validateTheme(parsed);
			if (!result.valid) return null;
			return parsed as LastermTheme;
		} catch {
			return null;
		}
	}

	/**
	 * Save a theme to disk. Validates before writing.
	 * Throws on invalid theme or invalid name.
	 */
	async save(theme: LastermTheme): Promise<void> {
		if (!THEME_NAME_REGEX.test(theme.name)) {
			throw new ThemeError("INVALID_NAME", `Theme name must match ${THEME_NAME_REGEX}`);
		}

		const result = validateTheme(theme);
		if (!result.valid) {
			throw new ThemeError("INVALID_THEME", `Validation failed: ${result.errors.join("; ")}`);
		}

		await writeFile(
			join(this.themesDir, `${theme.name}.json`),
			JSON.stringify(theme, null, "\t"),
			"utf-8",
		);
	}

	/**
	 * Delete a custom theme file. Rejects deletion of bundled themes.
	 */
	async delete(name: string): Promise<void> {
		if (!THEME_NAME_REGEX.test(name)) {
			throw new ThemeError("INVALID_NAME", `Invalid theme name: ${name}`);
		}
		if (this.isBundled(name)) {
			throw new ThemeError("BUNDLED_THEME", `Cannot delete bundled theme "${name}"`);
		}

		await unlink(join(this.themesDir, `${name}.json`));
	}

	/**
	 * Check whether a theme name is bundled.
	 */
	isBundled(name: string): boolean {
		return BUNDLED_THEME_NAMES.has(name);
	}
}

export class ThemeError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ThemeError";
		this.code = code;
	}
}
