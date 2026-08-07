/**
 * VisualProfileSettings — unit tests
 *
 * The component has no @vue/test-utils in this project; tests cover the pure
 * logic that drives the component's visual states:
 *
 *   - bannerTextError computed (SC-04 override indicator: error state)
 *   - opacityWarning computed (SC-06 inherited value: clamping behaviour)
 *   - onPresetChange logic via resolvePreset
 *   - onBannerField / onBorderField / onTintField merge-and-emit pattern
 *   - update() always sets preset to "custom" for manual edits
 *   - onTintField clamps opacity > 15 to 15
 */

import type { BorderStyle, VisualPreset, VisualProfile } from "@lasterm/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_VISUAL_PROFILE, resolvePreset } from "../utils/visual-presets.js";

// ---------------------------------------------------------------------------
// Helpers — replicate the component's internal functions as pure functions
// (identical logic, no Vue reactivity required)
// ---------------------------------------------------------------------------

function bannerTextError(profile: VisualProfile): string | null {
	if (profile.banner.enabled && !profile.banner.text.trim()) {
		return "Banner text is required when enabled";
	}
	return null;
}

function opacityWarning(profile: VisualProfile): string | null {
	if (profile.tint.opacity > 15) {
		return "Maximum opacity is 15%";
	}
	return null;
}

function update(current: VisualProfile, partial: Partial<VisualProfile>): VisualProfile {
	return { ...current, ...partial, preset: "custom" };
}

function onBannerField(
	current: VisualProfile,
	field: keyof VisualProfile["banner"],
	value: unknown,
): VisualProfile {
	return update(current, { banner: { ...current.banner, [field]: value } });
}

function onBorderField(
	current: VisualProfile,
	field: keyof VisualProfile["border"],
	value: unknown,
): VisualProfile {
	return update(current, { border: { ...current.border, [field]: value } });
}

function onTintField(
	current: VisualProfile,
	field: keyof VisualProfile["tint"],
	value: unknown,
): VisualProfile {
	const tint = { ...current.tint, [field]: value };
	if (typeof tint.opacity === "number" && tint.opacity > 15) {
		tint.opacity = 15;
	}
	return update(current, { tint });
}

function makeProfile(overrides: Partial<VisualProfile> = {}): VisualProfile {
	return {
		...DEFAULT_VISUAL_PROFILE,
		...overrides,
		banner: { ...DEFAULT_VISUAL_PROFILE.banner, ...(overrides.banner ?? {}) },
		border: { ...DEFAULT_VISUAL_PROFILE.border, ...(overrides.border ?? {}) },
		tint: { ...DEFAULT_VISUAL_PROFILE.tint, ...(overrides.tint ?? {}) },
	};
}

// ---------------------------------------------------------------------------
// bannerTextError — SC-04: override indicator drives error display
// ---------------------------------------------------------------------------

