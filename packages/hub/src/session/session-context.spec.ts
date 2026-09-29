import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentConfig, DEFAULT_AGENT_CONFIG } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigResolver } from "../config.js";
import type { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { agentLaunchConfig } from "./session-context.js";

// ─── agentLaunchConfig — what a daemon started now is given (#646) ────────────

describe("agentLaunchConfig", () => {
	const startup: AgentConfig = {
		...DEFAULT_AGENT_CONFIG,
		socketPath: "/run/user/1000/lasterm/agent.sock",
	};
	let configDir: string;

	beforeEach(() => {
		configDir = makeTempDir("lasterm-launch-config-");
	});

	afterEach(async () => {
		await removeTempDir(configDir);
	});

	it("takes the file count Settings saved after the hub started, and nothing else", async () => {
		const resolver = new ConfigResolver({} as MetaDAL);
		resolver.loadFromFile(configDir);
		// A socket written since the hub started does not move the one it reaches.
		writeFileSync(join(configDir, "config.toml"), '[agent]\nsocket_path = "/elsewhere.sock"\n');
		// As Settings saves it.
		await resolver.saveGlobalKey("logging", "agentFilesKept", 30);
		expect(resolver.agentConfig.socketPath).toBe("/elsewhere.sock");

		expect(agentLaunchConfig({ agentConfig: startup, configResolver: resolver })).toEqual({
			...startup,
			logFilesKept: 30,
		});
	});

	it("keeps the startup configuration without a resolver, or with one that has none", () => {
		expect(agentLaunchConfig({ agentConfig: startup, configResolver: null })).toBe(startup);
		const partial = { sshConfig: { remoteDaemon: true } } as unknown as ConfigResolver;
		expect(agentLaunchConfig({ agentConfig: startup, configResolver: partial })).toBe(startup);
	});
});
