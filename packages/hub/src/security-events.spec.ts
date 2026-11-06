import { generateKeyPairSync } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { format } from "node:util";
import {
	type AuthPromptMessage,
	decodeMessage,
	encodeFrame,
	encodeMessage,
	type HelloMessage,
	type Host,
	isValidUlid,
	type ProtocolMessage,
} from "@lasterm/shared";
import type { FastifyInstance, LogLevel } from "fastify";
import { Server as SshServer, utils as sshUtils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBootAssetToken } from "./asset-token.js";
import { createToken, revokeToken } from "./auth.js";
import { HubLogger } from "./logging/hub-logger.js";
import { SecurityLog } from "./logging/security-log.js";
import { createServer, startServer as listen } from "./server.fixture.js";
import type { SharedSessionContext } from "./session/session-context.js";
import type { WsClient } from "./session/session-manager.js";
import { SshConnectionManager } from "./session/ssh-connection-manager.js";
import { fingerprintOf } from "./ssh/fingerprint.js";
import { type DatabaseManager, openTestDatabases } from "./storage/db.js";
import { MetaDAL } from "./storage/meta.js";
import { getTestTls } from "./test-tls.fixture.js";

// ─── Mock agents so no real PTY / SSH is spawned ─────────────────────────────

/** What the mocked agent says its environment is, when asked (#576). */
const agentEnvironment = vi.hoisted(() => ({ env: {} as Record<string, string> }));
/** The directory the mocked agent says its terminal is in, once spawned (#834). */
const agentCwd = vi.hoisted(() => ({ dir: null as string | null }));

