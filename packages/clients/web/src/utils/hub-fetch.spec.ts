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

		const response = await hubFetch("http://127.0.0.1:4242/api/health");

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

	it("keeps browser requests on fetch", async () => {
		const browserFetch = vi.fn(async () => new Response("browser"));
		vi.stubGlobal("fetch", browserFetch);

		const response = await hubFetch("/api/health");

		expect(await response.text()).toBe("browser");
		expect(browserFetch).toHaveBeenCalledWith("/api/health", undefined);
	});
});
