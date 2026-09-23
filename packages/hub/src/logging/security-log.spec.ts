import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HubLogger } from "./hub-logger.js";
import { type SecurityFields, SecurityLog, WITHHELD } from "./security-log.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CLIENT = "01K5ZC0000000000000000C1A1";
const OTHER_CLIENT = "01K5ZC0000000000000000C2B2";
const HOST = "01K5ZC0000000000000000H057";
const CHANNEL = "01K5ZC0000000000000000CHAN";
const PAIRING = "01K5ZC0000000000000000PA1R";
const PAIRED_TOKEN_ID = "01K5ZC0000000000000000T0KN";

/** What § 7.2 says must never be written, in the shapes the hub handles them. */
const TOKEN = "3f".repeat(32);
const PAIRING_CODE = "84729316";
const SSH_PASSWORD = "correct horse battery staple";
const TERMINAL_OUTPUT = "\u001b[32muser@host\u001b[0m:~$ cat secrets.txt";

function collect(): { log: SecurityLog; records: Array<{ msg: string; fields: SecurityFields }> } {
	const records: Array<{ msg: string; fields: SecurityFields }> = [];
	return { log: new SecurityLog((msg, fields) => records.push({ msg, fields })), records };
}

// ─── The nine events ──────────────────────────────────────────────────────────

describe("SecurityLog — the events of SECURITY.md § 7.1, with their fields", () => {
	it("hub start: bind address, port and the permission check", () => {
		const { log, records } = collect();
		log.hubStarted({ bindAddress: "127.0.0.1", port: 4100, permissionsCheck: "passed" });
		expect(records).toEqual([
			{
				msg: "security: hub start",
				fields: {
					event: "hub.start",
					bindAddress: "127.0.0.1",
					port: 4100,
					permissionsCheck: "passed",
				},
			},
		]);
	});

	it("auth success over the WebSocket: connection, credential and source address", () => {
		const { log, records } = collect();
		log.authSucceeded({ via: "ws", sourceIp: "127.0.0.1", clientId: CLIENT, tokenId: "primary" });
		expect(records[0]?.fields).toEqual({
			event: "auth.success",
			via: "ws",
			sourceIp: "127.0.0.1",
			tokenId: "primary",
			clientId: CLIENT,
		});
	});

	it("auth success over REST: credential and source address", () => {
		const { log, records } = collect();
		log.authSucceeded({ via: "rest", sourceIp: "::1", tokenId: PAIRED_TOKEN_ID });
		expect(records[0]?.fields).toEqual({
			event: "auth.success",
			via: "rest",
			sourceIp: "::1",
			tokenId: PAIRED_TOKEN_ID,
		});
	});

	it("auth failure: where it was attempted, from where, and why", () => {
		const { log, records } = collect();
		log.authFailed({ via: "rest", sourceIp: "127.0.0.1", reason: "invalid_token" });
		log.authFailed({ via: "ws", sourceIp: "127.0.0.1", clientId: CLIENT, reason: "auth_timeout" });
		log.authFailed({ via: "pair", sourceIp: "127.0.0.1", reason: "unknown_code" });
		expect(records.map((record) => record.fields)).toEqual([
			{ event: "auth.failure", via: "rest", sourceIp: "127.0.0.1", reason: "invalid_token" },
			{
				event: "auth.failure",
				via: "ws",
				sourceIp: "127.0.0.1",
				clientId: CLIENT,
				reason: "auth_timeout",
			},
			{ event: "auth.failure", via: "pair", sourceIp: "127.0.0.1", reason: "unknown_code" },
		]);
		expect(records.every((record) => record.msg === "security: auth failure")).toBe(true);
	});

	it("pairing code generated: its record and expiry, never the code", () => {
		const { log, records } = collect();
		log.pairingCodeGenerated({
			pairingId: PAIRING,
			expiresAt: "2026-09-23T12:00:00.000Z",
			sourceIp: "127.0.0.1",
		});
		expect(records[0]?.fields).toEqual({
			event: "pairing.generated",
			pairingId: PAIRING,
			expiresAt: "2026-09-23T12:00:00.000Z",
			sourceIp: "127.0.0.1",
		});
	});

	it("pairing code verified: the credential it issued and to where", () => {
		const { log, records } = collect();
		log.pairingCodeVerified({
			pairingId: PAIRING,
			tokenId: PAIRED_TOKEN_ID,
			sourceIp: "127.0.0.1",
		});
		expect(records[0]?.fields).toEqual({
			event: "pairing.verified",
			pairingId: PAIRING,
			tokenId: PAIRED_TOKEN_ID,
			sourceIp: "127.0.0.1",
		});
	});

	it("SSH connect: host, its label and the authentication method", () => {
		const { log, records } = collect();
		log.sshConnected({ hostId: HOST, hostLabel: "build box", authMethod: "password" });
		expect(records[0]?.fields).toEqual({
			event: "ssh.connect",
			hostId: HOST,
			hostLabel: "build box",
			authMethod: "password",
		});
	});

	it("SSH disconnect: host and who ended it", () => {
		const { log, records } = collect();
		log.sshDisconnected({ hostId: HOST, reason: "connection_lost" });
		expect(records[0]?.fields).toEqual({
			event: "ssh.disconnect",
			hostId: HOST,
			reason: "connection_lost",
		});
	});

	it("write-lock force: channel, the client that forced and the one that held it", () => {
		const { log, records } = collect();
		log.writeLockForced({ channelId: CHANNEL, byClientId: CLIENT, fromClientId: OTHER_CLIENT });
		expect(records[0]?.fields).toEqual({
			event: "write_lock.force",
			channelId: CHANNEL,
			byClientId: CLIENT,
			fromClientId: OTHER_CLIENT,
		});
	});

	it("token rotated: which credential", () => {
		const { log, records } = collect();
		log.tokenRotated({ tokenId: "primary" });
		expect(records[0]).toEqual({
			msg: "security: token rotated",
			fields: { event: "token.rotate", tokenId: "primary" },
		});
	});
});

