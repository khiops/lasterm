import { describe, expect, it } from "vitest";
import { describeTestPlatform } from "./test-connect-platform.js";

describe("describeTestPlatform", () => {
	it("says what a first session will need", () => {
		const base = { system: "Linux aarch64", os: "linux", arch: "arm64", agentVersion: "0.11.0" };
		expect(describeTestPlatform({ ...base, agent: "ready" })).toEqual({
			text: "Linux aarch64 · agent ready",
			warning: false,
		});
		expect(describeTestPlatform({ ...base, agent: "download" }).text).toBe(
			"Linux aarch64 · agent v0.11.0 will be downloaded on first connect",
		);
		expect(describeTestPlatform({ ...base, agent: "unknown" }).text).toBe(
			"Linux aarch64 · agent status unknown",
		);
	});

	it("warns when no agent exists for the system", () => {
		expect(
			describeTestPlatform({
				system: "Linux armv7l",
				agent: "unsupported",
				agentVersion: "0.11.0",
			}),
		).toEqual({
			text: "Linux armv7l · no Lasterm agent is built for this system, so sessions cannot start on it",
			warning: true,
		});
	});
});
