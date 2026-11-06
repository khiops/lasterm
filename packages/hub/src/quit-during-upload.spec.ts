import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { request as requestHttps } from "node:https";
import { join } from "node:path";
import tls from "node:tls";
import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeInfo } from "./cli.js";
import { normaliseHostPath } from "./files/host-paths.js";
import { createServer, startServer } from "./server.fixture.js";
import { createQuitLifecycle, resetGracefulShutdownForTests } from "./shutdown.js";
import { type DatabaseManager, openTestDatabases } from "./storage/db.js";
import { MetaDAL } from "./storage/meta.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";
import { getTestTls } from "./test-tls.fixture.js";

const PRIMARY_TOKEN = "5e".repeat(32);
const OWNER_TOKEN = "6f".repeat(32);
const CHANNEL = "01K872CHAN0000000000000001";
const CHUNK = 1024 * 1024;
/**
 * The bound a hub's teardown has here. A quit that reaches it exits 1, as the
 * one in #872 did after the shipped 10 s.
 */
const TEARDOWN_BOUND_MS = 6_000;
/** How soon a quit must have ended: the close's drain, and margin for a slow runner. */
const QUIT_WITHIN_MS = 3_500;

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

interface Hub {
	server: FastifyInstance;
	readonly address: string;
	readonly dbs: DatabaseManager;
	readonly root: string;
	readonly dest: string;
	/** Resolves with the code the hub exits with. */
	readonly exited: Promise<number>;
	readonly sockets: InjectedSocket[];
	readonly raw: { destroy(): void }[];
}

let hub: Hub | null = null;

afterEach(async () => {
	resetGracefulShutdownForTests();
	if (hub === null) return;
	for (const socket of hub.sockets.splice(0)) socket.terminate();
	for (const socket of hub.raw.splice(0)) socket.destroy();
	await hub.server.close().catch(() => {});
	hub.dbs.close();
	await removeTempDir(hub.root);
	hub = null;
});

/**
 * A hub on its own meta.db, file transfer on, with the quit lifecycle the
 * shipped hub has: /api/quit latches the session manager, stops the agent (a
 * stand-in here: the real one would stop this machine's agent), answers, then
 * tears the hub down. Its databases stay open for the next hub to read.
 */
async function startQuittableHub(): Promise<Hub> {
	const root = makeTempDir("lasterm-quit-upload-");
	const configDir = join(root, "config");
	const destination = join(root, "dest");
	mkdirSync(configDir);
	mkdirSync(destination);
	writeFileSync(join(configDir, "config.toml"), "[experimental]\nfile_transfer = true\n");
	const dbs = openTestDatabases();
	let server: FastifyInstance | null = null;
	let exit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => {
		exit = resolve;
	});
	const quit = createQuitLifecycle(() => {
		if (server === null) throw new Error("quit before the server exists");
		return {
			server,
			// The next hub reads them: the test closes them.
			dbManager: { close: () => {} },
			runtime: runtimeRecord(),
			deleteRuntime: () => true,
			exit,
			timeoutMs: TEARDOWN_BOUND_MS,
		};
	});
	server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
		authToken: PRIMARY_TOKEN,
		authConfig: { tokenTtlDays: 90 },
		configDir,
		ownerToken: OWNER_TOKEN,
		onQuit: (sessionManager) =>
			quit.onQuit(
				sessionManager === null
					? null
					: {
							beginQuit: () => sessionManager.beginQuit(),
							stopLocalAgent: async () => ({
								stopped: true,
								diagnostic: "stopped",
								stdout: "",
								stderr: "",
							}),
						},
			),
		onQuitDelivered: quit.onQuitDelivered,
	});
	const address = await startServer(server, { port: 0 });
	const dal = new MetaDAL(dbs.meta);
	const [local] = dal.listLocalHosts();
	if (!local) throw new Error("the hub made no local host");
	dal.createSession({ id: "01K872SESS0000000000000001", hostId: local.id, status: "active" });
	dal.createChannel({ id: CHANNEL, sessionId: "01K872SESS0000000000000001", status: "live" });
	const dest = normaliseHostPath(destination, process.platform === "win32" ? "windows" : "posix");
	if (!dest.ok) throw new Error(dest.reason);
	hub = { server, address, dbs, root, dest: dest.path, exited, sockets: [], raw: [] };
	return hub;
}

