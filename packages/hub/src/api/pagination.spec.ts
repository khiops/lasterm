import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../ssh/ssh-config-parser.js", () => ({
	readSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
	parseSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
}));

vi.mock("ssh2", () => ({
	Client: vi.fn().mockImplementation(() =>
		Object.assign(new EventEmitter(), {
			connect: vi.fn(),
			end: vi.fn(),
			destroy: vi.fn(),
		}),
	),
}));

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

// ─── Setup ────────────────────────────────────────────────────────────────────

let dbs: DatabaseManager;
let server: FastifyInstance;

beforeEach(async () => {
	dbs = openTestDatabases();
	server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
	});
});

afterEach(async () => {
	await server.close();
	dbs.close();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createHost(label: string): Promise<string> {
	const res = await server.inject({
		method: "POST",
		url: "/api/hosts",
		payload: { type: "ssh", label, ssh_host: "example.com", ssh_auth: "password" },
	});
	expect(res.statusCode).toBe(201);
	return (res.json() as { id: string }).id;
}

async function createHostGroup(name: string): Promise<string> {
	const res = await server.inject({
		method: "POST",
		url: "/api/host-groups",
		payload: { name },
	});
	expect(res.statusCode).toBe(201);
	return (res.json() as { id: string }).id;
}

async function createLaunchProfile(name: string): Promise<string> {
	const res = await server.inject({
		method: "POST",
		url: "/api/launch-profiles",
		payload: { name, shell: "/bin/bash" },
	});
	expect(res.statusCode).toBe(201);
	return (res.json() as { id: string }).id;
}

// ─── GET /api/hosts — pagination ─────────────────────────────────────────────

describe("GET /api/hosts pagination", () => {
	it("returns plain array when no pagination params", async () => {
		await createHost("host-a");
		await createHost("host-b");
		const res = await server.inject({ method: "GET", url: "/api/hosts" });
		expect(res.statusCode).toBe(200);
		const body = res.json();
		// Backward-compat: plain array (includes local host created by default)
		expect(Array.isArray(body)).toBe(true);
	});

	it("returns paginated envelope when limit is provided", async () => {
		await createHost("host-p1");
		await createHost("host-p2");
		await createHost("host-p3");
		const res = await server.inject({ method: "GET", url: "/api/hosts?limit=2" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ data: unknown[]; total: number; limit: number; offset: number }>();
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data).toHaveLength(2);
		expect(typeof body.total).toBe("number");
		expect(body.total).toBeGreaterThanOrEqual(3);
		expect(body.limit).toBe(2);
		expect(body.offset).toBe(0);
	});

	it("respects offset in paginated response", async () => {
		await createHost("host-q1");
		await createHost("host-q2");
		await createHost("host-q3");

		const page1 = await server.inject({ method: "GET", url: "/api/hosts?limit=2&offset=0" });
		const page2 = await server.inject({ method: "GET", url: "/api/hosts?limit=2&offset=2" });

		expect(page1.statusCode).toBe(200);
		expect(page2.statusCode).toBe(200);

		const b1 = page1.json<{ data: { id: string }[]; total: number }>();
		const b2 = page2.json<{ data: { id: string }[]; total: number }>();

		expect(b1.total).toBe(b2.total);
		// Pages must be disjoint
		const ids1 = new Set(b1.data.map((h) => h.id));
		const ids2 = new Set(b2.data.map((h) => h.id));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}
	});

	it("returns empty data array when offset exceeds total", async () => {
		await createHost("host-r1");
		const res = await server.inject({ method: "GET", url: "/api/hosts?limit=10&offset=9999" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ data: unknown[] }>();
		expect(body.data).toHaveLength(0);
	});

	it("rejects invalid limit", async () => {
		const res = await server.inject({ method: "GET", url: "/api/hosts?limit=0" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects negative offset", async () => {
		const res = await server.inject({ method: "GET", url: "/api/hosts?limit=10&offset=-1" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── GET /api/host-groups — pagination ───────────────────────────────────────

describe("GET /api/host-groups pagination", () => {
	it("returns plain array when no pagination params", async () => {
		await createHostGroup("grp-a");
		const res = await server.inject({ method: "GET", url: "/api/host-groups" });
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.json())).toBe(true);
	});

	it("returns paginated envelope when limit is provided", async () => {
		await createHostGroup("grp-p1");
		await createHostGroup("grp-p2");
		await createHostGroup("grp-p3");
		const res = await server.inject({ method: "GET", url: "/api/host-groups?limit=2" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ data: unknown[]; total: number; limit: number; offset: number }>();
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data).toHaveLength(2);
		expect(body.total).toBeGreaterThanOrEqual(3);
		expect(body.limit).toBe(2);
		expect(body.offset).toBe(0);
	});

	it("respects offset in paginated response", async () => {
		await createHostGroup("grp-q1");
		await createHostGroup("grp-q2");
		await createHostGroup("grp-q3");

		const page1 = await server.inject({
			method: "GET",
			url: "/api/host-groups?limit=2&offset=0",
		});
		const page2 = await server.inject({
			method: "GET",
			url: "/api/host-groups?limit=2&offset=2",
		});

		const b1 = page1.json<{ data: { id: string }[] }>();
		const b2 = page2.json<{ data: { id: string }[] }>();

		const ids1 = new Set(b1.data.map((g) => g.id));
		const ids2 = new Set(b2.data.map((g) => g.id));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}
	});

	it("rejects invalid limit", async () => {
		const res = await server.inject({ method: "GET", url: "/api/host-groups?limit=abc" });
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── GET /api/launch-profiles — pagination ───────────────────────────────────

describe("GET /api/launch-profiles pagination", () => {
	it("returns plain array when no pagination params", async () => {
		await createLaunchProfile("lp-a");
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles" });
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.json())).toBe(true);
	});

	it("returns paginated envelope when limit is provided", async () => {
		await createLaunchProfile("lp-p1");
		await createLaunchProfile("lp-p2");
		await createLaunchProfile("lp-p3");
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles?limit=2" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ data: unknown[]; total: number; limit: number; offset: number }>();
		expect(Array.isArray(body.data)).toBe(true);
		expect(body.data).toHaveLength(2);
		expect(body.total).toBe(3);
		expect(body.limit).toBe(2);
		expect(body.offset).toBe(0);
	});

	it("respects offset in paginated response", async () => {
		await createLaunchProfile("lp-q1");
		await createLaunchProfile("lp-q2");
		await createLaunchProfile("lp-q3");

		const page1 = await server.inject({
			method: "GET",
			url: "/api/launch-profiles?limit=2&offset=0",
		});
		const page2 = await server.inject({
			method: "GET",
			url: "/api/launch-profiles?limit=2&offset=2",
		});

		const b1 = page1.json<{ data: { id: string }[] }>();
		const b2 = page2.json<{ data: { id: string }[] }>();

		expect(b1.data).toHaveLength(2);
		expect(b2.data).toHaveLength(1);

		const ids1 = new Set(b1.data.map((p) => p.id));
		const ids2 = new Set(b2.data.map((p) => p.id));
		for (const id of ids2) {
			expect(ids1.has(id)).toBe(false);
		}
	});

	it("returns empty data when offset exceeds total", async () => {
		await createLaunchProfile("lp-r1");
		const res = await server.inject({
			method: "GET",
			url: "/api/launch-profiles?limit=10&offset=9999",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ data: unknown[]; total: number }>();
		expect(body.data).toHaveLength(0);
		expect(body.total).toBe(1);
	});

	it("rejects limit > 1000", async () => {
		const res = await server.inject({ method: "GET", url: "/api/launch-profiles?limit=1001" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});
