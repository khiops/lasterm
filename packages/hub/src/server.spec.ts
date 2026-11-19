import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken, revokeToken } from "./auth.js";
import { type SecurityFields, SecurityLog } from "./logging/security-log.js";
import { createServer, startServer } from "./server.fixture.js";
import { addCorsOrigins, addStartupCorsOrigins } from "./server.js";
import type { DatabaseManager } from "./storage/db.js";
import { openTestDatabases } from "./storage/db.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";
import { getTestTls } from "./test-tls.fixture.js";
import { type EmbeddedFile, registerEmbeddedWebUi } from "./web-ui-files.js";

/** Known token used across auth tests */
const TEST_TOKEN = "a".repeat(64);
const TTF_MAGIC = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const PUBLIC_ASSET_CASES = [
	{ kind: "fonts", filename: "Test-Regular.ttf", body: TTF_MAGIC },
	{ kind: "sounds", filename: "Bell.wav", body: "RIFF....WAVEfmt " },
	{ kind: "wallpapers", filename: "Wallpaper.png", body: "fake-png" },
] as const;

/** Make every read of the token table throw, as a locked or closed database does. */
function failTokenStore(dbs: DatabaseManager) {
	const prepare = dbs.meta.prepare.bind(dbs.meta);
	return vi.spyOn(dbs.meta, "prepare").mockImplementation(((sql: string) => {
		if (sql.includes("FROM auth_tokens")) {
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		}
		return prepare(sql);
	}) as typeof dbs.meta.prepare);
}

/** The web UI the SEA serves, reduced to its page: what its catch-all route answers with. */
function webUiFiles(): ReadonlyMap<string, EmbeddedFile> {
	return new Map([
		["/index.html", { buf: Buffer.from("<html></html>"), contentType: "text/html" }],
	]);
}

