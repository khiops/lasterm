import {
	type AuthOkMessage,
	decodeMessage,
	encodeMessage,
	type ProtocolMessage,
} from "@lasterm/shared";
import { encode } from "@msgpack/msgpack";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken, PRIMARY_TOKEN_ID, revokeToken } from "../auth.js";
import { type SecurityFields, SecurityLog } from "../logging/security-log.js";
import { createServer } from "../server.fixture.js";
import type { SharedSessionContext } from "../session/session-context.js";
import { SessionManager } from "../session/session-manager.js";
import { WriteLockManager } from "../session/write-lock.js";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { getTestTls } from "../test-tls.fixture.js";
import { TransferService } from "../transfers/transfer-service.js";
import {
	WS_CLOSE_INTERNAL_ERROR,
	WS_CLOSE_POLICY_VIOLATION,
	WS_CLOSE_TRY_AGAIN_LATER,
} from "./ws-handler.js";

const TEST_TOKEN = "a".repeat(64);
const CHANNEL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WINDOW_1 = "01HZZZZZZZZZZZZZZZZZZZZZW1";
const WINDOW_2 = "01HZZZZZZZZZZZZZZZZZZZZZW2";

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
function failTokenStore(dbs: DatabaseManager) {
	const prepare = dbs.meta.prepare.bind(dbs.meta);
	return vi.spyOn(dbs.meta, "prepare").mockImplementation(((sql: string) => {
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
		// The primary too: REST takes it without the store, but everything a socket
		// serves after AUTH_OK reads meta.db, so a socket waits for the store.
		it.each(["primary", "paired"] as const)(
			"closes with Try Again Later, and no AUTH_FAIL, while the store cannot be read (%s token)",
			async (which) => {
				const token =
					which === "primary"
						? TEST_TOKEN
						: createToken(dbs.meta, { label: "browser", expiresAt: null }).token;
				const warnings = vi.spyOn(server.log, "warn");
				const outage = failTokenStore(dbs);
				const ws = await server.injectWS("/ws");
				const observed = observe(ws);

				ws.send(encodeMessage({ type: "AUTH", token }));

				// AUTH_FAIL is how a client learns to discard its token and pair again;
				// a store that could not answer has said nothing about the token.
				expect(await closeOf(observed)).toEqual({
					code: WS_CLOSE_TRY_AGAIN_LATER,
					reason: "AUTH_UNAVAILABLE",
				});
				expect(observed.messages).toEqual([]);
				expect(failures()).toEqual([]);

				// The socket was refused, so the outage counts it when the store answers.
				outage.mockRestore();
				await connect(TEST_TOKEN);
				expect(warnings).toHaveBeenCalledWith({ refused: 1 }, expect.stringContaining("answering"));
			},
		);

		// A socket the hub refused is done with. What it sends while it closes is
		// not acted on, and its AUTH deadline passing later, before its
		// close handshake ends or after the hub stopped, is not a second failure.
		// It used to log `auth_timeout` for it (#571).
		it.each([
			// With the store still failing, a second AUTH would prove nothing: a
			// PING acted on would be refused as not AUTH first, and logged.
			["the store cannot be read", { type: "AUTH", token: TEST_TOKEN }, { type: "PING" }, []],
			[
				"the token is unknown",
				{ type: "AUTH", token: "b".repeat(64) },
				{ type: "AUTH", token: TEST_TOKEN },
				[expect.objectContaining({ reason: "invalid_token", tokenStatus: "unknown" })],
			],
			[
				"its first frame is not AUTH",
				{ type: "PING" },
				{ type: "AUTH", token: TEST_TOKEN },
				[expect.objectContaining({ reason: "not_auth_first" })],
			],
		] as const)(
			"acts on nothing more, and logs no AUTH timeout, for a socket it refused because %s",
			async (why, refused, then, logged) => {
				vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
				if (why === "the store cannot be read") failTokenStore(dbs);
				const ws = await server.injectWS("/ws");
				const observed = observe(ws);
				ws.send(encodeMessage(refused as ProtocolMessage));
				ws.send(encodeMessage(then as ProtocolMessage));
				await vi.waitFor(() => expect(ws.readyState).not.toBe(ws.OPEN));

				// Past the hub's 10 s AUTH deadline.
				vi.advanceTimersByTime(10_000);

				expect(observed.types()).not.toContain("AUTH_OK");
				expect(security.filter((fields) => fields.event === "auth.success")).toEqual([]);
				expect(failures()).toEqual(logged);
			},
		);

		// A client takes an ERROR without its SPAWN's request id as about
		// something else only from a hub that says it echoes one (#777).
		it("says in AUTH_OK that it echoes a SPAWN's request id", async () => {
			const { observed } = await connect(TEST_TOKEN);

			expect(observed.messages.find((msg) => msg.type === "AUTH_OK")).toMatchObject({
				echoesSpawnRequestId: true,
			});
		});

		// A write lock's holder coming back from a reload is recognised by its
		// window, under its token (#846): two windows of one token are two
		// windows, and a window id under another token is another window.
		it("tells the write lock which window each socket belongs to, under its token", async () => {
			const identify = vi.spyOn(WriteLockManager.prototype, "identify");
			const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
			const clientIdOf = async (token: string, windowId?: string): Promise<string> => {
				const ws = await server.injectWS("/ws");
				const observed = observe(ws);
				ws.send(
					encodeMessage({ type: "AUTH", token, ...(windowId !== undefined && { windowId }) }),
				);
				await vi.waitFor(() => expect(observed.types()).toContain("AUTH_OK"));
				const ok = observed.messages.find((msg) => msg.type === "AUTH_OK");
				return (ok as AuthOkMessage).clientId;
			};

			const desktop = await clientIdOf(TEST_TOKEN, WINDOW_1);
			const desktopOther = await clientIdOf(TEST_TOKEN, WINDOW_2);
			const browser = await clientIdOf(paired.token, WINDOW_1);
			// Accepted all the same, as a client older than window ids is.
			await clientIdOf(TEST_TOKEN);
			await clientIdOf(TEST_TOKEN, "not-a-window-id");

			expect(identify.mock.calls).toEqual([
				[desktop, { tokenId: PRIMARY_TOKEN_ID, windowId: WINDOW_1 }],
				[desktopOther, { tokenId: PRIMARY_TOKEN_ID, windowId: WINDOW_2 }],
				[browser, { tokenId: paired.id, windowId: WINDOW_1 }],
			]);
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

		it.each(["primary", "paired"] as const)(
			"closes with Try Again Later when the store stops answering mid-session (%s token)",
			async (which) => {
				const token =
					which === "primary"
						? TEST_TOKEN
						: createToken(dbs.meta, { label: "browser", expiresAt: null }).token;
				const { ws, observed } = await connect(token);

				failTokenStore(dbs);
				ws.send(encodeMessage({ type: "PING" }));

				expect(await closeOf(observed)).toEqual({
					code: WS_CLOSE_TRY_AGAIN_LATER,
					reason: "AUTH_UNAVAILABLE",
				});
				expect(failures()).toEqual([]);
			},
		);

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

		it("keeps the primary token's sockets open when asked to revoke it, which it refuses", async () => {
			const desktop = await connect(TEST_TOKEN);

			const response = await server.inject({
				method: "DELETE",
				url: "/api/auth/tokens/primary",
				headers: { authorization: `Bearer ${TEST_TOKEN}` },
			});

			expect(response.statusCode).toBe(409);
			await ping(desktop.ws, desktop.observed);
			expect(failures()).toEqual([]);
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

	// A frame is untrusted input from a client that may not have authenticated.
	// Whatever it holds, it ends at most its own socket: an exception that left
	// the message listener used to stop the hub process.
	describe("a frame the hub cannot act on", () => {
		const boom = new Error("injected failure");

		/** The client id the hub gave a socket, from its AUTH_OK. */
		function clientIdOf(observed: Observed): string {
			const ok = observed.messages.find((message) => message.type === "AUTH_OK");
			return (ok as AuthOkMessage).clientId;
		}

		it.each([
			["a number", 123],
			["missing", undefined],
			["the primary token's bytes", new Uint8Array(Buffer.from(TEST_TOKEN))],
		] as const)(
			"refuses an AUTH whose token is %s, and serves the next socket",
			async (_what, token) => {
				const ws = await server.injectWS("/ws");
				const observed = observe(ws);

				ws.send(encode(token === undefined ? { type: "AUTH" } : { type: "AUTH", token }));

				await closeOf(observed);
				expect(observed.messages).toEqual([{ type: "AUTH_FAIL", message: "Invalid token" }]);
				expect(failures()).toEqual([
					expect.objectContaining({ via: "ws", reason: "invalid_token", tokenStatus: "unknown" }),
				]);
				await connect(TEST_TOKEN);
			},
		);

		it("leaves a second AUTH on an authenticated socket to the unhandled-type warning", async () => {
			const { ws, observed } = await connect(TEST_TOKEN);
			const warnings = vi.spyOn(server.log, "warn");

			ws.send(encodeMessage({ type: "AUTH" } as ProtocolMessage));
			await ping(ws, observed);

			expect(observed.types()).not.toContain("AUTH_FAIL");
			expect(warnings).toHaveBeenCalledWith(
				expect.objectContaining({ msgType: "AUTH" }),
				"ws: unhandled message type",
			);
		});

		const notProtocolFrames = [
			["null", null],
			["a number", 7],
			["an object with no type", {}],
			["an object whose type is a number", { type: 123 }],
		] as const;

		it.each(notProtocolFrames)(
			"answers a first frame that is %s as one that is not AUTH",
			async (_what, frame) => {
				const ws = await server.injectWS("/ws");
				const observed = observe(ws);

				ws.send(encode(frame));

				await closeOf(observed);
				expect(observed.messages).toEqual([
					{ type: "AUTH_FAIL", message: "First message must be AUTH" },
				]);
				expect(failures()).toEqual([expect.objectContaining({ reason: "not_auth_first" })]);
				await connect(TEST_TOKEN);
			},
		);

		it.each(notProtocolFrames)(
			"answers a frame that is %s after AUTH as malformed, and keeps the socket",
			async (_what, frame) => {
				const { ws, observed } = await connect(TEST_TOKEN);
				const warnings = vi.spyOn(server.log, "warn");
				const answered = observed.messages.length;

				ws.send(encode(frame));
				await ping(ws, observed);

				expect(observed.messages.slice(answered, -1)).toEqual([
					{ type: "ERROR", code: "MALFORMED_MESSAGE", message: "Not a protocol message" },
				]);
				expect(warnings).toHaveBeenCalledWith(
					{ clientId: clientIdOf(observed), byteLength: encode(frame).byteLength },
					"ws: not a protocol message",
				);
			},
		);

		it("checks a revoked token before it answers a frame as malformed", async () => {
			const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
			const { ws, observed } = await connect(paired.token);
			const answered = observed.messages.length;

			revokeToken(dbs.meta, paired.id);
			ws.send(encode(7));

			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_POLICY_VIOLATION,
				reason: "AUTH_REVOKED",
			});
			expect(observed.messages.slice(answered)).toEqual([]);
		});

		it("closes only the socket whose AUTH failed past AUTH_OK, and says why in the log", async () => {
			const witness = await connect(TEST_TOKEN);
			const errors = vi.spyOn(server.log, "error");
			vi.spyOn(SessionManager.prototype, "getStateSnapshot").mockImplementationOnce(() => {
				throw boom;
			});
			const ws = await server.injectWS("/ws");
			const observed = observe(ws);

			ws.send(encodeMessage({ type: "AUTH", token: TEST_TOKEN }));

			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_INTERNAL_ERROR,
				reason: "INTERNAL_ERROR",
			});
			expect(errors).toHaveBeenCalledTimes(1);
			expect(errors).toHaveBeenCalledWith(
				{ err: boom, clientId: clientIdOf(observed), msgType: "AUTH" },
				"ws: frame handling failed; closing socket",
			);
			await ping(witness.ws, witness.observed);
			await connect(TEST_TOKEN);
		});

		it("closes the socket whose frame a handler failed on", async () => {
			const { ws, observed } = await connect(TEST_TOKEN);
			const errors = vi.spyOn(server.log, "error");
			vi.spyOn(SessionManager.prototype, "handleDetach").mockImplementationOnce(() => {
				throw boom;
			});

			ws.send(encodeMessage({ type: "DETACH", channelId: CHANNEL_ID }));

			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_INTERNAL_ERROR,
				reason: "INTERNAL_ERROR",
			});
			expect(errors).toHaveBeenCalledWith(
				expect.objectContaining({ err: boom, msgType: "DETACH" }),
				"ws: frame handling failed; closing socket",
			);
			await connect(TEST_TOKEN);
		});

		it("still closes a revoked token's socket when releasing it throws, and releases the rest", async () => {
			const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
			const { ws, observed } = await connect(paired.token);
			vi.spyOn(SessionManager.prototype, "removeClient").mockImplementationOnce(() => {
				throw boom;
			});
			const gone = vi.spyOn(TransferService.prototype, "clientGone");

			revokeToken(dbs.meta, paired.id);
			ws.send(encodeMessage({ type: "PING" }));

			expect(await closeOf(observed)).toEqual({
				code: WS_CLOSE_POLICY_VIOLATION,
				reason: "AUTH_REVOKED",
			});
			expect(gone).toHaveBeenCalledWith(clientIdOf(observed));
			await connect(TEST_TOKEN);
		});

		it("closes every socket of a revoked token when releasing one of them throws", async () => {
			const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
			const first = await connect(paired.token);
			const second = await connect(paired.token);
			const errors = vi.spyOn(server.log, "error");
			const info = vi.spyOn(server.log, "info");
			vi.spyOn(SessionManager.prototype, "removeClient").mockImplementationOnce(() => {
				throw boom;
			});

			const response = await server.inject({
				method: "DELETE",
				url: `/api/auth/tokens/${paired.id}`,
				headers: { authorization: `Bearer ${TEST_TOKEN}` },
			});

			expect(response.statusCode).toBe(200);
			for (const socket of [first, second]) {
				expect(await closeOf(socket.observed)).toEqual({
					code: WS_CLOSE_POLICY_VIOLATION,
					reason: "AUTH_REVOKED",
				});
			}
			expect(errors).toHaveBeenCalledWith(
				expect.objectContaining({ err: boom, tokenId: paired.id }),
				expect.any(String),
			);
			expect(info).toHaveBeenCalledWith(
				{ tokenId: paired.id, closed: 2 },
				"ws-auth: closed the sockets of a revoked token",
			);
		});

		it("leaves no closed socket counted when a release step throws", async () => {
			const owner = "o".repeat(64);
			const ownedDbs = openTestDatabases();
			const owned = await createServer({
				tls: getTestTls(),
				logger: false,
				authToken: TEST_TOKEN,
				dbManager: ownedDbs,
				skipShellDiscovery: true,
				ownerToken: owner,
				onShutdown: vi.fn(),
				onQuit: vi.fn(),
				onQuitDelivered: vi.fn(),
			});
			try {
				await owned.ready();
				const open = async () => {
					const ws = await owned.injectWS("/ws");
					const observed = observe(ws);
					ws.send(encodeMessage({ type: "AUTH", token: TEST_TOKEN }));
					await vi.waitFor(() => expect(observed.types()).toContain("AUTH_OK"));
					return { ws, observed };
				};
				const caller = await open();
				const other = await open();
				vi.spyOn(WriteLockManager.prototype, "onClientDisconnect").mockImplementationOnce(() => {
					throw boom;
				});
				vi.spyOn(SessionManager.prototype, "handleDetach").mockImplementationOnce(() => {
					throw boom;
				});

				other.ws.send(encodeMessage({ type: "DETACH", channelId: CHANNEL_ID }));
				expect((await closeOf(other.observed)).code).toBe(WS_CLOSE_INTERNAL_ERROR);

				const response = await owned.inject({
					method: "POST",
					url: "/api/shutdown",
					headers: { "x-lasterm-owner": owner, "x-lasterm-client-id": clientIdOf(caller.observed) },
				});
				expect(response.statusCode).toBe(200);
			} finally {
				await owned.close();
				ownedDbs.close();
			}
		});
	});

	// A hub stopping closes its windows' sockets, and its shutdown ends every open
	// recording `interrupted`. A socket that ends before that shutdown detaches
	// from its terminals, a status write that can throw on meta.db. Thrown out of
	// the socket's listener, it is an uncaught exception: this hub installs no
	// handler for one, so the process ends there, before its shutdown (#80).
	// Vitest keeps the process up, which is why the tests watch the listener
	// itself. A socket the hub's own close ends here answers only after that
	// shutdown has cleared what it held, so the window ends its socket first, as
	// a window closing while the hub stops does.
	describe("when a window's detach cannot be written as the hub stops (#80)", () => {
		const CHANNEL = "01HZZZZZZZZZZZZZZZZZZZZZC1";

		async function recordedWindow(): Promise<{
			hub: FastifyInstance;
			hubDbs: DatabaseManager;
			ws: InjectedSocket;
			manager: SessionManager;
			clientId: string;
			id: string;
		}> {
			const hubDbs = openTestDatabases();
			const hub = await createServer({
				tls: getTestTls(),
				logger: false,
				authToken: TEST_TOKEN,
				dbManager: hubDbs,
				skipShellDiscovery: true,
			});
			await hub.ready();
			let manager: SessionManager | undefined;
			const addClient = SessionManager.prototype.addClient;
			vi.spyOn(SessionManager.prototype, "addClient").mockImplementation(function (
				this: SessionManager,
				client,
			) {
				manager = this;
				return addClient.call(this, client);
			});
			const ws = await hub.injectWS("/ws");
			const observed = observe(ws);
			ws.send(encodeMessage({ type: "AUTH", token: TEST_TOKEN }));
			await vi.waitFor(() => expect(observed.types()).toContain("AUTH_OK"));
			if (manager === undefined) throw new Error("no session manager");
			const clientId = (
				observed.messages.find((message) => message.type === "AUTH_OK") as AuthOkMessage
			).clientId;
			// The window shows a live terminal, which is being recorded.
			const { ctx } = manager as unknown as { ctx: SharedSessionContext };
			ctx.channels.set(CHANNEL, {
				sessionId: "01HZZZZZZZZZZZZZZZZZZZZZS1",
				hostId: "01HZZZZZZZZZZZZZZZZZZZZZH1",
				status: "live",
				clients: new Set([clientId]),
				cols: 80,
				rows: 24,
				dynamicTitle: null,
				processTitle: null,
				displayTitle: "bash",
			});
			ctx.clients.get(clientId)?.attachedChannels.add(CHANNEL);
			manager.recorder.startAutomatic({
				channelId: CHANNEL,
				hostId: "01HZZZZZZZZZZZZZZZZZZZZZH1",
				hostLabel: "box",
				cols: 80,
				rows: 24,
			});
			return { hub, hubDbs, ws, manager, clientId, id: manager.recordingIdOf(CHANNEL) ?? "" };
		}

		function failDetachWrite(): void {
			vi.spyOn(MetaDAL.prototype, "updateChannelStatus").mockImplementation(() => {
				throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
			});
		}

		// Mutation caught: the socket's "close" listener calling release() unguarded,
		// so the detach write's throw escapes it.
		it("logs a closed window's failed release by its code, and the stop still ends the recording interrupted", async () => {
			const { hub, hubDbs, ws, manager, clientId, id } = await recordedWindow();
			const { ctx } = manager as unknown as { ctx: SharedSessionContext };
			const escaped: unknown[] = [];
			const onUncaught = (err: unknown) => escaped.push(err);
			process.on("uncaughtException", onUncaught);
			try {
				const errors = vi.spyOn(hub.log, "error");
				failDetachWrite();
				ws.terminate();
				await vi.waitFor(() => expect(ctx.clients.has(clientId)).toBe(false));
				expect(vi.mocked(MetaDAL.prototype.updateChannelStatus)).toHaveBeenCalledWith(
					CHANNEL,
					"orphan",
					undefined,
					undefined,
				);
				expect(escaped).toEqual([]);
				expect(errors).toHaveBeenCalledWith(
					{ clientId, code: "SQLITE_IOERR" },
					"ws: releasing an ended socket failed",
				);
				vi.mocked(MetaDAL.prototype.updateChannelStatus).mockRestore();
				await hub.close();
				expect(manager.recorder.listed(id)?.end_reason).toBe("interrupted");
			} finally {
				process.off("uncaughtException", onUncaught);
				hubDbs.close();
			}
		});

		// The ws library emits "error" before "close" on a socket that fails; the
		// first releases it. Mutation caught: the "error" listener calling
		// release() unguarded, so the detach write's throw escapes it.
		it("releases a failing socket without throwing out of its error listener, and still ends the recording interrupted", async () => {
			const { hub, hubDbs, manager, clientId, id } = await recordedWindow();
			const { ctx } = manager as unknown as { ctx: SharedSessionContext };
			try {
				const errors = vi.spyOn(hub.log, "error");
				failDetachWrite();
				const [socket] = [...hub.websocketServer.clients];
				expect(() =>
					socket?.emit(
						"error",
						Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
					),
				).not.toThrow();
				expect(ctx.clients.has(clientId)).toBe(false);
				expect(errors).toHaveBeenCalledWith(
					{ clientId, code: "SQLITE_IOERR" },
					"ws: releasing an ended socket failed",
				);
				vi.mocked(MetaDAL.prototype.updateChannelStatus).mockRestore();
				await hub.close();
				expect(manager.recorder.listed(id)?.end_reason).toBe("interrupted");
			} finally {
				hubDbs.close();
			}
		});
	});
});