// ─── § 7.2 by construction ────────────────────────────────────────────────────

describe("SecurityLog — what § 7.2 excludes cannot be written", () => {
	it("refuses, at compile time, a field no event declares", () => {
		const { log } = collect();
		// Each of these is a type error: `pnpm typecheck` fails if one ever compiles.
		log.authFailed({
			via: "ws",
			sourceIp: "127.0.0.1",
			clientId: CLIENT,
			reason: "invalid_token",
			// @ts-expect-error — no event carries a token.
			token: TOKEN,
		});
		log.pairingCodeGenerated({
			pairingId: PAIRING,
			expiresAt: "2026-09-23T12:00:00.000Z",
			sourceIp: "127.0.0.1",
			// @ts-expect-error — nor the pairing code.
			code: PAIRING_CODE,
		});
		// @ts-expect-error — nor an SSH password.
		log.sshConnected({ hostId: HOST, hostLabel: "h", authMethod: "password", password: "x" });
		// @ts-expect-error — nor terminal output.
		log.sshDisconnected({ hostId: HOST, reason: "connection_lost", output: TERMINAL_OUTPUT });
		// @ts-expect-error — and a reason is one of a closed list, not text.
		log.authFailed({ via: "rest", sourceIp: "127.0.0.1", reason: "bad token 3f3f" });
	});

	it("drops a field smuggled in on an object the compiler did not see", () => {
		const { log, records } = collect();
		const failure = {
			via: "ws" as const,
			sourceIp: "127.0.0.1",
			clientId: CLIENT,
			reason: "invalid_token" as const,
			token: TOKEN,
			password: SSH_PASSWORD,
		};
		log.authFailed(failure);
		const verified = {
			pairingId: PAIRING,
			tokenId: PAIRED_TOKEN_ID,
			sourceIp: "127.0.0.1",
			code: PAIRING_CODE,
			token: TOKEN,
		};
		log.pairingCodeVerified(verified);

		const written = JSON.stringify(records);
		expect(written).not.toContain(TOKEN);
		expect(written).not.toContain(PAIRING_CODE);
		expect(written).not.toContain(SSH_PASSWORD);
		expect(Object.keys(records[0]?.fields ?? {})).toEqual([
			"event",
			"via",
			"sourceIp",
			"clientId",
			"reason",
		]);
	});

	it("withholds a secret passed where an identifier, an address or a reason belongs", () => {
		const { log, records } = collect();
		log.authSucceeded({ via: "ws", sourceIp: TOKEN, clientId: TOKEN, tokenId: TOKEN });
		log.pairingCodeGenerated({ pairingId: PAIRING_CODE, expiresAt: PAIRING_CODE, sourceIp: "x" });
		log.writeLockForced({ channelId: TERMINAL_OUTPUT, byClientId: TOKEN, fromClientId: "" });
		log.authFailed({
			via: "rest",
			sourceIp: "127.0.0.1",
			reason: SSH_PASSWORD as never,
		});
		log.hubStarted({
			bindAddress: TOKEN,
			port: Number(PAIRING_CODE),
			permissionsCheck: TOKEN as "passed",
		});

		const written = JSON.stringify(records);
		for (const secret of [TOKEN, PAIRING_CODE, SSH_PASSWORD, TERMINAL_OUTPUT]) {
			expect(written).not.toContain(secret);
		}
		expect(records[0]?.fields).toEqual({
			event: "auth.success",
			via: "ws",
			sourceIp: WITHHELD,
			tokenId: WITHHELD,
			clientId: WITHHELD,
		});
		expect(records[3]?.fields.reason).toBe(WITHHELD);
	});

	it("keeps an authentication going when the sink fails", () => {
		const log = new SecurityLog(() => {
			throw new Error("disk full");
		});
		expect(() =>
			log.authSucceeded({ via: "rest", sourceIp: "127.0.0.1", tokenId: "primary" }),
		).not.toThrow();
	});
});

// ─── Through the hub's own log ────────────────────────────────────────────────

describe("SecurityLog through HubLogger", () => {
	it("is written to hub.jsonl even when the configured level would hide INFO", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lasterm-security-log-"));
		try {
			const hubLog = new HubLogger(dir, {
				level: "error",
				format: "jsonl",
				output: "file",
				maxAgeDays: 30,
				maxSizeMb: 50,
			});
			const log = new SecurityLog((msg, fields) => hubLog.logAlways("info", msg, fields));
			hubLog.log("info", "a diagnostic the level hides");
			log.authFailed({ via: "rest", sourceIp: "127.0.0.1", reason: "missing_header" });

			const lines = fs
				.readFileSync(path.join(dir, "hub.jsonl"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatchObject({
				lvl: "info",
				msg: "security: auth failure",
				event: "auth.failure",
				via: "rest",
				reason: "missing_header",
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
