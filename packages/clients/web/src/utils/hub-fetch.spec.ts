import { afterEach, describe, expect, it, vi } from "vitest";
import { hubFetch, responseStream } from "./hub-fetch.js";

function responseFrame(
	id: bigint,
	sequence: bigint,
	kind: number,
	payload = new Uint8Array(),
): ArrayBuffer {
	const frame = new Uint8Array(17 + payload.byteLength);
	const view = new DataView(frame.buffer);
	view.setBigUint64(0, id, true);
	view.setBigUint64(8, sequence, true);
	frame[16] = kind;
	frame.set(payload, 17);
	return frame.buffer;
}

describe("hubFetch desktop transport", () => {
	afterEach(() => {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("does not make a webview network request for a desktop hub URL", async () => {
		const webviewFetch = vi.fn(() => Promise.reject(new Error("webview network was used")));
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_request") {
				return { id: 1, status: 204, statusText: "No Content", headers: [] };
			}
			return undefined;
		});
		vi.stubGlobal("fetch", webviewFetch);
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke, transformCallback: () => 1 },
		});

		const response = await hubFetch("https://127.0.0.1:4242/api/health");

		expect(response.status).toBe(204);
		expect(invoke).toHaveBeenCalledWith(
			"relay_hub_request",
			expect.objectContaining({
				request: expect.objectContaining({ path: "/api/health" }),
			}),
			undefined,
		);
		expect(webviewFetch).not.toHaveBeenCalled();
	});

	it.each([
		["HEAD", 200],
		["GET", 204],
		["GET", 205],
		["GET", 304],
	] as const)("returns a null body for %s %i", async (method, status) => {
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_request") {
				return { id: 1, status, statusText: "No Content", headers: [] };
			}
			return undefined;
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke, transformCallback: () => 1 },
		});

		const response = await hubFetch("https://127.0.0.1:4242/api/no-body", { method });

		expect(response.status).toBe(status);
		expect(response.body).toBeNull();
	});

	it("streams a large request body through bounded raw IPC frames", async () => {
		const body = new Uint8Array(256 * 1024 * 3 + 17);
		for (let index = 0; index < body.length; index++) body[index] = index % 251;
		const chunks: Uint8Array[] = [];
		const invoke = vi.fn(async (command: string, args?: unknown) => {
			if (command === "relay_hub_upload_start") return 33;
			if (command === "relay_hub_upload_chunk") {
				chunks.push(new Uint8Array(args as ArrayBuffer));
				return undefined;
			}
			if (command === "relay_hub_upload_finish") {
				return { id: 1, status: 204, statusText: "No Content", headers: [] };
			}
			return undefined;
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke, transformCallback: () => 1 },
		});

		await hubFetch("https://127.0.0.1:4242/api/body", { method: "POST", body });

		expect(invoke).toHaveBeenCalledWith(
			"relay_hub_upload_start",
			expect.objectContaining({ request: expect.objectContaining({ body: null }) }),
			undefined,
		);
		expect(chunks).toHaveLength(4);
		expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
			256 * 1024,
			256 * 1024,
			256 * 1024,
			17,
		]);
		const relayed = new Uint8Array(body.byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			relayed.set(chunk, offset);
			offset += chunk.byteLength;
		}
		expect(relayed).toEqual(body);
		expect(invoke).not.toHaveBeenCalledWith("relay_hub_request", expect.anything(), undefined);
	});

	it("acknowledges an identified response frame delivered before its head", async () => {
		let channelCallback:
			| ((
					message: { index: number; message: ArrayBuffer } | { index: number; end: boolean },
			  ) => void)
			| undefined;
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_request") {
				channelCallback?.({
					index: 0,
					message: responseFrame(55n, 1n, 0, new TextEncoder().encode("early")),
				});
				channelCallback?.({ index: 1, message: responseFrame(55n, 2n, 1) });
				return { id: 55, status: 200, statusText: "OK", headers: [] };
			}
			return undefined;
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke,
				transformCallback: (callback: typeof channelCallback) => {
					channelCallback = callback;
					return 1;
				},
			},
		});

		const response = await hubFetch("https://127.0.0.1:4242/api/early");

		expect(await response.text()).toBe("early");
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"relay_hub_response_ack",
				{ responseId: 55, sequence: 1 },
				undefined,
			),
		);
	});

	it("settles a response body when its acknowledgement never arrives", async () => {
		let channelCallback:
			| ((
					message: { index: number; message: ArrayBuffer } | { index: number; end: boolean },
			  ) => void)
			| undefined;
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_request") {
				return { id: 55, status: 200, statusText: "OK", headers: [] };
			}
			if (command === "relay_hub_response_ack") return new Promise<void>(() => undefined);
			return undefined;
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke,
				transformCallback: (callback: typeof channelCallback) => {
					channelCallback = callback;
					return 1;
				},
			},
		});

		const response = await hubFetch("https://127.0.0.1:4242/api/ack-timeout");
		channelCallback?.({
			index: 0,
			message: responseFrame(55n, 1n, 0, new TextEncoder().encode("partial")),
		});
		channelCallback?.({
			index: 1,
			message: responseFrame(
				55n,
				2n,
				2,
				new TextEncoder().encode("desktop response relay acknowledgement timed out"),
			),
		});

		await expect(response.text()).rejects.toThrow("acknowledgement timed out");
	});

	it("rejects a protocol failure delivered before the response head without cancelling another relay", async () => {
		const invoke = vi.fn(async () => undefined);
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke, transformCallback: () => 1 },
		});
		const channel = { onmessage: null as ((frame: ArrayBuffer) => void) | null };
		const stream = responseStream(channel);

		channel.onmessage?.(responseFrame(99n, 1n, 2, new TextEncoder().encode("pre-head failure")));
		stream.setResponseId(55);

		expect(stream.failure()).toMatchObject({
			message: "hub relay response frame belongs to another relay",
		});
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"relay_hub_response_cancel",
				{ responseId: 55 },
				undefined,
			),
		);
		expect(invoke).not.toHaveBeenCalledWith(
			"relay_hub_response_cancel",
			{ responseId: 99 },
			undefined,
		);
	});

	it("rejects response frames whose sequence skips the outstanding frame", async () => {
		let channelCallback:
			| ((
					message: { index: number; message: ArrayBuffer } | { index: number; end: boolean },
			  ) => void)
			| undefined;
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_request") {
				return { id: 55, status: 200, statusText: "OK", headers: [] };
			}
			return undefined;
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: {
				invoke,
				transformCallback: (callback: typeof channelCallback) => {
					channelCallback = callback;
					return 1;
				},
			},
		});

		const response = await hubFetch("https://127.0.0.1:4242/api/out-of-sequence");
		channelCallback?.({ index: 0, message: responseFrame(55n, 2n, 0, new Uint8Array([1])) });

		await expect(response.text()).rejects.toThrow("out of sequence");
	});

	it("cancels a started upload when a chunk relay fails", async () => {
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_upload_start") return 33;
			if (command === "relay_hub_upload_chunk") throw new Error("IPC rejected the chunk");
			return undefined;
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke, transformCallback: () => 1 },
		});
		const form = new FormData();
		form.append("field", "value");

		await expect(
			hubFetch("https://127.0.0.1:4242/api/upload", { method: "POST", body: form }),
		).rejects.toThrow("IPC rejected the chunk");
		expect(invoke).toHaveBeenCalledWith("relay_hub_upload_cancel", { uploadId: 33 }, undefined);
	});

	it("settles a stalled upload even when its producer and cancellation never resolve", async () => {
		vi.useFakeTimers();
		const invoke = vi.fn((command: string) => {
			if (command === "relay_hub_upload_start") return Promise.resolve(33);
			if (command === "relay_hub_upload_cancel") return new Promise<void>(() => undefined);
			return Promise.resolve(undefined);
		});
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			configurable: true,
			value: { invoke, transformCallback: () => 1 },
		});
		const body = new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => undefined);
			},
			cancel() {
				return new Promise<void>(() => undefined);
			},
		});

		const pending = hubFetch("https://127.0.0.1:4242/api/stalled-upload", {
			method: "POST",
			body,
		});
		const settled = expect(pending).rejects.toThrow("timed out while waiting for its producer");
		await vi.advanceTimersByTimeAsync(25_000);

		await settled;
		expect(invoke).toHaveBeenCalledWith("relay_hub_upload_cancel", { uploadId: 33 }, undefined);
	});

	it("keeps browser requests on fetch", async () => {
		const browserFetch = vi.fn(async () => new Response("browser"));
		vi.stubGlobal("fetch", browserFetch);

		const response = await hubFetch("/api/health");

		expect(await response.text()).toBe("browser");
		expect(browserFetch).toHaveBeenCalledWith("/api/health", undefined);
	});
});