/** A window: an authenticated socket, its id, and what it heard. */
async function window(
	h: Hub,
): Promise<{ id: string; socket: InjectedSocket; seen: ProtocolMessage[] }> {
	const socket = await h.server.injectWS("/ws", {
		socket: { remoteAddress: "127.0.0.1" },
	} as never);
	h.sockets.push(socket);
	const seen: ProtocolMessage[] = [];
	socket.on("message", (data: unknown) => seen.push(decodeMessage(new Uint8Array(data as Buffer))));
	socket.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
	await vi.waitFor(() => expect(seen.some((message) => message.type === "AUTH_OK")).toBe(true));
	const ok = seen.find((message) => message.type === "AUTH_OK") as { clientId: string };
	return { id: ok.clientId, socket, seen };
}

async function heard(
	seen: ProtocolMessage[],
	match: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return vi.waitFor(
		() => {
			const found = (seen as unknown as Record<string, unknown>[]).find(match);
			expect(found).toBeDefined();
			return found as Record<string, unknown>;
		},
		{ timeout: 10_000 },
	);
}

/** An upload of one file of `size` bytes, its first chunk on the host. */
async function uploadUnderWay(
	h: Hub,
	size: number,
): Promise<{ transferId: string; writer: Awaited<ReturnType<typeof window>> }> {
	const writer = await window(h);
	writer.socket.send(
		encodeMessage({
			type: "TRANSFER_START",
			requestId: "r1",
			channelId: CHANNEL,
			dir: h.dest,
			items: [{ relPath: "big.bin", kind: "file", size }],
			onConflict: "ask",
		} as unknown as ProtocolMessage),
	);
	const accepted = await heard(writer.seen, (m) => m.type === "TRANSFER_ACCEPTED");
	const transferId = accepted.transferId as string;
	await heard(
		writer.seen,
		(m) =>
			m.type === "TRANSFER_PROGRESS" &&
			(m.items as { state: string }[]).some((item) => item.state === "sending"),
	);
	const first = await send(h, `/api/transfers/${transferId}/items/0?offset=0`, {
		method: "PUT",
		headers: {
			Authorization: `Bearer ${PRIMARY_TOKEN}`,
			"Content-Type": "application/octet-stream",
			"X-Lasterm-Client-Id": writer.id,
		},
		body: Buffer.alloc(CHUNK, 1),
	});
	expect(first.status).toBe(200);
	expect(JSON.parse(first.body)).toEqual({ acked: CHUNK });
	return { transferId, writer };
}

/**
 * The next chunk's request, its headers and part of its body sent, the rest
 * never: a window whose relay stopped feeding it, as the desktop's does while
 * its quit is under way. Resolves once the hub is reading it.
 */
async function chunkHeldOpen(h: Hub, transferId: string, clientId: string): Promise<void> {
	const reading = new Promise<void>((resolve) => {
		const onRequest = (request: IncomingMessage) => {
			if (request.method !== "PUT") return;
			h.server.server.off("request", onRequest);
			resolve();
		};
		h.server.server.on("request", onRequest);
	});
	const request = requestHttps(
		new URL(`/api/transfers/${transferId}/items/0?offset=${CHUNK}`, h.address),
		{
			method: "PUT",
			ca: getTestTls().cert,
			agent: false,
			headers: {
				Authorization: `Bearer ${PRIMARY_TOKEN}`,
				"Content-Type": "application/octet-stream",
				"Content-Length": String(CHUNK),
				"X-Lasterm-Client-Id": clientId,
			},
		},
	);
	// The hub ending it is the point; what it says to this request is not.
	request.on("error", () => {});
	request.write(Buffer.alloc(CHUNK / 4, 2));
	h.raw.push(request);
	await reading;
}

/**
 * A WebSocket whose client reads nothing more once upgraded, and so never
 * answers the hub's close: what a relay busy waiting for its page does.
 */
