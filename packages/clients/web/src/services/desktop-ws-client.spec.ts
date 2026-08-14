import { encodeMessage } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWsClient } from "./ws-client.js";

const ipc = vi.hoisted(() => ({
	callback: undefined as
		| ((frame: ArrayBuffer | { event: "closed" | "transport_error" }) => void)
		| undefined,
	invoke: vi.fn((command: string) => {
		if (command === "relay_hub_ws_connect") return Promise.resolve(41);
		return Promise.resolve();
	}),
}));

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		constructor(callback: (frame: ArrayBuffer | { event: "closed" | "transport_error" }) => void) {
			ipc.callback = callback;
		}
	},
	invoke: ipc.invoke,
}));

function relayFrame(payload: Uint8Array, sequence = 1n, marker = 1): ArrayBuffer {
	const frame = new Uint8Array(34 + payload.byteLength);
	const view = new DataView(frame.buffer);
	view.setBigUint64(0, 41n, true);
	view.setBigUint64(8, sequence, true);
	frame.fill(7, 16, 32);
	frame[32] = 0;
	frame[33] = marker;
	frame.set(payload, 34);
	return frame.buffer;
}

describe("DesktopWsClient", () => {
	afterEach(() => {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		ipc.callback = undefined;
		ipc.invoke.mockClear();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not construct a webview WebSocket in the desktop runtime", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const webSocket = vi.fn();
		vi.stubGlobal("WebSocket", webSocket);

		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		expect(webSocket).not.toHaveBeenCalled();
		expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_connect", expect.any(Object));
		client.close();
	});

	it("acknowledges a consumed raw relay frame before Rust may read another", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		const received: string[] = [];
		client.on("AUTH_OK", (message) => received.push(message.type));
		await client.connect("ws://127.0.0.1:4100/ws");

		const message = encodeMessage({ type: "AUTH_OK", clientId: "client-1" });
		ipc.callback?.(relayFrame(message));
		await vi.waitFor(() => expect(received).toEqual(["AUTH_OK"]));

		await vi.waitFor(() =>
			expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_ack", {
				relayId: "41",
				sequence: "1",
				acknowledgementToken: "BwcHBwcHBwcHBwcHBwcHBw",
			}),
		);
		client.close();
	});

	it("acknowledges a valid empty binary relay message without disconnecting", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		ipc.callback?.(relayFrame(new Uint8Array()));

		await vi.waitFor(() =>
			expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_ack", {
				relayId: "41",
				sequence: "1",
				acknowledgementToken: "BwcHBwcHBwcHBwcHBwcHBw",
			}),
		);
		expect(client.isConnected).toBe(true);
		expect(consoleError).not.toHaveBeenCalledWith(
			"[DesktopWsClient] Transport failure:",
			expect.anything(),
		);
		client.close();
	});

	it("reports a transport failure as disconnected before reconnecting", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const client = createWsClient();
		const disconnected = vi.fn();
		client.onDisconnect(disconnected);
		await client.connect("ws://127.0.0.1:4100/ws");

		ipc.callback?.({ event: "transport_error" });
		expect(disconnected).toHaveBeenCalledTimes(1);
		expect(client.isConnected).toBe(false);
		expect(consoleError).toHaveBeenCalledWith(
			"[DesktopWsClient] Transport failure:",
			"pinned hub WebSocket transport failed",
		);
		client.close();
	});

	it("serializes fire-and-forget sends until native capacity accepts each one", async () => {
		let acceptFirst: (() => void) | undefined;
		let sendCount = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") return Promise.resolve(41);
			if (command !== "relay_hub_ws_send") return Promise.resolve();
			sendCount++;
			if (sendCount === 1) return new Promise<void>((resolve) => (acceptFirst = resolve));
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		client.send({ type: "AUTH", token: "first" });
		client.send({ type: "ATTACH", channelId: "channel-1" });
		await vi.waitFor(() => expect(sendCount).toBe(1));
		expect(sendCount).toBe(1);

		acceptFirst?.();
		await vi.waitFor(() => expect(sendCount).toBe(2));
		client.close();
	});

	it("fails the relay rather than retaining more than two fire-and-forget sends", async () => {
		let sendCount = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") return Promise.resolve(41);
			if (command !== "relay_hub_ws_send") return Promise.resolve();
			sendCount++;
			return new Promise<void>(() => undefined);
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		client.send({ type: "AUTH", token: "one" });
		client.send({ type: "AUTH", token: "two" });
		await vi.waitFor(() => expect(sendCount).toBe(1));
		client.send({ type: "AUTH", token: "three" });
		expect(client.isConnected).toBe(false);
		expect(consoleError).toHaveBeenCalledWith(
			"[DesktopWsClient] Transport failure:",
			"WebSocket relay send queue is full",
		);
		client.close();
	});

	it("does not reserve a send slot when message encoding fails", async () => {
		let sendCount = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") return Promise.resolve(41);
			if (command === "relay_hub_ws_send") {
				sendCount++;
				return new Promise<void>(() => undefined);
			}
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");
		const invalid = { type: "AUTH", token: "invalid" } as Record<string, unknown>;
		invalid.self = invalid;

		expect(() => client.send(invalid as never)).toThrow();
		client.send({ type: "AUTH", token: "one" });
		client.send({ type: "AUTH", token: "two" });
		await vi.waitFor(() => expect(sendCount).toBe(1));
		expect(client.isConnected).toBe(true);
		client.close();
	});

	it("discards a late send rejection from a replaced relay", async () => {
		let nextRelayId = 41;
		let rejectFirst: ((error: Error) => void) | undefined;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") return Promise.resolve(nextRelayId++);
			if (command === "relay_hub_ws_send") {
				return new Promise<void>((_resolve, reject) => (rejectFirst = reject));
			}
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		client.send({ type: "AUTH", token: "old" });
		await vi.waitFor(() => expect(rejectFirst).toBeTypeOf("function"));
		ipc.callback?.({ event: "transport_error" });
		await client.connect("ws://127.0.0.1:4100/ws");
		rejectFirst?.(new Error("late failure"));
		await Promise.resolve();
		await Promise.resolve();

		expect(client.isConnected).toBe(true);
		client.close();
	});

	it("closes the prior relay when an overlapping connect supersedes it", async () => {
		let nextRelayId = 41;
		let resolveSecond: ((relayId: number) => void) | undefined;
		let acceptOldSend: (() => void) | undefined;
		let oldSendCount = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") {
				if (nextRelayId++ === 41) return Promise.resolve(41);
				return new Promise<number>((resolve) => (resolveSecond = resolve));
			}
			if (command === "relay_hub_ws_send") {
				oldSendCount++;
				if (oldSendCount === 1) {
					return new Promise<void>((resolve) => (acceptOldSend = resolve));
				}
			}
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");
		client.send({ type: "AUTH", token: "old-first" });
		client.send({ type: "AUTH", token: "old-queued" });
		await vi.waitFor(() => expect(oldSendCount).toBe(1));

		const replacement = client.connect("ws://127.0.0.1:4100/ws");
		await vi.waitFor(() => expect(resolveSecond).toBeTypeOf("function"));
		resolveSecond?.(42);
		await replacement;

		expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_close", { relayId: "41" });
		acceptOldSend?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(oldSendCount).toBe(1);
		expect(client.isConnected).toBe(true);
		client.close();
	});

	it("does not report a failed replacement connection as live", async () => {
		let calls = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") {
				calls++;
				return calls === 1 ? Promise.resolve(41) : Promise.reject<number>(new Error("dial failed"));
			}
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		await expect(client.connect("ws://127.0.0.1:4100/ws")).rejects.toThrow("dial failed");

		expect(client.isConnected).toBe(false);
		expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_close", { relayId: "41" });
	});

	it("rejects when the hub closes immediately after its handshake", async () => {
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") {
				ipc.callback?.({ event: "closed" });
				return Promise.resolve(41);
			}
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();

		await expect(client.connect("ws://127.0.0.1:4100/ws")).rejects.toThrow(
			"WebSocket connection closed before it was established",
		);

		expect(client.isConnected).toBe(false);
		client.close();
	});

	it("reports a superseded connection attempt differently from an immediate close", async () => {
		let resolveFirst: ((relayId: number) => void) | undefined;
		let connects = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command !== "relay_hub_ws_connect") return Promise.resolve();
			connects++;
			if (connects === 1) return new Promise<number>((resolve) => (resolveFirst = resolve));
			return Promise.resolve(42);
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();

		const superseded = client.connect("ws://127.0.0.1:4100/ws");
		await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
		await client.connect("ws://127.0.0.1:4100/ws");
		resolveFirst?.(41);

		await expect(superseded).rejects.toThrow(
			"WebSocket connection was superseded by a newer connect",
		);
		expect(client.isConnected).toBe(true);
		client.close();
	});

	it("does not emit reconnect after close supersedes an in-flight reconnect", async () => {
		vi.useFakeTimers();
		let calls = 0;
		let resolveReconnect: ((relayId: number) => void) | undefined;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") {
				calls++;
				if (calls === 1) return Promise.resolve(41);
				return new Promise<number>((resolve) => (resolveReconnect = resolve));
			}
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		const reconnected = vi.fn();
		client.onReconnect(reconnected);
		await client.connect("ws://127.0.0.1:4100/ws");
		ipc.callback?.({ event: "closed" });

		await vi.advanceTimersByTimeAsync(1000);
		expect(resolveReconnect).toBeTypeOf("function");
		client.close();
		resolveReconnect?.(42);
		await Promise.resolve();
		await Promise.resolve();

		expect(reconnected).not.toHaveBeenCalled();
		expect(client.isConnected).toBe(false);
		expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_close", { relayId: "42" });
	});

	it("does not let a pending reconnect timer replace a newer manual connection", async () => {
		vi.useFakeTimers();
		let connects = 0;
		ipc.invoke.mockImplementation((command: string) => {
			if (command === "relay_hub_ws_connect") return Promise.resolve(++connects + 40);
			return Promise.resolve();
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: ipc.invoke, transformCallback: () => 1 },
			configurable: true,
		});
		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");
		ipc.callback?.({ event: "closed" });
		await client.connect("ws://127.0.0.1:4100/ws");
		await vi.advanceTimersByTimeAsync(30_000);

		expect(connects).toBe(2);
		expect(client.isConnected).toBe(true);
		client.close();
	});
});
