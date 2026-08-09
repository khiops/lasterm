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
		vi.unstubAllGlobals();
	});

	it("does not construct a webview WebSocket in the desktop runtime", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
		const webSocket = vi.fn();
		vi.stubGlobal("WebSocket", webSocket);

		const client = createWsClient();
		await client.connect("ws://127.0.0.1:4100/ws");

		expect(webSocket).not.toHaveBeenCalled();
		expect(ipc.invoke).toHaveBeenCalledWith("relay_hub_ws_connect", expect.any(Object));
		client.close();
	});

	it("acknowledges a consumed raw relay frame before Rust may read another", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
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

	it("keeps a transport failure distinct from a clean session close", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
		const client = createWsClient();
		const disconnected = vi.fn();
		client.onDisconnect(disconnected);
		await client.connect("ws://127.0.0.1:4100/ws");

		ipc.callback?.({ event: "transport_error" });
		expect(disconnected).not.toHaveBeenCalled();
		client.close();

		await client.connect("ws://127.0.0.1:4100/ws");
		ipc.callback?.({ event: "closed" });
		expect(disconnected).toHaveBeenCalledTimes(1);
		client.close();
	});
});
