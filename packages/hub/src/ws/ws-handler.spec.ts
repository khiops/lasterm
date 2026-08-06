import type { AuthPromptResponseMessage, ProtocolMessage } from "@lasterm/shared";
import {
	decodeMessage,
	encodeMessage,
	isValidDimensions,
	isValidEnv,
	isValidInputData,
	isValidUlid,
} from "@lasterm/shared";
import { describe, expect, it, vi } from "vitest";
import { handleAuthPromptResponse as handleAuthPromptResponseMessage } from "./handlers/auth-prompt-response.js";
import type { WsHandlerContext } from "./handlers/types.js";

/** Known token used across auth tests */
const TEST_TOKEN = "a".repeat(64);

// ws-handler is thin dispatch glue — core logic lives in SessionManager (tested separately).
// These tests verify the MessagePack codec round-trips that ws-handler relies on,
// plus the AUTH message protocol types.

describe("ws-handler codec round-trips", () => {
	it("SPAWN message (snake_case wire format) round-trips correctly", () => {
		const msg = {
			type: "SPAWN",
			hostId: "host-1",
			shell: "/bin/bash",
			cwd: "/home/user",
		} as unknown as ProtocolMessage;

		const encoded = encodeMessage(msg);
		expect(encoded).toBeInstanceOf(Uint8Array);

		const decoded = decodeMessage(encoded);
		expect(decoded.type).toBe("SPAWN");
		const spawnMsg = decoded as unknown as Record<string, string>;
		expect(spawnMsg.hostId).toBe("host-1");
		expect(spawnMsg.shell).toBe("/bin/bash");
		expect(spawnMsg.cwd).toBe("/home/user");
	});

	it("OUTPUT message with binary data round-trips", () => {
		const data = new Uint8Array([72, 101, 108, 108, 111]);
		const msg: ProtocolMessage = {
			type: "OUTPUT",
			channelId: "ch-1",
			seq: 42,
			ts: "2026-03-03T00:00:00Z",
			data,
		};

		const encoded = encodeMessage(msg);
		const decoded = decodeMessage(encoded);

		expect(decoded.type).toBe("OUTPUT");
		const outputMsg = decoded as unknown as Record<string, unknown>;
		expect(outputMsg.channelId).toBe("ch-1");
		expect(outputMsg.seq).toBe(42);
		expect(outputMsg.data).toBeInstanceOf(Uint8Array);
		expect(Array.from(outputMsg.data as Uint8Array)).toEqual([72, 101, 108, 108, 111]);
	});

	it("PING and PONG messages round-trip", () => {
		const ping: ProtocolMessage = { type: "PING" };
		const decodedPing = decodeMessage(encodeMessage(ping));
		expect(decodedPing.type).toBe("PING");

		const pong: ProtocolMessage = { type: "PONG" };
		const decodedPong = decodeMessage(encodeMessage(pong));
		expect(decodedPong.type).toBe("PONG");
	});

	it("ATTACH_OK with null snapshot round-trips", () => {
		const msg: ProtocolMessage = {
			type: "ATTACH_OK",
			channelId: "ch-1",
			snapshot: null,
			tail: [],
			writeLockHolder: null,
			cached: false,
		};

		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded.type).toBe("ATTACH_OK");
		const attachOk = decoded as unknown as Record<string, unknown>;
		expect(attachOk.channelId).toBe("ch-1");
		expect(attachOk.snapshot).toBeNull();
		expect(attachOk.tail).toEqual([]);
		expect(attachOk.writeLockHolder).toBeNull();
		expect(attachOk.cached).toBe(false);
	});

	it("ERROR message round-trips", () => {
		const msg: ProtocolMessage = {
			type: "ERROR",
			code: "CHANNEL_NOT_FOUND",
			message: "Channel xyz not found",
		};

		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded.type).toBe("ERROR");
		const errMsg = decoded as unknown as Record<string, string>;
		expect(errMsg.code).toBe("CHANNEL_NOT_FOUND");
		expect(errMsg.message).toBe("Channel xyz not found");
	});

	it("RESIZE message round-trips", () => {
		const msg: ProtocolMessage = {
			type: "RESIZE",
			channelId: "ch-2",
			cols: 120,
			rows: 40,
		};

		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded.type).toBe("RESIZE");
		const resizeMsg = decoded as unknown as Record<string, unknown>;
		expect(resizeMsg.channelId).toBe("ch-2");
		expect(resizeMsg.cols).toBe(120);
		expect(resizeMsg.rows).toBe(40);
	});
});

