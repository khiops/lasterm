import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	decodeMessage,
	encodeMessage,
	type ProtocolMessage,
	TRANSFER_CHUNK_MAX_BYTES,
} from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseHostPath } from "../files/host-paths.js";
import { createServer } from "../server.fixture.js";
import { type DatabaseManager, openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import { getTestTls } from "../test-tls.fixture.js";

const PRIMARY_TOKEN = "5d".repeat(32);
const bearer = { authorization: `Bearer ${PRIMARY_TOKEN}` };
const CHANNEL = "01K833CHAN0000000000000001";

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

interface Hub {
	server: FastifyInstance;
	dbs: DatabaseManager;
	root: string;
	dest: string;
	sockets: InjectedSocket[];
}

let hub: Hub | null = null;

afterEach(async () => {
	if (hub === null) return;
	for (const socket of hub.sockets.splice(0)) socket.terminate();
	await hub.server.close();
	hub.dbs.close();
	await removeTempDir(hub.root);
	hub = null;
});

/** A hub with a terminal on its local host, file transfer on or off. */
async function startHub(fileTransfer: boolean): Promise<Hub> {
	const root = makeTempDir("lasterm-transfer-route-");
	const configDir = join(root, "config");
	const destination = join(root, "dest");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(configDir);
	mkdirSync(destination);
	writeFileSync(
		join(configDir, "config.toml"),
		`[experimental]\nfile_transfer = ${fileTransfer}\n`,
	);
	const dbs = openTestDatabases();
	const server = await createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
		authToken: PRIMARY_TOKEN,
		authConfig: { tokenTtlDays: 90 },
		configDir,
	});
	await server.ready();
	const dal = new MetaDAL(dbs.meta);
	const [local] = dal.listLocalHosts();
	if (!local) throw new Error("the hub made no local host");
	dal.createSession({ id: "01K833SESS0000000000000001", hostId: local.id, status: "active" });
	dal.createChannel({ id: CHANNEL, sessionId: "01K833SESS0000000000000001", status: "live" });
	const dest = normaliseHostPath(destination, process.platform === "win32" ? "windows" : "posix");
	if (!dest.ok) throw new Error(dest.reason);
	hub = { server, dbs, root, dest: dest.path, sockets: [] };
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

