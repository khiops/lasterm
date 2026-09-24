import { describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage, toCamelCase, toSnakeCase } from "./codec.js";
import type { ProtocolMessage } from "./protocol.js";

// ---------------------------------------------------------------------------
// Key conversion helpers
// ---------------------------------------------------------------------------

describe("toSnakeCase", () => {
	it("converts simple camelCase keys", () => {
		expect(toSnakeCase({ channelId: "abc", exitCode: 0 })).toEqual({
			channel_id: "abc",
			exit_code: 0,
		});
	});

	it("converts nested objects recursively", () => {
		expect(
			toSnakeCase({
				snapshotData: {
					cursorX: 5,
					cursorY: 10,
				},
			}),
		).toEqual({
			snapshot_data: {
				cursor_x: 5,
				cursor_y: 10,
			},
		});
	});

	it("converts arrays of objects recursively", () => {
		expect(toSnakeCase({ items: [{ itemId: 1 }, { itemId: 2 }] })).toEqual({
			items: [{ item_id: 1 }, { item_id: 2 }],
		});
	});

	it("preserves Uint8Array fields unchanged", () => {
		const buf = new Uint8Array([1, 2, 3]);
		const result = toSnakeCase({ data: buf }) as { data: Uint8Array };
		expect(result.data).toBe(buf); // same reference
	});

	it("handles null and primitive values", () => {
		expect(toSnakeCase({ holder: null, count: 42, label: "ok" })).toEqual({
			holder: null,
			count: 42,
			label: "ok",
		});
	});

	it("does not transform UPPER_SNAKE type discriminants", () => {
		// camelToSnake operates on capital letters — "SPAWN_OK" has no camelCase
		// humps so it stays unchanged
		const result = toSnakeCase({ type: "SPAWN_OK" }) as { type: string };
		expect(result.type).toBe("SPAWN_OK");
	});
});

describe("toCamelCase", () => {
	it("converts simple snake_case keys", () => {
		expect(toCamelCase({ channel_id: "abc", exit_code: 0 })).toEqual({
			channelId: "abc",
			exitCode: 0,
		});
	});

	it("converts nested objects recursively", () => {
		expect(
			toCamelCase({
				snapshot_data: {
					cursor_x: 5,
					cursor_y: 10,
				},
			}),
		).toEqual({
			snapshotData: {
				cursorX: 5,
				cursorY: 10,
			},
		});
	});

	it("converts arrays of objects recursively", () => {
		expect(toCamelCase({ items: [{ item_id: 1 }, { item_id: 2 }] })).toEqual({
			items: [{ itemId: 1 }, { itemId: 2 }],
		});
	});

	it("preserves Uint8Array fields unchanged", () => {
		const buf = new Uint8Array([4, 5, 6]);
		const result = toCamelCase({ data: buf }) as { data: Uint8Array };
		expect(result.data).toBe(buf); // same reference
	});

	it("does not transform UPPER_SNAKE type discriminants", () => {
		// snakeToCamel matches /_([a-z])/ — uppercase letters after _ are NOT matched
		const result = toCamelCase({ type: "SPAWN_OK" }) as { type: string };
		expect(result.type).toBe("SPAWN_OK");
	});
});

// ---------------------------------------------------------------------------
// Round-trip encode → decode
// ---------------------------------------------------------------------------

