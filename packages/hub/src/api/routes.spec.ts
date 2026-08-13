import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../server.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.js";

// ─── Mock ssh-config-parser (controls readSshConfig in tests) ────────────────

vi.mock("../ssh/ssh-config-parser.js", () => ({
	readSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
	parseSshConfig: vi.fn(() => ({ entries: [], hasInclude: false })),
}));

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

// ─── Hosts ────────────────────────────────────────────────────────────────────

describe("GET /api/hosts", () => {
	it("returns at least the built-in local host", async () => {
		const res = await server.inject({ method: "GET", url: "/api/hosts" });
		expect(res.statusCode).toBe(200);
		const body = res.json<unknown[]>();
		expect(Array.isArray(body)).toBe(true);
		// ensureLocalHost creates a 'local' host on startup
		expect(body.length).toBeGreaterThanOrEqual(1);
	});
});

describe("POST /api/hosts", () => {
	it("creates a local host and returns 201", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "my-local" },
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<Record<string, unknown>>();
		expect(body.type).toBe("local");
		expect(body.label).toBe("my-local");
		expect(body.id).toBeTruthy();
		expect(body.created_at).toBeTruthy();
	});

	it("creates an SSH host with all fields and returns 201", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: {
				type: "ssh",
				label: "prod-server",
				ssh_host: "192.168.1.100",
				ssh_port: 2222,
				ssh_auth: "key",
				ssh_key_path: "/home/user/.ssh/id_ed25519",
				color: "#ff0000",
				trust_remote_hints: "ask",
			},
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<Record<string, unknown>>();
		expect(body.type).toBe("ssh");
		expect(body.label).toBe("prod-server");
		expect(body.ssh_host).toBe("192.168.1.100");
		expect(body.ssh_port).toBe(2222);
		expect(body.ssh_auth).toBe("key");
		expect(body.ssh_key_path).toBe("/home/user/.ssh/id_ed25519");
		expect(body.color).toBe("#ff0000");
		expect(body.trust_remote_hints).toBe("ask");
	});

	it("returns 400 when label is missing", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 when SSH host is missing ssh_host", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "ssh", label: "ssh-no-host" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 for invalid color format", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "color-bad", color: "notacolor" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 409 when label already exists", async () => {
		await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "duplicate-label" },
		});
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "duplicate-label" },
		});
		expect(res.statusCode).toBe(409);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("CONFLICT");
	});

	it("creates SSH host with os/arch and returns them in snake_case", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: {
				type: "ssh",
				label: "os-arch-host",
				ssh_host: "10.0.0.9",
				os: "linux",
				arch: "arm64",
			},
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<Record<string, unknown>>();
		expect(body.os).toBe("linux");
		expect(body.arch).toBe("arm64");
	});

	it("returns 400 for invalid os value", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "bad-os", os: "bsd" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 for invalid arch value", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "bad-arch", arch: "riscv" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("GET /api/hosts returns os/arch fields in snake_case", async () => {
		await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: {
				type: "ssh",
				label: "list-os-host",
				ssh_host: "10.0.0.10",
				os: "darwin",
				arch: "x64",
			},
		});
		const res = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = res.json<Array<Record<string, unknown>>>();
		const h = hosts.find((x) => x.label === "list-os-host");
		expect(h?.os).toBe("darwin");
		expect(h?.arch).toBe("x64");
	});
});

