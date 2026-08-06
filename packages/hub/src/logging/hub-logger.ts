import * as fs from "node:fs";
import * as path from "node:path";
import type { LogConfig } from "@lasterm/shared";
import { severityForLevel } from "./levels.js";

const ROTATION_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── HubLogger ────────────────────────────────────────────────────────────────

export class HubLogger {
	private readonly filePath: string;
	private readonly oldFilePath: string;
	private readonly logsDir: string;
	private readonly minSeverity: number;
	private readonly format: LogConfig["format"];
	private readonly output: LogConfig["output"];
	private dirEnsured = false;

	constructor(logsDir: string, config: LogConfig) {
		this.logsDir = logsDir;
		this.filePath = path.join(logsDir, "hub.jsonl");
		this.oldFilePath = path.join(logsDir, "hub.jsonl.old");
		this.minSeverity = severityForLevel(config.level) ?? severityForLevel("info") ?? 2;
		this.format = config.format;
		this.output = config.output;
	}

	log(level: LogConfig["level"], msg: string, extra?: Record<string, unknown>): void {
		if ((severityForLevel(level) ?? severityForLevel("info") ?? 2) < this.minSeverity) return;

		const entry: Record<string, unknown> = {
			ts: new Date().toISOString(),
			lvl: level,
			msg,
			...extra,
		};

		if (this.output === "file" || this.output === "both") {
			this.writeFileLine(entry);
		}
		if (this.output === "stderr" || this.output === "both") {
			this.writeStderrLine(entry);
		}
	}

	private writeFileLine(entry: Record<string, unknown>): void {
		this.ensureDir();
		this.maybeRotate();

		try {
			fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch {
			// Silently fail if write fails (e.g. disk full)
		}
	}

	private writeStderrLine(entry: Record<string, unknown>): void {
		const line = this.format === "text" ? this.renderTextLine(entry) : `${JSON.stringify(entry)}\n`;
		try {
			process.stderr.write(line);
		} catch {
			// Silently fail if stderr write fails
		}
	}

	private renderTextLine(entry: Record<string, unknown>): string {
		const { ts, lvl, msg, ...extra } = entry;
		const fields = Object.entries(extra)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => `${key}=${formatTextValue(value)}`);
		const suffix = fields.length > 0 ? ` ${fields.join(" ")}` : "";
		return `${String(ts)} ${String(lvl).toUpperCase()} ${String(msg).replace(/\s+/g, " ")}${suffix}\n`;
	}

	private maybeRotate(): void {
		if (!fs.existsSync(this.filePath)) return;
		try {
			const { size } = fs.statSync(this.filePath);
			if (size >= ROTATION_MAX_BYTES) {
				fs.renameSync(this.filePath, this.oldFilePath);
			}
		} catch {
			// If stat/rename fails, continue writing to existing file
		}
	}

	private ensureDir(): void {
		if (this.dirEnsured) return;
		fs.mkdirSync(this.logsDir, { recursive: true });
		this.dirEnsured = true;
	}
}

function formatTextValue(value: unknown): string {
	if (typeof value === "string") {
		return /^[^\s=]+$/.test(value) ? value : JSON.stringify(value);
	}
	try {
		const encoded = JSON.stringify(value);
		return encoded ?? String(value);
	} catch {
		return String(value);
	}
}
