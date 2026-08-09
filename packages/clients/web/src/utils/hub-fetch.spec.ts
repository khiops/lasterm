import { afterEach, describe, expect, it, vi } from "vitest";
import { hubFetch } from "./hub-fetch.js";

describe("hubFetch desktop transport", () => {
	afterEach(() => {
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
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
		["Blob", new Blob([new Uint8Array([0, 255, 1, 128])]), [0, 255, 1, 128]],
		["ArrayBuffer", new Uint8Array([2, 254, 3]).buffer, [2, 254, 3]],
		["typed array", new Uint8Array([4, 253, 5]), [4, 253, 5]],
		[
			"URLSearchParams",
			new URLSearchParams("one=1&two=%C3%A9"),
			[111, 110, 101, 61, 49, 38, 116, 119, 111, 61, 37, 67, 51, 37, 65, 57],
		],
	])("relays %s request bodies byte-for-byte", async (_kind, body, expectedBytes) => {
		const invoke = vi.fn(async (command: string) => {
			if (command === "relay_hub_request") {
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
			"relay_hub_request",
			expect.objectContaining({
				request: expect.objectContaining({ body: expectedBytes }),
			}),
			undefined,
		);
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

	it("keeps browser requests on fetch", async () => {
		const browserFetch = vi.fn(async () => new Response("browser"));
		vi.stubGlobal("fetch", browserFetch);

		const response = await hubFetch("/api/health");

		expect(await response.text()).toBe("browser");
		expect(browserFetch).toHaveBeenCalledWith("/api/health", undefined);
	});
});
