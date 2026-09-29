import { describe, expect, it } from "vitest";
import {
	DEFAULT_AGENT_CONFIG,
	DEFAULT_AGENT_LOG_FILES_KEPT,
	DEFAULT_BIND_TIMEOUT,
	isAgentLogFilesKept,
	LOGGING_SETTINGS_KEYS,
	LOGGING_SETTINGS_VALIDATORS,
	MAX_AGENT_LOG_FILES_KEPT,
	parseAgentConfig,
} from "./agent-config.js";

describe("isAgentLogFilesKept", () => {
	it("takes a whole number from 0, which keeps them all, to the bound", () => {
		for (const kept of [0, 1, DEFAULT_AGENT_LOG_FILES_KEPT, MAX_AGENT_LOG_FILES_KEPT]) {
			expect(isAgentLogFilesKept(kept)).toBe(true);
		}
	});

	it("refuses a negative, a fraction, a count past the bound, and anything not a number", () => {
		for (const refused of [
			-1,
			1.5,
			MAX_AGENT_LOG_FILES_KEPT + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			"7",
			null,
			undefined,
			true,
		]) {
			expect(isAgentLogFilesKept(refused)).toBe(false);
		}
	});

	it("is the rule the logging settings route applies, for its one key", () => {
		expect(LOGGING_SETTINGS_KEYS).toEqual(["agentFilesKept"]);
		expect(LOGGING_SETTINGS_VALIDATORS.agentFilesKept).toBe(isAgentLogFilesKept);
	});
});

describe("parseAgentConfig", () => {
	it("returns defaults when no section provided", () => {
		const config = parseAgentConfig();

		expect(config.logLevel).toBe("info");
		expect(config.logFormat).toBe("jsonl");
		expect(config.logFilesKept).toBe(DEFAULT_AGENT_LOG_FILES_KEPT);
		expect(config.socketPath).toBeUndefined();
		expect(config.bindTimeout).toBe(DEFAULT_BIND_TIMEOUT);
	});

	it("leaves the daemon log files kept to the shared [logging] contract", () => {
		const config = parseAgentConfig({ log_files_kept: 30, agent_files_kept: 30 });

		expect(config.logFilesKept).toBe(DEFAULT_AGENT_LOG_FILES_KEPT);
	});

	it("returns defaults when undefined passed", () => {
		const config = parseAgentConfig(undefined);

		expect(config.logLevel).toBe("info");
		expect(config.logFormat).toBe("jsonl");
		expect(config.socketPath).toBeUndefined();
		expect(config.bindTimeout).toBe(DEFAULT_BIND_TIMEOUT);
	});

	it("ignores buffer_per_channel and buffer_global, which no agent applies", () => {
		const config = parseAgentConfig({ buffer_per_channel: "2MB", buffer_global: "50MB" });

		expect(config).toEqual(DEFAULT_AGENT_CONFIG);
	});

	it("reads socket_path when provided", () => {
		const config = parseAgentConfig({
			socket_path: "/custom/agent.sock",
		});

		expect(config.socketPath).toBe("/custom/agent.sock");
	});

	it("omits socketPath when empty string", () => {
		const config = parseAgentConfig({ socket_path: "" });

		expect(config.socketPath).toBeUndefined();
	});

	it("leaves log_level to the shared [logging] contract", () => {
		const config = parseAgentConfig({ log_level: "debug" });

		expect(config.logLevel).toBe("info");
	});

	it("reads bind_timeout as a positive integer", () => {
		const config = parseAgentConfig({ bind_timeout: 3000 });

		expect(config.bindTimeout).toBe(3000);
	});

	it("falls back to default bindTimeout when bind_timeout is zero", () => {
		const config = parseAgentConfig({ bind_timeout: 0 });

		expect(config.bindTimeout).toBe(DEFAULT_BIND_TIMEOUT);
	});

	it("falls back to default bindTimeout when bind_timeout is negative", () => {
		const config = parseAgentConfig({ bind_timeout: -1 });

		expect(config.bindTimeout).toBe(DEFAULT_BIND_TIMEOUT);
	});

	it("falls back to default bindTimeout when bind_timeout is not a number", () => {
		const config = parseAgentConfig({ bind_timeout: "fast" });

		expect(config.bindTimeout).toBe(DEFAULT_BIND_TIMEOUT);
	});

	it("falls back to defaults for wrong-typed values without throwing", () => {
		expect(() =>
			parseAgentConfig({
				buffer_per_channel: true,
				buffer_global: [],
				socket_path: false,
				bind_timeout: "fast",
				log_level: 5,
				format: [],
			}),
		).not.toThrow();

		const config = parseAgentConfig({
			buffer_per_channel: true,
			buffer_global: [],
			socket_path: false,
			bind_timeout: "fast",
			log_level: 5,
			format: [],
		});

		expect(config.logLevel).toBe("info");
		expect(config.logFormat).toBe("jsonl");
		expect(config.socketPath).toBeUndefined();
		expect(config.bindTimeout).toBe(DEFAULT_BIND_TIMEOUT);
	});
});