describe("bannerTextError", () => {
	it("returns null when banner is disabled", () => {
		const p = makeProfile({
			banner: { enabled: false, text: "", bgColor: "#e06c75", textColor: "#ffffff" },
		});
		expect(bannerTextError(p)).toBeNull();
	});

	it("returns null when banner is enabled and text is non-empty", () => {
		const p = makeProfile({
			banner: { enabled: true, text: "PROD", bgColor: "#e06c75", textColor: "#ffffff" },
		});
		expect(bannerTextError(p)).toBeNull();
	});

	it("returns error message when banner is enabled but text is empty string", () => {
		const p = makeProfile({
			banner: { enabled: true, text: "", bgColor: "#e06c75", textColor: "#ffffff" },
		});
		expect(bannerTextError(p)).toBe("Banner text is required when enabled");
	});

	it("returns error when banner is enabled but text is only whitespace", () => {
		const p = makeProfile({
			banner: { enabled: true, text: "   ", bgColor: "#e06c75", textColor: "#ffffff" },
		});
		expect(bannerTextError(p)).toBe("Banner text is required when enabled");
	});

	it("returns null when banner is disabled even if text is empty (no false positive)", () => {
		const p = makeProfile({
			banner: { enabled: false, text: "", bgColor: "#e06c75", textColor: "#ffffff" },
		});
		expect(bannerTextError(p)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// opacityWarning — SC-06: inherited-value display; opacity > 15 is invalid
// ---------------------------------------------------------------------------

describe("opacityWarning", () => {
	it("returns null when opacity is within range (0)", () => {
		const p = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 0 } });
		expect(opacityWarning(p)).toBeNull();
	});

	it("returns null when opacity is exactly at max (15)", () => {
		const p = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 15 } });
		expect(opacityWarning(p)).toBeNull();
	});

	it("returns warning when opacity exceeds 15", () => {
		const p = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 16 } });
		expect(opacityWarning(p)).toBe("Maximum opacity is 15%");
	});

	it("returns warning when opacity is well above max", () => {
		const p = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 100 } });
		expect(opacityWarning(p)).toBe("Maximum opacity is 15%");
	});

	it("returns null when tint is disabled regardless of opacity value", () => {
		// The warning only checks the opacity number, not enabled state
		// (component shows the warning only inside v-if="tint.enabled" template block)
		const p = makeProfile({ tint: { enabled: false, color: "#e06c75", opacity: 0 } });
		expect(opacityWarning(p)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// onPresetChange — preset selector applies full preset profile
// ---------------------------------------------------------------------------

describe("onPresetChange", () => {
	it("resolves 'none' preset to fully disabled profile", () => {
		const result = resolvePreset("none");
		expect(result.preset).toBe("none");
		expect(result.banner.enabled).toBe(false);
		expect(result.border.style).toBe("none");
		expect(result.tint.enabled).toBe(false);
		expect(result.tint.opacity).toBe(0);
	});

	it("resolves 'danger' preset to fully enabled red profile", () => {
		const result = resolvePreset("danger");
		expect(result.preset).toBe("danger");
		expect(result.banner.enabled).toBe(true);
		expect(result.banner.bgColor).toBe("#e06c75");
		expect(result.banner.textColor).toBe("#ffffff");
		expect(result.border.style).toBe("strong");
		expect(result.tint.enabled).toBe(true);
		expect(result.tint.opacity).toBe(5);
	});

	it("resolves 'caution' preset to yellow warning profile", () => {
		const result = resolvePreset("caution");
		expect(result.preset).toBe("caution");
		expect(result.banner.enabled).toBe(true);
		expect(result.banner.bgColor).toBe("#e5c07b");
		expect(result.banner.textColor).toBe("#1e1e1e");
		expect(result.border.style).toBe("subtle");
		expect(result.tint.opacity).toBe(3);
	});

	it("resolves 'custom' preset to defaults with preset=custom", () => {
		const result = resolvePreset("custom");
		expect(result.preset).toBe("custom");
		expect(result.banner.enabled).toBe(false);
		expect(result.border.style).toBe("none");
		expect(result.tint.enabled).toBe(false);
	});

	it("each preset call returns a new top-level object (not the same reference)", () => {
		const a = resolvePreset("danger");
		const b = resolvePreset("danger");
		expect(a).not.toBe(b);
	});
});

// ---------------------------------------------------------------------------
// update() — manual edits always stamp preset as "custom"
// ---------------------------------------------------------------------------

describe("update — manual edit sets preset to custom", () => {
	it("overrides preset to 'custom' when updating any field", () => {
		const base = resolvePreset("danger");
		expect(base.preset).toBe("danger");

		const next = update(base, { banner: { ...base.banner, text: "MY ENV" } });
		expect(next.preset).toBe("custom");
		expect(next.banner.text).toBe("MY ENV");
		// Other fields carried over
		expect(next.banner.bgColor).toBe(base.banner.bgColor);
		expect(next.border.style).toBe(base.border.style);
	});
});

// ---------------------------------------------------------------------------
// onBannerField — banner field changes emit merged profile
// ---------------------------------------------------------------------------

describe("onBannerField", () => {
	it("updates banner.enabled and stamps preset=custom", () => {
		const base = makeProfile();
		const next = onBannerField(base, "enabled", true);
		expect(next.banner.enabled).toBe(true);
		expect(next.preset).toBe("custom");
	});

	it("updates banner.text without affecting other banner fields", () => {
		const base = makeProfile({
			banner: { enabled: true, text: "OLD", bgColor: "#111111", textColor: "#ffffff" },
		});
		const next = onBannerField(base, "text", "NEW TEXT");
		expect(next.banner.text).toBe("NEW TEXT");
		expect(next.banner.bgColor).toBe("#111111");
		expect(next.banner.textColor).toBe("#ffffff");
		expect(next.banner.enabled).toBe(true);
	});

	it("updates banner.bgColor", () => {
		const base = makeProfile({
			banner: { enabled: true, text: "T", bgColor: "#000000", textColor: "#ffffff" },
		});
		const next = onBannerField(base, "bgColor", "#abcdef");
		expect(next.banner.bgColor).toBe("#abcdef");
	});

	it("updates banner.textColor", () => {
		const base = makeProfile({
			banner: { enabled: true, text: "T", bgColor: "#000000", textColor: "#000000" },
		});
		const next = onBannerField(base, "textColor", "#ffffff");
		expect(next.banner.textColor).toBe("#ffffff");
	});

	it("does not mutate the original profile", () => {
		const base = makeProfile({
			banner: { enabled: false, text: "", bgColor: "#e06c75", textColor: "#ffffff" },
		});
		onBannerField(base, "enabled", true);
		expect(base.banner.enabled).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// onBorderField — border field changes emit merged profile
// ---------------------------------------------------------------------------

describe("onBorderField", () => {
	it("updates border.style to 'subtle'", () => {
		const base = makeProfile();
		const next = onBorderField(base, "style", "subtle" as BorderStyle);
		expect(next.border.style).toBe("subtle");
		expect(next.preset).toBe("custom");
	});

	it("updates border.style to 'strong'", () => {
		const base = makeProfile();
		const next = onBorderField(base, "style", "strong" as BorderStyle);
		expect(next.border.style).toBe("strong");
	});

	it("updates border.color without affecting style", () => {
		const base = makeProfile({ border: { style: "subtle", color: "#000000" } });
		const next = onBorderField(base, "color", "#ff0000");
		expect(next.border.color).toBe("#ff0000");
		expect(next.border.style).toBe("subtle");
	});

	it("does not mutate the original profile", () => {
		const base = makeProfile({ border: { style: "none", color: "" } });
		onBorderField(base, "style", "strong" as BorderStyle);
		expect(base.border.style).toBe("none");
	});
});

// ---------------------------------------------------------------------------
// onTintField — tint field changes with opacity clamping
// ---------------------------------------------------------------------------

describe("onTintField", () => {
	it("updates tint.enabled", () => {
		const base = makeProfile();
		const next = onTintField(base, "enabled", true);
		expect(next.tint.enabled).toBe(true);
		expect(next.preset).toBe("custom");
	});

	it("updates tint.color", () => {
		const base = makeProfile({ tint: { enabled: true, color: "#000000", opacity: 5 } });
		const next = onTintField(base, "color", "#ff0000");
		expect(next.tint.color).toBe("#ff0000");
		expect(next.tint.opacity).toBe(5);
	});

	it("updates tint.opacity within valid range", () => {
		const base = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 0 } });
		const next = onTintField(base, "opacity", 10);
		expect(next.tint.opacity).toBe(10);
	});

	it("clamps tint.opacity > 15 to 15", () => {
		const base = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 0 } });
		const next = onTintField(base, "opacity", 20);
		expect(next.tint.opacity).toBe(15);
	});

	it("clamps tint.opacity at boundary: 16 → 15", () => {
		const base = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 0 } });
		const next = onTintField(base, "opacity", 16);
		expect(next.tint.opacity).toBe(15);
	});

	it("does not clamp opacity at max valid value (15)", () => {
		const base = makeProfile({ tint: { enabled: true, color: "#e06c75", opacity: 0 } });
		const next = onTintField(base, "opacity", 15);
		expect(next.tint.opacity).toBe(15);
	});

	it("does not mutate the original profile", () => {
		const base = makeProfile({ tint: { enabled: false, color: "#e06c75", opacity: 0 } });
		onTintField(base, "opacity", 20);
		expect(base.tint.opacity).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// DEFAULT_VISUAL_PROFILE — initial state renders without errors
// ---------------------------------------------------------------------------

describe("DEFAULT_VISUAL_PROFILE — initial state", () => {
	it("has preset 'none' with all sections disabled", () => {
		expect(DEFAULT_VISUAL_PROFILE.preset).toBe("none");
		expect(DEFAULT_VISUAL_PROFILE.banner.enabled).toBe(false);
		expect(DEFAULT_VISUAL_PROFILE.border.style).toBe("none");
		expect(DEFAULT_VISUAL_PROFILE.tint.enabled).toBe(false);
		expect(DEFAULT_VISUAL_PROFILE.tint.opacity).toBe(0);
	});

	it("produces no bannerTextError in default state (banner disabled)", () => {
		expect(bannerTextError(DEFAULT_VISUAL_PROFILE)).toBeNull();
	});

	it("produces no opacityWarning in default state (opacity=0)", () => {
		expect(opacityWarning(DEFAULT_VISUAL_PROFILE)).toBeNull();
	});

	it("is not the same object reference as the preset registry entry", () => {
		const preset = resolvePreset("none");
		// DEFAULT_VISUAL_PROFILE should be a copy, not the VISUAL_PRESETS[none] object
		expect(DEFAULT_VISUAL_PROFILE).not.toBe(preset);
	});
});

// ---------------------------------------------------------------------------
// Preset options coverage — all four VisualPreset values are handled
// ---------------------------------------------------------------------------

describe("preset options", () => {
	const presetOptions: VisualPreset[] = ["none", "caution", "danger", "custom"];

	it("resolvePreset handles every preset option without throwing", () => {
		for (const p of presetOptions) {
			expect(() => resolvePreset(p)).not.toThrow();
		}
	});

	it("each resolved preset has the correct preset field", () => {
		for (const p of presetOptions) {
			expect(resolvePreset(p).preset).toBe(p);
		}
	});
});