vi.mock("./session/ssh-agent.js", () => {
	const { EventEmitter } = require("node:events");
	class MockSshAgent extends EventEmitter {
		connected = true;
		helloMessage = {
			type: "HELLO",
			version: 1,
			agentVersion: "0.0.0",
			capabilities: ["env-modes", "cwd"],
		};
		start = vi.fn().mockResolvedValue(undefined);
		send = vi.fn((msg: { type: string; requestId?: string; channelId?: string }) => {
			if (msg.type === "SPAWN") {
				const channelId = "01HZZZZZZZZZZZZZZZZZZZZZZY";
				setImmediate(() => {
					this.emit("message", { type: "SPAWN_OK", requestId: msg.requestId, channelId });
					const dir = agentCwd.dir;
					if (dir === null) return;
					// Where it starts, then where its shell says it went.
					this.emit("message", { type: "CWD_CHANGE", channelId, cwd: dir, source: "start" });
					this.emit("message", {
						type: "CWD_CHANGE",
						channelId,
						cwd: `${dir}/sub`,
						source: "shell",
						atPrompt: false,
						foreground: "vim",
					});
				});
			} else if (msg.type === "ATTACH") {
				setImmediate(() =>
					this.emit("message", {
						type: "ATTACH_OK",
						channelId: msg.channelId,
						requestId: msg.requestId,
						snapshot: { serialized: "", cols: 80, rows: 24, cursorX: 0, cursorY: 0 },
						lastSeq: 0,
					}),
				);
			} else if (msg.type === "ENV_QUERY") {
				setImmediate(() =>
					this.emit("message", {
						type: "ENV",
						requestId: msg.requestId,
						env: agentEnvironment.env,
						os: "linux",
					}),
				);
			}
		});
		close = vi.fn(() => {
			this.connected = false;
			this.emit("close");
		});
	}
	return { SshAgent: MockSshAgent };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PRIMARY_TOKEN = "5a".repeat(32);
const WRONG_TOKEN = "c7".repeat(32);

/**
 * The events as a reader finds them: written by the hub's own logger to
 * `hub.jsonl`, and read back as text. Asserting on the file, not on the
 * objects handed to it, is what shows a secret never reaches the log.
 */
class LogFile {
	readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-security-events-"));
	private readonly hubLog = new HubLogger(this.dir, {
		level: "info",
		format: "jsonl",
		output: "file",
		maxAgeDays: 30,
		maxSizeMb: 50,
	});
	readonly securityLog = new SecurityLog((msg, fields) =>
		this.hubLog.logAlways("info", msg, fields),
	);

	text(): string {
		const file = path.join(this.dir, "hub.jsonl");
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	}

	events(event?: string): Record<string, unknown>[] {
		return this.text()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((entry) => event === undefined || entry.event === event);
	}

	remove(): void {
		fs.rmSync(this.dir, { recursive: true, force: true });
	}
}

function startServer(dbs: DatabaseManager, log: LogFile, authToken = PRIMARY_TOKEN) {
	return createServer({
		tls: getTestTls(),
		logger: false,
		dbManager: dbs,
		skipShellDiscovery: true,
		authToken,
		authConfig: { tokenTtlDays: 90 },
		securityLog: log.securityLog,
	});
}

type InjectedSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

/** An injected socket has no TCP peer; this gives it the loopback one a browser has. */
async function openSocket(server: FastifyInstance): Promise<InjectedSocket> {
	await server.ready();
	return server.injectWS("/ws", { socket: { remoteAddress: "127.0.0.1" } } as never);
}

function nextMessage(ws: InjectedSocket): Promise<ProtocolMessage> {
	return new Promise((resolve) => {
		ws.once("message", (data: unknown) => resolve(decodeMessage(new Uint8Array(data as Buffer))));
	});
}

let dbs: DatabaseManager;
let log: LogFile;
let server: FastifyInstance;

beforeEach(async () => {
	dbs = openTestDatabases();
	log = new LogFile();
	server = await startServer(dbs, log);
});

afterEach(async () => {
	await server.close();
	dbs.close();
	log.remove();
});

// ─── Authentication over REST ─────────────────────────────────────────────────

describe("REST authentication is recorded", () => {
	it("records each failure with its reason and address, and never the token offered", async () => {
		await server.inject({ method: "GET", url: "/api/hosts" });
		await server.inject({
			method: "GET",
			url: "/api/hosts",
			headers: { authorization: `Basic ${WRONG_TOKEN}` },
		});
		const invalid = await server.inject({
			method: "GET",
			url: "/api/hosts",
			headers: { authorization: `Bearer ${WRONG_TOKEN}` },
		});
		expect(invalid.statusCode).toBe(401);

		expect(log.events("auth.failure")).toEqual([
			expect.objectContaining({ via: "rest", sourceIp: "127.0.0.1", reason: "missing_header" }),
			expect.objectContaining({ via: "rest", sourceIp: "127.0.0.1", reason: "malformed_header" }),
			expect.objectContaining({ via: "rest", sourceIp: "127.0.0.1", reason: "invalid_token" }),
		]);
		expect(log.events("auth.failure").every((entry) => entry.lvl === "info")).toBe(true);
		expect(log.text()).not.toContain(WRONG_TOKEN);
		expect(log.text()).not.toContain(PRIMARY_TOKEN);
	});

	it("says which way a refused token was invalid", async () => {
		const revoked = createToken(dbs.meta, { label: "browser", expiresAt: null });
		revokeToken(dbs.meta, revoked.id);
		for (const token of [WRONG_TOKEN, revoked.token]) {
			const res = await server.inject({
				method: "GET",
				url: "/api/hosts",
				headers: { authorization: `Bearer ${token}` },
			});
			expect(res.statusCode).toBe(401);
		}

		expect(log.events("auth.failure")).toEqual([
			expect.objectContaining({ via: "rest", reason: "invalid_token", tokenStatus: "unknown" }),
			expect.objectContaining({ via: "rest", reason: "invalid_token", tokenStatus: "revoked" }),
		]);
		expect(log.text()).not.toContain(revoked.token);
	});

	it("records the first success of a credential from an address, not every request", async () => {
		for (let i = 0; i < 3; i++) {
			const res = await server.inject({
				method: "GET",
				url: "/api/hosts",
				headers: { authorization: `Bearer ${PRIMARY_TOKEN}` },
			});
			expect(res.statusCode).toBe(200);
		}

		expect(log.events("auth.success")).toEqual([
			expect.objectContaining({ via: "rest", sourceIp: "127.0.0.1", tokenId: "primary" }),
		]);
		expect(log.text()).not.toContain(PRIMARY_TOKEN);
	});
});

// ─── Authentication over the WebSocket ────────────────────────────────────────

describe("WebSocket authentication is recorded", () => {
	it("records a refused AUTH with the connection and its address, not the token", async () => {
		const ws = await openSocket(server);
		const reply = nextMessage(ws);
		ws.send(encodeMessage({ type: "AUTH", token: WRONG_TOKEN }));
		expect((await reply).type).toBe("AUTH_FAIL");
		ws.terminate();

		const [failure] = log.events("auth.failure");
		expect(failure).toMatchObject({
			msg: "security: auth failure",
			via: "ws",
			sourceIp: "127.0.0.1",
			reason: "invalid_token",
			tokenStatus: "unknown",
		});
		expect(isValidUlid(failure?.clientId)).toBe(true);
		expect(log.text()).not.toContain(WRONG_TOKEN);
	});

	it("records an accepted AUTH with the connection it opened and the credential used", async () => {
		const ws = await openSocket(server);
		const reply = nextMessage(ws);
		ws.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
		const ok = await reply;
		expect(ok.type).toBe("AUTH_OK");
		ws.terminate();

		expect(log.events("auth.success")).toEqual([
			expect.objectContaining({
				via: "ws",
				sourceIp: "127.0.0.1",
				tokenId: "primary",
				clientId: (ok as { clientId: string }).clientId,
			}),
		]);
		expect(log.text()).not.toContain(PRIMARY_TOKEN);
	});
});

// ─── Pairing ──────────────────────────────────────────────────────────────────

describe("pairing is recorded without its code", () => {
	async function generateCode(): Promise<{ code: string; expires_at: string }> {
		const res = await server.inject({
			method: "POST",
			url: "/api/pair",
			headers: { authorization: `Bearer ${PRIMARY_TOKEN}` },
		});
		expect(res.statusCode).toBe(201);
		return res.json();
	}

	it("records a generated code by its record and expiry", async () => {
		const { code, expires_at } = await generateCode();

		const [generated] = log.events("pairing.generated");
		expect(generated).toMatchObject({ expiresAt: expires_at, sourceIp: "127.0.0.1" });
		expect(isValidUlid(generated?.pairingId)).toBe(true);
		expect(log.text()).not.toContain(code);
	});

	it("records a verified code with the credential it issued, and neither code nor token", async () => {
		const { code } = await generateCode();
		const res = await server.inject({
			method: "POST",
			url: "/api/pair/verify",
			payload: { code },
		});
		expect(res.statusCode).toBe(200);
		const { token } = res.json<{ token: string }>();

		const [generated] = log.events("pairing.generated");
		const [verified] = log.events("pairing.verified");
		expect(verified).toMatchObject({ pairingId: generated?.pairingId, sourceIp: "127.0.0.1" });
		expect(isValidUlid(verified?.tokenId)).toBe(true);
		expect(log.text()).not.toContain(code);
		expect(log.text()).not.toContain(token);
	});

	it("records a refused code as an authentication failure, and not the code tried", async () => {
		const { code } = await generateCode();
		const unknown = code === "00000000" ? "00000001" : "00000000";
		await server.inject({ method: "POST", url: "/api/pair/verify", payload: { code: unknown } });
		await server.inject({ method: "POST", url: "/api/pair/verify", payload: { code } });
		await server.inject({ method: "POST", url: "/api/pair/verify", payload: { code } });

		expect(log.events("auth.failure")).toEqual([
			expect.objectContaining({ via: "pair", sourceIp: "127.0.0.1", reason: "unknown_code" }),
			expect.objectContaining({ via: "pair", sourceIp: "127.0.0.1", reason: "code_used" }),
		]);
		expect(log.text()).not.toContain(code);
		expect(log.text()).not.toContain(unknown);
	});
});

// ─── Token rotation ───────────────────────────────────────────────────────────

describe("a replaced primary token is recorded", () => {
	it("says nothing on a first start or a restart with the same token", async () => {
		await server.close();
		server = await startServer(dbs, log);

		expect(log.events("token.rotate")).toEqual([]);
	});

	it("records a start whose auth.json token differs from the one last recorded", async () => {
		await server.close();
		server = await startServer(dbs, log, WRONG_TOKEN);

		expect(log.events("token.rotate")).toEqual([
			expect.objectContaining({ msg: "security: token rotated", tokenId: "primary" }),
		]);
		expect(log.text()).not.toContain(WRONG_TOKEN);
		expect(log.text()).not.toContain(PRIMARY_TOKEN);
	});
});

// ─── Token revocation ─────────────────────────────────────────────────────────

describe("a token revocation is recorded, refused or not", () => {
	function revoke(id: string) {
		return server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${id}`,
			headers: { authorization: `Bearer ${PRIMARY_TOKEN}` },
		});
	}

	it("records the credential asked for, from where, and what became of it, never a token", async () => {
		const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });

		expect((await revoke(paired.id)).statusCode).toBe(200);
		expect((await revoke(paired.id)).statusCode).toBe(404);
		expect((await revoke("primary")).statusCode).toBe(409);
		// A token's value where its id belongs: not found, and not written down.
		expect((await revoke(paired.token)).statusCode).toBe(404);

		expect(log.events("token.revoke")).toEqual([
			expect.objectContaining({
				lvl: "info",
				msg: "security: token revocation",
				tokenId: paired.id,
				byTokenId: "primary",
				sourceIp: "127.0.0.1",
				outcome: "revoked",
			}),
			expect.objectContaining({
				tokenId: paired.id,
				byTokenId: "primary",
				sourceIp: "127.0.0.1",
				outcome: "not_found",
			}),
			expect.objectContaining({
				tokenId: "primary",
				byTokenId: "primary",
				sourceIp: "127.0.0.1",
				outcome: "not_revocable",
			}),
			expect.objectContaining({
				tokenId: "<withheld>",
				byTokenId: "primary",
				sourceIp: "127.0.0.1",
				outcome: "not_found",
			}),
		]);
		expect(log.text()).not.toContain(paired.token);
		expect(log.text()).not.toContain(PRIMARY_TOKEN);
	});

	// Every local client connects from 127.0.0.1, so the address says nothing about
	// which of them asked; the credential it authenticated with does (#537).
	it("records which credential asked, by its id and never its value", async () => {
		const asker = createToken(dbs.meta, { label: "browser", expiresAt: null });
		const target = createToken(dbs.meta, { label: "another browser", expiresAt: null });

		const response = await server.inject({
			method: "DELETE",
			url: `/api/auth/tokens/${target.id}`,
			headers: { authorization: `Bearer ${asker.token}` },
		});

		expect(response.statusCode).toBe(200);
		expect(log.events("token.revoke")).toEqual([
			expect.objectContaining({
				tokenId: target.id,
				byTokenId: asker.id,
				sourceIp: "127.0.0.1",
				outcome: "revoked",
			}),
		]);
		expect(log.text()).not.toContain(asker.token);
		expect(log.text()).not.toContain(target.token);
	});

	it("records the revocation before the sockets it closes", async () => {
		const paired = createToken(dbs.meta, { label: "browser", expiresAt: null });
		const ws = await openSocket(server);
		const reply = nextMessage(ws);
		ws.send(encodeMessage({ type: "AUTH", token: paired.token }));
		expect((await reply).type).toBe("AUTH_OK");
		const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));

		expect((await revoke(paired.id)).statusCode).toBe(200);
		await closed;

		const sequence = log
			.events()
			.filter((entry) => entry.event === "token.revoke" || entry.event === "auth.failure")
			.map((entry) => `${entry.event} ${entry.outcome ?? entry.reason}`);
		expect(sequence).toEqual(["token.revoke revoked", "auth.failure token_no_longer_valid"]);
	});
});

// ─── Keystrokes ───────────────────────────────────────────────────────────────

describe("keystrokes leave no trace in the logs", () => {
	// Every keystroke is a frame. A line per frame at the default level, even one
	// naming only the frame's type, records when and how fast the user types.
	it("logs nothing at INFO or above for INPUT frames, and never their bytes", async () => {
		const typed = "typed-secret-4242";
		const channelId = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
		const hubLogger = new HubLogger(log.dir, {
			level: "info",
			format: "jsonl",
			output: "file",
			maxAgeDays: 30,
			maxSizeMb: 50,
		});
		const hub = await createServer({
			tls: getTestTls(),
			logger: false,
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
			securityLog: log.securityLog,
			hubLogger,
		});
		try {
			const lines: string[] = [];
			for (const level of ["fatal", "error", "warn", "info"] as const) {
				vi.spyOn(hub.log, level).mockImplementation(((...args: unknown[]) => {
					lines.push(`${level} ${JSON.stringify(args)}`);
				}) as never);
			}
			const ws = await openSocket(hub);
			const received: ProtocolMessage[] = [];
			ws.on("message", (data: unknown) => {
				received.push(decodeMessage(new Uint8Array(data as Buffer)));
			});
			ws.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "AUTH_OK")).toBe(true));
			const beforeTyping = lines.length;

			// One frame per key, as typed, then the whole string at once, as pasted.
			const frames = [...typed.split(""), typed];
			for (const text of frames) {
				ws.send(encodeMessage({ type: "INPUT", channelId, data: new TextEncoder().encode(text) }));
			}
			// Frames on a socket are handled in order, so the PONG shows every INPUT
			// before it went through the dispatcher.
			ws.send(encodeMessage({ type: "PING" }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "PONG")).toBe(true));
			ws.terminate();

			expect(lines.slice(beforeTyping)).toEqual([]);
			expect(lines.join("\n")).not.toContain(typed);
			expect(log.text()).not.toContain(typed);
		} finally {
			await hub.close();
		}
	});
});

// ─── Requests ─────────────────────────────────────────────────────────────────

/** Pino's numeric levels, as they appear in each line. */
const INFO = 30;
const WARN = 40;
const ERROR = 50;

/**
 * Fastify's own log as the desktop keeps it in `hub.log`: every line the
 * server writes, read back as the text it wrote. The keystroke spec above spies
 * on the server's logger, which a request's own child logger bypasses.
 */
class ServerLog {
	private readonly written: string[] = [];
	readonly destination = {
		write: (line: string) => {
			this.written.push(line);
		},
	};

	/** Where the lines of what a spec does next will start. */
	mark(): number {
		return this.written.length;
	}

	text(from = 0): string {
		return this.written.slice(from).join("");
	}

	entries(from = 0): Record<string, unknown>[] {
		return this.written.slice(from).map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	/** What a hub shipped at INFO would have written. */
	shipped(from = 0): Record<string, unknown>[] {
		return this.entries(from).filter((entry) => (entry.level as number) >= INFO);
	}
}

async function serverLoggingTo(serverLog: ServerLog, level: LogLevel): Promise<FastifyInstance> {
	const hub = await createServer({
		tls: getTestTls(),
		logger: { level, destination: serverLog.destination },
		dbManager: dbs,
		skipShellDiscovery: true,
		authToken: PRIMARY_TOKEN,
		authConfig: { tokenTtlDays: 90 },
		securityLog: log.securityLog,
	});
	// Routes a spec can fail on purpose, outside /api/ so no bearer is asked.
	hub.get("/spec/throws", async () => {
		throw new Error("spec: handler failed");
	});
	hub.get("/spec/unavailable", async (_request, reply) =>
		reply.code(503).send({ error: "SPEC_UNAVAILABLE" }),
	);
	// Two ways Fastify itself writes the raw URL into a message: a reply sent
	// twice, and a handler that returns a value after sending one.
	hub.get("/spec/sent-twice", (_request, reply) => {
		reply.send({ ok: true });
		reply.send({ ok: true });
	});
	hub.get("/spec/returns-after-send", async (_request, reply) => {
		reply.send({ ok: true });
		return { ok: true };
	});
	return hub;
}

const bearer = { authorization: `Bearer ${PRIMARY_TOKEN}` };

/** A terminal on the local host, and one on the remote host `remoteHostId`, as rows only. */
function terminalsOnLocalAndRemoteHosts(remoteHostId: string): { local: string; remote: string } {
	const dal = new MetaDAL(dbs.meta);
	const [local] = dal.listLocalHosts();
	if (!local) throw new Error("the hub made no local host");
	const ids = { local: "01K832F5000000000000000001", remote: "01K832F5000000000000000002" };
	for (const [hostId, channelId, session] of [
		[local.id, ids.local, "01K832F5SE5500000000000001"],
		[remoteHostId, ids.remote, "01K832F5SE5500000000000002"],
	] as const) {
		dal.createSession({ id: session, hostId, status: "active" });
		dal.createChannel({ id: channelId, sessionId: session, status: "live" });
	}
	return ids;
}

describe("routine requests leave no line at the shipped level", () => {
	// Fastify's own "incoming request" and "request completed" lines, two per
	// request at INFO, were most of the desktop's hub.log (#512).
	it("writes nothing at INFO or above for requests that succeed or miss", async () => {
		const serverLog = new ServerLog();
		const hub = await serverLoggingTo(serverLog, "info");
		try {
			await hub.ready();
			// What the hub writes at INFO does reach this log: its start is there.
			expect(serverLog.shipped()).toContainEqual(
				expect.objectContaining({ msg: "serving user fonts from config dir" }),
			);
			const from = serverLog.mark();
			const asset = `/public/fonts/missing.woff2?asset_token=${getBootAssetToken()}`;
			const hostId = new MetaDAL(dbs.meta).createHost({
				type: "ssh",
				label: "pi",
				sshHost: "pi@pi.local",
			}).id;
			// The settings page asks for a host's environment each time it shows
			// one (#576); a host with no agent connected answers 409.
			const environment = `/api/hosts/${hostId}/agent-environment?mode=inherit`;
			// A files panel lists its folder each time it opens or moves (#832):
			// found, missing, refused, or on a host not connected.
			const channels = terminalsOnLocalAndRemoteHosts(hostId);
			const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-routine-files-"));
			const filesOf = (channelId: string, query: string) =>
				hub.inject({
					method: "GET",
					url: `/api/channels/${channelId}/files${query}`,
					headers: bearer,
				});
			try {
				for (let i = 0; i < 3; i++) {
					expect((await hub.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
					const hosts = await hub.inject({ method: "GET", url: "/api/hosts", headers: bearer });
					expect(hosts.statusCode).toBe(200);
					expect((await hub.inject({ method: "GET", url: asset })).statusCode).toBe(404);
					expect((await hub.inject({ method: "GET", url: "/nowhere" })).statusCode).toBe(404);
					const unreached = await hub.inject({ method: "GET", url: environment, headers: bearer });
					expect(unreached.statusCode).toBe(409);
					const at = `?path=${encodeURIComponent(folder)}`;
					expect((await filesOf(channels.local, at)).statusCode).toBe(200);
					expect((await filesOf(channels.local, `${at}-missing`)).statusCode).toBe(404);
					expect((await filesOf(channels.local, "?path=relative")).statusCode).toBe(400);
					expect((await filesOf(channels.remote, "")).statusCode).toBe(409);
					const stat = `/api/channels/${channels.local}/files/stat${at}`;
					expect((await hub.inject({ method: "GET", url: stat, headers: bearer })).statusCode).toBe(
						200,
					);
				}
			} finally {
				fs.rmSync(folder, { recursive: true, force: true });
			}

			expect(serverLog.shipped(from)).toEqual([]);
		} finally {
			await hub.close();
		}
	});

	it("still writes a request the hub failed, with its error when one was thrown", async () => {
		const serverLog = new ServerLog();
		const hub = await serverLoggingTo(serverLog, "info");
		try {
			await hub.ready();
			const from = serverLog.mark();
			expect((await hub.inject({ method: "GET", url: "/spec/throws" })).statusCode).toBe(500);
			expect((await hub.inject({ method: "GET", url: "/spec/unavailable" })).statusCode).toBe(503);

			expect(serverLog.shipped(from)).toEqual([
				expect.objectContaining({
					level: ERROR,
					msg: "spec: handler failed",
					req: expect.objectContaining({ method: "GET", url: "/spec/throws" }),
					res: { statusCode: 500 },
					err: expect.objectContaining({ message: "spec: handler failed" }),
				}),
				expect.objectContaining({
					level: WARN,
					msg: "request failed",
					req: expect.objectContaining({ method: "GET", url: "/spec/unavailable" }),
					res: { statusCode: 503 },
				}),
			]);
		} finally {
			await hub.close();
		}
	});

	// Every request records its token's use. A store that can be read but not
	// written refuses each record, and a warning each time was a line per request.
	it("says once, not per request, that the store cannot record a token's use", async () => {
		const serverLog = new ServerLog();
		const hub = await serverLoggingTo(serverLog, "info");
		try {
			await hub.ready();
			const from = serverLog.mark();
			dbs.meta.pragma("query_only = ON");
			for (let i = 0; i < 4; i++) {
				const hosts = await hub.inject({ method: "GET", url: "/api/hosts", headers: bearer });
				expect(hosts.statusCode).toBe(200);
			}
			dbs.meta.pragma("query_only = OFF");
			expect(
				(await hub.inject({ method: "GET", url: "/api/hosts", headers: bearer })).statusCode,
			).toBe(200);

			expect(serverLog.shipped(from)).toEqual([
				expect.objectContaining({ level: WARN, tokenId: "primary" }),
				expect.objectContaining({ level: WARN, failed: 4 }),
			]);
		} finally {
			await hub.close();
		}
	});
});

describe("a host's environment leaves no trace in the logs (#576)", () => {
	// Tokens in an environment are common. The hub hands the variables to the
	// settings page and to nothing else: not its log, not the server's, at any
	// level — names included, since a name alone can say what a machine holds.
	it("logs neither the names nor the values an agent reports, at any level", async () => {
		const name = "LASTERM_SPEC_SECRET_NAME_4242";
		const value = "spec-secret-value-4242";
		agentEnvironment.env = { [name]: value, HOME: "/home/pi" };
		const serverLog = new ServerLog();
		const hubLogger = new HubLogger(log.dir, {
			level: "trace",
			format: "jsonl",
			output: "file",
			maxAgeDays: 30,
			maxSizeMb: 50,
		});
		const hub = await createServer({
			tls: getTestTls(),
			logger: { level: "trace", destination: serverLog.destination },
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
			securityLog: log.securityLog,
			hubLogger,
		});
		let ws: InjectedSocket | undefined;
		try {
			const hostId = new MetaDAL(dbs.meta).createHost({
				type: "ssh",
				label: "pi",
				sshHost: "pi@pi.local",
			}).id;
			// A terminal on the host is what connects its agent.
			ws = await openSocket(hub);
			const received: ProtocolMessage[] = [];
			ws.on("message", (data: unknown) => {
				received.push(decodeMessage(new Uint8Array(data as Buffer)));
			});
			ws.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "AUTH_OK")).toBe(true));
			ws.send(encodeMessage({ type: "SPAWN", hostId, cols: 80, rows: 24 } as ProtocolMessage));
			await vi.waitFor(() => expect(received.some((m) => m.type === "SPAWN_OK")).toBe(true));
			const from = serverLog.mark();

			const res = await hub.inject({
				method: "GET",
				url: `/api/hosts/${hostId}/agent-environment?mode=inherit`,
				headers: bearer,
			});

			expect(res.statusCode).toBe(200);
			expect(res.json().env[name]).toBe(value);
			expect(serverLog.shipped(from)).toEqual([]);
			const text = `${serverLog.text()}\n${log.text()}`;
			expect(text).not.toContain(name);
			expect(text).not.toContain(value);
		} finally {
			ws?.terminate();
			await hub.close();
			agentEnvironment.env = {};
		}
	});
});

describe("the paths and names a client browses leave no trace in the logs (#832)", () => {
	// A path or a file name is the user's: what they keep where, and what they
	// call it. Neither reaches hub.log nor hub.jsonl, at any level, whatever
	// the request comes to.
	it("logs no path and no name, listed, read, created or refused", async () => {
		const folderName = "lasterm-spec-folder-4242";
		const fileName = "lasterm-spec-file-4242.txt";
		const newName = "lasterm-spec-new-4242";
		const serverLog = new ServerLog();
		const hubLogger = new HubLogger(log.dir, {
			level: "trace",
			format: "jsonl",
			output: "file",
			maxAgeDays: 30,
			maxSizeMb: 50,
		});
		const hub = await createServer({
			tls: getTestTls(),
			logger: { level: "trace", destination: serverLog.destination },
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
			securityLog: log.securityLog,
			hubLogger,
		});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-files-log-"));
		const folder = path.join(root, folderName);
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, fileName), "x");
		let ws: InjectedSocket | undefined;
		try {
			await hub.ready();
			const remoteHostId = new MetaDAL(dbs.meta).createHost({
				type: "ssh",
				label: "pi",
				sshHost: "pi@pi.local",
			}).id;
			const channels = terminalsOnLocalAndRemoteHosts(remoteHostId);
			// The window that holds the terminal's write lock.
			ws = await openSocket(hub);
			const received: ProtocolMessage[] = [];
			ws.on("message", (data: unknown) => {
				received.push(decodeMessage(new Uint8Array(data as Buffer)));
			});
			ws.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "AUTH_OK")).toBe(true));
			const clientId = (received.find((m) => m.type === "AUTH_OK") as { clientId: string })
				.clientId;
			ws.send(encodeMessage({ type: "WRITE_CLAIM", channelId: channels.local } as ProtocolMessage));
			ws.send(encodeMessage({ type: "PING" }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "PONG")).toBe(true));
			const from = serverLog.mark();

			const get = (channelId: string, route: string, at: string) =>
				hub.inject({
					method: "GET",
					url: `/api/channels/${channelId}/${route}?path=${encodeURIComponent(at)}&hidden=1`,
					headers: bearer,
				});
			const create = (at: string, headers: Record<string, string>) =>
				hub.inject({
					method: "POST",
					url: `/api/channels/${channels.local}/folders`,
					headers: { ...bearer, ...headers },
					payload: { path: at },
				});
			const statuses = [
				(await get(channels.local, "files", folder)).statusCode,
				(await get(channels.local, "files/stat", path.join(folder, fileName))).statusCode,
				(await get(channels.local, "files/free-space", folder)).statusCode,
				(await get(channels.local, "files", path.join(folder, fileName))).statusCode,
				(await get(channels.local, "files", path.join(folder, newName))).statusCode,
				(await get(channels.remote, "files", folder)).statusCode,
				(await create(path.join(folder, newName), { "x-lasterm-client-id": clientId })).statusCode,
				(await create(path.join(folder, newName), { "x-lasterm-client-id": clientId })).statusCode,
				(await create(path.join(folder, `${newName}-2`), {})).statusCode,
			];

			expect(statuses).toEqual([200, 200, 200, 409, 404, 409, 201, 409, 403]);
			expect(fs.statSync(path.join(folder, newName)).isDirectory()).toBe(true);
			expect(serverLog.shipped(from)).toEqual([]);
			const text = `${serverLog.text()}\n${log.text()}`;
			for (const name of [folderName, fileName, newName]) expect(text).not.toContain(name);
		} finally {
			ws?.terminate();
			await hub.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("a terminal's directory leaves no trace in the logs (#834)", () => {
	// A directory is user content: its name can say whose files, which client,
	// which project. The hub keeps it, relays it, and gives it in STATE_SYNC and
	// ATTACH_OK, and writes it to no log, at any level.
	it("logs no directory an agent reports, relayed, synced or attached", async () => {
		const dir = "/home/me/lasterm-spec-secret-dir-4242";
		agentCwd.dir = dir;
		const serverLog = new ServerLog();
		const hubLogger = new HubLogger(log.dir, {
			level: "trace",
			format: "jsonl",
			output: "file",
			maxAgeDays: 30,
			maxSizeMb: 50,
		});
		const hub = await createServer({
			tls: getTestTls(),
			logger: { level: "trace", destination: serverLog.destination },
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
			securityLog: log.securityLog,
			hubLogger,
		});
		const sockets: InjectedSocket[] = [];
		const connect = async (): Promise<ProtocolMessage[]> => {
			const ws = await openSocket(hub);
			sockets.push(ws);
			const received: ProtocolMessage[] = [];
			ws.on("message", (data: unknown) => {
				received.push(decodeMessage(new Uint8Array(data as Buffer)));
			});
			ws.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "STATE_SYNC")).toBe(true));
			return received;
		};
		try {
			const hostId = new MetaDAL(dbs.meta).createHost({
				type: "ssh",
				label: "pi",
				sshHost: "pi@pi.local",
			}).id;
			const first = await connect();
			sockets[0]?.send(
				encodeMessage({ type: "SPAWN", hostId, cols: 80, rows: 24 } as ProtocolMessage),
			);
			await vi.waitFor(() => expect(first.filter((m) => m.type === "CWD_CHANGE")).toHaveLength(2));

			// Another window: the directory in its STATE_SYNC, then in its ATTACH_OK.
			const second = await connect();
			const sync = second.find((m) => m.type === "STATE_SYNC");
			expect(JSON.stringify(sync)).toContain(`${dir}/sub`);
			sockets[1]?.send(encodeMessage({ type: "ATTACH", channelId: "01HZZZZZZZZZZZZZZZZZZZZZZY" }));
			await vi.waitFor(() =>
				expect(second.find((m) => m.type === "ATTACH_OK")).toMatchObject({
					cwd: `${dir}/sub`,
					cwdSource: "shell",
				}),
			);

			const text = `${serverLog.text()}\n${log.text()}`;
			expect(text).toContain("CWD_CHANGE");
			expect(text).not.toContain(dir);
		} finally {
			for (const ws of sockets) ws.terminate();
			await hub.close();
			agentCwd.dir = null;
		}
	});
});

describe("an upload's paths, names and chunks leave no trace in the logs (#833)", () => {
	// What someone sends to a host, and where, is theirs: no name or path reaches
	// hub.log or hub.jsonl, at any level. A chunk's route runs once a megabyte,
	// and the messages that follow an upload as often: nothing of either at INFO.
	it("logs no name and no path at any level, and nothing at INFO, started, sent, refused or in conflict", async () => {
		const folderName = "lasterm-upload-folder-4343";
		const fileName = "lasterm-upload-file-4343.bin";
		const takenName = "lasterm-upload-taken-4343.txt";
		const destName = "lasterm-upload-dest-4343";
		const serverLog = new ServerLog();
		const hubLogger = new HubLogger(log.dir, {
			level: "trace",
			format: "jsonl",
			output: "file",
			maxAgeDays: 30,
			maxSizeMb: 50,
		});
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-upload-log-"));
		const configDir = path.join(root, "config");
		fs.mkdirSync(configDir);
		fs.writeFileSync(path.join(configDir, "config.toml"), "[experimental]\nfile_transfer = true\n");
		const dest = path.join(root, destName);
		fs.mkdirSync(dest);
		fs.writeFileSync(path.join(dest, takenName), "theirs");
		const hub = await createServer({
			tls: getTestTls(),
			logger: { level: "trace", destination: serverLog.destination },
			dbManager: dbs,
			skipShellDiscovery: true,
			authToken: PRIMARY_TOKEN,
			authConfig: { tokenTtlDays: 90 },
			securityLog: log.securityLog,
			hubLogger,
			configDir,
		});
		let ws: InjectedSocket | undefined;
		try {
			await hub.ready();
			const remoteHostId = new MetaDAL(dbs.meta).createHost({
				type: "ssh",
				label: "pi",
				sshHost: "pi@pi.local",
			}).id;
			const channels = terminalsOnLocalAndRemoteHosts(remoteHostId);
			ws = await openSocket(hub);
			const received: Record<string, unknown>[] = [];
			ws.on("message", (data: unknown) => {
				received.push(decodeMessage(new Uint8Array(data as Buffer)) as never);
			});
			ws.send(encodeMessage({ type: "AUTH", token: PRIMARY_TOKEN }));
			await vi.waitFor(() => expect(received.some((m) => m.type === "AUTH_OK")).toBe(true));
			const clientId = (received.find((m) => m.type === "AUTH_OK") as { clientId: string })
				.clientId;
			const from = serverLog.mark();
			const start = (requestId: string, items: unknown[]) =>
				ws?.send(
					encodeMessage({
						type: "TRANSFER_START",
						requestId,
						channelId: channels.local,
						dir: dest,
						items,
						onConflict: "ask",
					} as never),
				);
			const answer = (requestId: string) =>
				vi.waitFor(() => {
					const found = received.find((m) => m.requestId === requestId);
					expect(found).toBeDefined();
					return found as Record<string, unknown>;
				});

			// Refused: a folder the upload does not name.
			start("refused", [{ relPath: `${folderName}/${fileName}`, kind: "file", size: 1 }]);
			expect((await answer("refused")).code).toBe("INVALID_ITEMS");

			const data = Buffer.alloc(3 * 1024 * 1024, 1);
			start("upload", [
				{ relPath: folderName, kind: "dir" },
				{ relPath: `${folderName}/${fileName}`, kind: "file", size: data.length },
				{ relPath: takenName, kind: "file", size: 3 },
			]);
			const accepted = await answer("upload");
			expect(accepted.type).toBe("TRANSFER_ACCEPTED");
			const transferId = accepted.transferId as string;
			await vi.waitFor(() =>
				expect(
					received.some(
						(m) =>
							m.type === "TRANSFER_PROGRESS" &&
							(m.items as { itemId: number; state: string }[]).some(
								(item) => item.itemId === 1 && item.state === "sending",
							),
					),
				).toBe(true),
			);
			const chunk = 1024 * 1024;
			for (let at = 0; at < data.length; at += chunk) {
				const put = await hub.inject({
					method: "PUT",
					url: `/api/transfers/${transferId}/items/1?offset=${at}`,
					headers: {
						...bearer,
						"content-type": "application/octet-stream",
						"x-lasterm-client-id": clientId,
					},
					payload: data.subarray(at, at + chunk),
				});
				expect(put.statusCode).toBe(200);
			}
			// One refused chunk, and the conflict answered.
			const wrong = await hub.inject({
				method: "PUT",
				url: `/api/transfers/${transferId}/items/2?offset=0`,
				headers: { ...bearer, "content-type": "application/octet-stream" },
				payload: Buffer.from("ours"),
			});
			expect(wrong.statusCode).toBe(403);
			ws.send(
				encodeMessage({
					type: "TRANSFER_RESOLVE",
					transferId,
					scope: "upload",
					action: "skip",
				} as never),
			);
			await vi.waitFor(() => expect(received.some((m) => m.type === "TRANSFER_DONE")).toBe(true));
			const listed = await hub.inject({
				method: "GET",
				url: `/api/transfers/${transferId}`,
				headers: bearer,
			});
			expect(listed.statusCode).toBe(200);
			expect(fs.readFileSync(path.join(dest, folderName, fileName))).toEqual(data);

			expect(serverLog.shipped(from)).toEqual([]);
			const text = `${serverLog.text()}\n${log.text()}`;
			for (const name of [folderName, fileName, takenName, destName]) {
				expect(text).not.toContain(name);
			}
		} finally {
			ws?.terminate();
			await hub.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("no logged request carries a secret, at any level", () => {
	it("withholds the asset token, query values and request headers from every line", async () => {
		const assetToken = getBootAssetToken();
		const typedSearch = "typed-search-4242";
		const serverLog = new ServerLog();
		const hub = await serverLoggingTo(serverLog, "trace");
		try {
			const address = await listen(hub, {});
			const withToken = `asset_token=${assetToken}`;
			for (const url of [
				`/public/fonts/missing.woff2?${withToken}`,
				`/nowhere?${withToken}`,
				`/spec/throws?${withToken}`,
				`/spec/sent-twice?${withToken}`,
				`/spec/returns-after-send?${withToken}`,
			]) {
				await hub.inject({ method: "GET", url });
			}
			await hub.inject({ method: "GET", url: `/api/hosts?q=${typedSearch}`, headers: bearer });

			// A request the HTTP parser refuses: Node hands Fastify the error with
			// the bytes it could not parse, which are the whole request.
			const port = new URL(address).port;
			await new Promise<void>((resolve) => {
				const socket = tls.connect({
					host: "127.0.0.1",
					port: Number(port),
					rejectUnauthorized: false,
				});
				socket.on("secureConnect", () => {
					socket.write(
						`GET /api/hosts?${withToken} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
							`Authorization: Bearer ${PRIMARY_TOKEN}\r\nnot a header\r\n\r\n`,
					);
				});
				socket.on("data", () => undefined);
				// The hub answers 400 and destroys the socket, which may arrive here
				// as a reset: either way the request has been refused.
				socket.on("error", () => undefined);
				socket.on("close", () => resolve());
			});
			await vi.waitFor(() =>
				expect(serverLog.entries().some((entry) => entry.msg === "client error")).toBe(true),
			);

			const text = serverLog.text();
			expect(text).not.toContain(assetToken);
			expect(text).not.toContain(typedSearch);
			expect(text).not.toContain(PRIMARY_TOKEN);
			const entries = serverLog.entries();
			const clientError = entries.find((entry) => entry.msg === "client error");
			expect(clientError?.err).not.toHaveProperty("rawPacket");
			// What was withheld is said to be, where it was.
			expect(entries).toContainEqual(
				expect.objectContaining({
					msg: "incoming request",
					req: expect.objectContaining({
						url: "/public/fonts/missing.woff2?asset_token=[redacted]",
					}),
				}),
			);
			expect(entries).toContainEqual(
				expect.objectContaining({
					req: expect.objectContaining({ url: "/api/hosts?q=[redacted]" }),
				}),
			);
			// Fastify composed these around the raw URL; they are here, and redacted.
			expect(text).toContain("/spec/sent-twice?asset_token=[redacted]");
			expect(text).toContain("/spec/returns-after-send?asset_token=[redacted]");
		} finally {
			await hub.close();
		}
	});
});