function send(socket: InjectedSocket, message: Record<string, unknown>): void {
	socket.send(encodeMessage(message as unknown as ProtocolMessage));
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

function put(
	h: Hub,
	transferId: string,
	item: number,
	offset: number,
	body: Buffer,
	clientId?: string,
) {
	return h.server.inject({
		method: "PUT",
		url: `/api/transfers/${transferId}/items/${item}?offset=${offset}`,
		headers: {
			...bearer,
			"content-type": "application/octet-stream",
			...(clientId !== undefined ? { "x-lasterm-client-id": clientId } : {}),
		},
		payload: body,
	});
}

describe("uploads over the hub's WebSocket and REST routes (#833)", () => {
	it("wait behind [experimental] file_transfer: every message and route is refused while it is off", async () => {
		const h = await startHub(false);
		const writer = await window(h);
		send(writer.socket, {
			type: "TRANSFER_START",
			requestId: "r1",
			channelId: CHANNEL,
			dir: h.dest,
			items: [{ relPath: "x", kind: "file", size: 1 }],
			onConflict: "ask",
		});
		expect(await heard(writer.seen, (m) => m.type === "TRANSFER_ERROR")).toMatchObject({
			requestId: "r1",
			code: "FILE_TRANSFER_DISABLED",
		});
		const transferId = "01K833TRAN0000000000000001";
		const chunk = await put(h, transferId, 0, 0, Buffer.from("x"), writer.id);
		expect(chunk.statusCode).toBe(404);
		expect(chunk.json().error.code).toBe("FILE_TRANSFER_DISABLED");
		const listed = await h.server.inject({
			method: "GET",
			url: `/api/transfers?channel_id=${CHANNEL}`,
			headers: bearer,
		});
		expect(listed.statusCode).toBe(404);
	});

	it("start over the socket, take each chunk over REST once the host holds it, and say it to every window", async () => {
		const h = await startHub(true);
		const writer = await window(h);
		const reader = await window(h);
		const data = Buffer.alloc(2_500_000, 7);
		send(writer.socket, {
			type: "TRANSFER_START",
			requestId: "r2",
			channelId: CHANNEL,
			dir: h.dest,
			items: [
				{ relPath: "sub", kind: "dir" },
				{ relPath: "sub/data.bin", kind: "file", size: data.length, mtime: 1_700_000_000_000 },
			],
			onConflict: "ask",
		});
		const accepted = await heard(writer.seen, (m) => m.type === "TRANSFER_ACCEPTED");
		expect(accepted).toMatchObject({
			requestId: "r2",
			channelId: CHANNEL,
			dir: h.dest,
			joined: false,
			items: [
				{ itemId: 0, state: "queued" },
				{ itemId: 1, state: "queued" },
			],
		});
		const transferId = accepted.transferId as string;
		await heard(
			writer.seen,
			(m) =>
				m.type === "TRANSFER_PROGRESS" &&
				(m.items as { itemId: number; state: string }[]).some(
					(i) => i.itemId === 1 && i.state === "sending",
				),
		);

		// Only the window that started it sends its bytes, from where the host's end.
		expect((await put(h, transferId, 1, 0, data.subarray(0, 10), reader.id)).statusCode).toBe(403);
		expect((await put(h, transferId, 1, 0, data.subarray(0, 10))).statusCode).toBe(403);
		const ahead = await put(h, transferId, 1, 5, data.subarray(0, 10), writer.id);
		expect(ahead.statusCode).toBe(409);
		expect(ahead.json().error).toMatchObject({ code: "OFFSET_MISMATCH", acked: 0 });
		const json = await h.server.inject({
			method: "PUT",
			url: `/api/transfers/${transferId}/items/1?offset=0`,
			headers: { ...bearer, "x-lasterm-client-id": writer.id },
			payload: { not: "bytes" },
		});
		expect(json.statusCode).toBe(415);
		const tooBig = await put(
			h,
			transferId,
			1,
			0,
			Buffer.alloc(TRANSFER_CHUNK_MAX_BYTES + 1),
			writer.id,
		);
		expect(tooBig.statusCode).toBe(413);

		const chunk = 1024 * 1024;
		for (let at = 0; at < data.length; at += chunk) {
			const answer = await put(h, transferId, 1, at, data.subarray(at, at + chunk), writer.id);
			expect(answer.statusCode).toBe(200);
			expect(answer.json()).toEqual({ acked: Math.min(at + chunk, data.length) });
		}
		const done = await heard(writer.seen, (m) => m.type === "TRANSFER_DONE");
		expect(done).toMatchObject({
			transferId,
			totals: { files: 1, acked: data.length, states: { placed: 1 } },
		});
		expect(readFileSync(join(h.root, "dest", "sub", "data.bin"))).toEqual(data);

		const listed = await h.server.inject({
			method: "GET",
			url: `/api/transfers?channel_id=${CHANNEL}`,
			headers: bearer,
		});
		expect(listed.json()).toMatchObject({
			transfers: [{ transfer_id: transferId, state: "done", direction: "upload" }],
		});
		const described = await h.server.inject({
			method: "GET",
			url: `/api/transfers/${transferId}`,
			headers: bearer,
		});
		expect(described.json().items).toEqual([
			expect.objectContaining({ item_id: 0, rel_path: "sub", state: "placed", outcome: "created" }),
			expect.objectContaining({
				item_id: 1,
				rel_path: "sub/data.bin",
				state: "placed",
				acked: data.length,
				verification: "size",
			}),
		]);
	});

	it("refuse a start from a window that does not hold the write lock", async () => {
		const h = await startHub(true);
		const writer = await window(h);
		const reader = await window(h);
		// Not attached, it hears no WRITE_LOCK: the PONG says its claim was handled.
		send(writer.socket, { type: "WRITE_CLAIM", channelId: CHANNEL });
		send(writer.socket, { type: "PING" });
		await heard(writer.seen, (m) => m.type === "PONG");
		send(reader.socket, {
			type: "TRANSFER_START",
			requestId: "r3",
			channelId: CHANNEL,
			dir: h.dest,
			items: [{ relPath: "x", kind: "file", size: 1 }],
			onConflict: "ask",
		});
		expect(await heard(reader.seen, (m) => m.type === "TRANSFER_ERROR")).toMatchObject({
			requestId: "r3",
			code: "WRITE_LOCK_DENIED",
		});
	});
});
