import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.fixture.js";
import { LIMIT_ERROR, OFFSET_ERROR, parsePagination } from "./pagination.js";

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

/** A whole hub server, for the describes that test a route through one. */
function useHubServer(): void {
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
}

// ─── parsePagination — the one reading of ?limit=&offset= ────────────────────
//
// Every rule asserted here, so a broken one fails under its own name. Each
// route that pages keeps one test below proving it consults the parser; the
// two log routes keep theirs in logs.spec.ts.

describe("parsePagination", () => {
	/** What the parser gives for a query whose values are refused. */
	const refused = (message: string) => ({
		ok: false,
		error: { code: "VALIDATION_ERROR", message },
	});

	it("gives no limit and offset 0 when the query names neither", () => {
		expect(parsePagination({})).toEqual({ ok: true, limit: undefined, offset: 0 });
	});

	it.each([
		["1", 1],
		["1000", 1000],
		["0010", 10],
	])("accepts limit=%s", (raw, limit) => {
		expect(parsePagination({ limit: raw })).toEqual({ ok: true, limit, offset: 0 });
	});

	it.each([
		["0", "below the range"],
		["1001", "above the range"],
		["99999999999999999999", "huge"],
		["-1", "negative"],
		["abc", "not a number"],
		["10abc", "a number with trailing text"],
		["1.5", "a float"],
		["1e3", "an exponent"],
		["+5", "a sign"],
		[" 5", "whitespace"],
		["", "empty"],
	])("refuses limit=%j (%s)", (raw) => {
		expect(parsePagination({ limit: raw })).toEqual(refused(LIMIT_ERROR));
	});

	it.each([
		["0", 0],
		["1", 1],
		["9007199254740991", Number.MAX_SAFE_INTEGER],
	])("accepts offset=%s", (raw, offset) => {
		expect(parsePagination({ limit: "10", offset: raw })).toEqual({ ok: true, limit: 10, offset });
	});

	it.each([
		["-1", "negative"],
		["9007199254740992", "one past the largest exact integer"],
		["99999999999999999999", "huge: SQLite cannot bind it"],
		["abc", "not a number"],
		["2xyz", "a number with trailing text"],
		["1.5", "a float"],
		["", "empty"],
	])("refuses offset=%j (%s)", (raw) => {
		expect(parsePagination({ limit: "10", offset: raw })).toEqual(refused(OFFSET_ERROR));
	});

	it("reads an offset given without a limit", () => {
		expect(parsePagination({ offset: "3" })).toEqual({ ok: true, limit: undefined, offset: 3 });
		expect(parsePagination({ offset: "-1" })).toEqual(refused(OFFSET_ERROR));
	});

	it("refuses a parameter given twice, which arrives as an array", () => {
		expect(parsePagination({ limit: ["1", "2"] })).toEqual(refused(LIMIT_ERROR));
		expect(parsePagination({ limit: "1", offset: ["0", "1"] })).toEqual(refused(OFFSET_ERROR));
	});

	it("names the limit when both are refused", () => {
		expect(parsePagination({ limit: "0", offset: "-1" })).toEqual(refused(LIMIT_ERROR));
	});

	it("states the range it enforces", () => {
		expect(LIMIT_ERROR).toBe("limit must be an integer from 1 to 1000");
		expect(OFFSET_ERROR).toBe("offset must be an integer from 0 to 9007199254740991");
	});
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The one test each paging route keeps: a query the parser refuses gets 400
 * and the parser's own error, not a copy of it, and one it accepts gets a page.
 * Before #530, /api/hosts and /api/launch-profiles answered the refusal with 200.
 */
async function expectRouteConsultsParser(path: string): Promise<void> {
	const refusedPage = parsePagination({ limit: "0" });
	if (refusedPage.ok) throw new Error("parsePagination accepts limit=0");

	const refused = await server.inject({ method: "GET", url: `${path}?limit=0` });
	expect(refused.statusCode).toBe(400);
	expect(refused.json()).toEqual({ error: refusedPage.error });

	const accepted = await server.inject({ method: "GET", url: `${path}?limit=1000&offset=1` });
	expect(accepted.statusCode).toBe(200);
	expect(accepted.json()).toMatchObject({ limit: 1000, offset: 1 });
}

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
	useHubServer();

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

	it("answers a query parsePagination refuses with 400 and its error (#530)", async () => {
		await expectRouteConsultsParser("/api/hosts");
	});
});

// ─── GET /api/host-groups — pagination ───────────────────────────────────────

describe("GET /api/host-groups pagination", () => {
	useHubServer();

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

	it("answers a query parsePagination refuses with 400 and its error (#530)", async () => {
		await expectRouteConsultsParser("/api/host-groups");
	});
});

// ─── GET /api/launch-profiles — pagination ───────────────────────────────────

describe("GET /api/launch-profiles pagination", () => {
	useHubServer();

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

	it("answers a query parsePagination refuses with 400 and its error (#530)", async () => {
		await expectRouteConsultsParser("/api/launch-profiles");
	});
});