// ─── SSH key passphrases ──────────────────────────────────────────────────────

/**
 * Everything the process writes while it runs: the console, and stdout and
 * stderr underneath it. The desktop keeps the hub's stderr in `hub.log`.
 */
function captureOutput(): { text: () => string; restore: () => void } {
	const written: string[] = [];
	const spies = [
		...(["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				written.push(format(...args));
			}),
		),
		...[process.stdout, process.stderr].map((stream) =>
			vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
				written.push(String(chunk));
				return true;
			}) as never),
		),
	];
	return {
		text: () => written.join("\n"),
		restore: () => {
			for (const spy of spies) spy.mockRestore();
		},
	};
}

describe("an SSH key's passphrase leaves no trace in the logs (#644)", () => {
	// A passphrase's length narrows a brute-force search as surely as its value
	// gives it away. Both lengths are four digits that no timestamp holds, and
	// they differ, so a count of bytes is caught as well as one of characters.
	//
	// And the passphrase fits in 1024 bytes. From Node 24.20, an encrypted PKCS#1
	// key is written through OpenSSL's encoder, which asks for the passphrase
	// with a PEM_BUFSIZE (1024-byte) buffer and silently keeps only what fits
	// (ossl_pw_get_passphrase): a longer one encrypts the key under its first
	// 1024 bytes, which ssh2, hashing all of it, then cannot decrypt.
	const fragment = "spec-passphrase-644-";
	const passphrase = `${"é".repeat(8)}${fragment.repeat(60)}`.slice(0, 1009);
	// A wrong one is typed first, and asked for again (#812): it leaves no
	// more trace than the right one.
	const wrongFragment = "spec-wrong-passphrase-812-";
	const wrong = `${"ü".repeat(5)}${wrongFragment.repeat(40)}`.slice(0, 1013);
	const lengths = [
		passphrase.length,
		Buffer.byteLength(passphrase),
		wrong.length,
		Buffer.byteLength(wrong),
	];

	it("logs neither passphrase nor its length, asked for, asked again or remembered", async () => {
		expect(lengths).toEqual([1009, 1017, 1013, 1018]);
		const { buildSshConnectConfig } =
			await vi.importActual<typeof import("./session/ssh-agent.js")>("./session/ssh-agent.js");
		const keyPath = path.join(log.dir, "id_rsa");
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "pkcs1", format: "pem" },
			privateKeyEncoding: { type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase },
		});
		fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });

		const hostId = "spec-host";
		const sent: AuthPromptMessage[] = [];
		const client = {
			id: "spec-client",
			send: (msg: AuthPromptMessage) => sent.push(msg),
		} as unknown as WsClient;
		const ctx = {
			passphraseCache: new Map(),
			promptContexts: new Map(),
			promptIndex: new Map(),
			pendingPrompts: new Map(),
			clients: new Map([[client.id, client]]),
			channels: new Map(),
			acquisitions: new Map(),
			hubLogger: new HubLogger(log.dir, {
				level: "trace",
				format: "jsonl",
				output: "file",
				maxAgeDays: 30,
				maxSizeMb: 50,
			}),
		} as unknown as SharedSessionContext;
		const manager = new SshConnectionManager(ctx, null as never, null as never, null as never);
		const promptAuth = manager.buildPromptAuth(client);
		const connect = () =>
			buildSshConnectConfig({ method: "key", keyPath }, "pi.local", 22, "pi", promptAuth, hostId);

		const output = captureOutput();
		try {
			// Asked for: the person types a wrong one first, and asks the hub to
			// remember it.
			const asked = connect();
			await vi.waitFor(() => expect(sent).toHaveLength(1));
			const first = sent[0] as AuthPromptMessage;
			expect(first).toMatchObject({ type: "AUTH_PROMPT", hostId, promptType: "passphrase" });
			manager.handleAuthPromptResponse(client.id, {
				hostId,
				secret: wrong,
				rememberSession: true,
				promptId: first.promptId,
				deliveryEpoch: first.deliveryEpoch,
			});
			// Asked again, saying so: the right one this time.
			await vi.waitFor(() => expect(sent).toHaveLength(2));
			const prompt = sent[1] as AuthPromptMessage;
			expect(prompt).toMatchObject({ type: "AUTH_PROMPT", hostId, promptType: "passphrase" });
			expect(prompt.message).toMatch(/^Wrong passphrase/);
			manager.handleAuthPromptResponse(client.id, {
				hostId,
				secret: passphrase,
				rememberSession: true,
				promptId: prompt.promptId,
				deliveryEpoch: prompt.deliveryEpoch,
			});
			expect((await asked).passphrase).toBe(passphrase);
			// Remembered: the next connection takes it from the cache, unasked.
			expect((await connect()).passphrase).toBe(passphrase);
			expect(sent).toHaveLength(2);
		} finally {
			output.restore();
		}

		const text = `${output.text()}\n${log.text()}`;
		// The path was heard, and says whether it has a passphrase.
		expect(text).toContain("[lasterm-ssh] passphrase obtained: yes");
		expect(text).toContain("[lasterm-ssh] key decryption failed, asking again");
		expect(text).toContain("[lasterm-ssh] returning cached passphrase");
		// Neither passphrase, nor any piece of one, nor a length.
		expect(text).not.toContain(fragment);
		expect(text).not.toContain(wrongFragment);
		for (const length of lengths) {
			expect(text).not.toMatch(new RegExp(`(?<![0-9A-Za-z])${length}(?!\\d)`));
		}
	});
});