describe("encodeMessage / decodeMessage round-trip", () => {
	it("round-trips a HELLO message", () => {
		const msg: ProtocolMessage = {
			type: "HELLO",
			version: 1,
			agentVersion: "0.1.0",
			capabilities: ["multiplex", "snapshot", "resize"],
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips an OUTPUT message preserving Uint8Array data", () => {
		const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
		const msg: ProtocolMessage = {
			type: "OUTPUT",
			channelId: "01ABCDEFGHJKMNPQRSTV",
			seq: 42,
			ts: "2026-03-03T00:00:00.000Z",
			data,
		};
		const decoded = decodeMessage(encodeMessage(msg)) as typeof msg;
		expect(decoded.type).toBe("OUTPUT");
		expect(decoded.channelId).toBe(msg.channelId);
		expect(decoded.seq).toBe(42);
		expect(decoded.data).toBeInstanceOf(Uint8Array);
		expect(Array.from(decoded.data)).toEqual(Array.from(data));
	});

	it("round-trips a SPAWN (agent) message with nested env", () => {
		const msg: ProtocolMessage = {
			type: "SPAWN",
			requestId: "req-1",
			shell: "/bin/bash",
			cwd: "/home/user",
			env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
			cols: 80,
			rows: 24,
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips an ATTACH_OK (agent) message with snapshot", () => {
		const msg: ProtocolMessage = {
			type: "ATTACH_OK",
			channelId: "chan-1",
			snapshot: {
				serialized: "<xterm-state>",
				cols: 80,
				rows: 24,
				cursorX: 5,
				cursorY: 12,
			},
			lastSeq: 100,
		};
		const decoded = decodeMessage(encodeMessage(msg)) as typeof msg;
		expect(decoded.type).toBe("ATTACH_OK");
		expect(decoded.snapshot.cursorX).toBe(5);
		expect(decoded.snapshot.cursorY).toBe(12);
		expect(decoded.lastSeq).toBe(100);
	});

	it("round-trips a WRITE_LOCK message with null holder", () => {
		const msg: ProtocolMessage = {
			type: "WRITE_LOCK",
			channelId: "chan-1",
			holder: null,
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips a CHANNEL_EXIT message with optional signal", () => {
		const msg: ProtocolMessage = {
			type: "CHANNEL_EXIT",
			channelId: "chan-2",
			exitCode: 130,
			signal: "SIGINT",
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips a HELLO message with visualHints", () => {
		const msg: ProtocolMessage = {
			type: "HELLO",
			version: 1,
			agentVersion: "0.2.0",
			capabilities: ["multiplex"],
			visualHints: {
				badge: { text: "prod", color: "#ff0000" },
				themeOverlay: { background: "#000000" },
			},
		};
		const decoded = decodeMessage(encodeMessage(msg)) as typeof msg;
		expect(decoded.visualHints?.badge?.text).toBe("prod");
		expect(decoded.visualHints?.themeOverlay?.background).toBe("#000000");
	});

	it("round-trips an AUTH_OK message", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_OK",
			clientId: "client-abc",
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips a PING message", () => {
		const msg: ProtocolMessage = { type: "PING" };
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips an AGENT_FETCH_PROGRESS message with snake_case wire fields", () => {
		const msg: ProtocolMessage = {
			type: "AGENT_FETCH_PROGRESS",
			jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			os: "linux",
			arch: "arm64",
			downloaded: 12,
			total: 42,
			phase: "download",
		};

		expect(toSnakeCase(msg)).toMatchObject({
			type: "AGENT_FETCH_PROGRESS",
			job_id: msg.jobId,
			os: "linux",
			arch: "arm64",
			downloaded: 12,
			total: 42,
			phase: "download",
		});
		expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
	});

	it("round-trips an AGENT_SYNCED message with snake_case wire fields", () => {
		const msg: ProtocolMessage = {
			type: "AGENT_SYNCED",
			hostId: "host-1",
			hostname: "prod-box",
			message: "Agent on prod-box updated to the current version",
		};

		expect(toSnakeCase(msg)).toMatchObject({
			type: "AGENT_SYNCED",
			host_id: "host-1",
			hostname: "prod-box",
			message: "Agent on prod-box updated to the current version",
		});
		expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
	});

	it("round-trips an AUTH_PROMPT message without optional fields (back-compat)", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_PROMPT",
			hostId: "host-1",
			promptType: "passphrase",
			message: "Enter passphrase for key:",
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips an AUTH_PROMPT message with promptId and deliveryEpoch", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_PROMPT",
			hostId: "host-1",
			promptType: "passphrase",
			message: "Enter passphrase for key:",
			promptId: "01HXYZ1234567890ABCDEF",
			deliveryEpoch: 1_700_000_000_000,
		};
		const decoded = decodeMessage(encodeMessage(msg)) as typeof msg;
		expect(decoded.type).toBe("AUTH_PROMPT");
		expect(decoded.promptId).toBe("01HXYZ1234567890ABCDEF");
		expect(decoded.deliveryEpoch).toBe(1_700_000_000_000);
		expect(decoded.hostId).toBe("host-1");
	});

	it("round-trips an AUTH_PROMPT_RESPONSE with promptId and deliveryEpoch", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-1",
			secret: "my-passphrase",
			rememberSession: true,
			promptId: "01HXYZ1234567890ABCDEF",
			deliveryEpoch: 1_700_000_000_000,
		};
		const decoded = decodeMessage(encodeMessage(msg)) as typeof msg;
		expect(decoded.type).toBe("AUTH_PROMPT_RESPONSE");
		expect(decoded.promptId).toBe("01HXYZ1234567890ABCDEF");
		expect(decoded.deliveryEpoch).toBe(1_700_000_000_000);
		expect(decoded.secret).toBe("my-passphrase");
		expect(decoded.rememberSession).toBe(true);
	});

	it("round-trips an AUTH_PROMPT_RESPONSE without optional fields (back-compat)", () => {
		const msg: ProtocolMessage = {
			type: "AUTH_PROMPT_RESPONSE",
			hostId: "host-1",
			secret: null,
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});

	it("round-trips a PROMPT_CANCEL message", () => {
		const msg: ProtocolMessage = {
			type: "PROMPT_CANCEL",
			promptId: "01HXYZ1234567890ABCDEF",
		};
		const decoded = decodeMessage(encodeMessage(msg));
		expect(decoded).toEqual(msg);
	});
});

// The fields #127 adds to the hub <-> agent protocol. The agent reads the wire
// names with serde, so a camelCase key reaching it would be a field it ignores:
// a hub key it never sees, and a hub it files under the legacy owner.
describe("hub identity on the wire (#127)", () => {
	it("sends the hub key of an agent AUTH as hub_key", () => {
		const msg: ProtocolMessage = { type: "AUTH", token: "a".repeat(64), hubKey: "b".repeat(64) };

		expect(toSnakeCase(msg)).toEqual({
			type: "AUTH",
			token: "a".repeat(64),
			hub_key: "b".repeat(64),
		});
		expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
	});

	it("reads other_owner_channels from a CHANNEL_STATE_END", () => {
		const wire = { type: "CHANNEL_STATE_END", other_owner_channels: 3 };

		expect(toCamelCase(wire)).toEqual({ type: "CHANNEL_STATE_END", otherOwnerChannels: 3 });
	});

	it("reads a CHANNEL_STATE_END without it, as an agent before #127 sends it", () => {
		expect(toCamelCase({ type: "CHANNEL_STATE_END" })).toEqual({ type: "CHANNEL_STATE_END" });
	});

	it("round-trips a STOP with its force flag", () => {
		for (const force of [false, true]) {
			const msg: ProtocolMessage = { type: "STOP", force };
			expect(toSnakeCase(msg)).toEqual({ type: "STOP", force });
			expect(decodeMessage(encodeMessage(msg))).toEqual(msg);
		}
	});
});
