import type { FontFamily } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	domPublicAssetUrl: vi.fn<(path: string) => Promise<string>>(),
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../utils/hub-url.js", () => ({
	domPublicAssetUrl: mocks.domPublicAssetUrl,
	hubBaseUrl: () => "",
}));

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { injectFontFaces, useConfigStore } from "./config.js";

const oldFace: FontFamily[] = [
	{
		family: "Old Working Font",
		files: [{ url: "/public/fonts/old.woff2", weight: 400, style: "normal" }],
	},
];

const partiallyResolvableFaces: FontFamily[] = [
	{
		family: "Replacement Font",
		files: [
			{ url: "/public/fonts/working.woff2", weight: 400, style: "normal" },
			{ url: "/public/fonts/broken.woff2", weight: 700, style: "normal" },
		],
	},
];

describe("injectFontFaces", () => {
	beforeEach(() => {
		document.head.innerHTML = "";
		mocks.domPublicAssetUrl.mockReset();
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps a working face applied when another face cannot be resolved", async () => {
		mocks.domPublicAssetUrl.mockResolvedValueOnce("blob:old-working-font");
		await injectFontFaces(oldFace);
		const previousStyle = document.getElementById("lasterm-fonts");
		if (!previousStyle) throw new Error("expected the existing font style");
		const removePreviousStyle = vi.spyOn(previousStyle, "remove");

		mocks.domPublicAssetUrl.mockImplementation(async (path) => {
			if (path.endsWith("working.woff2")) return "blob:replacement-working-font";
			throw new Error("font file is unavailable");
		});
		await injectFontFaces(partiallyResolvableFaces);

		const style = document.getElementById("lasterm-fonts");
		expect(style).not.toBeNull();
		expect(style).not.toBe(previousStyle);
		expect(style?.textContent).toContain('url("blob:replacement-working-font")');
		expect(style?.textContent).not.toContain("broken.woff2");
		expect(document.head.contains(previousStyle)).toBe(false);
		expect(removePreviousStyle).not.toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:old-working-font");
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("failed to resolve custom font Replacement Font"),
			expect.any(Error),
		);
	});
});

// "Always do this" on an ended terminal's overlay writes the setting (#574).
describe("saveUiSettings", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		mocks.hubFetch.mockReset();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes the values to the UI config, and takes them at once", async () => {
		mocks.hubFetch.mockResolvedValue(new Response("{}", { status: 200 }));
		const store = useConfigStore();
		store.uiConfig = { onChannelDead: "readonly", panes: { maxPanes: 4 } };

		const saving = store.saveUiSettings("panes", { whenEnded: "close", keepEnded: true });
		// Acted on before the hub answers.
		expect(store.uiConfig.panes).toEqual({ maxPanes: 4, whenEnded: "close", keepEnded: true });
		await expect(saving).resolves.toBe(true);

		expect(mocks.hubFetch).toHaveBeenCalledTimes(1);
		const [url, init] = mocks.hubFetch.mock.calls[0] ?? [];
		expect(url).toBe("/api/config/ui");
		expect(init?.method).toBe("PUT");
		expect(JSON.parse(String(init?.body))).toEqual({
			panes: { whenEnded: "close", keepEnded: true },
		});
	});

	it("reads back what the hub holds when it refuses the write", async () => {
		mocks.hubFetch.mockResolvedValueOnce(new Response("{}", { status: 400 })).mockResolvedValueOnce(
			new Response(JSON.stringify({ onChannelDead: "readonly", panes: { whenEnded: "ask" } }), {
				status: 200,
			}),
		);
		const store = useConfigStore();

		await expect(store.saveUiSettings("panes", { whenEnded: "restart" })).resolves.toBe(false);
		expect(store.uiConfig.panes?.whenEnded).toBe("ask");
	});
});
