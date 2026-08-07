import { afterEach, describe, expect, it } from "vitest";
import {
	assetTokenReady,
	hubBaseUrl,
	hubWsUrl,
	namedPublicAssetUrl,
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

		expect(hubBaseUrl()).toBe("http://127.0.0.1:4137");
		expect(hubWsUrl()).toBe("ws://127.0.0.1:4137");
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

		expect(namedPublicAssetUrl("wallpapers", "desktop image.jpg", { t: 123 })).toBe(
			"/public/wallpapers/desktop%20image.jpg?asset_token=asset-token&t=123",
		);
	});

	it("signs existing public asset paths without dropping their query string", () => {
		setAssetTokenForTests("asset-token");

		expect(publicAssetUrl("/public/fonts/Hack-Regular.ttf?variant=regular")).toBe(
			"/public/fonts/Hack-Regular.ttf?variant=regular&asset_token=asset-token",
		);
	});

	it("prefixes signed public assets with the hub base URL in Tauri runtime", () => {
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		setAssetTokenForTests("asset-token");
		setHubPortForTests(4100);

		// The literal loopback address, not `localhost`: the hub binds `127.0.0.1`, and
		// a name that resolves to `::1` first would let another local process holding
		// `::1:4100` receive this URL's asset token.
		expect(namedPublicAssetUrl("sounds", "bell.mp3")).toBe(
			"http://127.0.0.1:4100/public/sounds/bell.mp3?asset_token=asset-token",
		);
	});

	it("omits asset_token from URL when no token is set", () => {
		// Token not set (default state after afterEach reset)
		const url = namedPublicAssetUrl("wallpapers", "bg.png");
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
