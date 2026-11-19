/**
 * What a real browser's CSS parser makes of the wallpaper style, which happy-dom
 * cannot answer: it refuses a quoted url() holding parentheses, which CSS allows.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { effectScope, ref } from "vue";
import { resetAssetHolderForTests } from "../utils/asset-holder.js";
import { setAssetTokenForTests } from "../utils/hub-url.js";
import { useWallpaper } from "./useWallpaper.js";

afterEach(() => {
	resetAssetHolderForTests();
	setAssetTokenForTests(null);
});

// encodeURIComponent keeps parentheses, and an unquoted url() ends at one (#194).
it("keeps a wallpaper whose name holds parentheses and spaces valid CSS", async () => {
	setActivePinia(createPinia());
	setAssetTokenForTests("t");
	const scope = effectScope();
	onTestFinished(() => scope.stop());
	const profile = ref({
		fontFamily: "monospace",
		fontSize: 14,
		theme: "dark",
		cursorStyle: "block" as const,
		scrollback: 5000,
		bellSound: "mute" as const,
		scrollbarMarkers: true,
		wallpaper: "my image (1).jpg",
		wallpaperBlur: 0,
		wallpaperDim: 0,
	});

	const { wallpaperStyle } = scope.run(() => useWallpaper(profile)) as ReturnType<
		typeof useWallpaper
	>;
	await expect.poll(() => wallpaperStyle.value?.backgroundImage).toContain("my%20image%20(1).jpg");

	const element = document.createElement("div");
	element.style.backgroundImage = wallpaperStyle.value?.backgroundImage ?? "";
	expect(element.style.backgroundImage).toContain("my%20image%20(1).jpg");
});
