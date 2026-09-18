import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// ────────────────────────────────────────────────────────────────────────────
// Child processes run without a shell
// ────────────────────────────────────────────────────────────────────────────

describe("run", () => {
	it("passes an argument containing a space as one argument", async () => {
		const { run } = await import("./build-sea-binary.js");
		// A checkout under a profile such as C:\Users\Jane Doe. With the shell
		// Windows used to get, cmd.exe split this path in two.
		const argument = join(tmpdir(), "Jane Doe", "lasterm checkout", "sea-prep.blob");
		const check = `process.exit(process.argv.length === 2 && process.argv[1] === ${JSON.stringify(argument)} ? 0 : 3)`;

		expect(() => run(process.execPath, ["-e", check, argument], "argument check")).not.toThrow();
	});

	it("reports a child's failure with its exit code", async () => {
		const { run } = await import("./build-sea-binary.js");
		expect(() => run(process.execPath, ["-e", "process.exit(3)"], "failing child")).toThrow(
			/failing child exited with code 3/,
		);
	});
});

describe("postjectCommand", () => {
	it("runs the pinned postject CLI with this Node, not through npx", async () => {
		const { postjectCommand, run } = await import("./build-sea-binary.js");
		const { cmd, args } = postjectCommand(["--help"]);

		expect(cmd).toBe(resolve(process.execPath));
		expect(args[0]?.replaceAll("\\", "/")).toMatch(/\/postject\/dist\/cli\.js$/);
		expect(args.slice(1)).toEqual(["--help"]);
		// It starts without a shell on every platform, Windows included.
		expect(() => run(cmd, args, "postject help")).not.toThrow();
	});
});
