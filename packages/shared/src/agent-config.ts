import type { LogConfig } from "./entities.js";

/** Resolved agent configuration used when launching lasterm-agent */
export interface AgentConfig {
	/** Socket path override (empty = auto-detect per platform) */
	socketPath?: string;
	/** Log level resolved from the shared [logging] section */
	logLevel: LogConfig["level"];
	/** Log format resolved from the shared [logging] section */
	logFormat: LogConfig["format"];
	/**
	 * Daemon log files an agent daemon keeps, one per day with something logged;
	 * 0 keeps them all. `[logging] agent_files_kept`, passed to every daemon the
	 * hub starts, local or remote, as `--log-files-kept` (#646).
	 */
	logFilesKept: number;
	/** Timeout in ms to wait for the Unix socket bind to succeed (default 5000) */
	bindTimeout: number;
}

/** Default socket bind timeout in ms */
export const DEFAULT_BIND_TIMEOUT = 5000;

/**
 * Daemon log files kept by default: a week of days with activity, which covers
 * "it started on Monday". The agent's own default is the same
 * (`DEFAULT_FILES_KEPT` in `crates/lasterm-agent/src/logging.rs`).
 */
export const DEFAULT_AGENT_LOG_FILES_KEPT = 7;

/** Ten years of daily files: a bound, so that the count stays a count. */
export const MAX_AGENT_LOG_FILES_KEPT = 3650;

/** A number of daemon log files to keep: a whole number from 0 (all) to the bound. */
export function isAgentLogFilesKept(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= MAX_AGENT_LOG_FILES_KEPT
	);
}

/** Default agent config values */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
	logLevel: "info",
	logFormat: "jsonl",
	logFilesKept: DEFAULT_AGENT_LOG_FILES_KEPT,
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
		logFilesKept: DEFAULT_AGENT_CONFIG.logFilesKept,
		bindTimeout:
			typeof tomlAgent.bind_timeout === "number" && tomlAgent.bind_timeout > 0
				? tomlAgent.bind_timeout
				: DEFAULT_BIND_TIMEOUT,
	};
}

/**
 * What Settings edits of `[logging]`, through `GET` and `PUT /api/config/logging`.
 * The rest of the section is read from `config.toml` only.
 */
export interface LoggingSettings {
	/** `[logging] agent_files_kept`: see `AgentConfig.logFilesKept`. */
	agentFilesKept: number;
}

export const LOGGING_SETTINGS_KEYS = ["agentFilesKept"] as const;

/**
 * The values `PUT /api/config/logging` accepts, by key. Each rule is tested
 * beside it, in `agent-config.spec.ts`; the route keeps one test proving it
 * consults this table.
 */
export const LOGGING_SETTINGS_VALIDATORS: Record<
	(typeof LOGGING_SETTINGS_KEYS)[number],
	(value: unknown) => boolean
> = {
	agentFilesKept: isAgentLogFilesKept,
};