describe("GET /api/hosts/:id", () => {
	it("returns the host", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "get-test" },
		});
		const created = createRes.json<Record<string, unknown>>();

		const res = await server.inject({
			method: "GET",
			url: `/api/hosts/${created.id}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<Record<string, unknown>>();
		expect(body.id).toBe(created.id);
		expect(body.label).toBe("get-test");
	});

	it("returns 404 for unknown id", async () => {
		const res = await server.inject({ method: "GET", url: "/api/hosts/nonexistent" });
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});
});

describe("PUT /api/hosts/:id", () => {
	it("updates host fields", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "update-me" },
		});
		const created = createRes.json<Record<string, unknown>>();

		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${created.id}`,
			payload: { label: "updated-label", color: "#00ff00" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<Record<string, unknown>>();
		expect(body.label).toBe("updated-label");
		expect(body.color).toBe("#00ff00");
	});

	it("returns 404 for unknown id", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/hosts/nonexistent",
			payload: { label: "x" },
		});
		expect(res.statusCode).toBe(404);
	});

	it("updates arch field and returns 200", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "ssh", label: "arch-update", ssh_host: "10.0.0.11" },
		});
		const created = createRes.json<Record<string, unknown>>();
		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${created.id}`,
			payload: { arch: "arm64" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<Record<string, unknown>>();
		expect(body.arch).toBe("arm64");
	});

	it("returns 400 for invalid os on PUT", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "put-bad-os" },
		});
		const created = createRes.json<Record<string, unknown>>();
		const res = await server.inject({
			method: "PUT",
			url: `/api/hosts/${created.id}`,
			payload: { os: "bsd" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

describe("DELETE /api/hosts/:id", () => {
	it("deletes a host and returns 204", async () => {
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "delete-me" },
		});
		const created = createRes.json<Record<string, unknown>>();

		const res = await server.inject({
			method: "DELETE",
			url: `/api/hosts/${created.id}`,
		});
		expect(res.statusCode).toBe(204);

		const getRes = await server.inject({
			method: "GET",
			url: `/api/hosts/${created.id}`,
		});
		expect(getRes.statusCode).toBe(404);
	});

	it("returns 404 for unknown id", async () => {
		const res = await server.inject({ method: "DELETE", url: "/api/hosts/nonexistent" });
		expect(res.statusCode).toBe(404);
	});
});

// ─── Sessions ─────────────────────────────────────────────────────────────────

describe("GET /api/sessions", () => {
	it("returns an array (initially only sessions from ensureLocalHost flow)", async () => {
		const res = await server.inject({ method: "GET", url: "/api/sessions" });
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.json())).toBe(true);
	});

	it("filters by host_id", async () => {
		const hostsRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostsRes.json<Array<{ id: string }>>();
		const localHost = hosts[0];

		const res = await server.inject({
			method: "GET",
			url: `/api/sessions?host_id=${localHost?.id ?? "x"}`,
		});
		expect(res.statusCode).toBe(200);
		const sessions = res.json<Array<{ host_id: string }>>();
		for (const s of sessions) {
			expect(s.host_id).toBe(localHost?.id);
		}
	});
});

describe("GET /api/sessions/:id", () => {
	it("returns 404 for unknown session id", async () => {
		const res = await server.inject({ method: "GET", url: "/api/sessions/nonexistent" });
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("returns session with embedded channels array", async () => {
		// Create a host so we can seed a session via metaDal directly
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "session-get-test" },
		});
		const host = createRes.json<{ id: string }>();

		// Inject a session via the list endpoint path — use MetaDAL directly
		// via the server's sessionManager (accessible via the test db)
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		const sessionId = "01TESTSESSION0000000000001";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });

		const res = await server.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ id: string; status: string; channels: unknown[] }>();
		expect(body.id).toBe(sessionId);
		expect(body.status).toBe("active");
		expect(Array.isArray(body.channels)).toBe(true);
	});
});

describe("DELETE /api/sessions/:id", () => {
	it("returns 404 for unknown session id", async () => {
		const res = await server.inject({ method: "DELETE", url: "/api/sessions/nonexistent" });
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("closes an existing session and returns 204", async () => {
		// Create a host and seed a session
		const createRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "session-delete-test" },
		});
		const host = createRes.json<{ id: string }>();

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		const sessionId = "01TESTSESSION0000000000002";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });

		const res = await server.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
		expect(res.statusCode).toBe(204);

		// Session should now be closed in DB
		const session = dal.getSession(sessionId);
		expect(session?.status).toBe("closed");
	});
});

// ─── Channels ─────────────────────────────────────────────────────────────────

describe("GET /api/channels", () => {
	it("returns an array", async () => {
		const res = await server.inject({ method: "GET", url: "/api/channels" });
		expect(res.statusCode).toBe(200);
		expect(Array.isArray(res.json())).toBe(true);
	});

	it("filters by host_id without error", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/channels?host_id=nonexistent",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual([]);
	});
});

describe("GET /api/channels/:id", () => {
	it("returns 404 for unknown id", async () => {
		const res = await server.inject({ method: "GET", url: "/api/channels/nonexistent" });
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});
});

describe("PATCH /api/channels/:id", () => {
	let patchCounter = 0;

	async function createTestChannel(label: string): Promise<{ channelId: string }> {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		const host = hostRes.json<{ id: string }>();

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		patchCounter++;
		const n = String(patchCounter).padStart(3, "0");
		const sessionId = `01TSTPATCHSES0000000000${n}`;
		const channelId = `01TSTPATCHCHN0000000000${n}`;
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		dal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });

		return { channelId };
	}

	it("renames a channel", async () => {
		const { channelId } = await createTestChannel("patch-rename");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "My Shell" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ title: string }>();
		expect(body.title).toBe("My Shell");
	});

	it("trims whitespace from title before saving", async () => {
		const { channelId } = await createTestChannel("patch-trim");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "  Trimmed  " },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ title: string }>();
		expect(body.title).toBe("Trimmed");
	});

	it("resets title to null", async () => {
		const { channelId } = await createTestChannel("patch-null");

		// First give it a title
		await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "Temporary" },
		});

		// Now reset to null
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: null },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ title: unknown }>();
		expect(body.title).toBeUndefined();
	});

	it("rejects empty string", async () => {
		const { channelId } = await createTestChannel("patch-empty");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "" },
		});
		expect(res.statusCode).toBe(400);
		// Fastify schema validation: minLength: 1 rejects empty string
		const body = res.json<{ statusCode: number; message: string }>();
		expect(body.statusCode).toBe(400);
	});

	it("rejects whitespace-only string", async () => {
		const { channelId } = await createTestChannel("patch-ws");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "   " },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects title longer than 128 characters", async () => {
		const { channelId } = await createTestChannel("patch-toolong");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "x".repeat(129) },
		});
		expect(res.statusCode).toBe(400);
		// Fastify schema validation: maxLength: 128 rejects > 128 chars
		const body = res.json<{ statusCode: number; message: string }>();
		expect(body.statusCode).toBe(400);
	});

	it("rejects empty body (missing title field)", async () => {
		const { channelId } = await createTestChannel("patch-nobody");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: {},
		});
		expect(res.statusCode).toBe(400);
	});

	it("coerces non-string title (number) to string via Fastify schema coercion", async () => {
		// Fastify's default ajv config coerces numbers to strings before validation.
		// This documents the behavior: { title: 123 } becomes { title: "123" } and succeeds.
		const { channelId } = await createTestChannel("patch-numtitle");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: 123 },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ title: string }>();
		expect(body.title).toBe("123");
	});

	it("strips additional properties via Fastify removeAdditional (additionalProperties: false)", async () => {
		// Fastify's default ajv config with removeAdditional strips unknown fields
		// rather than rejecting them. This documents that behavior.
		const { channelId } = await createTestChannel("patch-extra");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: "valid", extra: "field" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ title: string }>();
		expect(body.title).toBe("valid");
	});

	it("coerces boolean title to string via Fastify/ajv coerceTypes", async () => {
		// Fastify's default ajv config (coerceTypes: true) coerces true → "true".
		// Same behavior as number coercion above.
		const { channelId } = await createTestChannel("patch-bool");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: true },
		});
		expect(res.statusCode).toBe(200); // Fastify/ajv coerces true to "true"
		const body = res.json<{ title: string }>();
		expect(body.title).toBe("true");
	});

	it("accepts null title (resets to default)", async () => {
		const { channelId } = await createTestChannel("patch-nullok");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { title: null },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ title: unknown }>();
		// title null → stored as null → serialized without the key (or as null/undefined)
		expect(body.title === null || body.title === undefined).toBe(true);
	});

	it("returns 404 for non-existent channel", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV",
			payload: { title: "Ghost" },
		});
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("returns 400 for invalid channel ID", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/channels/not-a-ulid",
			payload: { title: "Ghost" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

describe("DELETE /api/channels/:id", () => {
	let delCounter = 0;

	async function createTestChannel(label: string): Promise<{ channelId: string }> {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		const host = hostRes.json<{ id: string }>();

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		delCounter++;
		const n = String(delCounter).padStart(3, "0");
		const sessionId = `01TSTRMVSESS00000000000${n}`;
		const channelId = `01TSTRMVCHAN00000000000${n}`;
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		dal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });

		return { channelId };
	}

	it("returns 404 for unknown channel", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("returns 400 for invalid channel ID", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/channels/not-a-ulid",
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("marks a live channel as dead", async () => {
		const { channelId } = await createTestChannel("del-live");

		const res = await server.inject({
			method: "DELETE",
			url: `/api/channels/${channelId}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ ok: boolean }>();
		expect(body.ok).toBe(true);

		// Verify the channel is now dead in DB
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		const channel = dal.getChannel(channelId);
		expect(channel?.status).toBe("dead");
	});

	it("returns 200 for already-dead channel (idempotent)", async () => {
		const { channelId } = await createTestChannel("del-dead");

		// First delete
		await server.inject({ method: "DELETE", url: `/api/channels/${channelId}` });
		// Second delete — channel is now dead
		const res = await server.inject({
			method: "DELETE",
			url: `/api/channels/${channelId}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ ok: boolean }>();
		expect(body.ok).toBe(true);
	});
});

// ─── Groups ───────────────────────────────────────────────────────────────────

describe("GET /api/groups", () => {
	it("returns 400 without host_id query", async () => {
		const res = await server.inject({ method: "GET", url: "/api/groups" });
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 with invalid ULID host_id", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/groups?host_id=not-a-ulid",
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns empty array for host with no groups", async () => {
		const res = await server.inject({
			method: "GET",
			url: "/api/groups?host_id=01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual([]);
	});

	it("returns groups after creating one", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "grp-list-host" },
		});
		const host = hostRes.json<{ id: string }>();

		await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "My Group" },
		});

		const res = await server.inject({
			method: "GET",
			url: `/api/groups?host_id=${host.id}`,
		});
		expect(res.statusCode).toBe(200);
		const groups = res.json<Array<{ name: string; host_id: string }>>();
		expect(groups.length).toBe(1);
		expect(groups[0].name).toBe("My Group");
		expect(groups[0].host_id).toBe(host.id);
	});
});

describe("POST /api/groups", () => {
	it("returns 400 with missing name", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
		});
		expect(res.statusCode).toBe(400);
	});

	it("returns 400 with whitespace-only name", async () => {
		const res = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "   " },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 201 with valid body and correct snake_case response", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "grp-create-host" },
		});
		const host = hostRes.json<{ id: string }>();

		const res = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Dev Servers" },
		});
		expect(res.statusCode).toBe(201);
		const body = res.json<Record<string, unknown>>();
		expect(body.id).toBeTruthy();
		expect(body.host_id).toBe(host.id);
		expect(body.name).toBe("Dev Servers");
		expect(body.sort_order).toBe(0);
		expect(body.created_at).toBeTruthy();
	});

	it("auto-increments sort_order", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "grp-sort-host" },
		});
		const host = hostRes.json<{ id: string }>();

		const res1 = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "First" },
		});
		const res2 = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Second" },
		});

		expect(res1.json<Record<string, unknown>>().sort_order).toBe(0);
		expect(res2.json<Record<string, unknown>>().sort_order).toBe(1);
	});
});

describe("PATCH /api/groups/:id", () => {
	it("returns 404 for non-existent group", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/groups/01ARZ3NDEKTSV4RRFFQ69G5FAV",
			payload: { name: "Renamed" },
		});
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("returns 400 with whitespace-only name", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/groups/01ARZ3NDEKTSV4RRFFQ69G5FAV",
			payload: { name: "   " },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 for invalid ULID group ID", async () => {
		const res = await server.inject({
			method: "PATCH",
			url: "/api/groups/not-a-ulid",
			payload: { name: "Renamed" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 200 with valid rename", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "grp-rename-host" },
		});
		const host = hostRes.json<{ id: string }>();

		const createRes = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Original" },
		});
		const group = createRes.json<{ id: string }>();

		const res = await server.inject({
			method: "PATCH",
			url: `/api/groups/${group.id}`,
			payload: { name: "Renamed" },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ ok: boolean }>();
		expect(body.ok).toBe(true);
	});
});

describe("DELETE /api/groups/:id", () => {
	it("returns 404 for non-existent group", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/groups/01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		expect(res.statusCode).toBe(404);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("NOT_FOUND");
	});

	it("returns 400 for invalid ULID group ID", async () => {
		const res = await server.inject({
			method: "DELETE",
			url: "/api/groups/not-a-ulid",
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 200 for successful delete", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "grp-del-host" },
		});
		const host = hostRes.json<{ id: string }>();

		const createRes = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "ToDelete" },
		});
		const group = createRes.json<{ id: string }>();

		const res = await server.inject({
			method: "DELETE",
			url: `/api/groups/${group.id}`,
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ ok: boolean }>();
		expect(body.ok).toBe(true);
	});

	it("clears group_id on channels after delete", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "grp-del-chan-host" },
		});
		const host = hostRes.json<{ id: string }>();

		// Create group
		const groupRes = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Ephemeral" },
		});
		const group = groupRes.json<{ id: string }>();

		// Create a channel and assign it to the group
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		const sessionId = "01TESTGRPDELSESS000000001";
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		const channelId = "01TESTGRPDELCHAN000000001";
		dal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });
		dal.updateChannelGroupId(channelId, group.id);

		// Verify group_id is set
		const before = dal.getChannel(channelId);
		expect(before?.groupId).toBe(group.id);

		// Delete the group
		await server.inject({ method: "DELETE", url: `/api/groups/${group.id}` });

		// Verify group_id is now cleared
		const after = dal.getChannel(channelId);
		expect(after?.groupId).toBeUndefined();
	});
});

describe("PUT /api/groups/reorder", () => {
	it("returns 400 with invalid host_id ULID", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/groups/order",
			payload: { host_id: "not-a-ulid", group_ids: [] },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 when a group_id is not a valid ULID", async () => {
		const res = await server.inject({
			method: "PUT",
			url: "/api/groups/order",
			payload: { host_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", group_ids: ["not-a-ulid"] },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 400 when a group does not belong to the given host", async () => {
		// Create two hosts, create a group under host A, try to reorder it under host B
		const hostARes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "reorder-host-a" },
		});
		const hostA = hostARes.json<{ id: string }>();

		const hostBRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "reorder-host-b" },
		});
		const hostB = hostBRes.json<{ id: string }>();

		const grpRes = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: hostA.id, name: "Group A" },
		});
		const grp = grpRes.json<{ id: string }>();

		const res = await server.inject({
			method: "PUT",
			url: "/api/groups/order",
			payload: { host_id: hostB.id, group_ids: [grp.id] },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});

	it("returns 200 and persists new sort_order for reordered groups", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "reorder-sort-host" },
		});
		const host = hostRes.json<{ id: string }>();

		const g1Res = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Alpha" },
		});
		const g2Res = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Beta" },
		});
		const g3Res = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: host.id, name: "Gamma" },
		});
		const g1 = g1Res.json<{ id: string }>();
		const g2 = g2Res.json<{ id: string }>();
		const g3 = g3Res.json<{ id: string }>();

		// Reorder: Gamma, Alpha, Beta
		const reorderRes = await server.inject({
			method: "PUT",
			url: "/api/groups/order",
			payload: { host_id: host.id, group_ids: [g3.id, g1.id, g2.id] },
		});
		expect(reorderRes.statusCode).toBe(200);
		expect(reorderRes.json<{ ok: boolean }>().ok).toBe(true);

		// Verify order via GET /api/groups
		const listRes = await server.inject({
			method: "GET",
			url: `/api/groups?host_id=${host.id}`,
		});
		expect(listRes.statusCode).toBe(200);
		const groups = listRes.json<Array<{ id: string; name: string }>>();
		expect(groups.map((g) => g.name)).toEqual(["Gamma", "Alpha", "Beta"]);
	});

	it("returns 200 for empty group_ids array (no-op)", async () => {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label: "reorder-noop-host" },
		});
		const host = hostRes.json<{ id: string }>();

		const res = await server.inject({
			method: "PUT",
			url: "/api/groups/order",
			payload: { host_id: host.id, group_ids: [] },
		});
		expect(res.statusCode).toBe(200);
		expect(res.json<{ ok: boolean }>().ok).toBe(true);
	});
});

describe("PATCH /api/channels/:id — group_id", () => {
	let grpCounter = 0;

	async function createTestChannelForGroup(label: string): Promise<{ channelId: string }> {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		const host = hostRes.json<{ id: string }>();

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		grpCounter++;
		const n = String(grpCounter).padStart(3, "0");
		const sessionId = `01TSTGRPSESS00000000000${n}`;
		const channelId = `01TSTGRPCHAN00000000000${n}`;
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		dal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });

		return { channelId };
	}

	it("returns 200 when setting group_id on a channel", async () => {
		const { channelId } = await createTestChannelForGroup("grp-set");

		// Create a group to assign
		const hostRes = await server.inject({ method: "GET", url: "/api/hosts" });
		const hosts = hostRes.json<Array<{ id: string }>>();
		const groupRes = await server.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: hosts[0].id, name: "AssignGroup" },
		});
		const group = groupRes.json<{ id: string }>();

		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { group_id: group.id },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<{ group_id: string }>();
		expect(body.group_id).toBe(group.id);
	});

	it("returns 200 when clearing group_id to null", async () => {
		const { channelId } = await createTestChannelForGroup("grp-clear");

		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { group_id: null },
		});
		expect(res.statusCode).toBe(200);
		const body = res.json<Record<string, unknown>>();
		// group_id should be absent or null (cleared)
		expect(body.group_id === null || body.group_id === undefined).toBe(true);
	});

	it("returns 400 for invalid ULID group_id", async () => {
		const { channelId } = await createTestChannelForGroup("grp-bad-id");

		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}`,
			payload: { group_id: "not-a-ulid" },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── Auth enforcement ─────────────────────────────────────────────────────────

describe("Auth enforcement", () => {
	const TEST_TOKEN = "a".repeat(64); // 32 bytes hex
	let authServer: FastifyInstance;
	let authDbs: DatabaseManager;

	beforeEach(async () => {
		authDbs = openTestDatabases();
		authServer = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: authDbs,
			skipShellDiscovery: true,
			authToken: TEST_TOKEN,
		});
	});

	afterEach(async () => {
		await authServer.close();
		authDbs.close();
	});

	it("rejects protected route without Authorization header", async () => {
		const res = await authServer.inject({ method: "GET", url: "/api/hosts" });
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects GET /api/config/ui without auth", async () => {
		const res = await authServer.inject({ method: "GET", url: "/api/config/ui" });
		expect(res.statusCode).toBe(401);
	});

	it("rejects protected route with wrong token", async () => {
		const res = await authServer.inject({
			method: "GET",
			url: "/api/hosts",
			headers: { authorization: "Bearer wrong-token" },
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_INVALID");
	});

	it("accepts protected route with valid token", async () => {
		const res = await authServer.inject({
			method: "GET",
			url: "/api/hosts",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(res.statusCode).toBe(200);
	});

	it("bypasses auth for /api/health", async () => {
		const res = await authServer.inject({ method: "GET", url: "/api/health" });
		expect(res.statusCode).toBe(200);
		const body = res.json<{ status: string }>();
		expect(body.status).toBe("ok");
	});

	it("bypasses auth for /api/pair/verify", async () => {
		// POST with empty body → should get a validation/bad-request error, NOT 401
		const res = await authServer.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: {},
		});
		expect(res.statusCode).not.toBe(401);
	});

	it("rejects GET /api/fonts without auth", async () => {
		const res = await authServer.inject({ method: "GET", url: "/api/fonts" });
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects GET /api/wallpapers without auth", async () => {
		const res = await authServer.inject({ method: "GET", url: "/api/wallpapers" });
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects GET /api/assets/token without auth", async () => {
		const res = await authServer.inject({ method: "GET", url: "/api/assets/token" });
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects GET /api/groups without auth", async () => {
		const res = await authServer.inject({
			method: "GET",
			url: "/api/groups?host_id=01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects POST /api/groups without auth", async () => {
		const res = await authServer.inject({
			method: "POST",
			url: "/api/groups",
			payload: { host_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "NoAuth" },
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects PATCH /api/groups/:id without auth", async () => {
		const res = await authServer.inject({
			method: "PATCH",
			url: "/api/groups/01ARZ3NDEKTSV4RRFFQ69G5FAV",
			payload: { name: "NoAuth" },
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects DELETE /api/groups/:id without auth", async () => {
		const res = await authServer.inject({
			method: "DELETE",
			url: "/api/groups/01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects PATCH /api/channels/:id without auth", async () => {
		const res = await authServer.inject({
			method: "PATCH",
			url: "/api/channels/some-id",
			payload: { title: "No Auth" },
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});

	it("rejects DELETE /api/channels/:id without auth", async () => {
		const res = await authServer.inject({
			method: "DELETE",
			url: "/api/channels/01ARZ3NDEKTSV4RRFFQ69G5FAV",
		});
		expect(res.statusCode).toBe(401);
		const body = res.json<{ error: string }>();
		expect(body.error).toBe("AUTH_REQUIRED");
	});
});

// ─── Profile PATCH — merge behaviour ─────────────────────────────────────────

describe("PATCH /api/hosts/:id/profile — merge", () => {
	async function createHost(label: string): Promise<string> {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		return res.json<{ id: string }>().id;
	}

	it("merges new keys with existing profile instead of replacing", async () => {
		const hostId = await createHost("prof-host-merge");

		// Set initial profile
		await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { fontSize: 20 } },
		});

		// Patch a different key
		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { theme: "solarized" } },
		});
		expect(res.statusCode).toBe(200);

		const getRes = await server.inject({ method: "GET", url: `/api/hosts/${hostId}/profile` });
		const { profile } = getRes.json<{ profile: Record<string, unknown> }>();
		expect(profile.fontSize).toBe(20);
		expect(profile.theme).toBe("solarized");
	});

	it("removes a key when its value is null (reset to inherited)", async () => {
		const hostId = await createHost("prof-host-null");

		// Set both keys
		await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { theme: "solarized", fontSize: 20 } },
		});

		// Reset theme to null
		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { theme: null } },
		});
		expect(res.statusCode).toBe(200);

		const getRes = await server.inject({ method: "GET", url: `/api/hosts/${hostId}/profile` });
		const { profile } = getRes.json<{ profile: Record<string, unknown> }>();
		expect(profile.fontSize).toBe(20);
		expect("theme" in profile).toBe(false);
	});
});

describe("PATCH /api/channels/:id/profile — merge", () => {
	let profChanCounter = 0;

	async function createTestChannel(label: string): Promise<string> {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		const host = hostRes.json<{ id: string }>();

		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		profChanCounter++;
		const n = String(profChanCounter).padStart(3, "0");
		const sessionId = `01TSTPROFSES0000000000${n}`;
		const channelId = `01TSTPROFCHN0000000000${n}`;
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		dal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });
		return channelId;
	}

	it("merges new keys with existing profile instead of replacing", async () => {
		const channelId = await createTestChannel("prof-chan-merge");

		// Set initial profile
		await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}/profile`,
			payload: { profile: { fontSize: 16 } },
		});

		// Patch a different key
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}/profile`,
			payload: { profile: { cursorStyle: "bar" } },
		});
		expect(res.statusCode).toBe(200);

		const getRes = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/profile`,
		});
		const { profile } = getRes.json<{ profile: Record<string, unknown> }>();
		expect(profile.fontSize).toBe(16);
		expect(profile.cursorStyle).toBe("bar");
	});

	it("removes a key when its value is null (reset to inherited)", async () => {
		const channelId = await createTestChannel("prof-chan-null");

		// Set both keys
		await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}/profile`,
			payload: { profile: { cursorStyle: "bar", fontSize: 16 } },
		});

		// Reset cursorStyle to null
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}/profile`,
			payload: { profile: { cursorStyle: null } },
		});
		expect(res.statusCode).toBe(200);

		const getRes = await server.inject({
			method: "GET",
			url: `/api/channels/${channelId}/profile`,
		});
		const { profile } = getRes.json<{ profile: Record<string, unknown> }>();
		expect(profile.fontSize).toBe(16);
		expect("cursorStyle" in profile).toBe(false);
	});
});

// ─── PATCH /api/hosts/:id/profile — TERMINAL_PROFILE_KEYS validation ──────────

describe("PATCH /api/hosts/:id/profile — key validation", () => {
	async function createHost(label: string): Promise<string> {
		const res = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		return res.json<{ id: string }>().id;
	}

	it("accepts known terminal profile keys", async () => {
		const hostId = await createHost("prof-key-valid");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { fontSize: 14, fontFamily: "Fira Code", cursorStyle: "bar" } },
		});
		expect(res.statusCode).toBe(200);
	});

	it("accepts and persists background mode and window effect keys", async () => {
		const hostId = await createHost("prof-key-bg-valid");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { backgroundMode: "transparent", windowEffect: "auto" } },
		});
		expect(res.statusCode).toBe(200);

		const getRes = await server.inject({
			method: "GET",
			url: `/api/hosts/${hostId}/profile`,
		});
		expect(getRes.statusCode).toBe(200);
		const { profile } = getRes.json<{ profile: Record<string, unknown> }>();
		expect(profile.backgroundMode).toBe("transparent");
		expect(profile.windowEffect).toBe("auto");
	});

	it("rejects unknown profile keys with 400", async () => {
		const hostId = await createHost("prof-key-invalid");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { unknownKey: "value" } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string; message: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
		expect(body.error.message).toContain("unknownKey");
	});

	it("rejects a mix of known and unknown keys", async () => {
		const hostId = await createHost("prof-key-mixed");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/hosts/${hostId}/profile`,
			payload: { profile: { fontSize: 12, injected: "evil" } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
	});
});

