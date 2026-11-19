import type { TerminalProfile } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EffectScope, effectScope, ref } from "vue";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { useAuthStore } from "../stores/auth.js";
import { invalidateAsset, resetAssetHolderForTests } from "../utils/asset-holder.js";
import { setAssetTokenForTests, setHubPortForTests } from "../utils/hub-url.js";
import { useWallpaper, WALLPAPER_RELEASE_DELAY_MS } from "./useWallpaper.js";

function makeProfile(overrides: Partial<TerminalProfile> = {}): TerminalProfile {
	return {
		fontFamily: "monospace",
		fontSize: 14,
		theme: "dark",
		cursorStyle: "block",
		scrollback: 5000,
		bellSound: "mute",
		scrollbarMarkers: true,
		wallpaper: "",
		wallpaperBlur: 0,
		wallpaperDim: 0,
		...overrides,
	};
}

let scope: EffectScope;
let revoked: string[];

/** Animation frames run only when a test says so, as in a window the system holds back. */
const frames = {
	queue: [] as FrameRequestCallback[],
	runFrame(): void {
		const due = frames.queue.splice(0);
		for (const callback of due) callback(0);
	},
};

function run<T>(body: () => T): T {
	return scope.run(body) as T;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The next relay fetch answers only when the test says so. */
function deferredFetch(): { resolve: () => void; reject: (error: Error) => void } {
	const control = { resolve: () => {}, reject: (_error: Error) => {} };
	mocks.hubFetch.mockImplementationOnce(
		() =>
			new Promise<Response>((resolve, reject) => {
				control.resolve = () => resolve(new Response("bytes", { status: 200 }));
				control.reject = reject;
			}),
	);
	return {
		resolve: () => control.resolve(),
		reject: (error) => control.reject(error),
	};
}

function enterDesktop(): void {
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: { invoke: () => undefined },
		configurable: true,
	});
	setHubPortForTests(4100);
}

