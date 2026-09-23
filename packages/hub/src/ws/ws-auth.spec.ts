import { decodeMessage, encodeMessage, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken, revokeToken } from "../auth.js";
import { type SecurityFields, SecurityLog } from "../logging/security-log.js";
import { createServer } from "../server.fixture.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { getTestTls } from "../test-tls.fixture.js";
import { WS_CLOSE_POLICY_VIOLATION, WS_CLOSE_TRY_AGAIN_LATER } from "./ws-handler.js";

const TEST_TOKEN = "a".repeat(64);
const CHANNEL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

/**
 * How long a socket the hub should be ending may stay open. Ending is immediate
 * here; the bound only turns a socket left open into a failure that says so,
 * rather than a test that waits out its own timeout.
 */
const CLOSE_BOUND_MS = 5_000;

interface Observed {
	readonly messages: ProtocolMessage[];
	readonly closed: Promise<{ code: number; reason: string }>;
	readonly types: () => string[];
}

/** Record what the hub sends a socket, and how it ends it. */
function observe(ws: InjectedSocket): Observed {
	const messages: ProtocolMessage[] = [];
	ws.on("message", (data: Buffer) => messages.push(decodeMessage(new Uint8Array(data))));
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
	});
	return { messages, closed, types: () => messages.map((message) => message.type) };
}

/** How the hub ended the socket, failing if it is still open after the bound. */
async function closeOf(observed: Observed): Promise<{ code: number; reason: string }> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			observed.closed,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`the hub left the socket open for ${CLOSE_BOUND_MS}ms`)),
					CLOSE_BOUND_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Make every read of the token table throw, as a locked or closed database does. */
function failTokenStore(dbs: DatabaseManager): void {
	const prepare = dbs.meta.prepare.bind(dbs.meta);
	vi.spyOn(dbs.meta, "prepare").mockImplementation(((sql: string) => {
		if (sql.includes("FROM auth_tokens")) {
			throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
		}
		return prepare(sql);
	}) as typeof dbs.meta.prepare);
}

