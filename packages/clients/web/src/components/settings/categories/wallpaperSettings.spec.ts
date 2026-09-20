import { describe, expect, it } from "vitest";
import {
	backgroundModeOptions,
	normalizeSettingsBackgroundMode,
	normalizeSettingsWindowEffect,
	shouldShowWindowEffectPicker,
	WALLPAPER_OVERRIDE_KEYS,
	windowEffectDescription,
	windowEffectSettingsOptions,
} from "./wallpaperSettings.js";

describe("wallpaper settings helpers", () => {
	it("shows the transparent mode hint in non-Tauri runtimes", () => {
		expect(backgroundModeOptions(false)).toContainEqual({
			label: "Transparent (desktop only — renders as solid in this browser)",
			value: "transparent",
		});
		expect(backgroundModeOptions(true)).toContainEqual({
			label: "Transparent",
			value: "transparent",
		});
	});

	it("normalizes unknown settings values to safe defaults", () => {
		expect(normalizeSettingsBackgroundMode("transparent")).toBe("transparent");
		expect(normalizeSettingsBackgroundMode("garbage")).toBe("image");
		expect(normalizeSettingsWindowEffect("mica")).toBe("mica");
		expect(normalizeSettingsWindowEffect("shimmer")).toBe("none");
	});

	it("shows the effect picker only for Tauri with platform info", () => {
		const win11 = { os: "windows" as const, windowsBuild: 26_100 };
		expect(shouldShowWindowEffectPicker(false, win11)).toBe(false);
		expect(shouldShowWindowEffectPicker(true, null)).toBe(false);
		expect(shouldShowWindowEffectPicker(true, win11)).toBe(true);
		// Windows 11 offers the two materials DWM paints, and see-through.
		expect(windowEffectSettingsOptions(win11).map((option) => option.value)).toEqual([
			"none",
			"mica",
			"acrylic",
		]);
	});

	// Blur is the legacy accent — it drags badly on 22621+ and looks like a
	// material without being one, which is what made the picker read as broken.
	it("offers no blur and no auto, which hid which material you would get", () => {
		const values = windowEffectSettingsOptions({
			os: "windows" as const,
			windowsBuild: 26_100,
		}).map((option) => option.value);
		expect(values).not.toContain("blur");
		expect(values).not.toContain("auto");
	});

	it("hides the effect picker entirely on Linux (every effect resolves to none there)", () => {
		expect(shouldShowWindowEffectPicker(true, { os: "linux" as const, windowsBuild: null })).toBe(
			false,
		);
	});

	it("keeps background override detection and reset scoped to every wallpaper key", () => {
		expect(WALLPAPER_OVERRIDE_KEYS).toEqual([
			"backgroundMode",
			"windowEffect",
			"wallpaper",
			"wallpaperBlur",
			"wallpaperDim",
		]);
	});

	it("describes platform-specific effect behavior", () => {
		expect(windowEffectDescription({ os: "linux", windowsBuild: null })).toContain(
			"compositor support",
		);
		expect(windowEffectDescription({ os: "windows", windowsBuild: 26_100 })).toContain("Windows");
		expect(windowEffectDescription({ os: "macos", windowsBuild: null })).toContain("macOS");
	});
});
