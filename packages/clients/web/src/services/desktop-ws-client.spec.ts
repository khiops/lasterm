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

describe("DesktopWsClient", () => {
	afterEach(() => {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		ipc.callback = undefined;
		ipc.invoke.mockClear();
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
		const frame = new Uint8Array(message.byteLength + 1);
		frame[0] = 1;
		frame.set(message, 1);
		ipc.callback?.(frame.buffer);
		await vi.waitFor(() => expect(received).toEqual(["AUTH_OK"]));

		await vi.waitFor(() =>
			expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_ack", { relayId: 41 }),
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

		expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_close", { relayId: 41 });
		acceptOldSend?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(oldSendCount).toBe(1);
		expect(client.isConnected).toBe(true);
		client.close();
	});
});
