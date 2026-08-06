import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppearanceConfig } from "@lasterm/shared";
import { DEFAULT_APPEARANCE, deepMerge } from "@lasterm/shared";

export class AppearanceManager {
	private readonly filePath: string;
	private config: AppearanceConfig;

	constructor(configDir: string) {
		this.filePath = join(configDir, "appearance.json");
		this.config = { ...DEFAULT_APPEARANCE };
	}

	/**
	 * Load appearance.json from disk, deep-merging with defaults to fill any missing fields.
	 * If the file does not exist, defaults are used.
	 */
	async init(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, "utf-8");
			const parsed = JSON.parse(raw) as Partial<AppearanceConfig>;
			this.config = deepMerge<AppearanceConfig>(DEFAULT_APPEARANCE, parsed);
		} catch {
			// File doesn't exist or is invalid — use defaults
			this.config = deepMerge<AppearanceConfig>(DEFAULT_APPEARANCE);
		}
	}

	/**
	 * Get the current appearance configuration.
	 */
	get(): AppearanceConfig {
		return this.config;
	}

	/**
	 * Deep-merge a partial update into the current config and persist to disk.
	 */
	async update(partial: Partial<AppearanceConfig>): Promise<AppearanceConfig> {
		this.config = deepMerge<AppearanceConfig>(this.config, partial);
		await writeFile(this.filePath, JSON.stringify(this.config, null, "\t"), "utf-8");
		return this.config;
	}
}
