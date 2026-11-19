import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchSpy = vi.hoisted(() => vi.fn<(url: string, init?: RequestInit) => Promise<Response>>());
vi.mock("./hub-fetch.js", () => ({ hubFetch: fetchSpy }));

import { useAuthStore } from "../stores/auth.js";
import {
	assetAccessReady,
	assetTokenReady,
	hubBaseUrl,
	hubWsUrl,
	initAssetAccess,
	publicAssetUrl,
	setAssetTokenForTests,
	setHubPortForTests,
} from "./hub-url.js";

describe("the address the desktop client talks to", () => {
	afterEach(() => {
		setHubPortForTests(null);
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	});

	// Both of these carry the bearer token, and the hub binds `127.0.0.1`. A name
	// that resolves to `::1` first would let another local process holding
	// `::1:<port>` receive it, which is why the literal address is asserted here
	// rather than left to whatever the resolver prefers.
	it("is the literal loopback address, never a name that resolves", () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		setHubPortForTests(4137);

		expect(hubBaseUrl()).toBe("https://127.0.0.1:4137");
		expect(hubWsUrl()).toBe("wss://127.0.0.1:4137");
		expect(hubBaseUrl()).not.toContain("localhost");
		expect(hubWsUrl()).not.toContain("localhost");
	});

	it("stays relative outside the desktop runtime, where the page's own origin applies", () => {
		expect(hubBaseUrl()).toBe("");
	});

	// The port used to fall back to 4100 when unresolved, which is the same guess
	// that let a stranger on that port receive the bearer token. Failing names the
	// missing resolution instead of hiding it behind a plausible number.
	it("refuses to build a URL before the shell resolved the port", () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});

		expect(() => hubBaseUrl()).toThrow(/before initHubPort/);
		expect(() => hubWsUrl()).toThrow(/before initHubPort/);
	});
});

describe("public asset URL helpers", () => {
	afterEach(() => {
		setAssetTokenForTests(null);
		setHubPortForTests(null);
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	});

	it("appends the boot asset token and preserves extra query parameters", () => {
		setAssetTokenForTests("asset-token");

		expect(publicAssetUrl("/public/wallpapers/desktop%20image.jpg", { t: 123 })).toBe(
			"/public/wallpapers/desktop%20image.jpg?asset_token=asset-token&t=123",
		);
	});

	it("signs existing public asset paths without dropping their query string", () => {
		setAssetTokenForTests("asset-token");

		expect(publicAssetUrl("/public/fonts/Hack-Regular.ttf?variant=regular")).toBe(
			"/public/fonts/Hack-Regular.ttf?variant=regular&asset_token=asset-token",
		);
	});

	it("never puts the asset token in a desktop URL, even when one is set (#194)", () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		setAssetTokenForTests("asset-token");
		setHubPortForTests(4100);

		// The desktop relays this path with its bearer. The literal loopback
		// address, not `localhost`: the hub binds `127.0.0.1`.
		expect(publicAssetUrl("/public/sounds/b.mp3")).toBe(
			"https://127.0.0.1:4100/public/sounds/b.mp3",
		);
	});

	it("never produces a plaintext desktop asset URL", () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		setHubPortForTests(4100);

		expect(publicAssetUrl("/public/wallpapers/desktop.png")).toMatch(
			/^https:\/\/127\.0\.0\.1:4100\//,
		);
	});

	it("omits asset_token from URL when no token is set", () => {
		// Token not set (default state after afterEach reset)
		const url = publicAssetUrl("/public/wallpapers/bg.png");
		expect(url).not.toContain("asset_token");
	});

	it("assetTokenReady is false before setAssetTokenForTests and true after", () => {
		expect(assetTokenReady.value).toBe(false);
		setAssetTokenForTests("tok");
		expect(assetTokenReady.value).toBe(true);
		setAssetTokenForTests(null);
		expect(assetTokenReady.value).toBe(false);
	});
});

describe("asset access at startup (#194)", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		fetchSpy.mockReset();
		fetchSpy.mockResolvedValue(Response.json({ assetToken: "browser-token" }));
	});

	afterEach(() => {
		setAssetTokenForTests(null);
		setHubPortForTests(null);
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	});

	it("the desktop asks for no asset token, and is ready once its port and bearer are known", async () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: { invoke: () => undefined },
			configurable: true,
		});
		setHubPortForTests(4100);
		useAuthStore().setToken("bearer-1");

		await initAssetAccess("bearer-1");

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(assetAccessReady.value).toBe(true);
	});

	it("a browser loads the asset token with its bearer, then is ready", async () => {
		expect(assetAccessReady.value).toBe(false);

		await initAssetAccess("bearer-1");

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		expect(url).toBe("/api/assets/token");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bearer-1");
		expect(assetAccessReady.value).toBe(true);
	});
});