describe("WebSocket authentication against the token store", () => {
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
		vi.useRealTimers();
		vi.restoreAllMocks();
		await server.close();
		dbs.close();
	});

	/** Open a socket and authenticate it, proving the hub answers it before the test acts. */
	async function connect(token: string): Promise<{ ws: InjectedSocket; observed: Observed }> {
		const ws = await server.injectWS("/ws");
		const observed = observe(ws);
		ws.send(encodeMessage({ type: "AUTH", token }));
		await vi.waitFor(() => expect(observed.types()).toContain("AUTH_OK"));
		await ping(ws, observed);
		return { ws, observed };
	}

	/** Send a PING and wait for its PONG: the socket is open and its frames are acted on. */
	async function ping(ws: InjectedSocket, observed: Observed): Promise<void> {
		const pongs = observed.types().filter((type) => type === "PONG").length;
		ws.send(encodeMessage({ type: "PING" }));
		await vi.waitFor(() =>
			expect(observed.types().filter((type) => type === "PONG")).toHaveLength(pongs + 1),
		);
	}

	function failures(): SecurityFields[] {
		return security.filter((fields) => fields.event === "auth.failure");
	}

	function lastUsedAt(tokenId: string): string | null {
		const row = dbs.meta
			.prepare("SELECT last_used_at FROM auth_tokens WHERE id = ?")
			.get(tokenId) as { last_used_at: string | null };
		return row.last_used_at;
	}

	describe("AUTH", () => {
		it("closes with Try Again Later, and no AUTH_FAIL, while the store cannot be read", async () => {
			failTokenStore(dbs);
			const ws = await server.injectWS("/ws");
			const observed = observe(ws);

			ws.send(encodeMessage({ type: "AUTH", token: TEST_TOKEN }));

			// AUTH_FAIL is how a client learns to discard its token and pair again;
			// a store that could not answer has said nothing about the token.
			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_TRY_AGAIN_LATER,
				reason: "AUTH_UNAVAILABLE",
			});
			expect(observed.messages).toEqual([]);
			expect(failures()).toEqual([]);
		});

		it("still answers AUTH_FAIL to a token the store does not know", async () => {
			const ws = await server.injectWS("/ws");
			const observed = observe(ws);

			ws.send(encodeMessage({ type: "AUTH", token: "b".repeat(64) }));

			await closeOf(observed);
			expect(observed.types()).toEqual(["AUTH_FAIL"]);
			expect(failures()).toEqual([
				expect.objectContaining({ via: "ws", reason: "invalid_token", tokenStatus: "unknown" }),
			]);
		});
	});

	describe("after AUTH_OK", () => {
		it.each([
			["INPUT", { type: "INPUT", channelId: CHANNEL_ID, data: new Uint8Array([0x6c, 0x73]) }],
			["RESIZE", { type: "RESIZE", channelId: CHANNEL_ID, cols: 120, rows: 40 }],
			["WRITE_CLAIM", { type: "WRITE_CLAIM", channelId: CHANNEL_ID }],
			["PING", { type: "PING" }],
		] as const)(
			"closes on the next %s once the token is revoked, and acts on none of it",
			async (_type, frame) => {
				const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
				const { ws, observed } = await connect(paired.token);
				const answered = observed.messages.length;

				// Revoked in the store directly: this is the per-frame check alone, with
				// no help from the revocation route.
				revokeToken(dbs.meta, paired.id);
				ws.send(encodeMessage(frame as ProtocolMessage));
				ws.send(encodeMessage({ type: "PING" }));

				expect(await closeOf(observed)).toEqual({
					code: WS_CLOSE_POLICY_VIOLATION,
					reason: "AUTH_REVOKED",
				});
				expect(observed.messages.slice(answered)).toEqual([]);
				expect(failures()).toEqual([
					expect.objectContaining({
						via: "ws",
						reason: "token_no_longer_valid",
						tokenStatus: "revoked",
					}),
				]);
			},
		);

		it("closes on the next frame once the token has expired", async () => {
			const paired = createToken(dbs.meta, {
				label: "browser",
				expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			});
			const { ws, observed } = await connect(paired.token);

			dbs.meta
				.prepare("UPDATE auth_tokens SET expires_at = ? WHERE id = ?")
				.run(new Date(Date.now() - 1_000).toISOString(), paired.id);
			ws.send(encodeMessage({ type: "PING" }));

			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_POLICY_VIOLATION,
				reason: "AUTH_REVOKED",
			});
			expect(failures()).toEqual([
				expect.objectContaining({ reason: "token_no_longer_valid", tokenStatus: "expired" }),
			]);
		});

		it("closes with Try Again Later when the store stops answering mid-session", async () => {
			const { ws, observed } = await connect(TEST_TOKEN);

			failTokenStore(dbs);
			ws.send(encodeMessage({ type: "PING" }));

			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_TRY_AGAIN_LATER,
				reason: "AUTH_UNAVAILABLE",
			});
			expect(failures()).toEqual([]);
		});

		it("closes the sockets of a token revoked through the API at once, and only those", async () => {
			const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
			const revokedSocket = await connect(paired.token);
			const primarySocket = await connect(TEST_TOKEN);
			const answered = revokedSocket.observed.messages.length;

			const response = await server.inject({
				method: "DELETE",
				url: `/api/auth/tokens/${paired.id}`,
				headers: { authorization: `Bearer ${TEST_TOKEN}` },
			});

			expect(response.statusCode).toBe(200);
			// No frame is sent on the revoked socket: the revocation alone ends it.
			expect(await closeOf(revokedSocket.observed)).toEqual({
				code: WS_CLOSE_POLICY_VIOLATION,
				reason: "AUTH_REVOKED",
			});
			expect(revokedSocket.observed.messages.slice(answered)).toEqual([]);
			await ping(primarySocket.ws, primarySocket.observed);
			// The record names the connection an auth.success opened with that token.
			const opened = security.find(
				(fields) => fields.event === "auth.success" && fields.tokenId === paired.id,
			);
			expect(failures()).toEqual([
				expect.objectContaining({
					via: "ws",
					clientId: opened?.clientId,
					reason: "token_no_longer_valid",
					tokenStatus: "revoked",
				}),
			]);
		});

		it("records the token's use at most once a minute while frames keep arriving", async () => {
			// Only Date is faked. vi.waitFor still moves it on by its polling
			// interval, so the times below are bounds rather than exact instants.
			vi.useFakeTimers({ toFake: ["Date"] });
			const start = Date.parse("2026-09-01T09:00:00.000Z");
			vi.setSystemTime(start);
			const paired = createToken(dbs.meta, {
				label: "browser",
				expiresAt: new Date(start + 86_400_000).toISOString(),
			});
			const { ws, observed } = await connect(paired.token);
			const authenticatedAt = lastUsedAt(paired.id);
			expect(Date.parse(authenticatedAt ?? "")).toBeLessThan(start + 30_000);

			vi.setSystemTime(start + 30_000);
			await ping(ws, observed);
			expect(lastUsedAt(paired.id)).toBe(authenticatedAt);

			// Past the interval the socket's activity counts as use again, and slides
			// the expiry as a REST request would.
			vi.setSystemTime(start + 61_000);
			await ping(ws, observed);
			expect(Date.parse(lastUsedAt(paired.id) ?? "")).toBeGreaterThanOrEqual(start + 61_000);
		});
	});
});