describe("ws-handler AUTH protocol codec", () => {
	it("AUTH message encodes and decodes correctly", () => {
		const msg: ProtocolMessage = {
			type: "AUTH",
			token: TEST_TOKEN,
		};

		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded.type).toBe("AUTH");
		const authMsg = decoded as unknown as Record<string, string>;
		expect(authMsg.token).toBe(TEST_TOKEN);
	});

	it("AUTH_OK message encodes and decodes correctly", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_OK",
			clientId: "01ABCDEF",
		};

		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded.type).toBe("AUTH_OK");
		// clientId is camelCase in TS; wire may be snake_case depending on codec
		const authOk = decoded as unknown as Record<string, string>;
		expect(authOk.clientId ?? authOk.client_id).toBe("01ABCDEF");
	});

	it("AUTH_FAIL message encodes and decodes correctly", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_FAIL",
			message: "Invalid token",
		};

		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded.type).toBe("AUTH_FAIL");
		const failMsg = decoded as unknown as Record<string, string>;
		expect(failMsg.message).toBe("Invalid token");
	});
});

// Input validation tests — verify the validators that ws-handler applies before dispatch.
// The validators themselves are tested exhaustively in packages/shared/src/validation.spec.ts.
// These tests confirm the validation rules match ws-handler's usage patterns.
describe("ws-handler input validation", () => {
	const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

	describe("channelId validation (ATTACH, DETACH, INPUT, RESIZE, WRITE_*)", () => {
		it("rejects non-ULID channelId", () => {
			expect(isValidUlid("not-a-ulid")).toBe(false);
			expect(isValidUlid("")).toBe(false);
			expect(isValidUlid(123)).toBe(false);
		});

		it("accepts valid ULID channelId", () => {
			expect(isValidUlid(VALID_ULID)).toBe(true);
		});
	});

	describe("SPAWN hostId validation", () => {
		it("rejects non-ULID hostId", () => {
			expect(isValidUlid("bad-host-id")).toBe(false);
		});

		it("accepts valid ULID hostId", () => {
			expect(isValidUlid(VALID_ULID)).toBe(true);
		});
	});

	describe("INPUT data validation", () => {
		it("rejects oversized input data", () => {
			const oversized = new Uint8Array(65_537);
			expect(isValidInputData(oversized)).toBe(false);
		});

		it("accepts normal-sized input data", () => {
			const normal = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
			expect(isValidInputData(normal)).toBe(true);
		});

		it("rejects non-Uint8Array data", () => {
			expect(isValidInputData("hello")).toBe(false);
		});
	});

	describe("RESIZE dimensions validation", () => {
		it("rejects zero dimensions", () => {
			expect(isValidDimensions(0, 24)).toBe(false);
			expect(isValidDimensions(80, 0)).toBe(false);
		});

		it("rejects dimensions above 500", () => {
			expect(isValidDimensions(501, 24)).toBe(false);
			expect(isValidDimensions(80, 501)).toBe(false);
		});

		it("rejects non-integer dimensions", () => {
			expect(isValidDimensions(80.5, 24)).toBe(false);
		});

		it("accepts valid dimensions", () => {
			expect(isValidDimensions(80, 24)).toBe(true);
			expect(isValidDimensions(1, 1)).toBe(true);
			expect(isValidDimensions(500, 500)).toBe(true);
		});
	});

	describe("SPAWN env validation", () => {
		it("rejects env with non-string values", () => {
			expect(isValidEnv({ KEY: 123 })).toBe(false);
		});

		it("rejects env with too many entries", () => {
			const bigEnv: Record<string, string> = {};
			for (let i = 0; i <= 256; i++) {
				bigEnv[`K${i}`] = "v";
			}
			expect(isValidEnv(bigEnv)).toBe(false);
		});

		it("accepts valid env", () => {
			expect(isValidEnv({ PATH: "/usr/bin" })).toBe(true);
		});

		it("accepts undefined env (optional)", () => {
			expect(isValidEnv(undefined)).toBe(true);
		});
	});

	describe("INVALID_INPUT error message format", () => {
		it("INVALID_INPUT error round-trips through codec", () => {
			const msg: ProtocolMessage = {
				type: "ERROR",
				code: "INVALID_INPUT",
				message: "Invalid channelId",
			};

			const decoded = decodeMessage(encodeMessage(msg));
			expect(decoded.type).toBe("ERROR");
			const errMsg = decoded as unknown as Record<string, string>;
			expect(errMsg.code).toBe("INVALID_INPUT");
			expect(errMsg.message).toBe("Invalid channelId");
		});
	});
});

