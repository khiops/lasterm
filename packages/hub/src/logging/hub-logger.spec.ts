import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LogConfig } from "@lasterm/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLogger } from "./hub-logger.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-hub-logger-"));
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

describe("HubLogger", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = makeTmpDir();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("writes JSONL with ISO 8601 ts field", () => {
		const logger = new HubLogger(tmpDir, makeConfig({ format: "jsonl" }));
		logger.log("info", "hub started");

		const filePath = path.join(tmpDir, "hub.jsonl");
		expect(fs.existsSync(filePath)).toBe(true);

		const lines = readLines(filePath);
		expect(lines).toHaveLength(1);
		const entry = lines[0];
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(entry.lvl).toBe("info");
		expect(entry.msg).toBe("hub started");
		// ts is ISO 8601
		expect(typeof entry.ts).toBe("string");
		expect(() => new Date(entry.ts as string)).not.toThrow();
		expect(new Date(entry.ts as string).toISOString()).toBe(entry.ts);
	});

	it("keeps file output as JSONL when text format is configured", () => {
		const logger = new HubLogger(tmpDir, makeConfig({ format: "text", output: "file" }));
		logger.log("warn", "hub started", { port: 4100, component: "server core" });

		const filePath = path.join(tmpDir, "hub.jsonl");
		const lines = readLines(filePath);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.lvl).toBe("warn");
		expect(lines[0]?.msg).toBe("hub started");
		expect(lines[0]?.port).toBe(4100);
		expect(lines[0]?.component).toBe("server core");
	});

	it("writes human-readable text to stderr when text format is configured", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = new HubLogger(tmpDir, makeConfig({ format: "text", output: "both" }));

		logger.log("warn", "hub\nstarted", { port: 4100, component: "server core" });

		expect(stderrSpy).toHaveBeenCalledTimes(1);
		expect(stderrSpy).toHaveBeenCalledWith(
			expect.stringMatching(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN hub started port=4100 component="server core"\n$/,
			),
		);
		const lines = readLines(path.join(tmpDir, "hub.jsonl"));
		expect(lines[0]?.msg).toBe("hub\nstarted");
	});

	it("writes structured JSONL to stderr by default", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = new HubLogger(tmpDir, makeConfig({ output: "stderr" }));

		logger.log("info", "hub started", { port: 4100 });

		expect(stderrSpy).toHaveBeenCalledTimes(1);
		const line = stderrSpy.mock.calls[0]?.[0];
		expect(typeof line).toBe("string");
		if (typeof line !== "string") return;
		expect(line.endsWith("\n")).toBe(true);
		const entry = JSON.parse(line) as Record<string, unknown>;
		expect(entry.lvl).toBe("info");
		expect(entry.msg).toBe("hub started");
		expect(entry.port).toBe(4100);
		expect(fs.existsSync(path.join(tmpDir, "hub.jsonl"))).toBe(false);
	});

	it("filters out entries below configured level", () => {
		const logger = new HubLogger(tmpDir, makeConfig({ level: "warn" }));
		logger.log("debug", "filtered");
		logger.log("info", "also filtered");
		logger.log("warn", "visible");
		logger.log("error", "also visible");

		const filePath = path.join(tmpDir, "hub.jsonl");
		const lines = readLines(filePath);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.lvl).toBe("warn");
		expect(lines[1]?.lvl).toBe("error");
	});

	it("emits debug records when configured at debug level", () => {
		const logger = new HubLogger(tmpDir, makeConfig({ level: "debug" }));
		logger.log("debug", "local agent trace", { component: "lasterm-agent" });

		const lines = readLines(path.join(tmpDir, "hub.jsonl"));
		expect(lines).toHaveLength(1);
		expect(lines[0]?.lvl).toBe("debug");
		expect(lines[0]?.msg).toBe("local agent trace");
		expect(lines[0]?.component).toBe("lasterm-agent");
	});

	it("suppresses debug records when configured at info level", () => {
		const logger = new HubLogger(tmpDir, makeConfig({ level: "info" }));
		logger.log("debug", "hidden trace");
		logger.log("info", "visible info");

		const lines = readLines(path.join(tmpDir, "hub.jsonl"));
		expect(lines).toHaveLength(1);
		expect(lines[0]?.lvl).toBe("info");
		expect(lines[0]?.msg).toBe("visible info");
	});

	it("routes debug records to stderr when stderr output is configured", () => {
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const logger = new HubLogger(
			tmpDir,
			makeConfig({ level: "debug", format: "text", output: "stderr" }),
		);

		logger.log("debug", "local agent trace", { connId: 1 });

		expect(stderrSpy).toHaveBeenCalledTimes(1);
		expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("DEBUG local agent trace"));
		expect(fs.existsSync(path.join(tmpDir, "hub.jsonl"))).toBe(false);
	});

	it("rotates to hub.jsonl.old when size exceeds 10 MB", () => {
		const logger = new HubLogger(tmpDir, makeConfig());
		const filePath = path.join(tmpDir, "hub.jsonl");
		const oldPath = path.join(tmpDir, "hub.jsonl.old");

		// Pre-seed file to just over 10 MB
		const tenMbPlusOne = 10 * 1024 * 1024 + 1;
		fs.writeFileSync(filePath, Buffer.alloc(tenMbPlusOne, "x"), { mode: 0o600 });

		logger.log("info", "triggers rotation");

		// Original file should now be hub.jsonl.old (or have been replaced)
		expect(fs.existsSync(oldPath)).toBe(true);
		// New hub.jsonl should exist and be small
		expect(fs.existsSync(filePath)).toBe(true);
		expect(fs.statSync(filePath).size).toBeLessThan(tenMbPlusOne);
	});

	it("spreads extra fields into the entry", () => {
		const logger = new HubLogger(tmpDir, makeConfig());
		logger.log("error", "crash", { code: 500, component: "ws" });

		const filePath = path.join(tmpDir, "hub.jsonl");
		const lines = readLines(filePath);
		expect(lines[0]?.code).toBe(500);
		expect(lines[0]?.component).toBe("ws");
	});

	it("creates logsDir on first write if missing", () => {
		const subDir = path.join(tmpDir, "nested", "logs");
		expect(fs.existsSync(subDir)).toBe(false);

		const logger = new HubLogger(subDir, makeConfig());
		logger.log("info", "init");

		expect(fs.existsSync(path.join(subDir, "hub.jsonl"))).toBe(true);
	});
});
