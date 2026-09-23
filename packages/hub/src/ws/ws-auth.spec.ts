import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SecurityFields, SecurityLog } from "../logging/security-log.js";
import { createServer } from "../server.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.fixture.js";
import { WS_CLOSE_TRY_AGAIN_LATER } from "./ws-handler.js";

const TEST_TOKEN = "a".repeat(64);

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

interface Observed {
	readonly messages: ProtocolMessage[];
	readonly closed: Promise<{ code: number; reason: string }>;
}

/** Record what the hub sends a socket, and how it ends it. */
function observe(ws: InjectedSocket): Observed {
	const messages: ProtocolMessage[] = [];
	ws.on("message", (data: Buffer) => messages.push(decodeMessage(new Uint8Array(data))));
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
	});
	return { messages, closed };
}

describe("WebSocket AUTH against the token store", () => {
	let dbs: DatabaseManager;
	let server: FastifyInstance;
	let security: SecurityFields[];

	beforeEach(async () => {
		dbs = openTestDatabases();
		security = [];
		server = await createServer({
			tls: getTestTls(),
			logger: false,
			authToken: TEST_TOKEN,
			dbManager: dbs,
			skipShellDiscovery: true,
			securityLog: new SecurityLog((_msg, fields) => security.push(fields)),
		});
		await server.ready();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await server.close();
		dbs.close();
	});

	it("closes with Try Again Later, and no AUTH_FAIL, while the store cannot be read", async () => {
		const prepare = dbs.meta.prepare.bind(dbs.meta);
		vi.spyOn(dbs.meta, "prepare").mockImplementation(((sql: string) => {
			if (sql.includes("FROM auth_tokens")) {
				throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
			}
			return prepare(sql);
		}) as typeof dbs.meta.prepare);
		const ws = await server.injectWS("/ws");
		const observed = observe(ws);

		ws.send(encodeMessage({ type: "AUTH", token: TEST_TOKEN }));

		// AUTH_FAIL is how a client learns to discard its token and pair again;
		// a store that could not answer has said nothing about the token.
		expect(await observed.closed).toEqual({
			code: WS_CLOSE_TRY_AGAIN_LATER,
			reason: "AUTH_UNAVAILABLE",
		});
		expect(observed.messages).toEqual([]);
		expect(security.filter((fields) => fields.event === "auth.failure")).toEqual([]);
	});

	it("still answers AUTH_FAIL to a token the store does not know", async () => {
		const ws = await server.injectWS("/ws");
		const observed = observe(ws);

		ws.send(encodeMessage({ type: "AUTH", token: "b".repeat(64) }));

		await observed.closed;
		expect(observed.messages.map((message) => message.type)).toEqual(["AUTH_FAIL"]);
		expect(security).toEqual([
			expect.objectContaining({ event: "auth.failure", via: "ws", reason: "invalid_token" }),
		]);
	});
});
