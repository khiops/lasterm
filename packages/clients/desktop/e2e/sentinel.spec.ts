import { describe, expect, it } from "vitest";
import { startSentinel } from "./sentinel.js";

describe("desktop boundary sentinel", () => {
	it("closes its listening socket when initialization after listen fails", async () => {
		let baseUrl = "";
		await expect(
			startSentinel(
				() => undefined,
				() => [],
				async (url) => {
					baseUrl = url;
					throw new Error("injected health check failure");
				},
			),
		).rejects.toThrow("injected health check failure");

		await expect(fetch(`${baseUrl}/__health`)).rejects.toThrow();
	});
});