/** GET a path exactly as written, over the socket, with no normalisation on the way. */
function rawGet(address: string, path: string): Promise<{ statusCode: number; body: string }> {
	const { port } = new URL(address);
	return new Promise((resolve, reject) => {
		const req = httpsRequest(
			{ host: "127.0.0.1", port, path, method: "GET", ca: getTestTls().cert },
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

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

	it("lets a served page connect back to this hub only", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });
		const response = await server.inject({ method: "GET", url: "/api/health" });
		const policy = String(response.headers["content-security-policy"]);
		const connectSrc = policy.split(";").find((d) => d.trim().startsWith("connect-src"));
		// Mutation caught: the ws: and wss: scheme sources allowed a socket to any
		// host; 'self' alone still covers the same-origin WebSocket (#210).
		expect(connectSrc?.trim()).toBe("connect-src 'self'");
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

	it("lets the primary through while the token store cannot be read, refuses other tokens with 503, and reports each outage once", async () => {
		const security: SecurityFields[] = [];
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			securityLog: new SecurityLog((_msg, fields) => security.push(fields)),
		});
		const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
		const errors = vi.spyOn(server.log, "error");
		const warnings = vi.spyOn(server.log, "warn");
		const request = (token: string) =>
			server.inject({
				method: "GET",
				url: "/api/unknown",
				headers: { authorization: `Bearer ${token}` },
			});

		const outage = failTokenStore(dbs);
		const primary = await request(TEST_TOKEN);
		const again = await request(TEST_TOKEN);
		const first = await request(paired.token);
		const second = await request(paired.token);
		outage.mockRestore();

		// The store has nothing to say about auth.json's token: it never expires and
		// cannot be revoked, so it is compared with the value the hub holds.
		expect(primary.statusCode).toBe(404);
		expect(again.statusCode).toBe(404);
		for (const response of [first, second]) {
			expect(response.statusCode).toBe(503);
			expect(response.json().error).toBe("AUTH_UNAVAILABLE");
		}
		expect(errors).toHaveBeenCalledTimes(1);
		// Nobody failed to authenticate: an outage is not a run of failures.
		expect(security.filter((fields) => fields.event === "auth.failure")).toEqual([]);
		expect(security.filter((fields) => fields.event === "auth.success")).toEqual([
			expect.objectContaining({ via: "rest", tokenId: "primary" }),
		]);

		// The store answers again: the outage closes, counting the two refusals only.
		expect((await request(paired.token)).statusCode).toBe(404);
		expect(warnings).toHaveBeenCalledWith({ refused: 2 }, expect.stringContaining("answering"));

		// An outage only the primary saw is still opened once and closed once.
		const lone = failTokenStore(dbs);
		expect((await request(TEST_TOKEN)).statusCode).toBe(404);
		lone.mockRestore();
		expect((await request(TEST_TOKEN)).statusCode).toBe(404);
		expect(errors).toHaveBeenCalledTimes(2);
		expect(warnings).toHaveBeenCalledWith({ refused: 0 }, expect.stringContaining("answering"));
	});

	it("names the primary as the credential that asked while the token store cannot be read", async () => {
		const security: SecurityFields[] = [];
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			securityLog: new SecurityLog((_msg, fields) => security.push(fields)),
		});
		const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });

		// Reads of the token table fail; the revocation's UPDATE still runs.
		const outage = failTokenStore(dbs);
		const response = await server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${paired.id}`,
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		outage.mockRestore();

		expect(response.statusCode).toBe(200);
		expect(security.filter((fields) => fields.event === "token.revoke")).toEqual([
			expect.objectContaining({ tokenId: paired.id, byTokenId: "primary", outcome: "revoked" }),
		]);
	});

	it("refuses a percent-encoded spelling of an /api route without the token", async () => {
		server = await bearerHub();
		const response = await server.inject({ method: "GET", url: "/%61pi/hosts" });
		expect(response.statusCode).toBe(401);
		expect(response.json().error).toBe("AUTH_REQUIRED");
	});

	it("refuses the asset token to a percent-encoded path without the bearer", async () => {
		server = await bearerHub();
		const response = await server.inject({ method: "GET", url: "/%61pi/assets/token" });
		expect(response.statusCode).toBe(401);
		expect(response.json().error).toBe("AUTH_REQUIRED");
		expect(response.json().assetToken).toBeUndefined();
	});

	it("serves a percent-encoded spelling of an /api route to the bearer", async () => {
		server = await bearerHub();
		const response = await server.inject({
			method: "GET",
			url: "/%61pi/hosts",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(response.statusCode).toBe(200);
		expect(Array.isArray(response.json())).toBe(true);
	});

	it("keeps /api/health open whatever its spelling", async () => {
		server = await bearerHub();
		const response = await server.inject({ method: "GET", url: "/%61pi/health" });
		expect(response.statusCode).toBe(200);
		expect(response.json().status).toBe("ok");
	});

	it.each(["quit", "shutdown"])(
		"leaves %s to its owner token whatever its spelling",
		async (route) => {
			server = await bearerHub();
			const response = await server.inject({ method: "POST", url: `/%61pi/${route}` });
			expect(response.statusCode).toBe(401);
			expect(response.json().error).toBe("OWNER_TOKEN_REQUIRED");
		},
	);

	it("leaves routes outside /api/ open whatever their spelling", async () => {
		server = await bearerHub();
		server.get("/probe-page", async () => "page");
		for (const url of ["/probe-page", "/%70robe-page"]) {
			const response = await server.inject({ method: "GET", url });
			expect(response.statusCode, url).toBe(200);
			expect(response.body).toBe("page");
		}
	});

	it("authenticates an unknown /api path under the web UI's catch-all", async () => {
		server = await bearerHub();
		registerEmbeddedWebUi(server, webUiFiles());
		const response = await server.inject({ method: "GET", url: "/api/unknown" });
		expect(response.statusCode).toBe(401);
		expect(response.json().error).toBe("AUTH_REQUIRED");
	});

	it("gates a protected asset prefix the web UI's catch-all would answer", async () => {
		server = await bearerHub();
		registerEmbeddedWebUi(server, webUiFiles());
		const response = await server.inject({ method: "GET", url: "/public/system-fonts" });
		expect(response.statusCode).toBe(403);
		expect(response.json().error.code).toBe("ASSET_TOKEN_REQUIRED");
	});

	it("never exempts a request the router gave to another route, over a real socket", async () => {
		server = await bearerHub();
		registerEmbeddedWebUi(server, webUiFiles());
		const address = await server.listen({ port: 0, host: "127.0.0.1" });
		// `inject` removes dot segments; a client on a socket does not have to. The
		// pathname reads /api/health, but the router hands the request to the catch-all.
		const response = await rawGet(address, "/api/x/../health");
		expect(response.statusCode).toBe(401);
		expect(JSON.parse(response.body).error).toBe("AUTH_REQUIRED");
	});

	it("refuses an Authorization header with more than a scheme and a token", async () => {
		server = await bearerHub();
		const response = await server.inject({
			method: "GET",
			url: "/api/hosts",
			headers: { authorization: `Bearer ${TEST_TOKEN} extra` },
		});
		expect(response.statusCode).toBe(401);
		expect(response.json().error).toBe("AUTH_REQUIRED");
	});

	it("records an agent route's refusal as a REST authentication failure", async () => {
		const security: SecurityFields[] = [];
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			securityLog: new SecurityLog((_msg, fields) => security.push(fields)),
		});
		const response = await server.inject({
			method: "GET",
			url: "/api/agents/targets",
			headers: { authorization: `Bearer ${"b".repeat(64)}` },
		});
		expect(response.statusCode).toBe(401);
		expect(response.json().error.code).toBe("AUTH_INVALID");
		expect(security.filter((fields) => fields.event === "auth.failure")).toEqual([
			expect.objectContaining({ via: "rest", reason: "invalid_token" }),
		]);
	});

	it("judges the primary alone on a hub built with no token store", async () => {
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			skipShellDiscovery: true,
		});
		const primary = await server.inject({
			method: "GET",
			url: "/api/assets/token",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		const other = await server.inject({
			method: "GET",
			url: "/api/assets/token",
			headers: { authorization: `Bearer ${"b".repeat(64)}` },
		});
		expect(primary.statusCode).toBe(200);
		expect(other.statusCode).toBe(401);
		expect(other.json().error).toBe("AUTH_INVALID");
	});

	/** A hub with the primary token and a token store, as `startHub` builds one. */
	function bearerHub(): Promise<FastifyInstance> {
		return createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});
	}

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
		for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
	});

	it("adds the actual bound loopback port so agent mutations are not blocked by Origin guard", async () => {
		const configDir = makeTempDir("lasterm-startup-cors-config-");
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
		if (configDir) await removeTempDir(configDir);
		server = undefined;
		dbs = undefined;
		configDir = undefined;
	});

	async function createProtectedAssetServer(
		kind: (typeof PUBLIC_ASSET_CASES)[number]["kind"],
		filename: string,
		body: Buffer | string,
	): Promise<string> {
		configDir = makeTempDir("lasterm-public-corp-");
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

	it.each(PUBLIC_ASSET_CASES)(
		"GET /public/$kind/:file serves signed public assets with same-origin CORP (#194)",
		async ({ kind, filename, body }) => {
			const assetToken = await createProtectedAssetServer(kind, filename, body);

			const response = await server?.inject({
				method: "GET",
				url: `/public/${kind}/${filename}?asset_token=${assetToken}`,
				headers: { origin: "tauri://localhost" },
			});

			expect(response?.statusCode).toBe(200);
			expect(response?.headers["cross-origin-resource-policy"]).toBe("same-origin");
		},
	);

	it.each(PUBLIC_ASSET_CASES)(
		"GET /public/$kind/:file rejects missing asset token",
		async ({ kind, filename, body }) => {
			await createProtectedAssetServer(kind, filename, body);

			const response = await server?.inject({
				method: "GET",
				url: `/public/${kind}/${filename}`,
				headers: { origin: "tauri://localhost" },
			});

			expect(response?.statusCode).toBe(403);
			expect(response?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");
		},
	);

	it.each(PUBLIC_ASSET_CASES)(
		"GET /public/$kind/:file rejects invalid asset token",
		async ({ kind, filename, body }) => {
			await createProtectedAssetServer(kind, filename, body);

			const response = await server?.inject({
				method: "GET",
				url: `/public/${kind}/${filename}?asset_token=bad-token`,
				headers: { origin: "tauri://localhost" },
			});

			expect(response?.statusCode).toBe(403);
			expect(response?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");
		},
	);

	it("GET /public/system-fonts/:file needs the asset token like every served asset (#100)", async () => {
		const assetToken = await createProtectedAssetServer("fonts", "unused.woff2", "x");

		const missing = await server?.inject({
			method: "GET",
			url: "/public/system-fonts/unknown.ttf",
		});
		expect(missing?.statusCode).toBe(403);
		expect(missing?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");

		// With the token the request reaches the route, which knows no such font.
		const signed = await server?.inject({
			method: "GET",
			url: `/public/system-fonts/unknown.ttf?asset_token=${assetToken}`,
		});
		expect(signed?.statusCode).toBe(404);
		expect(signed?.json<{ error: { code: string } }>().error.code).toBe("FONT_NOT_FOUND");
	});

	/**
	 * A hub as production starts it: a bearer and a token store (#194). Returns
	 * the asset token the browser would use, and a paired token besides the
	 * primary one.
	 */
	async function createAuthenticatedAssetServer(
		kind: (typeof PUBLIC_ASSET_CASES)[number]["kind"],
		filename: string,
		body: Buffer | string,
	): Promise<{ assetToken: string; paired: { id: string; token: string } }> {
		configDir = makeTempDir("lasterm-public-bearer-");
		mkdirSync(join(configDir, kind), { recursive: true });
		writeFileSync(join(configDir, kind, filename), body);
		dbs = openTestDatabases();
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			configDir,
			authToken: TEST_TOKEN,
		});
		const paired = createToken(dbs.meta, { label: "paired", expiresAt: null });
		const tokenRes = await server.inject({
			method: "GET",
			url: "/api/assets/token",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		return { assetToken: tokenRes.json<{ assetToken: string }>().assetToken, paired };
	}

	it.each(PUBLIC_ASSET_CASES)(
		"GET /public/$kind/:file serves the file to the bearer alone (#194)",
		async ({ kind, filename, body }) => {
			await createAuthenticatedAssetServer(kind, filename, body);

			const response = await server?.inject({
				method: "GET",
				url: `/public/${kind}/${filename}`,
				headers: { authorization: `Bearer ${TEST_TOKEN}` },
			});

			expect(response?.statusCode).toBe(200);
			expect(response?.rawPayload.equals(Buffer.from(body))).toBe(true);
		},
	);

	it("GET /public/system-fonts/:file reaches its route with the bearer alone (#194)", async () => {
		await createAuthenticatedAssetServer("fonts", "unused.woff2", "x");

		const response = await server?.inject({
			method: "GET",
			url: "/public/system-fonts/unknown.ttf",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});

		expect(response?.statusCode).toBe(404);
		expect(response?.json<{ error: { code: string } }>().error.code).toBe("FONT_NOT_FOUND");
	});

	it("GET /public/wallpapers/:file serves a paired bearer, not only the primary one (#194)", async () => {
		const { paired } = await createAuthenticatedAssetServer("wallpapers", "w.png", "png-bytes");

		const response = await server?.inject({
			method: "GET",
			url: "/public/wallpapers/w.png",
			headers: { authorization: `Bearer ${paired.token}` },
		});

		expect(response?.statusCode).toBe(200);
		expect(response?.body).toBe("png-bytes");
	});

	it("an asset token alone still opens /public on a hub with a bearer, with same-origin CORP (#194)", async () => {
		const { assetToken } = await createAuthenticatedAssetServer("wallpapers", "w.png", "png-bytes");

		const response = await server?.inject({
			method: "GET",
			url: `/public/wallpapers/w.png?asset_token=${assetToken}`,
			headers: { origin: "https://evil.example" },
		});

		expect(response?.statusCode).toBe(200);
		expect(response?.headers["cross-origin-resource-policy"]).toBe("same-origin");
	});

	it.each([
		["a wrong bearer", () => "Bearer wrong"],
		["another scheme", () => "Basic eDp5"],
	])("GET /public refuses %s with 401 (#194)", async (_case, header) => {
		await createAuthenticatedAssetServer("wallpapers", "w.png", "png-bytes");

		const response = await server?.inject({
			method: "GET",
			url: "/public/wallpapers/w.png",
			headers: { authorization: header() },
		});

		expect(response?.statusCode).toBe(401);
	});

	it("GET /public refuses a revoked paired bearer with 401 (#194)", async () => {
		const { paired } = await createAuthenticatedAssetServer("wallpapers", "w.png", "png-bytes");
		revokeToken(dbs?.meta as NonNullable<typeof dbs>["meta"], paired.id);

		const response = await server?.inject({
			method: "GET",
			url: "/public/wallpapers/w.png",
			headers: { authorization: `Bearer ${paired.token}` },
		});

		expect(response?.statusCode).toBe(401);
	});

	it("a bearer opens nothing on /public when the hub has no bearer configured (#194)", async () => {
		await createProtectedAssetServer("wallpapers", "w.png", "png-bytes");

		const response = await server?.inject({
			method: "GET",
			url: "/public/wallpapers/w.png",
			headers: { authorization: "Bearer anything" },
		});

		expect(response?.statusCode).toBe(403);
		expect(response?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");
	});

	it.each(["/unknown", "/public/other/x"])(
		"%s keeps answering without credentials on a hub with a bearer (#194)",
		async (path) => {
			await createAuthenticatedAssetServer("wallpapers", "w.png", "png-bytes");

			const response = await server?.inject({ method: "GET", url: path });

			expect(response?.statusCode).toBe(404);
		},
	);

	it("GET /public/system-fonts/:file needs the asset token whatever its spelling", async () => {
		const assetToken = await createProtectedAssetServer("fonts", "unused.woff2", "x");

		// The router decodes %73 to the system-font route; the gate must judge that route.
		const missing = await server?.inject({
			method: "GET",
			url: "/public/%73ystem-fonts/unknown.ttf",
		});
		expect(missing?.statusCode).toBe(403);
		expect(missing?.json<{ error: { code: string } }>().error.code).toBe("ASSET_TOKEN_REQUIRED");

		const signed = await server?.inject({
			method: "GET",
			url: `/public/%73ystem-fonts/unknown.ttf?asset_token=${assetToken}`,
		});
		expect(signed?.statusCode).toBe(404);
		expect(signed?.json<{ error: { code: string } }>().error.code).toBe("FONT_NOT_FOUND");
	});

	it("GET /api/health keeps Helmet's same-origin CORP", async () => {
		server = await createServer({ tls: getTestTls(), logger: false });

		const response = await server.inject({ method: "GET", url: "/api/health" });

		expect(response.statusCode).toBe(200);
		expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
	});
});

describe("Hub Server — listening", () => {
	/** A server whose `listen` refuses `refused` with EACCES, as Windows does a reserved port. */
	function refusingServer(refused: number) {
		const listen = vi.fn(async ({ port }: { host: string; port: number }) => {
			if (port === refused) {
				throw Object.assign(new Error(`listen EACCES: 127.0.0.1:${port}`), { code: "EACCES" });
			}
			return `https://127.0.0.1:${port === 0 ? 50_123 : port}`;
		});
		const info = vi.fn();
		return { server: { listen, log: { info } } as unknown as FastifyInstance, listen, info };
	}

	it("moves an explicit port past one the system refuses, and logs where it went (#573)", async () => {
		const { server, listen, info } = refusingServer(4100);
		await expect(startServer(server, { port: 4100 })).resolves.toBe("https://127.0.0.1:4101");
		expect(listen.mock.calls.map(([options]) => options)).toEqual([
			{ host: "127.0.0.1", port: 4100 },
			{ host: "127.0.0.1", port: 4101 },
		]);
		expect(info).toHaveBeenCalledWith(
			{ basePort: 4100, port: 4101 },
			"hub: port unavailable, using zero_conf port",
		);
	});

	it("leaves the port to the system when none is asked for, without the fallback", async () => {
		const { server, listen, info } = refusingServer(0);
		await expect(startServer(server)).rejects.toMatchObject({ code: "EACCES" });
		expect(listen.mock.calls.map(([options]) => options)).toEqual([{ host: "127.0.0.1", port: 0 }]);
		expect(info).not.toHaveBeenCalled();
	});
});
