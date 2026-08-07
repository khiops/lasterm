import type { LogConfig } from "./entities.js";

/** Resolved agent configuration used when launching lasterm-agent */
export interface AgentConfig {
	/** Socket path override (empty = auto-detect per platform) */
	socketPath?: string;
	/** Per-channel output buffer cap in bytes (default 1 MB) */
	bufferPerChannel: number;
	/** Global output buffer cap across all channels in bytes (default 20 MB) */
	bufferGlobal: number;
	/** Log level resolved from the shared [logging] section */
	logLevel: LogConfig["level"];
	/** Log format resolved from the shared [logging] section */
	logFormat: LogConfig["format"];
	/** Timeout in ms to wait for the Unix socket bind to succeed (default 5000) */
	bindTimeout: number;
}

/** Default buffer caps */
export const DEFAULT_BUFFER_PER_CHANNEL = 1024 * 1024; // 1 MB
export const DEFAULT_BUFFER_GLOBAL = 20 * 1024 * 1024; // 20 MB

/** Default socket bind timeout in ms */
export const DEFAULT_BIND_TIMEOUT = 5000;

/** Default agent config values */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
	bufferPerChannel: DEFAULT_BUFFER_PER_CHANNEL,
	bufferGlobal: DEFAULT_BUFFER_GLOBAL,
	logLevel: "info",
	logFormat: "jsonl",
	bindTimeout: DEFAULT_BIND_TIMEOUT,
};

/**
 * Parse human-readable size strings like "1MB", "20MB", "512KB" to bytes.
 * Supports: B, KB, MB, GB (case-insensitive).
 * Falls back to parseInt for plain numbers.
 */
export function parseSize(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value !== "string") return Number.NaN;

	const trimmed = value.trim();
	const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
	if (!match || match[1] === undefined) return Number.parseInt(trimmed, 10);

	const num = Number.parseFloat(match[1]);
	const unit = (match[2] ?? "B").toUpperCase();

	const multipliers: Record<string, number> = {
		B: 1,
		KB: 1024,
		MB: 1024 * 1024,
		GB: 1024 * 1024 * 1024,
	};

	return Math.floor(num * (multipliers[unit] ?? 1));
}

function parseSizeOrDefault(value: unknown, defaultValue: number): number {
	if (typeof value !== "number" && typeof value !== "string") return defaultValue;

	const parsed = parseSize(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

/**
 * Parse daemon-specific fields from the [agent] section of a TOML config object.
 * Logging fields are resolved from the shared [logging] section by the hub.
 */
export function parseAgentConfig(tomlAgent?: Record<string, unknown>): AgentConfig {
	if (!tomlAgent) return { ...DEFAULT_AGENT_CONFIG };

	return {
		...(tomlAgent.socket_path !== undefined &&
		typeof tomlAgent.socket_path === "string" &&
		tomlAgent.socket_path !== ""
			? { socketPath: tomlAgent.socket_path }
			: {}),
		bufferPerChannel: parseSizeOrDefault(tomlAgent.buffer_per_channel, DEFAULT_BUFFER_PER_CHANNEL),
		bufferGlobal: parseSizeOrDefault(tomlAgent.buffer_global, DEFAULT_BUFFER_GLOBAL),
		logLevel: DEFAULT_AGENT_CONFIG.logLevel,
		logFormat: DEFAULT_AGENT_CONFIG.logFormat,
		bindTimeout:
			typeof tomlAgent.bind_timeout === "number" && tomlAgent.bind_timeout > 0
				? tomlAgent.bind_timeout
				: DEFAULT_BIND_TIMEOUT,
	};
}