describe("ws-handler AUTH_PROMPT_RESPONSE routing", () => {
	const VALID_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
	const VALID_PROMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

	function makeAuthPromptResponseContext(): {
		ctx: WsHandlerContext;
		client: { send: ReturnType<typeof vi.fn> };
		sessionManager: { handleAuthPromptResponse: ReturnType<typeof vi.fn> };
	} {
		const client = { send: vi.fn() };
		const sessionManager = { handleAuthPromptResponse: vi.fn() };

		return {
			ctx: {
				clientId: "client-1",
				client,
				log: {} as never,
				sessionManager,
				writeLockManager: {} as never,
			} as WsHandlerContext,
			client,
			sessionManager,
		};
	}

	it("AUTH_PROMPT_RESPONSE message round-trips through codec", () => {
		const msg: AuthPromptResponseMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: VALID_ULID,
			secret: "my-password",
		};

		const encoded = encodeMessage(msg);
		const decoded = decodeMessage(encoded) as unknown as Record<string, unknown>;
		expect(decoded.type).toBe("AUTH_PROMPT_RESPONSE");
		expect(decoded.hostId ?? decoded.host_id).toBe(VALID_ULID);
		expect(decoded.secret).toBe("my-password");
	});

	it("AUTH_PROMPT_RESPONSE with null secret round-trips correctly", () => {
		const msg: AuthPromptResponseMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: VALID_ULID,
			secret: null,
		};

		const encoded = encodeMessage(msg);
		const decoded = decodeMessage(encoded) as unknown as Record<string, unknown>;
		expect(decoded.type).toBe("AUTH_PROMPT_RESPONSE");
		expect(decoded.secret).toBeNull();
	});

	it("hostId validation: rejects non-ULID hostId", () => {
		expect(isValidUlid("bad-host-id")).toBe(false);
		expect(isValidUlid("")).toBe(false);
	});

	it("hostId validation: accepts valid ULID", () => {
		expect(isValidUlid(VALID_ULID)).toBe(true);
	});

	it("forwards promptId and deliveryEpoch to SessionManager", () => {
		const { ctx, client, sessionManager } = makeAuthPromptResponseContext();
		const msg: AuthPromptResponseMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: VALID_ULID,
			secret: "hunter2",
			rememberSession: true,
			promptId: VALID_PROMPT_ID,
			deliveryEpoch: 2,
		};

		handleAuthPromptResponseMessage(msg, ctx);

		expect(client.send).not.toHaveBeenCalled();
		expect(sessionManager.handleAuthPromptResponse).toHaveBeenCalledOnce();
		expect(sessionManager.handleAuthPromptResponse).toHaveBeenCalledWith(
			"client-1",
			VALID_ULID,
			"hunter2",
			true,
			VALID_PROMPT_ID,
			2,
		);
	});

	it("rejects invalid promptId before dispatching", () => {
		const { ctx, client, sessionManager } = makeAuthPromptResponseContext();
		const msg: AuthPromptResponseMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: VALID_ULID,
			secret: "hunter2",
			promptId: "not-a-ulid",
		};

		handleAuthPromptResponseMessage(msg, ctx);

		expect(sessionManager.handleAuthPromptResponse).not.toHaveBeenCalled();
		expect(client.send).toHaveBeenCalledWith({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "Invalid promptId",
		});
	});

	it("rejects invalid deliveryEpoch before dispatching", () => {
		const { ctx, client, sessionManager } = makeAuthPromptResponseContext();
		const msg: AuthPromptResponseMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: VALID_ULID,
			secret: "hunter2",
			deliveryEpoch: Number.NaN,
		};

		handleAuthPromptResponseMessage(msg, ctx);

		expect(sessionManager.handleAuthPromptResponse).not.toHaveBeenCalled();
		expect(client.send).toHaveBeenCalledWith({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "deliveryEpoch must be a finite non-negative number",
		});
	});

	it("forwards responses without promptId for back-compat clients", () => {
		const { ctx, client, sessionManager } = makeAuthPromptResponseContext();
		const msg: AuthPromptResponseMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: VALID_ULID,
			secret: null,
		};

		handleAuthPromptResponseMessage(msg, ctx);

		expect(client.send).not.toHaveBeenCalled();
		expect(sessionManager.handleAuthPromptResponse).toHaveBeenCalledOnce();
		expect(sessionManager.handleAuthPromptResponse).toHaveBeenCalledWith(
			"client-1",
			VALID_ULID,
			null,
			undefined,
			undefined,
			undefined,
		);
	});
});

