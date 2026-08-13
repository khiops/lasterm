import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addCorsOrigins, addStartupCorsOrigins, createServer } from "./server.js";
import type { DatabaseManager } from "./storage/db.js";
import { openTestDatabases } from "./storage/db.js";
import { getTestTls } from "./test-tls.fixture.js";

/** Known token used across auth tests */
const TEST_TOKEN = "a".repeat(64);
const TTF_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const PUBLIC_ASSET_CASES = [
	{ kind: "fonts", filename: "Test-Regular.ttf", body: TTF_MAGIC },
	{ kind: "sounds", filename: "Bell.wav", body: "RIFF....WAVEfmt " },
	{ kind: "wallpapers", filename: "Wallpaper.png", body: "fake-png" },
] as const;

describe("Hub Server", () => {
	let server: FastifyInstance;

	afterEach(async () => {
		if (server) await server.close();
	});

	it("should create a server instance", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		expect(server).toBeDefined();
	});

	it("GET /api/health returns ok status with build hash and version", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({ method: "GET", url: "/api/health" });
		expect(response.statusCode).toBe(200);
		const body = response.json();
		expect(body.status).toBe("ok");
		expect(typeof body.version).toBe("string");
		expect(body.version.length).toBeGreaterThan(0);
		expect(typeof body.build).toBe("string");
		expect(body.build.length).toBeGreaterThan(0);
		expect(body.uptime).toBeUndefined();
	});

	it("GET /unknown returns 404", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({ method: "GET", url: "/unknown" });
		expect(response.statusCode).toBe(404);
	});
});

describe("Hub Server — Bearer auth", () => {
	let server: FastifyInstance;
	let dbs: DatabaseManager;

	beforeEach(() => {
		dbs = openTestDatabases();
	});

	afterEach(async () => {
		if (server) await server.close();
		dbs.meta.close();
		dbs.spool.close();
	});

	it("GET /api/health is accessible without token", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		const response = await server.inject({ method: "GET", url: "/api/health" });
		expect(response.statusCode).toBe(200);
	});

	it("GET /api/pair/verify is accessible without token", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		// Route doesn't exist yet (M4.2) — but auth must not block it; expect 404 not 401
		const response = await server.inject({ method: "GET", url: "/api/pair/verify" });
		expect(response.statusCode).not.toBe(401);
	});

	it("API route without Authorization header → 401 AUTH_REQUIRED", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		const response = await server.inject({ method: "GET", url: "/api/unknown" });
		expect(response.statusCode).toBe(401);
		const body = response.json();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("API route with wrong token → 401 AUTH_INVALID", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		const response = await server.inject({
			method: "GET",
			url: "/api/unknown",
			headers: { authorization: `Bearer ${"b".repeat(64)}` },
		});
		expect(response.statusCode).toBe(401);
		const body = response.json();
		expect(body.error).toBe("AUTH_INVALID");
	});

	it("API route with malformed Authorization header → 401", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		const response = await server.inject({
			method: "GET",
			url: "/api/unknown",
			headers: { authorization: "Token abc123" },
		});
		expect(response.statusCode).toBe(401);
		const body = response.json();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("API route with correct token → passes auth (404 from missing route, not 401)", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
		const response = await server.inject({
			method: "GET",
			url: "/api/unknown",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(response.statusCode).toBe(404);
	});

	it("no authToken configured → all routes accessible without auth", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({ method: "GET", url: "/unknown" });
		// Without auth, falls through to 404 — not 401
		expect(response.statusCode).toBe(404);
	});
});

describe("Hub Server — CORS allowlist", () => {
	let server: FastifyInstance;

	afterEach(async () => {
		if (server) await server.close();
	});

	it("allowed origin (localhost:5173) gets Access-Control-Allow-Origin header when explicitly allowed", async () => {
		// SEC-020: localhost:5173 is NOT in the default allowlist — it must be explicitly added
		// (done by startup code after startServer() in non-production, or via corsOrigins override).
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			corsOrigins: ["http://localhost:5173"],
		});
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://localhost:5173" },
		});
		expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
	});

	it("disallowed origin (http://evil.com) gets no CORS allow header", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://evil.com" },
		});
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("subdomain bypass blocked (http://localhost.evil.com:5173)", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://localhost.evil.com:5173" },
		});
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("default config allows Tauri origin (tauri://localhost)", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "tauri://localhost" },
		});
		expect(response.headers["access-control-allow-origin"]).toBe("tauri://localhost");
	});

	it("default config allows http://tauri.localhost", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://tauri.localhost" },
		});
		expect(response.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
	});

	it("empty allowlist rejects all origins", async () => {
		server = await createServer({ tls: getTestTls(), logger: false, corsOrigins: [] });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://localhost:5173" },
		});
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("missing origin header results in no CORS allow header", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
		});
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("127.0.0.1 origin is allowed after addCorsOrigins() injects the actual port", async () => {
		// SEC-020: Exact localhost origins are not in defaults — addCorsOrigins() injects them
		// after startServer() returns the actual port.
		server = await createServer({ tls: getTestTls(), logger: false });
		addCorsOrigins("http://127.0.0.1:4100");
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://127.0.0.1:4100" },
		});
		expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:4100");
	});

	it("localhost:5173 is NOT allowed by default (no wildcard)", async () => {
		// SEC-020: Verify wildcard removal — localhost:5173 must not be allowed without explicit config.
		server = await createServer({ tls: getTestTls(), logger: false, corsOrigins: [] });
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://localhost:5173" },
		});
		expect(response.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("addCorsOrigins() adds an exact origin to the allowlist", async () => {
		server = await createServer({ tls: getTestTls(), logger: false, corsOrigins: [] });
		addCorsOrigins("http://localhost:9999");
		const response = await server.inject({
			method: "GET",
			url: "/api/health",
			headers: { origin: "http://localhost:9999" },
		});
		expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:9999");
	});
});

