import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";

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

const TEST_TOKEN = "test-fonts-token-64chars-padded-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * Minimal TTF-like buffer: OpenType signature 0x00010000 (TrueType).
 * No valid name table, but magic bytes pass MIME detection.
 */
const TTF_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

/**
 * OpenType CFF signature: 0x4F54544F ("OTTO")
 */
const OTF_MAGIC = Buffer.from([0x4f, 0x54, 0x54, 0x4f, 0x00, 0x00, 0x00, 0x00]);

function buildMultipart(
	filename: string,
	content: Buffer | string,
	contentType = "application/octet-stream",
): { payload: Buffer; headers: Record<string, string> } {
	const boundary = "----TestFontBoundary42";
	const header = Buffer.from(
		`--${boundary}\r\nContent-Disposition: form-data; name="font"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
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

describe("Font endpoints", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let configDir: string;

	beforeEach(async () => {
		configDir = join(
			tmpdir(),
			`lasterm-fonts-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(join(configDir, "fonts"), { recursive: true });
		dbs = openTestDatabases();
		server = await createServer({
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

	// ─── GET /api/fonts ───────────────────────────────────────────────────────

	describe("GET /api/fonts", () => {
		it("should return empty array when no fonts exist", async () => {
			const res = await server.inject({ method: "GET", url: "/api/fonts", headers: authHeader() });
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual([]);
		});

		it("should return font families for scanned fonts", async () => {
			// Write a minimal TTF — family name will be derived from filename heuristic
			writeFileSync(join(configDir, "fonts", "Hack-Regular.ttf"), TTF_MAGIC);

			const res = await server.inject({ method: "GET", url: "/api/fonts", headers: authHeader() });
			expect(res.statusCode).toBe(200);
			const families = res.json<{ family: string; files: Array<{ url: string }> }[]>();
			expect(Array.isArray(families)).toBe(true);
			expect(families.length).toBeGreaterThan(0);
			expect(families[0]?.files[0]?.url).toMatch(
				/^\/public\/fonts\/Hack-Regular\.ttf\?asset_token=/,
			);
		});
	});

	// ─── POST /api/fonts ──────────────────────────────────────────────────────

	describe("POST /api/fonts", () => {
		it("should upload a valid TTF file and return FontFamily[]", async () => {
			const { payload, headers } = buildMultipart("Hack-Regular.ttf", TTF_MAGIC, "font/sfnt");
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(200);
			const families = res.json<{ family: string; files: unknown[] }[]>();
			expect(Array.isArray(families)).toBe(true);
			expect(families.length).toBeGreaterThan(0);
		});

		it("should upload a valid OTF file and return FontFamily[]", async () => {
			const { payload, headers } = buildMultipart("FiraMono-Bold.otf", OTF_MAGIC, "font/otf");
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(200);
			const families = res.json<{ family: string; files: unknown[] }[]>();
			expect(Array.isArray(families)).toBe(true);
		});

		it("should reject files with an invalid extension", async () => {
			const { payload, headers } = buildMultipart(
				"malware.exe",
				"MZ...",
				"application/octet-stream",
			);
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("UNSUPPORTED_TYPE");
		});

		it("should reject upload without auth", async () => {
			const boundary = "----TestFontBoundary42";
			const payload = [
				`--${boundary}`,
				`Content-Disposition: form-data; name="font"; filename="Hack-Regular.ttf"`,
				"Content-Type: font/sfnt",
				"",
				"fake",
				`--${boundary}--`,
			].join("\r\n");
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
				payload,
			});
			expect(res.statusCode).toBe(401);
		});

		it("should reject upload when no file is provided", async () => {
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers: {
					...authHeader(),
					"content-type": "multipart/form-data; boundary=----Empty",
				},
				payload: "------Empty--\r\n",
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("NO_FILE");
		});

		it("should handle path traversal in filename", async () => {
			const { payload, headers } = buildMultipart("../../etc/passwd", "evil");
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(400);
		});

		it("should reject content whose MIME does not match a font type", async () => {
			// Send a PNG magic with a .ttf filename — should be rejected by MIME check
			const PNG_MAGIC = Buffer.from([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
				0x52,
			]);
			const { payload, headers } = buildMultipart("Hack-Regular.ttf", PNG_MAGIC, "font/sfnt");
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(400);
			expect(res.json().error.code).toBe("INVALID_FILE_TYPE");
		});

		it("should not overwrite an existing font (duplicate rejected)", async () => {
			writeFileSync(join(configDir, "fonts", "Hack-Regular.ttf"), TTF_MAGIC);

			const { payload, headers } = buildMultipart("Hack-Regular.ttf", TTF_MAGIC, "font/sfnt");
			const res = await server.inject({
				method: "POST",
				url: "/api/fonts",
				headers,
				payload,
			});
			expect(res.statusCode).toBe(409);
			expect(res.json().error.code).toBe("DUPLICATE");
		});
	});

	// ─── DELETE /api/fonts/:family ────────────────────────────────────────────

	describe("DELETE /api/fonts/:family", () => {
		it("should delete all files of a font family and return 204", async () => {
			// Write two files belonging to the same family "My Font"
			writeFileSync(join(configDir, "fonts", "MyFont-Regular.ttf"), TTF_MAGIC);
			writeFileSync(join(configDir, "fonts", "MyFont-Bold.ttf"), TTF_MAGIC);

			const res = await server.inject({
				method: "DELETE",
				url: `/api/fonts/${encodeURIComponent("My Font")}`,
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(204);

			// Verify files are gone
			const listRes = await server.inject({
				method: "GET",
				url: "/api/fonts",
				headers: authHeader(),
			});
			expect(
				listRes.json<{ family: string }[]>().find((f) => f.family === "My Font"),
			).toBeUndefined();
		});

		it("should return 404 for an unknown family", async () => {
			const res = await server.inject({
				method: "DELETE",
				url: `/api/fonts/${encodeURIComponent("Does Not Exist")}`,
				headers: authHeader(),
			});
			expect(res.statusCode).toBe(404);
			expect(res.json().error.code).toBe("FONT_FAMILY_NOT_FOUND");
		});

		it("should reject delete without auth", async () => {
			const res = await server.inject({
				method: "DELETE",
				url: `/api/fonts/${encodeURIComponent("My Font")}`,
			});
			expect(res.statusCode).toBe(401);
		});
	});
});