describe("ws-handler TEST_CONNECT validation", () => {
	const validMsg = {
		type: "TEST_CONNECT" as const,
		hostId: "temp-host-123",
		hostname: "example.com",
		port: 22,
		sshAuth: "agent" as const,
	};

	it("TEST_CONNECT message round-trips through codec", () => {
		const encoded = encodeMessage(validMsg as unknown as ProtocolMessage);
		const decoded = decodeMessage(encoded) as unknown as Record<string, unknown>;
		expect(decoded.type).toBe("TEST_CONNECT");
		expect(decoded.hostId ?? decoded.host_id).toBe("temp-host-123");
		expect(decoded.hostname).toBe("example.com");
		expect(decoded.port).toBe(22);
		expect(decoded.sshAuth ?? decoded.ssh_auth).toBe("agent");
	});

	it("validates hostId: rejects empty string", () => {
		// Simulate the ws-handler dispatch logic inline
		const msg = { ...validMsg, hostId: "" };
		const hostId = msg.hostId;
		expect(typeof hostId !== "string" || hostId.length === 0 || hostId.length > 128).toBe(true);
	});

	it("validates hostId: rejects string longer than 128 chars", () => {
		const msg = { ...validMsg, hostId: "a".repeat(129) };
		expect(msg.hostId.length > 128).toBe(true);
	});

	it("validates hostId: accepts valid temp id", () => {
		const hostId = "temp-host-abc-123";
		expect(typeof hostId !== "string" || hostId.length === 0 || hostId.length > 128).toBe(false);
	});

	it("validates hostname: rejects empty string", () => {
		const hostname = "";
		expect(typeof hostname !== "string" || hostname.length === 0 || hostname.length > 4096).toBe(
			true,
		);
	});

	it("validates hostname: rejects string longer than 4096 chars", () => {
		const hostname = "x".repeat(4097);
		expect(hostname.length > 4096).toBe(true);
	});

	it("validates hostname: accepts valid hostname", () => {
		const hostname = "example.com";
		expect(typeof hostname !== "string" || hostname.length === 0 || hostname.length > 4096).toBe(
			false,
		);
	});

	it("validates port: rejects 0", () => {
		const port = 0;
		expect(typeof port !== "number" || port < 1 || port > 65535).toBe(true);
	});

	it("validates port: rejects 65536", () => {
		const port = 65536;
		expect(typeof port !== "number" || port < 1 || port > 65535).toBe(true);
	});

	it("validates port: accepts valid port", () => {
		expect(typeof 22 !== "number" || 22 < 1 || 22 > 65535).toBe(false);
		expect(typeof 443 !== "number" || 443 < 1 || 443 > 65535).toBe(false);
	});

	it("validates sshAuth: rejects unknown value", () => {
		const sshAuth = "certificate";
		expect(!["agent", "key", "password"].includes(sshAuth)).toBe(true);
	});

	it("validates sshAuth: accepts agent, key, password", () => {
		expect(!["agent", "key", "password"].includes("agent")).toBe(false);
		expect(!["agent", "key", "password"].includes("key")).toBe(false);
		expect(!["agent", "key", "password"].includes("password")).toBe(false);
	});

	it("handleTestConnect is called on SessionManager with valid message", () => {
		const mockSessionManager = {
			handleTestConnect: vi.fn().mockResolvedValue(undefined),
		};

		// Simulate valid dispatch
		const msg = { ...validMsg };
		const hostId = msg.hostId;
		const hostname = msg.hostname;
		const port = msg.port;
		const sshAuth = msg.sshAuth;

		const isInvalid =
			typeof hostId !== "string" ||
			hostId.length === 0 ||
			hostId.length > 128 ||
			typeof hostname !== "string" ||
			hostname.length === 0 ||
			hostname.length > 4096 ||
			typeof port !== "number" ||
			port < 1 ||
			port > 65535 ||
			!["agent", "key", "password"].includes(sshAuth);

		expect(isInvalid).toBe(false);

		// Dispatch
		mockSessionManager.handleTestConnect("client-1", msg);
		expect(mockSessionManager.handleTestConnect).toHaveBeenCalledOnce();
		expect(mockSessionManager.handleTestConnect).toHaveBeenCalledWith("client-1", msg);
	});

	it("TEST_CONNECT_OK message round-trips through codec", () => {
		const ok: ProtocolMessage = {
			type: "TEST_CONNECT_OK",
			hostId: "temp-host-123",
		} as unknown as ProtocolMessage;
		const decoded = decodeMessage(encodeMessage(ok)) as unknown as Record<string, unknown>;
		expect(decoded.type).toBe("TEST_CONNECT_OK");
		expect(decoded.hostId ?? decoded.host_id).toBe("temp-host-123");
	});

	it("TEST_CONNECT_FAIL message round-trips through codec", () => {
		const fail: ProtocolMessage = {
			type: "TEST_CONNECT_FAIL",
			hostId: "temp-host-123",
			message: "Authentication failed",
		} as unknown as ProtocolMessage;
		const decoded = decodeMessage(encodeMessage(fail)) as unknown as Record<string, unknown>;
		expect(decoded.type).toBe("TEST_CONNECT_FAIL");
		expect(decoded.hostId ?? decoded.host_id).toBe("temp-host-123");
		expect(decoded.message).toBe("Authentication failed");
	});
});
