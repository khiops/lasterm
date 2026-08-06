import * as fs from "node:fs";
import * as path from "node:path";
import type { LogConfig } from "@lasterm/shared";
import { severityForLevel } from "./levels.js";

// ─── ChannelLogger ─────────────────────────────────────────────────────────────

export class ChannelLogger {
	private readonly filePath: string;
	private readonly createdAt: Date;
	private readonly minSeverity: number;
	private readonly maxBytes: number;
	private readonly channelsDir: string;
	private dirEnsured = false;
	private firstWrite = true;
	private saturated = false;

	constructor(channelId: string, logsDir: string, config: LogConfig, createdAt: Date) {
		this.channelsDir = path.join(logsDir, "channels");
		this.filePath = path.join(this.channelsDir, `${channelId}.jsonl`);
		this.createdAt = createdAt;
		this.minSeverity = severityForLevel(config.level) ?? severityForLevel("info") ?? 2;
		this.maxBytes = config.maxSizeMb * 1024 * 1024;
	}

	log(
		src: "hub" | "agent",
		level: LogConfig["level"],
		msg: string,
		extra?: Record<string, unknown>,
	): void {
		if (this.saturated) return;
		if ((severityForLevel(level) ?? severityForLevel("info") ?? 2) < this.minSeverity) return;

		this.ensureDir();

		// Size guard before write
		if (this.maxBytes > 0 && fs.existsSync(this.filePath)) {
			try {
				const { size } = fs.statSync(this.filePath);
				if (size >= this.maxBytes) {
					this.saturated = true;
					return;
				}
			} catch {
				// If stat fails, attempt write anyway
			}
		}

		const offset = Date.now() - this.createdAt.getTime();
		const entry: Record<string, unknown> = { t: offset, src, lvl: level, msg, ...extra };

		if (this.firstWrite) {
			entry.created_at = this.createdAt.toISOString();
			this.firstWrite = false;
			// Create file with 0o600 permissions on first write
			try {
				const fd = fs.openSync(this.filePath, "a", 0o600);
				fs.closeSync(fd);
			} catch {
				// File may already exist; continue
			}
		}

		const line = `${JSON.stringify(entry)}\n`;
		try {
			fs.appendFileSync(this.filePath, line);
		} catch {
			// Silently fail if write fails (e.g. disk full)
		}
	}

	close(): void {
		// Lazy handles — nothing to close. Log final entry if file was ever written.
		if (!this.firstWrite && !this.saturated) {
			this.log("hub", "info", "channel closed");
		}
	}

	private ensureDir(): void {
		if (this.dirEnsured) return;
		fs.mkdirSync(this.channelsDir, { recursive: true });
		this.dirEnsured = true;
	}
}
