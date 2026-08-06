import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LogConfig } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelLogger } from "./channel-logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-channel-logger-"));
}

function makeConfig(overrides: Partial<LogConfig> = {}): LogConfig {
	return {
		level: "info",
		format: "jsonl",
		output: "file",
		maxAgeDays: 30,
		maxSizeMb: 50,
		...overrides,
	};
}

function readLines(filePath: string): Record<string, unknown>[] {
	const raw = fs.readFileSync(filePath, "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ChannelLogger", () => {
	let tmpDir: string;
	const createdAt = new Date("2026-01-01T00:00:00.000Z");

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes JSONL with correct fields (t, src, lvl, msg)", () => {
		const logger = new ChannelLogger("ch1", tmpDir, makeConfig(), createdAt);
		logger.log("hub", "info", "hello world");

		const filePath = path.join(tmpDir, "channels", "ch1.jsonl");
		expect(fs.existsSync(filePath)).toBe(true);

		const lines = readLines(filePath);
		expect(lines).toHaveLength(1);
		const entry = lines[0];
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(typeof entry.t).toBe("number");
		expect(entry.src).toBe("hub");
		expect(entry.lvl).toBe("info");
		expect(entry.msg).toBe("hello world");
	});

	it("first entry includes created_at ISO 8601 field", () => {
		const logger = new ChannelLogger("ch2", tmpDir, makeConfig(), createdAt);
		logger.log("agent", "info", "first");
		logger.log("agent", "info", "second");

		const filePath = path.join(tmpDir, "channels", "ch2.jsonl");
		const lines = readLines(filePath);

		// Only the first line has created_at
		expect(lines[0]?.created_at).toBe(createdAt.toISOString());
		expect(lines[1]?.created_at).toBeUndefined();
	});

	it("filters out entries below configured level", () => {
		const logger = new ChannelLogger("ch3", tmpDir, makeConfig({ level: "info" }), createdAt);
		logger.log("hub", "debug", "should be filtered");
		logger.log("hub", "trace", "should be filtered too");
		logger.log("hub", "info", "visible");
		logger.log("hub", "warn", "also visible");

		const filePath = path.join(tmpDir, "channels", "ch3.jsonl");
		const lines = readLines(filePath);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.lvl).toBe("info");
		expect(lines[1]?.lvl).toBe("warn");
	});

	it("stops writing when file exceeds maxSizeMb", () => {
		// maxSizeMb = 0.0001 MB = ~102 bytes
		const logger = new ChannelLogger("ch4", tmpDir, makeConfig({ maxSizeMb: 0.0001 }), createdAt);

		// Write enough lines to exceed the limit
		for (let i = 0; i < 20; i++) {
			logger.log("hub", "info", `line ${i} padding padding padding padding`);
		}

		const filePath = path.join(tmpDir, "channels", "ch4.jsonl");
		const lines = readLines(filePath);
		// Should stop before 20 lines due to size cap
		expect(lines.length).toBeLessThan(20);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("creates channels/ directory on first write", () => {
		const channelsDir = path.join(tmpDir, "channels");
		expect(fs.existsSync(channelsDir)).toBe(false);

		const logger = new ChannelLogger("ch5", tmpDir, makeConfig(), createdAt);
		logger.log("hub", "info", "trigger dir creation");

		expect(fs.existsSync(channelsDir)).toBe(true);
	});

	it("spreads extra fields into the entry", () => {
		const logger = new ChannelLogger("ch6", tmpDir, makeConfig(), createdAt);
		logger.log("hub", "info", "with extra", { code: 42, key: "val" });

		const filePath = path.join(tmpDir, "channels", "ch6.jsonl");
		const lines = readLines(filePath);
		expect(lines[0]?.code).toBe(42);
		expect(lines[0]?.key).toBe("val");
	});

	it("t field is a non-negative numeric offset in ms", () => {
		const logger = new ChannelLogger("ch7", tmpDir, makeConfig(), createdAt);
		logger.log("hub", "info", "timing test");

		const filePath = path.join(tmpDir, "channels", "ch7.jsonl");
		const lines = readLines(filePath);
		const t = lines[0]?.t;
		expect(typeof t).toBe("number");
		expect(t as number).toBeGreaterThanOrEqual(0);
	});

	it("close() writes a final 'channel closed' entry", () => {
		const logger = new ChannelLogger("ch8", tmpDir, makeConfig(), createdAt);
		logger.log("hub", "info", "first");
		logger.close();

		const filePath = path.join(tmpDir, "channels", "ch8.jsonl");
		const lines = readLines(filePath);
		// Last line should be the close entry
		expect(lines.at(-1)?.msg).toBe("channel closed");
	});
});