async function silentWebSocket(h: Hub): Promise<void> {
	const url = new URL(h.address);
	const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
		const connected = tls.connect({
			host: url.hostname,
			port: Number(url.port),
			ca: getTestTls().cert,
		});
		connected.once("secureConnect", () => resolve(connected));
		connected.once("error", reject);
	});
	h.raw.push(socket);
	socket.on("error", () => {});
	const upgraded = new Promise<string>((resolve) => {
		let data = "";
		const onData = (chunk: Buffer) => {
			data += chunk.toString("latin1");
			if (!data.includes("\r\n\r\n")) return;
			socket.off("data", onData);
			socket.pause();
			resolve(data);
		};
		socket.on("data", onData);
	});
	socket.write(
		[
			"GET /ws HTTP/1.1",
			`Host: ${url.host}`,
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
			"Sec-WebSocket-Version: 13",
			"\r\n",
		].join("\r\n"),
	);
	expect(await upgraded).toMatch(/^HTTP\/1\.1 101/);
}

/** The quit the desktop asks for, naming its own window as it does. */
function quitHub(h: Hub, clientId?: string): Promise<{ status: number; body: string }> {
	return send(h, "/api/quit", {
		method: "POST",
		headers: {
			"X-Lasterm-Owner": OWNER_TOKEN,
			...(clientId !== undefined ? { "X-Lasterm-Client-Id": clientId } : {}),
		},
	});
}

function send(
	h: Hub,
	path: string,
	options: { method: string; headers?: Record<string, string>; body?: Buffer },
): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = requestHttps(new URL(path, h.address), {
			method: options.method,
			headers: options.headers,
			ca: getTestTls().cert,
			agent: false,
		});
		request.once("error", reject);
		request.once("response", (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("error", reject);
			response.once("end", () =>
				resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
			);
		});
		request.end(options.body);
	});
}

/** How the hub ended, and how long after the quit was answered. */
async function ending(h: Hub): Promise<{ code: number; afterMs: number }> {
	const started = Date.now();
	const code = await h.exited;
	return { code, afterMs: Date.now() - started };
}

/** What the next hub, on the same meta.db, says of the upload. */
async function nextHubSays(h: Hub, transferId: string): Promise<Record<string, unknown>> {
	h.server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: h.dbs,
		skipShellDiscovery: true,
		authToken: PRIMARY_TOKEN,
		authConfig: { tokenTtlDays: 90 },
		configDir: join(h.root, "config"),
	});
	await h.server.ready();
	const described = await h.server.inject({
		method: "GET",
		url: `/api/transfers/${transferId}`,
		headers: { authorization: `Bearer ${PRIMARY_TOKEN}` },
	});
	expect(described.statusCode).toBe(200);
	return described.json() as Record<string, unknown>;
}

describe("quitting while an upload sends (#872)", () => {
	it("ends a chunk held open, and the hub exits 0 at once with the upload interrupted where the host's bytes end", async () => {
		const h = await startQuittableHub();
		const { transferId, writer } = await uploadUnderWay(h, 3 * CHUNK);
		await chunkHeldOpen(h, transferId, writer.id);

		const answer = await quitHub(h, writer.id);
		expect(answer.status).toBe(200);
		const { code, afterMs } = await ending(h);

		expect(code).toBe(0);
		expect(afterMs).toBeLessThan(QUIT_WITHIN_MS);
		expect(await nextHubSays(h, transferId)).toMatchObject({
			transfer_id: transferId,
			state: "interrupted",
			items: [expect.objectContaining({ item_id: 0, state: "interrupted", acked: CHUNK })],
		});
	});

	it("does not wait for a WebSocket client that never answers the close", async () => {
		const h = await startQuittableHub();
		await silentWebSocket(h);

		const answer = await quitHub(h);
		expect(answer.status).toBe(200);
		const { code, afterMs } = await ending(h);

		expect(code).toBe(0);
		expect(afterMs).toBeLessThan(QUIT_WITHIN_MS);
	});
});

function runtimeRecord(): RuntimeInfo {
	return {
		pid: 123,
		port: 456,
		started_at: "2026-11-06T00:00:00.000Z",
		instanceId: "quit-during-upload",
		ownerToken: OWNER_TOKEN,
		spki: "not-a-key",
	};
}
