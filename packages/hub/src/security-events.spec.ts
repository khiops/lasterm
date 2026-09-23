import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeMessage, encodeMessage, isValidUlid, type ProtocolMessage } from "@lasterm/shared";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToken, revokeToken } from "./auth.js";
import { HubLogger } from "./logging/hub-logger.js";
import { SecurityLog } from "./logging/security-log.js";
import { createServer } from "./server.fixture.js";
import { type DatabaseManager, openTestDatabases } from "./storage/db.js";
import { getTestTls } from "./test-tls.fixture.js";

// ─── Mock agents so no real PTY / SSH is spawned ─────────────────────────────

vi.mock("./session/ssh-agent.js", () => {
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