// ─── PATCH /api/channels/:id/profile — TERMINAL_PROFILE_KEYS validation ───────

describe("PATCH /api/channels/:id/profile — key validation", () => {
	let profChanCounter = 0;

	async function createTestChannelForProfKey(label: string): Promise<string> {
		const hostRes = await server.inject({
			method: "POST",
			url: "/api/hosts",
			payload: { type: "local", label },
		});
		const host = hostRes.json<{ id: string }>();
		const { MetaDAL } = await import("../storage/meta.js");
		const dal = new MetaDAL(dbs.meta);
		profChanCounter++;
		const n = String(profChanCounter).padStart(3, "0");
		const sessionId = `01TSTPKVSESS00000000000${n}`;
		const channelId = `01TSTPKVCHAN00000000000${n}`;
		dal.createSession({ id: sessionId, hostId: host.id, status: "active" });
		dal.createChannel({ id: channelId, sessionId, status: "live", cols: 80, rows: 24 });
		return channelId;
	}

	it("accepts known terminal profile keys for channel", async () => {
		const channelId = await createTestChannelForProfKey("chan-prof-key-valid");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}/profile`,
			payload: { profile: { scrollback: 5000, theme: "dracula" } },
		});
		expect(res.statusCode).toBe(200);
	});

	it("rejects unknown profile keys for channel with 400", async () => {
		const channelId = await createTestChannelForProfKey("chan-prof-key-invalid");
		const res = await server.inject({
			method: "PATCH",
			url: `/api/channels/${channelId}/profile`,
			payload: { profile: { bogusKey: 42 } },
		});
		expect(res.statusCode).toBe(400);
		const body = res.json<{ error: { code: string; message: string } }>();
		expect(body.error.code).toBe("VALIDATION_ERROR");
		expect(body.error.message).toContain("bogusKey");
	});
});

// ─── POST /api/hosts/import — sshAuth set from identityFile (kept as-is) ─────

describe("POST /api/hosts/import — sshAuth inferred from identityFile (kept as-is)", () => {
	it("sets sshAuth to 'key' when identityFile is present in SSH config entry", async () => {
		const { readSshConfig } = await import("../ssh/ssh-config-parser.js");
		vi.mocked(readSshConfig).mockReturnValueOnce({
			entries: [
				{
					name: "myserver",
					hostname: "10.0.0.1",
					port: 22,
					user: "deploy",
					identityFile: "/home/user/.ssh/id_ed25519",
					proxyJump: null,
					isGitHost: false,
				},
			],
			hasInclude: false,
		});

		const res = await server.inject({
			method: "POST",
			url: "/api/hosts/import",
			payload: {
				entries: [{ name: "myserver", label: "my-server" }],
			},
		});

		expect(res.statusCode).toBe(201);
		const hosts = res.json<Array<{ ssh_auth: string; ssh_key_path: string }>>();
		expect(hosts[0].ssh_auth).toBe("key");
		expect(hosts[0].ssh_key_path).toBe("/home/user/.ssh/id_ed25519");
	});

	it("does not set sshAuth when identityFile is absent", async () => {
		const { readSshConfig } = await import("../ssh/ssh-config-parser.js");
		vi.mocked(readSshConfig).mockReturnValueOnce({
			entries: [
				{
					name: "nokey",
					hostname: "10.0.0.2",
					port: 22,
					user: "admin",
					identityFile: null,
					proxyJump: null,
					isGitHost: false,
				},
			],
			hasInclude: false,
		});

		const res = await server.inject({
			method: "POST",
			url: "/api/hosts/import",
			payload: {
				entries: [{ name: "nokey", label: "no-key-host" }],
			},
		});

		expect(res.statusCode).toBe(201);
		const hosts = res.json<Array<{ ssh_auth: string | null }>>();
		// ssh_auth should be null/undefined (not set to "key")
		expect(hosts[0].ssh_auth == null).toBe(true);
	});
});
