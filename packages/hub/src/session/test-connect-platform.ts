import type { TestConnectPlatform } from "@lasterm/shared";
import type { Client as SshClient } from "ssh2";
import { readRemoteSystem } from "./agent-deployer.js";
import type { AgentTargetState } from "./agent-status.js";
import type { OsDetectResult } from "./os-detect.js";

/** How long each probe command may take: the test must answer promptly. */
const PROBE_TIMEOUT_MS = 5_000;

/** The hub's view of the agent a target needs, from its bundle or its cache. */
export type AgentStateLookup = (
	os: OsDetectResult["os"],
	arch: OsDetectResult["arch"],
) => Promise<AgentTargetState | undefined>;

function agentReadiness(state: AgentTargetState | undefined): TestConnectPlatform["agent"] {
	switch (state) {
		case "bundled":
		case "cached":
			return "ready";
		case "stale":
		case "missing":
			return "download";
		case "unsupported":
			return "unsupported";
		default:
			return "unknown";
	}
}

/**
 * What the connection test tells the user before a first session: the remote
 * system as it reported it, and whether an agent exists for it, is at hand, or
 * will be downloaded. `undefined` when the remote let nothing be read, which
 * says nothing either way.
 */
export async function probeTestConnectPlatform(
	client: SshClient,
	agentState: AgentStateLookup,
	agentVersion: string,
): Promise<TestConnectPlatform | undefined> {
	const read = await readRemoteSystem(client, PROBE_TIMEOUT_MS);
	if (!read) return undefined;
	if (!read.parsed) {
		// A system we do not build for, such as 32-bit ARM (`armv7l`, #401).
		return { system: read.system, agent: "unsupported", agentVersion };
	}
	const { os, arch } = read.parsed;
	return {
		system: read.system,
		os,
		arch,
		agent: agentReadiness(await agentState(os, arch)),
		agentVersion,
	};
}
