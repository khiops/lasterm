import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const _ROOT = resolve(__dirname, "..");

// ────────────────────────────────────────────────────────────────────────────
// Test 1: generates valid sea-config.json
// ────────────────────────────────────────────────────────────────────────────

describe("buildSeaConfigJson generates valid sea-config.json structure", () => {
	it("includes main, output, assets, disableExperimentalSEAWarning, useCodeCache", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/abs/path/agent.cjs",
			outputBinary: "/abs/path/lasterm-agent",
			name: "lasterm-agent",
			nativeAddons: { "pty.node": "/abs/path/pty.node" },
			extraAssets: { VERSION: "/abs/path/VERSION" },
			useCodeCache: true,
			disableExperimentalSEAWarning: true,
		};

		const result = buildSeaConfigJson(cfg, "/abs/path/sea-prep.blob");

		expect(result).toMatchObject({
			main: "/abs/path/agent.cjs",
			output: "/abs/path/sea-prep.blob",
			disableExperimentalSEAWarning: true,
			useCodeCache: true,
		});

		// Assets must include both nativeAddons and extraAssets
		expect(result.assets).toMatchObject({
			"pty.node": "/abs/path/pty.node",
			VERSION: "/abs/path/VERSION",
		});
	});

	it("defaults disableExperimentalSEAWarning and useCodeCache to true", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/a/entry.cjs",
			outputBinary: "/a/out",
			name: "test",
			nativeAddons: {},
		};

		const result = buildSeaConfigJson(cfg, "/a/blob");
		expect(result.disableExperimentalSEAWarning).toBe(true);
		expect(result.useCodeCache).toBe(true);
	});

	it("allows overriding defaults to false", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/a/entry.cjs",
			outputBinary: "/a/out",
			name: "test",
			nativeAddons: {},
			useCodeCache: false,
			disableExperimentalSEAWarning: false,
		};

		const result = buildSeaConfigJson(cfg, "/a/blob");
		expect(result.useCodeCache).toBe(false);
		expect(result.disableExperimentalSEAWarning).toBe(false);
	});

	it("handles empty nativeAddons and no extraAssets", async () => {
		const { buildSeaConfigJson } = await import("./build-sea-binary.js");

		const cfg = {
			entryScript: "/a/entry.cjs",
			outputBinary: "/a/out",
			name: "test",
			nativeAddons: {},
		};

		const result = buildSeaConfigJson(cfg, "/a/blob");
		expect(result.assets).toEqual({});
	});
});
