import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "./cli.js";
import { createServer, startServer } from "./server.js";
import {
	createQuitLifecycle,
	gracefulShutdown,
	QuitCoordinator,
	resetGracefulShutdownForTests,
} from "./shutdown.js";
import type { DatabaseManager } from "./storage/db.js";
import { openTestDatabases } from "./storage/db.js";

const TEST_TOKEN = "a".repeat(64);
const OWNER_TOKEN = "b".repeat(64);

describe("gracefulShutdown", () => {
	afterEach(() => {
		resetGracefulShutdownForTests();
	});

	it("is idempotent and tears down server, DB, runtime, then exits", async () => {
		const server = Fastify({ logger: false });
		const dbs = openTestDatabases();
		const order: string[] = [];
		const exits: number[] = [];

		server.addHook("onClose", async () => {
			order.push("server.close");
		});
		await server.ready();

		const close = dbs.close.bind(dbs);
		const closeSpy = vi.spyOn(dbs, "close").mockImplementation(() => {
			order.push("db.close");
			close();
		});

		const options = {
			server,
			dbManager: dbs,
			runtime: runtimeRecord(),
			deleteRuntime: () => {
				order.push("runtime.delete");
				return true;
			},
			exit: (code: number) => {
				order.push(`exit:${code}`);
				exits.push(code);
			},
			timeoutMs: 1_000,
		};

		const first = gracefulShutdown(options);
		const second = gracefulShutdown(options);

		expect(second).toBe(first);
		await first;

		expect(order).toEqual(["server.close", "db.close", "runtime.delete", "exit:0"]);
		expect(exits).toEqual([0]);
		expect(closeSpy).toHaveBeenCalledTimes(1);
	});

	it("deletes runtime and exits nonzero when server.close hangs", async () => {
		const server = Fastify({ logger: false });
		const dbs = openTestDatabases();
		const dir = mkdtempSync(join(tmpdir(), "lasterm-shutdown-"));
		const runtimePath = join(dir, "runtime.json");
		const exits: number[] = [];

		writeFileSync(runtimePath, "{}");
		server.addHook("onClose", () => new Promise<void>(() => {}));
		await server.ready();

		await gracefulShutdown({
			server,
			dbManager: dbs,
			runtime: runtimeRecord(),
			deleteRuntime: () => {
				rmSync(runtimePath, { force: true });
				return true;
			},
			exit: (code) => {
				exits.push(code);
			},
			timeoutMs: 10,
		});

		expect(exits).toEqual([1]);
		expect(existsSync(runtimePath)).toBe(false);

		dbs.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("leaves a replacement runtime record during normal teardown", async () => {
		const server = Fastify({ logger: false });
		const dbs = openTestDatabases();
		const target = runtimeRecord({ instanceId: "target" });
		let current = target;
		let deleted = false;
		server.addHook("onClose", () => {
			current = runtimeRecord({ instanceId: "replacement" });
		});
		await server.ready();

		await gracefulShutdown({
			server,
			dbManager: dbs,
			runtime: target,
			deleteRuntime: (expected) => {
				if (expected.instanceId !== current.instanceId) return false;
				deleted = true;
				return true;
			},
			exit: () => {},
		});

		expect(deleted).toBe(false);
		expect(current.instanceId).toBe("replacement");
		dbs.close();
	});

	it("leaves a replacement runtime record on the teardown failure path", async () => {
		const server = Fastify({ logger: false });
		const dbs = openTestDatabases();
		const target = runtimeRecord({ instanceId: "target" });
		const current = runtimeRecord({ instanceId: "replacement" });
		let deleted = false;
		server.addHook("onClose", () => new Promise<void>(() => {}));
		await server.ready();

		await gracefulShutdown({
			server,
			dbManager: dbs,
			runtime: target,
			deleteRuntime: (expected) => {
				if (expected.instanceId !== current.instanceId) return false;
				deleted = true;
				return true;
			},
			exit: () => {},
			timeoutMs: 10,
		});

		expect(deleted).toBe(false);
		expect(current.instanceId).toBe("replacement");
		dbs.close();
	});
});

describe("QuitCoordinator", () => {
	afterEach(() => {
		resetGracefulShutdownForTests();
	});

	it("latches first, reports a failed agent stop, then still tears the hub down with exit 1", async () => {
		const server = Fastify({ logger: false });
		await server.ready();
		const dbs = openTestDatabases();
		const calls: string[] = [];
		const coordinator = new QuitCoordinator(
			{
				beginQuit: () => calls.push("beginQuit"),
				stopLocalAgent: async () => ({
					stopped: false,
					diagnostic: "record mismatch",
					stdout: "",
					stderr: "mismatch",
				}),
			},
			{
				server,
				dbManager: dbs,
				runtime: runtimeRecord(),
				deleteRuntime: () => {
					calls.push("runtime.delete");
					return true;
				},
				exit: (code) => calls.push(`exit:${code}`),
			},
		);

		await expect(coordinator.beginQuit()).resolves.toMatchObject({
			ok: false,
			message: "record mismatch",
		});
		await coordinator.finishQuit();
		expect(calls).toEqual(["beginQuit", "runtime.delete", "exit:1"]);
		dbs.close();
	});

	it("an ordinary shutdown joins a pending quit without running a second teardown", async () => {
		const server = Fastify({ logger: false });
		await server.ready();
		const dbs = openTestDatabases();
		let resolveStop!: (value: import("./session/agent-launcher.js").AgentStopResult) => void;
		const stop = new Promise<import("./session/agent-launcher.js").AgentStopResult>((resolve) => {
			resolveStop = resolve;
		});
		let beginCalls = 0;
		const coordinator = new QuitCoordinator(
			{ beginQuit: () => beginCalls++, stopLocalAgent: () => stop },
			{
				server,
				dbManager: dbs,
				runtime: runtimeRecord(),
				deleteRuntime: () => true,
				exit: () => {},
			},
		);

		void coordinator.beginQuit();
		const ordinaryStop = coordinator.shutdown();
		resolveStop({ stopped: true, diagnostic: "stopped", stdout: "", stderr: "" });
		await Promise.resolve();
		expect(beginCalls).toBe(1);
		// The ordinary stop has joined but cannot close the HTTP response early.
		let settled = false;
		void ordinaryStop.then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		await coordinator.finishQuit();
		await ordinaryStop;
		dbs.close();
	});

	it("resolves quit joiners when ordinary teardown started first", async () => {
		const server = Fastify({ logger: false });
		await server.ready();
		const dbs = openTestDatabases();
		const coordinator = new QuitCoordinator(
			{
				beginQuit: () => {},
				stopLocalAgent: async () => ({
					stopped: false,
					diagnostic: "stopper failed",
					stdout: "",
					stderr: "",
				}),
			},
			{
				server,
				dbManager: dbs,
				runtime: runtimeRecord(),
				deleteRuntime: () => true,
				exit: () => {},
			},
		);

		const ordinary = coordinator.shutdown();
		await expect(coordinator.beginQuit()).resolves.toMatchObject({ ok: false });
		const joiner = coordinator.shutdown();
		await expect(Promise.all([ordinary, joiner, coordinator.finishQuit()])).resolves.toEqual([
			undefined,
			undefined,
			undefined,
		]);
		dbs.close();
	});

	it("joins two quit requests into one stop and teardown", async () => {
		const server = Fastify({ logger: false });
		await server.ready();
		const dbs = openTestDatabases();
		const calls: string[] = [];
		const lifecycle = createQuitLifecycle(() => ({
			server,
			dbManager: dbs,
			runtime: runtimeRecord(),
			deleteRuntime: () => {
				calls.push("runtime.delete");
				return true;
			},
			exit: () => calls.push("exit"),
		}));
		const session = {
			beginQuit: () => calls.push("beginQuit"),
			stopLocalAgent: async () => ({
				stopped: true,
				diagnostic: "stopped",
				stdout: "",
				stderr: "",
			}),
		};

		const first = lifecycle.onQuit(session);
		const second = lifecycle.onQuit(session);
		await Promise.all([first, second]);

		const firstTeardown = lifecycle.onQuitDelivered();
		const secondTeardown = lifecycle.onQuitDelivered();
		expect(secondTeardown).toBe(firstTeardown);
		await Promise.all([firstTeardown, secondTeardown]);
		expect(calls).toEqual(["beginQuit", "runtime.delete", "exit"]);
	});
});

describe("POST /api/shutdown", () => {
	let server: FastifyInstance | undefined;
	let dbs: DatabaseManager | undefined;

	afterEach(async () => {
		if (server) {
			try {
				await server.close();
			} catch {
				// already closed by the test path
			}
			server = undefined;
		}
		dbs?.close();
		dbs = undefined;
	});

	it("requires owner token and loopback; paired Bearer auth is not enough", async () => {
		let shutdownCalls = 0;
		server = await createServer({
			logger: false,
			ownerToken: OWNER_TOKEN,
			onShutdown: () => {
				shutdownCalls++;
			},
		});

		const missing = await server.inject({ method: "POST", url: "/api/shutdown" });
		expect(missing.statusCode).toBe(401);

		const pairedBearerOnly = await server.inject({
			method: "POST",
			url: "/api/shutdown",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(pairedBearerOnly.statusCode).toBe(401);

		const remote = await server.inject({
			method: "POST",
			url: "/api/shutdown",
			headers: { "x-lasterm-owner": OWNER_TOKEN },
			remoteAddress: "203.0.113.10",
		});
		expect(remote.statusCode).toBe(403);

		const ok = await server.inject({
			method: "POST",
			url: "/api/shutdown",
			headers: { "x-lasterm-owner": OWNER_TOKEN },
		});
		expect(ok.statusCode).toBe(200);
		await tick();
		expect(shutdownCalls).toBe(1);
	});

	it("POST /api/quit waits for the stopper result, then schedules teardown", async () => {
		const calls: string[] = [];
		server = await createServer({
			logger: false,
			ownerToken: OWNER_TOKEN,
			onQuit: async () => {
				calls.push("stop-agent");
				return { ok: false, message: "agent still running", stdout: "", stderr: "still running" };
			},
			onQuitDelivered: () => {
				calls.push("teardown");
			},
		});

		const response = await server.inject({
			method: "POST",
			url: "/api/quit",
			headers: { "x-lasterm-owner": OWNER_TOKEN },
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).toMatchObject({ ok: false, message: "agent still running" });
		expect(calls).toEqual(["stop-agent"]);
		await tick();
		expect(calls).toEqual(["stop-agent", "teardown"]);
	});

	it("refuses quit around another connected client without latching teardown", async () => {
		dbs = openTestDatabases();
		const calls: string[] = [];
		server = await createServer({
			logger: false,
			authToken: TEST_TOKEN,
			ownerToken: OWNER_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			onQuit: async () => {
				calls.push("stop-agent");
				return { ok: true, message: "stopped", stdout: "", stderr: "" };
			},
			onQuitDelivered: () => calls.push("teardown"),
		});
		const address = await startServer(server, { port: 0 });
		const first = await connectAuthedWebSocket(address, TEST_TOKEN);
		const second = await connectAuthedWebSocket(address, TEST_TOKEN);

		const refused = await fetch(`${address}/api/quit`, {
			method: "POST",
			headers: {
				"X-Lasterm-Owner": OWNER_TOKEN,
				"X-Lasterm-Client-Id": first.clientId,
			},
		});

		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({
			others: 1,
			message: expect.stringContaining("snapshot"),
		});
		expect(calls).toEqual([]);
		expect((await fetch(`${address}/api/health`)).status).toBe(200);

		const forced = await fetch(`${address}/api/quit?force=1`, {
			method: "POST",
			headers: {
				"X-Lasterm-Owner": OWNER_TOKEN,
				"X-Lasterm-Client-Id": first.clientId,
			},
		});
		expect(forced.status).toBe(200);
		expect(await forced.json()).toMatchObject({ ok: true, override: true });
		await tick();
		expect(calls).toEqual(["stop-agent", "teardown"]);

		await Promise.all([first.close(), second.close()]);
	});

	// Mutation: count other clients unconditionally, and a second request during a
	// quit already under way is told the quit was refused while the hub is dying.
	// The guard is about starting a quit, not about observing one.
	it("joins a quit already under way instead of refusing it", async () => {
		dbs = openTestDatabases();
		let quitCalls = 0;
		let releaseQuit: () => void = () => {};
		const quitInFlight = new Promise<void>((resolve) => {
			releaseQuit = resolve;
		});
		let announceLatched: () => void = () => {};
		// A scheduler tick does not prove the first handler reached the latch. This
		// does, so the joiner cannot win the race and pass for the wrong reason.
		const latched = new Promise<void>((resolve) => {
			announceLatched = resolve;
		});
		server = await createServer({
			logger: false,
			authToken: TEST_TOKEN,
			ownerToken: OWNER_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			onQuit: async (sessionManager) => {
				quitCalls++;
				// What the real coordinator does first: latch, then stop the agent.
				sessionManager?.beginQuit();
				announceLatched();
				await quitInFlight;
				return { ok: true, message: "stopped", stdout: "", stderr: "" };
			},
			onQuitDelivered: () => {},
		});
		const address = await startServer(server, { port: 0 });
		const first = await connectAuthedWebSocket(address, TEST_TOKEN);
		const second = await connectAuthedWebSocket(address, TEST_TOKEN);

		const forced = fetch(`${address}/api/quit?force=1`, {
			method: "POST",
			headers: { "X-Lasterm-Owner": OWNER_TOKEN, "X-Lasterm-Client-Id": first.clientId },
		});
		await latched;

		// Both are in flight before either can settle, which is the shape being
		// tested; releasing afterwards keeps the joiner from waiting on itself.
		const joiner = fetch(`${address}/api/quit`, {
			method: "POST",
			headers: { "X-Lasterm-Owner": OWNER_TOKEN, "X-Lasterm-Client-Id": first.clientId },
		});
		await tick();
		releaseQuit();

		// The contract is that the joiner gets the same answer, not merely that it
		// escapes the refusal — a 500 would also have escaped it.
		const joined = await joiner;
		expect(joined.status).toBe(200);
		expect(await joined.json()).toMatchObject({ ok: true });
		expect((await forced).status).toBe(200);
		expect(quitCalls).toBe(2);

		await Promise.all([first.close(), second.close()]);
	});

	it("allows quit when its only connected client identifies itself", async () => {
		dbs = openTestDatabases();
		let quitCalls = 0;
		server = await createServer({
			logger: false,
			authToken: TEST_TOKEN,
			ownerToken: OWNER_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			onQuit: async () => {
				quitCalls++;
				return { ok: true, message: "stopped", stdout: "", stderr: "" };
			},
			onQuitDelivered: () => {},
		});
		const address = await startServer(server, { port: 0 });
		const client = await connectAuthedWebSocket(address, TEST_TOKEN);

		const response = await fetch(`${address}/api/quit`, {
			method: "POST",
			headers: {
				"X-Lasterm-Owner": OWNER_TOKEN,
				"X-Lasterm-Client-Id": client.clientId,
			},
		});

		expect(response.status).toBe(200);
		expect(quitCalls).toBe(1);
		await client.close();
	});

	it("does not run shutdown when no owner token is configured", async () => {
		let shutdownCalls = 0;
		server = await createServer({
			logger: false,
			onShutdown: () => {
				shutdownCalls++;
			},
		});

		const response = await server.inject({
			method: "POST",
			url: "/api/shutdown",
			headers: { "x-lasterm-owner": OWNER_TOKEN },
		});

		expect(response.statusCode).toBe(401);
		await tick();
		expect(shutdownCalls).toBe(0);
	});

	it("rejects a valid paired bearer on shutdown when the owner token is missing", async () => {
		dbs = openTestDatabases();
		let shutdownCalls = 0;
		server = await createServer({
			logger: false,
			authToken: TEST_TOKEN,
			ownerToken: OWNER_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			onShutdown: () => {
				shutdownCalls++;
			},
		});

		const pairedBearerOnly = await server.inject({
			method: "POST",
			url: "/api/shutdown",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});

		expect(pairedBearerOnly.statusCode).toBe(401);
		await tick();
		expect(shutdownCalls).toBe(0);
	});

	it("does not exempt non-POST /api/shutdown from bearer auth", async () => {
		dbs = openTestDatabases();
		server = await createServer({
			logger: false,
			authToken: TEST_TOKEN,
			ownerToken: OWNER_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
		});

		const missingBearer = await server.inject({ method: "GET", url: "/api/shutdown" });
		expect(missingBearer.statusCode).toBe(401);

		const withBearer = await server.inject({
			method: "GET",
			url: "/api/shutdown",
			headers: { authorization: `Bearer ${TEST_TOKEN}` },
		});
		expect(withBearer.statusCode).toBe(404);
	});

	it("guards other connected clients and allows force=1", async () => {
		dbs = openTestDatabases();
		let shutdownCalls = 0;
		server = await createServer({
			logger: false,
			authToken: TEST_TOKEN,
			ownerToken: OWNER_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			onShutdown: () => {
				shutdownCalls++;
			},
		});
		const address = await startServer(server, { port: 0 });
		const first = await connectAuthedWebSocket(address, TEST_TOKEN);
		const second = await connectAuthedWebSocket(address, TEST_TOKEN);

		const guarded = await fetch(`${address}/api/shutdown`, {
			method: "POST",
			headers: {
				"X-Lasterm-Owner": OWNER_TOKEN,
				"X-Lasterm-Client-Id": first.clientId,
			},
		});

		expect(guarded.status).toBe(409);
		expect(await guarded.json()).toEqual({ others: 1 });
		expect(shutdownCalls).toBe(0);

		const forced = await fetch(`${address}/api/shutdown?force=1`, {
			method: "POST",
			headers: {
				"X-Lasterm-Owner": OWNER_TOKEN,
				"X-Lasterm-Client-Id": first.clientId,
			},
		});

		expect(forced.status).toBe(200);
		await tick();
		expect(shutdownCalls).toBe(1);

		await Promise.all([first.close(), second.close()]);
	});
});

async function connectAuthedWebSocket(
	address: string,
	token: string,
): Promise<{ clientId: string; close: () => Promise<void> }> {
	const ws = new WebSocket(`${address.replace(/^http/, "ws")}/ws`);
	ws.binaryType = "arraybuffer";
	await once(ws, "open");

	const authOk = new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("AUTH_OK timeout")), 2_000);
		ws.addEventListener("message", (event) => {
			try {
				const msg = decodeWsMessage(event.data);
				if (msg.type === "AUTH_OK") {
					clearTimeout(timer);
					resolve(msg.clientId);
				} else if (msg.type === "AUTH_FAIL") {
					clearTimeout(timer);
					reject(new Error(msg.message));
				}
			} catch (err) {
				clearTimeout(timer);
				reject(err);
			}
		});
	});

	ws.send(encodeMessage({ type: "AUTH", token }));
	const clientId = await authOk;

	return {
		clientId,
		close: () => closeWebSocket(ws),
	};
}

function decodeWsMessage(data: unknown): ProtocolMessage {
	if (data instanceof ArrayBuffer) {
		return decodeMessage(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		return decodeMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	}
	throw new Error(`Unexpected WebSocket message payload: ${typeof data}`);
}

function once(ws: WebSocket, eventName: "open" | "close"): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${eventName} timeout`)), 2_000);
		ws.addEventListener(
			eventName,
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				reject(new Error(`WebSocket ${eventName} failed`));
			},
			{ once: true },
		);
	});
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.CLOSED) return;
	const closed = once(ws, "close");
	ws.close();
	await closed;
}

function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function runtimeRecord(overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
	return {
		pid: 123,
		port: 456,
		started_at: "2026-08-03T00:00:00.000Z",
		instanceId: "target",
		...overrides,
	};
}
