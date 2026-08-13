import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LastermTheme } from "@lasterm/shared";
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

const VALID_CUSTOM_THEME: LastermTheme = {
	name: "test-custom",
	type: "dark",
	colors: {
		foreground: "#f8f8f2",
		background: "#282a36",
		cursor: "#f8f8f2",
		selectionBackground: "#44475a",
		black: "#21222c",
		red: "#ff5555",
		green: "#50fa7b",
		yellow: "#f1fa8c",
		blue: "#bd93f9",
		magenta: "#ff79c6",
		cyan: "#8be9fd",
		white: "#f8f8f2",
		brightBlack: "#6272a4",
		brightRed: "#ff6e6e",
		brightGreen: "#69ff94",
		brightYellow: "#ffffa5",
		brightBlue: "#d6acff",
		brightMagenta: "#ff92df",
		brightCyan: "#a4ffff",
		brightWhite: "#ffffff",
	},
	ui: {
		tabBar: "#21222c",
		tabActive: "#282a36",
		tabInactive: "#21222c",
		tabHover: "#343746",
		sidebar: "#21222c",
		sidebarText: "#f8f8f2",
		sidebarActive: "#343746",
		hostRail: "#191a21",
		border: "#191a21",
		accent: "#bd93f9",
		badge: "#ff5555",
		scrollbarThumb: "#6272a4",
		scrollbarTrack: "#00000000",
		searchHighlight: "#f1fa8c40",
		searchHighlightActive: "#f1fa8caa",
	},
};

let dbs: DatabaseManager;
let server: FastifyInstance;
let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "lasterm-theme-api-test-"));
	dbs = openTestDatabases();
	server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
		configDir: tempDir,
	});
});

afterEach(async () => {
	await server.close();
	dbs.close();
});

// ─── Theme Routes ────────────────────────────────────────────────────────────

describe("GET /api/themes", () => {
	it("returns list of themes including bundled", async () => {
		const res = await server.inject({ method: "GET", url: "/api/themes" });
		expect(res.statusCode).toBe(200);
		const body = res.json<LastermTheme[]>();
		expect(Array.isArray(body)).toBe(true);
		// Should have at least the bundled themes
		expect(body.length).toBeGreaterThanOrEqual(9);
		expect(body.find((t) => t.name === "dracula")).toBeTruthy();
	});
});

describe("GET /api/themes/:name", () => {
	it("returns specific theme", async () => {
		const res = await server.inject({ method: "GET", url: "/api/themes/dracula" });
		expect(res.statusCode).toBe(200);
		const body = res.json<LastermTheme>();
		expect(body.name).toBe("dracula");
		expect(body.type).toBe("dark");
		expect(body.colors).toBeTruthy();
		expect(body.ui).toBeTruthy();
	});

	it("returns 404 for missing theme", async () => {
		const res = await server.inject({ method: "GET", url: "/api/themes/nonexistent" });
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("THEME_NOT_FOUND");
	});

	it("returns 400 for path traversal name", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/themes/..%2F..%2Fetc%2Fpasswd",
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("INVALID_NAME");
	});
});

describe("POST /api/themes", () => {
	it("creates new theme", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/themes",
			payload: VALID_CUSTOM_THEME,
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<{ name: string }>();
		expect(body.name).toBe("test-custom");

		// Verify it can be retrieved
		const get = await server.inject({ method: "GET", url: "/api/themes/test-custom" });
		expect(get.statusCode).toBe(200);
		expect(get.json<LastermTheme>().name).toBe("test-custom");
	});

	it("rejects duplicate (409)", async () => {
		// Create first
		await server.inject({
			method: "POST",
			url: "/api/themes",
			payload: VALID_CUSTOM_THEME,
		});

		// Attempt duplicate
		const res = await server.inject({
			method: "POST",
			url: "/api/themes",
			payload: VALID_CUSTOM_THEME,
		});
		expect(res.statusCode).toBe(409);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("THEME_EXISTS");
	});

	it("rejects invalid theme (400)", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/themes",
			payload: { name: "bad", type: "dark" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("INVALID_THEME");
	});
});

describe("PUT /api/themes/:name", () => {
	it("updates theme", async () => {
		// Create theme first
		await server.inject({
			method: "POST",
			url: "/api/themes",
			payload: VALID_CUSTOM_THEME,
		});

		// Update it with a modified author
		const updated = { ...VALID_CUSTOM_THEME, author: "Updated Author" };
		const res = await server.inject({
			method: "PUT",
			url: "/api/themes/test-custom",
			payload: updated,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ name: string }>();
		expect(body.name).toBe("test-custom");

		// Verify the update
		const get = await server.inject({ method: "GET", url: "/api/themes/test-custom" });
		expect(get.json<LastermTheme>().author).toBe("Updated Author");
	});
});

describe("DELETE /api/themes/:name", () => {
	it("removes custom theme", async () => {
		// Create first
		await server.inject({
			method: "POST",
			url: "/api/themes",
			payload: VALID_CUSTOM_THEME,
		});

		const res = await server.inject({
			method: "DELETE",
			url: "/api/themes/test-custom",
		});
		expect(res.statusCode).toBe(204);

		// Verify it's gone
		const get = await server.inject({ method: "GET", url: "/api/themes/test-custom" });
		expect(get.statusCode).toBe(404);
	});

	it("rejects bundled theme (409)", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/themes/dracula",
		});
		expect(res.statusCode).toBe(409);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("BUNDLED_THEME");
	});
});

// Appearance config routes have been moved to config.ts (PUT /api/config/appearance)
