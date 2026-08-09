import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken } from "../auth.js";
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

const TEST_TOKEN = "test-auth-token-for-token-management";

let dbs: DatabaseManager;
let server: FastifyInstance;

beforeEach(async () => {
	dbs = openTestDatabases();
	server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
		authToken: TEST_TOKEN,
		authConfig: { tokenTtlDays: 90 },
	});
});

afterEach(async () => {
	await server.close();
	dbs.close();
});

function authHeader() {
	return { authorization: `Bearer ${TEST_TOKEN}` };
}

// ─── GET /api/auth/tokens ────────────────────────────────────────────────────

describe("GET /api/auth/tokens", () => {
	it("returns 401 without auth", async () => {
		const res = await server.inject({ method: "GET", url: "/api/auth/tokens" });
		expect(res.statusCode).toBe(401);
	});

	it("returns a list with the primary token on startup", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: authHeader(),
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ tokens: Array<{ id: string; label: string }> }>();
		expect(Array.isArray(body.tokens)).toBe(true);
		// Primary token is always seeded
		const primary = body.tokens.find((t) => t.id === "primary");
		expect(primary).toBeDefined();
		expect(primary?.label).toBe("Primary");
	});

	it("does not expose token hashes", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: authHeader(),
		});
		const body = res.json<{ tokens: Array<Record<string, unknown>> }>();
		for (const token of body.tokens) {
			expect(token).not.toHaveProperty("token_hash");
			expect(token).not.toHaveProperty("tokenHash");
		}
	});

	it("includes tokens created via createToken", async () => {
		createToken(dbs.meta, { label: "My device", expiresAt: null });

		const res = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: authHeader(),
		});
		const body = res.json<{ tokens: Array<{ label: string }> }>();
		expect(body.tokens.some((t) => t.label === "My device")).toBe(true);
	});

	it("shows expires_at and revoked_at fields", async () => {
		const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
		const { id } = createToken(dbs.meta, { label: "expiring", expiresAt });

		const res = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: authHeader(),
		});
		const body = res.json<{
			tokens: Array<{ id: string; expires_at: string | null; revoked_at: string | null }>;
		}>();
		const found = body.tokens.find((t) => t.id === id);
		expect(found?.expires_at).toBe(expiresAt);
		expect(found?.revoked_at).toBeNull();
	});
});

// ─── DELETE /api/auth/tokens/:id ─────────────────────────────────────────────

describe("DELETE /api/auth/tokens/:id", () => {
	it("returns 401 without auth", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/auth/tokens/someid",
		});
		expect(res.statusCode).toBe(401);
	});

	it("revokes an active token and returns 200", async () => {
		const { id } = createToken(dbs.meta, { label: "to-revoke", expiresAt: null });

		const res = await server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${id}`,
			headers: authHeader(),
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ ok: boolean }>();
		expect(body.ok).toBe(true);
	});

	it("returns 404 for unknown token ID", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/auth/tokens/nonexistent",
			headers: authHeader(),
		});
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("TOKEN_NOT_FOUND");
	});

	it("returns 404 for already-revoked token", async () => {
		const { id } = createToken(dbs.meta, { label: "revoked", expiresAt: null });

		// Revoke once
		await server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${id}`,
			headers: authHeader(),
		});

		// Revoke again
		const res = await server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${id}`,
			headers: authHeader(),
		});
		expect(res.statusCode).toBe(404);
	});

	it("revoked token is rejected by auth hook", async () => {
		// Create a new token, use it to auth, then revoke it
		const { id, token: newToken } = createToken(dbs.meta, { label: "temp", expiresAt: null });

		// Verify it works before revocation
		const before = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: { authorization: `Bearer ${newToken}` },
		});
		expect(before.statusCode).toBe(200);

		// Revoke via primary token
		await server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${id}`,
			headers: authHeader(),
		});

		// Now the revoked token should be rejected
		const after = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: { authorization: `Bearer ${newToken}` },
		});
		expect(after.statusCode).toBe(401);
	});

	it("expired token is rejected by auth hook", async () => {
		const pastExpiry = new Date(Date.now() - 1000).toISOString();
		const { token: expiredToken } = createToken(dbs.meta, {
			label: "expired",
			expiresAt: pastExpiry,
		});

		const res = await server.inject({
			method: "GET",
			url: "/api/auth/tokens",
			headers: { authorization: `Bearer ${expiredToken}` },
		});
		expect(res.statusCode).toBe(401);
	});
});