describe("an SSH password leaves no trace in the logs, refused or taken (#815)", () => {
	// As for a passphrase: four-digit lengths no timestamp holds, a count of
	// characters and one of bytes for each.
	const fragment = "spec-password-815-";
	const password = `${"é".repeat(6)}${fragment.repeat(60)}`.slice(0, 1061);
	const wrongFragment = "spec-wrong-password-815-";
	const wrong = `${"ü".repeat(4)}${wrongFragment.repeat(50)}`.slice(0, 1051);
	const lengths = [
		password.length,
		Buffer.byteLength(password),
		wrong.length,
		Buffer.byteLength(wrong),
	];

	it("logs neither password nor its length, and keeps none, when one is refused", async () => {
		expect(lengths).toEqual([1061, 1067, 1051, 1055]);
		const { SshAgent } =
			await vi.importActual<typeof import("./session/ssh-agent.js")>("./session/ssh-agent.js");
		const { privateKey: hostKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "pkcs1", format: "pem" },
			privateKeyEncoding: { type: "pkcs1", format: "pem" },
		});
		const parsedKey = sshUtils.parseKey(hostKey);
		if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error("invalid key");
		const hello: HelloMessage = {
			type: "HELLO",
			version: 1,
			agentVersion: "0.0.0-test",
			capabilities: [],
		};
		// Takes this password and nothing else, then runs an agent that says HELLO.
		const server = new SshServer({ hostKeys: [hostKey] }, (conn) => {
			conn.on("error", () => {});
			conn.on("authentication", (ctx) => {
				if (ctx.method === "password" && ctx.password === password) ctx.accept();
				else ctx.reject(["password"]);
			});
			conn.on("ready", () => {
				conn.on("session", (accept) => {
					accept().on("exec", (acceptExec) => {
						acceptExec().write(Buffer.from(encodeFrame(hello)));
					});
				});
			});
		});
		server.on("error", () => {});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;

		const hostId = "spec-password-host";
		const sent: AuthPromptMessage[] = [];
		const client = {
			id: "spec-client",
			send: (msg: AuthPromptMessage) => sent.push(msg),
		} as unknown as WsClient;
		const ctx = {
			passphraseCache: new Map(),
			promptContexts: new Map(),
			promptIndex: new Map(),
			pendingPrompts: new Map(),
			clients: new Map([[client.id, client]]),
			channels: new Map(),
			acquisitions: new Map(),
			hubLogger: new HubLogger(log.dir, {
				level: "trace",
				format: "jsonl",
				output: "file",
				maxAgeDays: 30,
				maxSizeMb: 50,
			}),
		} as unknown as SharedSessionContext;
		const manager = new SshConnectionManager(ctx, null as never, null as never, null as never);
		const agent = new SshAgent(
			{
				id: hostId,
				type: "ssh",
				label: "spec",
				sshHost: "127.0.0.1",
				sshPort: port,
				sshUser: "pi",
				sshAuth: "password",
			} as Host,
			manager.buildPromptAuth(client),
		);
		const answer = (prompt: AuthPromptMessage, secret: string) =>
			manager.handleAuthPromptResponse(client.id, {
				hostId,
				secret,
				// Asked to remember it: a password is kept all the same nowhere.
				rememberSession: true,
				promptId: prompt.promptId,
				deliveryEpoch: prompt.deliveryEpoch,
			});

		const output = captureOutput();
		try {
			const started = agent.start(fingerprintOf(parsedKey.getPublicSSH()));
			// A wrong one first, which the server refuses.
			await vi.waitFor(() => expect(sent).toHaveLength(1));
			answer(sent[0] as AuthPromptMessage, wrong);
			// Asked again, saying so: the right one this time.
			await vi.waitFor(() => expect(sent).toHaveLength(2));
			expect((sent[1] as AuthPromptMessage).message).toBe(
				"Wrong password for pi@127.0.0.1. Try again.",
			);
			answer(sent[1] as AuthPromptMessage, password);
			expect((await started).hello.type).toBe("HELLO");
		} finally {
			output.restore();
			await agent.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}

		expect(ctx.passphraseCache.size).toBe(0);
		const text = `${output.text()}\n${log.text()}`;
		// The path was heard, and says whether there is one.
		expect(text).toContain("[lasterm-ssh] the server refused the password for pi@127.0.0.1");
		expect(text).toContain("[lasterm-ssh] password obtained: yes");
		// Neither password, nor any piece of one, nor a length.
		expect(text).not.toContain(fragment);
		expect(text).not.toContain(wrongFragment);
		for (const length of lengths) {
			expect(text).not.toMatch(new RegExp(`(?<![0-9A-Za-z])${length}(?!\\d)`));
		}
	});
});
