import type { BackgroundMode, WindowEffect } from "@lasterm/shared";
import {
	type WindowEffectOption,
	type WindowEffectsPlatformInfo,
	windowEffectOptionsForPlatform,
} from "../../../composables/useWindowEffects.js";

export const WALLPAPER_OVERRIDE_KEYS = [
	"backgroundMode",
	"windowEffect",
	"wallpaper",
	"wallpaperBlur",
	"wallpaperDim",
] as const;

export type WallpaperOverrideKey = (typeof WALLPAPER_OVERRIDE_KEYS)[number];

export function normalizeSettingsBackgroundMode(value: unknown): BackgroundMode {
	return value === "solid" || value === "transparent" ? value : "image";
}

export function normalizeSettingsWindowEffect(value: unknown): WindowEffect {
	if (
		value === "auto" ||
		value === "mica" ||
		value === "blur" ||
		value === "acrylic" ||
		value === "vibrancy-under-window" ||
		value === "vibrancy-sidebar" ||
		value === "vibrancy-hud"
	) {
		return value;
	}
	return "none";
}

export function backgroundModeOptions(runsInTauri: boolean): Array<{
	label: string;
	value: BackgroundMode;
}> {
	return [
		{ label: "Image", value: "image" },
		{ label: "Solid", value: "solid" },
		{
			label: runsInTauri
				? "Transparent"
				: "Transparent (desktop only — renders as solid in this browser)",
			value: "transparent",
		},
	];
}

export function windowEffectSettingsOptions(
	platformInfo: WindowEffectsPlatformInfo | null,
): WindowEffectOption[] {
	return windowEffectOptionsForPlatform(platformInfo);
}

export function shouldShowWindowEffectPicker(
	runsInTauri: boolean,
	platformInfo: WindowEffectsPlatformInfo | null,
): boolean {
	// Linux resolves every effect to none (spec §3.2: picker hidden entirely) —
	// offering a picker there would persist a setting that never does anything.
	if (!runsInTauri || platformInfo === null || platformInfo.os === "linux") return false;
	return windowEffectSettingsOptions(platformInfo).length > 0;
}

export function windowEffectDescription(platformInfo: WindowEffectsPlatformInfo | null): string {
	if (platformInfo?.os === "linux") {
		return "Linux exposes no native blur material; transparent mode depends on compositor support.";
	}
	if (platformInfo?.os === "windows") {
		return "Native desktop material for transparent mode; Blur and Acrylic can be slower on some Windows builds.";
	}
	return "Native macOS vibrancy material for transparent mode.";
}
