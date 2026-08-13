import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.js";

// ─── Mock agents so no real PTY / SSH is spawned ─────────────────────────────

vi.mock("../session/ssh-agent.js", () => {
	const { EventEmitter } = require("node:events");
	class MockSshAgent extends EventEmitter {
		connected = true;
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn();
		close = vi.fn(() => {
			this.connected = false;
			this.emit("close");
		});
	}
	return { SshAgent: MockSshAgent };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_TOKEN = "test-wallpaper-token-64chars-padded-aaaaaaaaaaaaaaaaaaaaaaaaa";

// Minimal valid PNG for tests (signature + IHDR chunk, enough for file-type detection)
// signature(8) + chunk_length(4=13) + "IHDR"(4) + width(4=1) + height(4=1) +
// bit_depth(1=8) + color_type(1=2) + compress(1) + filter(1) + interlace(1) + crc(4)
const PNG_MAGIC = Buffer.from([
	0x89,
	0x50,
	0x4e,
	0x47,
	0x0d,
	0x0a,
	0x1a,
	0x0a, // PNG signature
	0x00,
	0x00,
	0x00,
	0x0d, // IHDR chunk length = 13
	0x49,
	0x48,
	0x44,
	0x52, // "IHDR"
	0x00,
	0x00,
	0x00,
	0x01, // width = 1
	0x00,
	0x00,
	0x00,
	0x01, // height = 1
	0x08,
	0x02,
	0x00,
	0x00,
	0x00, // bit depth=8, color type=2 (RGB)
	0x90,
	0x77,
	0x53,
	0xde, // CRC
]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function buildMultipart(
	filename: string,
	content: Buffer | string,
	contentType = "image/jpeg",
): { payload: Buffer; headers: Record<string, string> } {
	const boundary = "----TestBoundary42";
	const header = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
	);
	const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
	const bodyBuf = Buffer.isBuffer(content) ? content : Buffer.from(content);
	const payload = Buffer.concat([header, bodyBuf, footer]);
	return {
		payload,
		headers: {
			authorization: `Bearer ${TEST_TOKEN}`,
			"content-type": `multipart/form-data; boundary=${boundary}`,
		},
	};
}

function authHeader(): Record<string, string> {
	return { authorization: `Bearer ${TEST_TOKEN}` };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Wallpaper endpoints", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let configDir: string;

	beforeEach(async () => {
		// Use a unique temp subdir per test to avoid cross-test pollution
		configDir = join(
			tmpdir(),
			`lasterm-wallpaper-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(join(configDir, "wallpapers"), { recursive: true });
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: TEST_TOKEN,
			configDir,
		});
	});

	afterEach(async () => {
		await server.close();
		dbs.close();
	});

	// ─── GET /api/wallpapers ──────────────────────────────────────────────────

	describe("GET /api/wallpapers", () => {
		it("should return empty list when no wallpapers exist", async () => {
			const res = await server.inject({
				method: "GET",
				url: "/api/wallpapers",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ wallpapers: [] });
		});

		it("should list uploaded wallpapers", async () => {
			writeFileSync(join(configDir, "wallpapers", "bg.png"), "fake-png");
			writeFileSync(join(configDir, "wallpapers", "hero.jpg"), "fake-jpg");

			const res = await server.inject({
				method: "GET",
				url: "/api/wallpapers",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ wallpapers: string[] }>();
			expect(body.wallpapers).toContain("bg.png");
			expect(body.wallpapers).toContain("hero.jpg");
		});

		it("should filter non-image files from listing", async () => {
			writeFileSync(join(configDir, "wallpapers", "script.sh"), "#!/bin/sh");
			writeFileSync(join(configDir, "wallpapers", "image.webp"), "fake-webp");

			const res = await server.inject({
				method: "GET",
				url: "/api/wallpapers",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			const body = res.json<{ wallpapers: string[] }>();
			expect(body.wallpapers).not.toContain("script.sh");
			expect(body.wallpapers).toContain("image.webp");
		});

		it("should reject list without auth", async () => {
			const res = await server.inject({ method: "GET", url: "/api/wallpapers" });
			expect(res.statusCode).toBe(401);
		});
	});

	// ─── POST /api/wallpapers ─────────────────────────────────────────────────

	describe("POST /api/wallpapers", () => {
		it("should upload a valid image file", async () => {
			const { payload, headers } = buildMultipart("test.jpg", JPEG_MAGIC);
			const res = await server.inject({
				method: "POST",
				url: "/api/wallpapers",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ filename: "test.jpg" });
		});

		it("should reject files with invalid extension", async () => {
			const { payload, headers } = buildMultipart(
				"malware.exe",
				"MZ...",
				"application/octet-stream",
			);
			const res = await server.inject({
				method: "POST",
				url: "/api/wallpapers",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("UNSUPPORTED_TYPE");
		});

		it("should reject upload without auth", async () => {
			const boundary = "----TestBoundary42";
			const payload = [
				`--${boundary}`,
				`Content-Disposition: form-data; name="image"; filename="test.jpg"`,
				"Content-Type: image/jpeg",
				"",
				"fake",
				`--${boundary}--`,
			].join("\r\n");
			const res = await server.inject({
				method: "POST",
				url: "/api/wallpapers",
				headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
				payload,
			});
			expect(res.statusCode).toBe(401);
		});

		it("should handle path traversal in filename", async () => {
			// basename() strips directory parts — "../../etc/passwd" → sanitizeFilename returns null
			// because basename("../../etc/passwd") = "passwd" which !== "../../etc/passwd"
			const { payload, headers } = buildMultipart("../../etc/passwd", "evil");
			const res = await server.inject({
				method: "POST",
				url: "/api/wallpapers",
				headers,
				payload,
			});
			// Either 400 INVALID_FILENAME or the safe basename "passwd" (unsupported ext) → 400
			expect(res.statusCode).toBe(400);
		});

		it("should overwrite existing file with same name", async () => {
			writeFileSync(join(configDir, "wallpapers", "bg.png"), "original");

			const { payload, headers } = buildMultipart("bg.png", PNG_MAGIC, "image/png");
			const res = await server.inject({
				method: "POST",
				url: "/api/wallpapers",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ filename: "bg.png" });
		});

		it("should accept files within size limit", async () => {
			// Verifies that a small valid file is accepted end-to-end.
			// The 10 MB ceiling enforced by @fastify/multipart (MAX_WALLPAPER_SIZE) is a
			// framework-level feature trusted at framework level — sending an actual 10 MB+
			// payload in tests would be slow and brittle, so we rely on @fastify/multipart's
			// own test suite for the 413 rejection path and only assert the happy path here.
			const { payload, headers } = buildMultipart(
				"small.jpg",
				Buffer.concat([JPEG_MAGIC, Buffer.alloc(50)]),
			);
			const res = await server.inject({
				method: "POST",
				url: "/api/wallpapers",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ filename: "small.jpg" });
		});
	});

	// ─── DELETE /api/wallpapers/:filename ─────────────────────────────────────

	describe("DELETE /api/wallpapers/:filename", () => {
		it("should delete an existing wallpaper", async () => {
			writeFileSync(join(configDir, "wallpapers", "old.png"), "data");

			const res = await server.inject({
				method: "DELETE",
				url: "/api/wallpapers/old.png",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({ ok: true });
		});

		it("should return 404 for non-existent wallpaper", async () => {
			const res = await server.inject({
				method: "DELETE",
				url: "/api/wallpapers/ghost.jpg",
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(404);
			expect(res.json().error.code).toBe("NOT_FOUND");
		});

		it("should reject delete without auth", async () => {
			const res = await server.inject({
				method: "DELETE",
				url: "/api/wallpapers/something.jpg",
			});
			expect(res.statusCode).toBe(401);
		});

		it("should handle path traversal in filename", async () => {
			const res = await server.inject({
				method: "DELETE",
				url: "/api/wallpapers/..%2Fetc%2Fpasswd",
				headers: authHeader(),
			});
			// Fastify URL-decodes route params — sanitizeFilename rejects traversal → 400
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("INVALID_FILENAME");
		});
	});
});
