import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnectionOutcome } from "../session/session-manager.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { readHostConnectionBody, registerHostConnectionRoutes } from "./host-connection.js";

const WINDOW_ID = "01K6480000000000000000WNDW";

// ─── The body ────────────────────────────────────────────────────────────────

describe("readHostConnectionBody (#648)", () => {
	it("reads no body as nothing asked", () => {
		expect(readHostConnectionBody(undefined)).toEqual({ force: false });
		expect(readHostConnectionBody(null)).toEqual({ force: false });
		expect(readHostConnectionBody({})).toEqual({ force: false });
	});

	it("refuses a body that is not an object", () => {
		for (const body of ["force", 1, [], [true]]) {
			expect(readHostConnectionBody(body)).toEqual({ error: "The body must be a JSON object." });
		}
	});

	it("takes force as a boolean only: nothing else says to end someone's terminals", () => {
		expect(readHostConnectionBody({ force: true })).toEqual({ force: true });
		expect(readHostConnectionBody({ force: false })).toEqual({ force: false });
		for (const force of ["true", 1, "yes", null]) {
			expect(readHostConnectionBody({ force })).toEqual({ error: "force must be true or false." });
		}
	});

	it("takes client_id as a window's id only", () => {
		expect(readHostConnectionBody({ client_id: WINDOW_ID })).toEqual({
			force: false,
			clientId: WINDOW_ID,
		});
		for (const clientId of ["c-window", 7, "", null]) {
			expect(readHostConnectionBody({ client_id: clientId })).toEqual({
				error: "client_id must be the id AUTH_OK gave this window.",
			});
		}
	});

	it("ignores what it does not know", () => {
		expect(readHostConnectionBody({ mode: "gently", force: true })).toEqual({ force: true });
	});
});

// ─── The routes ──────────────────────────────────────────────────────────────

let dbs: DatabaseManager;
let server: FastifyInstance;
let sshHostId: string;
let localHostId: string;
const manager = {
	connectHost: vi.fn<(hostId: string, options?: object) => HostConnectionOutcome>(),
	reconnectHost: vi.fn<(hostId: string, options?: object) => HostConnectionOutcome>(),
	disconnectHost: vi.fn<(hostId: string, options?: object) => HostConnectionOutcome>(),
};

beforeEach(async () => {
	dbs = openTestDatabases();
	const metaDal = new MetaDAL(dbs.meta);
	sshHostId = metaDal.createHost({ type: "ssh", label: "pi", sshHost: "pi@pi.local" }).id;
	localHostId = metaDal.createHost({ type: "local", label: "local" }).id;
	for (const fn of Object.values(manager)) fn.mockReset();
	server = Fastify({ logger: false });
	registerHostConnectionRoutes(server, metaDal, manager);
	await server.ready();
});

afterEach(async () => {
	await server.close();
	dbs.close();
});

function post(action: string, hostId: string, payload?: unknown) {
	return server.inject({
		method: "POST",
		url: `/api/hosts/${hostId}/${action}`,
		...(payload !== undefined && { payload: payload as object }),
	});
}

describe("POST /api/hosts/:id/connect|reconnect|disconnect (#648)", () => {
	it.each(["connect", "reconnect", "disconnect"])(
		"%s reads its body through readHostConnectionBody: refused, 400; accepted, it reaches the hub",
		async (action) => {
			const refused = await post(action, sshHostId, { force: "yes" });
			expect(refused.statusCode).toBe(400);
			expect(refused.json()).toEqual({
				error: { code: "VALIDATION_ERROR", message: "force must be true or false." },
			});
			expect(Object.values(manager).some((fn) => fn.mock.calls.length > 0)).toBe(false);

			for (const fn of Object.values(manager)) {
				fn.mockReturnValue({ kind: "disconnected", ended: 0 });
			}
			const accepted = await post(action, sshHostId, { force: true, client_id: WINDOW_ID });
			expect(accepted.statusCode).toBe(200);
			const called = {
				connect: manager.connectHost,
				reconnect: manager.reconnectHost,
				disconnect: manager.disconnectHost,
			}[action];
			expect(called?.mock.calls).toEqual([
				[
					sshHostId,
					{
						connect: { clientId: WINDOW_ID },
						reconnect: { force: true, clientId: WINDOW_ID },
						disconnect: { force: true },
					}[action],
				],
			]);
		},
	);

	it.each(["connect", "reconnect", "disconnect"])(
		"%s refuses a host it has never heard of",
		async (action) => {
			const res = await post(action, "01HZZZZZZZZZZZZZZZZZZZZZZZ");
			expect(res.statusCode).toBe(404);
			expect(res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Host not found" } });
		},
	);

	it("answers 202 while connecting, the terminals a reconnect ended with it", async () => {
		manager.reconnectHost.mockReturnValue({
			kind: "connecting",
			ended: 2,
			done: Promise.resolve(true),
		});
		const res = await post("reconnect", sshHostId, { force: true });
		expect(res.statusCode).toBe(202);
		expect(res.json()).toEqual({ status: "connecting", ended: 2 });
	});

	it("answers 200 for a host connected already", async () => {
		manager.connectHost.mockReturnValue({ kind: "connected" });
		const res = await post("connect", sshHostId);
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ status: "connected" });
	});

	it("answers 409 with how many terminals would end, when not told to end them", async () => {
		manager.disconnectHost.mockReturnValue({ kind: "terminals-would-end", terminals: 3 });
		const res = await post("disconnect", sshHostId);
		expect(res.statusCode).toBe(409);
		expect(res.json()).toEqual({
			error: {
				code: "TERMINALS_WOULD_END",
				message: "3 terminals on this host would end. Send force: true to end them.",
				terminals: 3,
			},
		});
	});

	it("answers 400 for the local host, which has no connection to act on", async () => {
		manager.connectHost.mockReturnValue({ kind: "not-ssh" });
		const res = await post("connect", localHostId);
		expect(res.statusCode).toBe(400);
		expect(res.json()).toMatchObject({ error: { code: "NOT_SSH_HOST" } });
	});

	it("answers 409 while the hub quits", async () => {
		manager.disconnectHost.mockReturnValue({ kind: "quitting" });
		const res = await post("disconnect", sshHostId);
		expect(res.statusCode).toBe(409);
		expect(res.json()).toMatchObject({ error: { code: "HUB_QUITTING" } });
	});
});