describe("Hub Server — startup CORS origin injection", () => {
	let server: FastifyInstance | undefined;
	let dbs: DatabaseManager | undefined;
	const tempDirs: string[] = [];

	afterEach(async () => {
		if (server) await server.close();
		dbs?.close();
		server = undefined;
		dbs = undefined;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("adds the actual bound loopback port so agent mutations are not blocked by Origin guard", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "lasterm-startup-cors-config-"));
		tempDirs.push(configDir);
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir,
		});

		const actualPort = addStartupCorsOrigins("https://127.0.0.1:4217", 4100);
		const response = await server.inject({
			method: "POST",
			url: "/api/agents/fetch",
			headers: {
				authorization: `Bearer ${TEST_TOKEN}`,
				"content-type": "application/json",
				host: "127.0.0.1:4217",
				origin: "https://127.0.0.1:4217",
			},
			payload: { os: "plan9", arch: "x64" },
		});

		expect(actualPort).toBe(4217);
		expect(response.statusCode).toBe(400);
		expect(response.json().error).toEqual({
			code: "UNSUPPORTED_TARGET",
			message: "No Lasterm agent release is built for plan9/x64.",
		});
	});

	it("allows agent mutations from a wildcard CORS origin when the hub Host differs", async () => {
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			corsOrigins: ["https://ui.example.com:*"],
		});

		const response = await server.inject({
			method: "POST",
			url: "/api/agents/fetch",
			headers: {
				authorization: `Bearer ${TEST_TOKEN}`,
				"content-type": "application/json",
				host: "hub.example.com",
				origin: "https://ui.example.com:8443",
			},
			payload: { os: "plan9", arch: "x64" },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("UNSUPPORTED_TARGET");
	});

	it("allows agent mutations from an exact CORS origin regardless of Host", async () => {
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			corsOrigins: ["https://ui.example.com"],
		});

		const response = await server.inject({
			method: "POST",
			url: "/api/agents/fetch",
			headers: {
				authorization: `Bearer ${TEST_TOKEN}`,
				"content-type": "application/json",
				host: "hub.example.com",
				origin: "https://ui.example.com",
			},
			payload: { os: "plan9", arch: "x64" },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error.code).toBe("UNSUPPORTED_TARGET");
	});
});

describe("Hub Server — security headers", () => {
	let server: FastifyInstance | undefined;
	let dbs: DatabaseManager | undefined;
	let configDir: string | undefined;

	afterEach(async () => {
		if (server) await server.close();
		dbs?.close();
		if (configDir) rmSync(configDir, { recursive: true, force: true });
		server = undefined;
		dbs = undefined;
		configDir = undefined;
	});

	async function createProtectedAssetServer(
		kind: (typeof PUBLIC_ASSET_CASES)[number]["kind"],
		filename: string,
		body: Buffer | string,
	): Promise<string> {
		configDir = join(
			tmpdir(),
			`lasterm-public-corp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(join(configDir, kind), { recursive: true });
		writeFileSync(join(configDir, kind, filename), body);
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir,
		});

		const tokenRes = await server.inject({ method: "GET", url: "/api/assets/token" });
		const { assetToken } = tokenRes.json<{ assetToken: string }>();
		return assetToken;
	}

	it.each(
		PUBLIC_ASSET_CASES,
	)("GET /public/$kind/:file serves signed public assets with cross-origin CORP", async ({
		kind,
		filename,
		body,
	}) => {
		const assetToken = await createProtectedAssetServer(kind, filename, body);

		const response = await server?.inject({
			method: "GET",
			url: `/public/${kind}/${filename}?asset_token=${assetToken}`,
			headers: { origin: "tauri://localhost" },
		});

		expect(response?.statusCode).toBe(200);
		expect(response?.headers["cross-origin-resource-policy"]).toBe("cross-origin");
	});

	it.each(PUBLIC_ASSET_CASES)("GET /public/$kind/:file rejects missing asset token", async ({
		kind,
		filename,
		body,
	}) => {
		await createProtectedAssetServer(kind, filename, body);

		const response = await server?.inject({
			method: "GET",
			url: `/public/${kind}/${filename}`,
			headers: { origin: "tauri://localhost" },
		});

		expect(response?.statusCode).toBe(403);
		expect(response?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");
	});

	it.each(PUBLIC_ASSET_CASES)("GET /public/$kind/:file rejects invalid asset token", async ({
		kind,
		filename,
		body,
	}) => {
		await createProtectedAssetServer(kind, filename, body);

		const response = await server?.inject({
			method: "GET",
			url: `/public/${kind}/${filename}?asset_token=bad-token`,
			headers: { origin: "tauri://localhost" },
		});

		expect(response?.statusCode).toBe(403);
		expect(response?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");
	});

	it("GET /api/health keeps Helmet's same-origin CORP", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });

		const response = await server.inject({ method: "GET", url: "/api/health" });

		expect(response.statusCode).toBe(200);
		expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
	});
});