describe("useWallpaper", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		setActivePinia(createPinia());
		useAuthStore().setToken("bearer-1");
		scope = effectScope();
		revoked = [];
		frames.queue = [];
		let next = 0;
		vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:test/${++next}`);
		vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
			revoked.push(url);
		});
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.queue.push(callback);
			return frames.queue.length;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {});
		mocks.hubFetch.mockReset();
		mocks.hubFetch.mockImplementation(async () => new Response("bytes", { status: 200 }));
	});

	afterEach(() => {
		scope.stop();
		resetAssetHolderForTests();
		Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
		setAssetTokenForTests(null);
		setHubPortForTests(null);
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe("wallpaperStyle", () => {
		it("should return null when wallpaper is empty", () => {
			const profile = ref(makeProfile());

			const { wallpaperStyle } = run(() => useWallpaper(profile));

			expect(wallpaperStyle.value).toBeNull();
		});

		it("shows the wallpaper as a quoted CSS url, signed in the browser", async () => {
			setAssetTokenForTests("asset-test-token");
			const profile = ref(makeProfile({ wallpaper: "mountains.jpg" }));

			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			expect(wallpaperStyle.value?.backgroundImage).toBe(
				'url("/public/wallpapers/mountains.jpg?asset_token=asset-test-token")',
			);
			expect(wallpaperStyle.value?.backgroundSize).toBe("cover");
			expect(wallpaperStyle.value?.backgroundPosition).toBe("center");
		});

		it("should include blur filter when wallpaperBlur > 0", async () => {
			setAssetTokenForTests("t");
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperBlur: 10 }));

			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			expect(wallpaperStyle.value?.filter).toBe("blur(10px)");
			expect(wallpaperStyle.value?.willChange).toBe("filter");
		});

		it("should not include blur filter when wallpaperBlur is 0", async () => {
			setAssetTokenForTests("t");
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperBlur: 0 }));

			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			expect(wallpaperStyle.value?.filter).toBeUndefined();
			expect(wallpaperStyle.value?.willChange).toBeUndefined();
		});

		it("waits for the asset token before showing a browser wallpaper (pairing path)", async () => {
			const profile = ref(makeProfile({ wallpaper: "bg.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();
			expect(wallpaperStyle.value).toBeNull();

			setAssetTokenForTests("late-token");
			await flush();

			expect(wallpaperStyle.value?.backgroundImage).toContain("asset_token=late-token");
		});

		it("names the new version after a same-name upload in the browser (#194)", async () => {
			setAssetTokenForTests("t");
			const profile = ref(makeProfile({ wallpaper: "bg.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			invalidateAsset("wallpapers", "bg.png");
			await flush();

			expect(wallpaperStyle.value?.backgroundImage).toBe(
				'url("/public/wallpapers/bg.png?asset_token=t&v=1")',
			);
		});
	});

	describe("on the desktop (#194)", () => {
		beforeEach(() => {
			enterDesktop();
		});

		it("relays the wallpaper and shows its blob URL", async () => {
			const profile = ref(makeProfile({ wallpaper: "desktop image.jpg" }));

			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/1")');
			expect(mocks.hubFetch.mock.calls[0]?.[0]).toBe(
				"https://127.0.0.1:4100/public/wallpapers/desktop%20image.jpg",
			);
		});

		it("releases a replaced wallpaper only after its layer has faded out, and the last one at dispose", async () => {
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			profile.value = makeProfile({ wallpaper: "b.png" });
			await flush();
			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/2")');

			// Frames withheld, as in a hidden window: no amount of time is enough.
			vi.advanceTimersByTime(60_000);
			expect(revoked).toEqual([]);
			frames.runFrame();
			frames.runFrame();
			vi.advanceTimersByTime(WALLPAPER_RELEASE_DELAY_MS - 1);
			expect(revoked).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(revoked).toEqual(["blob:test/1"]);

			scope.stop();
			expect(revoked).toEqual(["blob:test/1", "blob:test/2"]);
		});

		it("revokes a wallpaper that arrives after its pane is gone, and never shows it", async () => {
			const fetch = deferredFetch();
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			scope.stop();
			fetch.resolve();
			await flush();

			expect(wallpaperStyle.value).toBeNull();
			expect(revoked).toEqual(["blob:test/1"]);
		});

		it("keeps the old wallpaper while the new one loads, and clears it if that load fails", async () => {
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			const next = deferredFetch();
			profile.value = makeProfile({ wallpaper: "b.png" });
			await flush();
			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/1")');

			next.reject(new Error("relay closed"));
			await flush();
			expect(wallpaperStyle.value).toBeNull();
			// The layer showing a fades out over the same rule as a replacement.
			vi.advanceTimersByTime(60_000);
			expect(revoked).toEqual([]);
			frames.runFrame();
			frames.runFrame();
			vi.advanceTimersByTime(WALLPAPER_RELEASE_DELAY_MS - 1);
			expect(revoked).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(revoked).toEqual(["blob:test/1"]);
		});

		it("a late failure of a wallpaper no longer wanted leaves the chosen one shown", async () => {
			const first = deferredFetch();
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			profile.value = makeProfile({ wallpaper: "b.png" });
			await flush();
			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/1")');

			first.reject(new Error("relay closed"));
			await flush();
			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/1")');
		});

		it("going back and forth within a fade releases every handle exactly once", async () => {
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			run(() => useWallpaper(profile));
			await flush();
			profile.value = makeProfile({ wallpaper: "b.png" });
			await flush();
			profile.value = makeProfile({ wallpaper: "a.png" });
			await flush();

			frames.runFrame();
			frames.runFrame();
			vi.advanceTimersByTime(WALLPAPER_RELEASE_DELAY_MS);
			scope.stop();

			expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
			expect([...revoked].sort()).toEqual(["blob:test/1", "blob:test/2"]);
		});

		it("after a same-name upload of the shown wallpaper, fetches it again and retires the old blob", async () => {
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			invalidateAsset("wallpapers", "a.png");
			await flush();

			expect(mocks.hubFetch).toHaveBeenCalledTimes(2);
			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/2")');
			// Same name, new file: the old layer still fades out over the old blob.
			expect(revoked).toEqual([]);
			frames.runFrame();
			frames.runFrame();
			vi.advanceTimersByTime(WALLPAPER_RELEASE_DELAY_MS - 1);
			expect(revoked).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(revoked).toEqual(["blob:test/1"]);
		});

		it("after a same-name upload during the first load, never shows the old file that arrives late", async () => {
			const old = deferredFetch();
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			invalidateAsset("wallpapers", "a.png");
			await flush();
			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/1")');
			old.resolve();
			await flush();

			expect(wallpaperStyle.value?.backgroundImage).toBe('url("blob:test/1")');
			expect(revoked).toEqual(["blob:test/2"]);
		});

		it("never shows a wallpaper chosen away from while access was lost", async () => {
			const first = deferredFetch();
			const profile = ref(makeProfile({ wallpaper: "a.png" }));
			const { wallpaperStyle } = run(() => useWallpaper(profile));
			await flush();

			useAuthStore().clearToken();
			profile.value = makeProfile({ wallpaper: "b.png" });
			first.resolve();
			await flush();

			expect(wallpaperStyle.value).toBeNull();
			expect(revoked).toEqual(["blob:test/1"]);
		});

		it("loads nothing before the bearer is known", async () => {
			useAuthStore().clearToken();
			const profile = ref(makeProfile({ wallpaper: "a.png" }));

			run(() => useWallpaper(profile));
			await flush();

			expect(mocks.hubFetch).not.toHaveBeenCalled();
		});
	});

	describe("dimStyle", () => {
		it("should return null when wallpaper is empty", () => {
			const profile = ref(makeProfile());

			const { dimStyle } = run(() => useWallpaper(profile));

			expect(dimStyle.value).toBeNull();
		});

		// Same setting, same gesture — turn down what is behind — whether that is
		// a wallpaper image or the window under a see-through one.
		it("dims what shows through a see-through window, with no wallpaper at all", () => {
			const profile = ref(makeProfile({ backgroundMode: "transparent", wallpaperDim: 40 }));

			const { dimStyle } = run(() => useWallpaper(profile));

			expect(dimStyle.value).toEqual({ background: "rgba(0, 0, 0, 0.4)" });
		});

		it("has nothing to dim behind a solid background", () => {
			const profile = ref(makeProfile({ backgroundMode: "solid", wallpaperDim: 40 }));

			const { dimStyle } = run(() => useWallpaper(profile));

			expect(dimStyle.value).toBeNull();
		});

		it("should return null when wallpaperDim is 0", () => {
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperDim: 0 }));

			const { dimStyle } = run(() => useWallpaper(profile));

			expect(dimStyle.value).toBeNull();
		});

		it("should return rgba overlay when wallpaperDim > 0", () => {
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperDim: 40 }));

			const { dimStyle } = run(() => useWallpaper(profile));

			expect(dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.4)");
		});

		it("should return full opacity at 100%", () => {
			const profile = ref(makeProfile({ wallpaper: "bg.png", wallpaperDim: 100 }));

			const { dimStyle } = run(() => useWallpaper(profile));

			expect(dimStyle.value?.background).toBe("rgba(0, 0, 0, 1)");
		});
	});
});
