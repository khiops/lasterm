import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LogConfig } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubLogger } from "../logging/hub-logger.js";
import { registerLogRoutes } from "./logs.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-logs-test-"));
}

function writeChannelLog(logsDir: string, channelId: string, lines: object[]): void {
	const dir = path.join(logsDir, "channels");
	fs.mkdirSync(dir, { recursive: true });
	const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	fs.writeFileSync(path.join(dir, `${channelId}.jsonl`), content);
}

function writeHubLog(logsDir: string, lines: object[]): void {
	fs.mkdirSync(logsDir, { recursive: true });
	const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	fs.writeFileSync(path.join(logsDir, "hub.jsonl"), content);
}

function makeLogConfig(overrides: Partial<LogConfig> = {}): LogConfig {
	return {
		level: "info",
		format: "jsonl",
		output: "file",
		maxAgeDays: 30,
		maxSizeMb: 50,
		...overrides,
	};
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// A valid 26-char alphanumeric channel ID (ULID-shaped)
const CHANNEL_ID = "01JQKZ2ABCDEFGHJKMNPQRSTUV";

const CHANNEL_ENTRIES = [
	{ t: 0, src: "hub", lvl: "info", msg: "channel opened" },
	{ t: 100, src: "agent", lvl: "debug", msg: "pty created" },
	{ t: 200, src: "hub", lvl: "warn", msg: "backpressure detected" },
	{ t: 300, src: "hub", lvl: "error", msg: "write failed" },
];

const HUB_ENTRIES = [
	{ ts: "2026-03-21T10:00:00.000Z", lvl: "info", msg: "hub started" },
	{ ts: "2026-03-21T10:01:00.000Z", lvl: "debug", msg: "session created" },
	{ ts: "2026-03-21T10:02:00.000Z", lvl: "warn", msg: "reconnect attempt" },
	{ ts: "2026-03-21T10:03:00.000Z", lvl: "error", msg: "agent disconnected" },
];

// ─── Test setup ───────────────────────────────────────────────────────────────

let tmpDir: string;
let logsDir: string;
let app: FastifyInstance;

beforeEach(async () => {
	tmpDir = makeTmpDir();
	logsDir = path.join(tmpDir, "logs");
	app = Fastify({ logger: false });
	await registerLogRoutes(app, logsDir);
	await app.ready();
});

afterEach(async () => {
	await app.close();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── GET /api/logs/channels/:channelId ────────────────────────────────────────

describe("GET /api/logs/channels/:channelId", () => {
	it("returns empty entries when file does not exist", async () => {
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.entries).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("parses JSONL and returns all entries", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.total).toBe(4);
		expect(body.entries).toHaveLength(4);
	});

	it("skips malformed JSONL lines", async () => {
		const dir = path.join(logsDir, "channels");
		fs.mkdirSync(dir, { recursive: true });
		const content = [
			JSON.stringify({ t: 0, src: "hub", lvl: "info", msg: "ok" }),
			"NOT VALID JSON{{{{",
			"",
			JSON.stringify({ t: 1, src: "hub", lvl: "info", msg: "also ok" }),
		].join("\n");
		fs.writeFileSync(path.join(dir, `${CHANNEL_ID}.jsonl`), content);

		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.total).toBe(2);
		expect(body.entries).toHaveLength(2);
	});

	it("filters by level — warn returns warn and error only", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?level=warn`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ lvl: string }>; total: number }>();
		expect(body.total).toBe(2);
		expect(body.entries.map((e) => e.lvl)).toEqual(["warn", "error"]);
	});

	it("filters by level — error returns error only", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?level=error`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ lvl: string }>; total: number }>();
		expect(body.total).toBe(1);
		expect(body.entries[0]?.lvl).toBe("error");
	});

	it("filters by search (case-insensitive)", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?search=BACKPRESSURE`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ msg: string }>; total: number }>();
		expect(body.total).toBe(1);
		expect(body.entries[0]?.msg).toBe("backpressure detected");
	});

	it("filters by from_t / to_t (ms offset range)", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?from_t=100&to_t=200`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ t: number }>; total: number }>();
		expect(body.total).toBe(2);
		expect(body.entries.map((e) => e.t)).toEqual([100, 200]);
	});

	it("applies limit and offset for pagination", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?limit=2&offset=1`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ t: number }>; total: number }>();
		expect(body.total).toBe(4); // total before pagination
		expect(body.entries).toHaveLength(2);
		expect(body.entries[0]?.t).toBe(100); // second entry (offset=1)
		expect(body.entries[1]?.t).toBe(200);
	});

	it("blocks path traversal via channelId (returns 400)", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/logs/channels/../../../etc/passwd",
		});
		// Fastify may return 400 (param validation) or 404 (route not matched)
		// — either is safe. We just assert it's not 200.
		expect(res.statusCode).not.toBe(200);
	});

	it("blocks short channelId (returns 400)", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/api/logs/channels/short",
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("INVALID_CHANNEL_ID");
	});

	it("returns 400 for invalid limit", async () => {
		writeChannelLog(logsDir, CHANNEL_ID, CHANNEL_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?limit=9999`,
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── GET /api/logs/hub ────────────────────────────────────────────────────────

describe("GET /api/logs/hub", () => {
	it("returns empty entries when file does not exist", async () => {
		const res = await app.inject({ method: "GET", url: "/api/logs/hub" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.entries).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("parses hub JSONL and returns all entries", async () => {
		writeHubLog(logsDir, HUB_ENTRIES);
		const res = await app.inject({ method: "GET", url: "/api/logs/hub" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.total).toBe(4);
		expect(body.entries).toHaveLength(4);
	});

	it("returns hub entries written with text format because the file remains JSONL", async () => {
		const logger = new HubLogger(logsDir, makeLogConfig({ format: "text", output: "file" }));
		logger.log("info", "hub started", { port: 4100 });
		logger.log("warn", "agent reconnect failed", { host: "prod-web" });

		const rawLines = fs.readFileSync(path.join(logsDir, "hub.jsonl"), "utf8").trim().split("\n");
		expect(rawLines).toHaveLength(2);
		expect(rawLines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
			{ lvl: "info", msg: "hub started", port: 4100 },
			{ lvl: "warn", msg: "agent reconnect failed", host: "prod-web" },
		]);

		const res = await app.inject({ method: "GET", url: "/api/logs/hub" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ lvl: string; msg: string }>; total: number }>();
		expect(body.total).toBe(2);
		expect(body.entries.map((entry) => entry.msg)).toEqual([
			"hub started",
			"agent reconnect failed",
		]);
	});

	it("skips malformed JSONL lines", async () => {
		fs.mkdirSync(logsDir, { recursive: true });
		const content = [
			JSON.stringify({ ts: "2026-03-21T10:00:00.000Z", lvl: "info", msg: "good" }),
			"INVALID_JSON",
			JSON.stringify({ ts: "2026-03-21T10:01:00.000Z", lvl: "info", msg: "also good" }),
		].join("\n");
		fs.writeFileSync(path.join(logsDir, "hub.jsonl"), content);

		const res = await app.inject({ method: "GET", url: "/api/logs/hub" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.total).toBe(2);
	});

	it("filters by level — warn returns warn and error", async () => {
		writeHubLog(logsDir, HUB_ENTRIES);
		const res = await app.inject({ method: "GET", url: "/api/logs/hub?level=warn" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ lvl: string }>; total: number }>();
		expect(body.total).toBe(2);
		expect(body.entries.map((e) => e.lvl)).toEqual(["warn", "error"]);
	});

	it("filters by search (case-insensitive)", async () => {
		writeHubLog(logsDir, HUB_ENTRIES);
		const res = await app.inject({ method: "GET", url: "/api/logs/hub?search=RECONNECT" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ msg: string }>; total: number }>();
		expect(body.total).toBe(1);
		expect(body.entries[0]?.msg).toBe("reconnect attempt");
	});

	it("filters by from_t / to_t (ISO date range)", async () => {
		writeHubLog(logsDir, HUB_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: "/api/logs/hub?from_t=2026-03-21T10:01:00.000Z&to_t=2026-03-21T10:02:00.000Z",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ lvl: string }>; total: number }>();
		expect(body.total).toBe(2);
		expect(body.entries.map((e) => e.lvl)).toEqual(["debug", "warn"]);
	});

	it("applies limit and offset for pagination", async () => {
		writeHubLog(logsDir, HUB_ENTRIES);
		const res = await app.inject({
			method: "GET",
			url: "/api/logs/hub?limit=2&offset=2",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ lvl: string }>; total: number }>();
		expect(body.total).toBe(4);
		expect(body.entries).toHaveLength(2);
		expect(body.entries[0]?.lvl).toBe("warn");
		expect(body.entries[1]?.lvl).toBe("error");
	});

	it("returns 400 for invalid offset", async () => {
		const res = await app.inject({ method: "GET", url: "/api/logs/hub?offset=-5" });
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── Streaming correctness (readline path) ────────────────────────────────────
//
// These tests exercise the streaming read path directly via the HTTP routes to
// ensure the readline implementation is faithful to the old readFileSync slurp:
//   - Blank lines are skipped (not counted as malformed or real entries)
//   - Malformed lines are silently skipped
//   - No trailing newline at EOF: the last entry is still returned
//   - Mutation caught: a streaming impl that drops the last line when there is
//     no trailing newline, or miscounts entries due to blank-line handling.

describe("streaming correctness — readline vs slurp parity", () => {
	it("returns last entry when file has no trailing newline", async () => {
		// Write JSONL WITHOUT a trailing newline — a common readline pitfall where
		// the final line is silently dropped if the impl only emits on "\n".
		const dir = path.join(logsDir, "channels");
		fs.mkdirSync(dir, { recursive: true });
		const lines = [
			JSON.stringify({ t: 0, src: "hub", lvl: "info", msg: "first" }),
			JSON.stringify({ t: 1, src: "hub", lvl: "info", msg: "last" }),
		];
		// Deliberately NO trailing "\n"
		fs.writeFileSync(path.join(dir, `${CHANNEL_ID}.jsonl`), lines.join("\n"));

		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ msg: string }>; total: number }>();
		// Both entries must be present — the last one must not be dropped
		expect(body.total).toBe(2);
		expect(body.entries[1]?.msg).toBe("last");
	});

	it("blank lines and malformed line do not affect valid entry count", async () => {
		// Mixed fixture: valid, blank, malformed, blank, valid — no trailing newline
		const dir = path.join(logsDir, "channels");
		fs.mkdirSync(dir, { recursive: true });
		const content = [
			JSON.stringify({ t: 0, src: "hub", lvl: "info", msg: "entry-a" }),
			"",
			"NOT_JSON{{{{",
			"",
			JSON.stringify({ t: 1, src: "hub", lvl: "warn", msg: "entry-b" }),
		].join("\n"); // no trailing newline
		fs.writeFileSync(path.join(dir, `${CHANNEL_ID}.jsonl`), content);

		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ msg: string }>; total: number }>();
		// Only the two valid objects should be returned
		expect(body.total).toBe(2);
		expect(body.entries[0]?.msg).toBe("entry-a");
		expect(body.entries[1]?.msg).toBe("entry-b");
	});

	it("returns [] for a missing file (ENOENT) without throwing", async () => {
		// No file written — ENOENT must be handled gracefully, returning empty result
		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: unknown[]; total: number }>();
		expect(body.entries).toEqual([]);
		expect(body.total).toBe(0);
	});

	it("filters apply correctly after streaming read (level + search combined)", async () => {
		// Ensure downstream filter chain works identically after the async read
		const dir = path.join(logsDir, "channels");
		fs.mkdirSync(dir, { recursive: true });
		const content = `${[
			JSON.stringify({ t: 0, src: "hub", lvl: "info", msg: "noise" }),
			JSON.stringify({ t: 1, src: "hub", lvl: "warn", msg: "important warning" }),
			JSON.stringify({ t: 2, src: "hub", lvl: "error", msg: "important error" }),
			JSON.stringify({ t: 3, src: "hub", lvl: "warn", msg: "other warn" }),
		].join("\n")}\n`;
		fs.writeFileSync(path.join(dir, `${CHANNEL_ID}.jsonl`), content);

		const res = await app.inject({
			method: "GET",
			url: `/api/logs/channels/${CHANNEL_ID}?level=warn&search=important`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ entries: Array<{ msg: string }>; total: number }>();
		// warn+error filtered, then "important" search: 2 entries remain
		expect(body.total).toBe(2);
		expect(body.entries[0]?.msg).toBe("important warning");
		expect(body.entries[1]?.msg).toBe("important error");
	});
});
