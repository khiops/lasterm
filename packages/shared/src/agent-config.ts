import type { LogConfig } from "./entities.js";

/** Resolved agent configuration used when launching lasterm-agent */
export interface AgentConfig {
	/** Socket path override (empty = auto-detect per platform) */
	socketPath?: string;
	/** Log level resolved from the shared [logging] section */
	logLevel: LogConfig["level"];
	/** Log format resolved from the shared [logging] section */
	logFormat: LogConfig["format"];
	/** Timeout in ms to wait for the Unix socket bind to succeed (default 5000) */
	bindTimeout: number;
}

/** Default socket bind timeout in ms */
export const DEFAULT_BIND_TIMEOUT = 5000;

/** Default agent config values */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
	logLevel: "info",
	logFormat: "jsonl",
	bindTimeout: DEFAULT_BIND_TIMEOUT,
};

/**
 * Parse daemon-specific fields from the [agent] section of a TOML config object.
 * Logging fields are resolved from the shared [logging] section by the hub.
 * `buffer_per_channel` and `buffer_global` are not read: no agent applies them
 * (SPEC.md § 3.2).
 */
export function parseAgentConfig(tomlAgent?: Record<string, unknown>): AgentConfig {
	if (!tomlAgent) return { ...DEFAULT_AGENT_CONFIG };

	return {
		...(tomlAgent.socket_path !== undefined &&
		typeof tomlAgent.socket_path === "string" &&
		tomlAgent.socket_path !== ""
			? { socketPath: tomlAgent.socket_path }
			: {}),
		logLevel: DEFAULT_AGENT_CONFIG.logLevel,
		logFormat: DEFAULT_AGENT_CONFIG.logFormat,
		bindTimeout:
			typeof tomlAgent.bind_timeout === "number" && tomlAgent.bind_timeout > 0
				? tomlAgent.bind_timeout
				: DEFAULT_BIND_TIMEOUT,
	};
}
