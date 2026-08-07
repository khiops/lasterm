import type { VisualPreset, VisualProfile } from "@lasterm/shared";

export const VISUAL_PRESETS: Record<Exclude<VisualPreset, "custom">, VisualProfile> = {
	none: {
		preset: "none",
		banner: { enabled: false, text: "", bgColor: "#e06c75", textColor: "#ffffff" },
		border: { style: "none", color: "" },
		tint: { enabled: false, color: "#e06c75", opacity: 0 },
	},
	caution: {
		preset: "caution",
		banner: { enabled: true, text: "STAGING - {host}", bgColor: "#e5c07b", textColor: "#1e1e1e" },
		border: { style: "subtle", color: "#e5c07b" },
		tint: { enabled: true, color: "#e5c07b", opacity: 3 },
	},
	danger: {
		preset: "danger",
		banner: {
			enabled: true,
			text: "PRODUCTION - {host}",
			bgColor: "#e06c75",
			textColor: "#ffffff",
		},
		border: { style: "strong", color: "#e06c75" },
		tint: { enabled: true, color: "#e06c75", opacity: 5 },
	},
};

export function resolvePreset(preset: VisualPreset): VisualProfile {
	if (preset === "custom") {
		return { ...VISUAL_PRESETS.none, preset: "custom" };
	}
	return { ...VISUAL_PRESETS[preset] };
}

/** Hex color validation: #rrggbb */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Default empty visual profile */
export const DEFAULT_VISUAL_PROFILE: VisualProfile = { ...VISUAL_PRESETS.none };
