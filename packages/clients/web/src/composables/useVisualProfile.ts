import type { Host, VisualProfile } from "@lasterm/shared";
import { computed, type Ref } from "vue";
import { DEFAULT_VISUAL_PROFILE, HEX_COLOR_RE } from "../utils/visual-presets.js";

/**
 * Deep-merge two VisualProfile objects: defaults first, then overrides.
 * Each nested object (banner, border, tint) is merged independently so
 * a partial override (e.g. only `banner.enabled`) does not lose the
 * other default sub-keys.
 */
function deepMergeProfile(
	defaults: VisualProfile,
	overrides: Partial<VisualProfile>,
): VisualProfile {
	return {
		preset: overrides.preset ?? defaults.preset,
		banner: { ...defaults.banner, ...overrides.banner },
		border: { ...defaults.border, ...overrides.border },
		tint: { ...defaults.tint, ...overrides.tint },
	};
}

/**
 * Resolve a host's visual profile from its profileJson field.
 * Falls back to DEFAULT_VISUAL_PROFILE for missing/invalid data.
 * Uses a deep merge so partial nested overrides preserve sub-key defaults.
 */
export function getVisualProfile(host: Host | undefined | null): VisualProfile {
	if (!host?.profileJson) return { ...DEFAULT_VISUAL_PROFILE };
	try {
		const parsed = JSON.parse(host.profileJson);
		if (parsed?.visualProfile) {
			return deepMergeProfile(
				DEFAULT_VISUAL_PROFILE,
				parsed.visualProfile as Partial<VisualProfile>,
			);
		}
	} catch {
		// Invalid JSON — fall back
	}
	return { ...DEFAULT_VISUAL_PROFILE };
}

/** Replace banner tokens with host values. Unresolvable tokens stay as literal. */
export function resolveBannerTokens(text: string, host: Host): string {
	return text
		.replace(/\{host\}/g, host.label ?? "")
		.replace(/\{ip\}/g, host.sshHost ?? "localhost")
		.replace(/\{user\}/g, host.sshUser ?? "")
		.replace(/\{group\}/g, host.hostGroup ?? "{group}");
}

/** Validate a hex color. Returns true for valid #rrggbb format. */
export function isValidHexColor(color: string): boolean {
	return HEX_COLOR_RE.test(color);
}

/** Clamp tint opacity to 0-15 range */
export function clampOpacity(opacity: number): number {
	return Math.max(0, Math.min(15, opacity));
}

/**
 * Composable: reactive visual profile for a host.
 */
export function useVisualProfile(host: Ref<Host | undefined | null>) {
	const profile = computed(() => getVisualProfile(host.value));

	const bannerText = computed(() => {
		if (!profile.value.banner.enabled || !host.value) return "";
		const resolved = resolveBannerTokens(profile.value.banner.text, host.value);
		return resolved.trim() ? resolved : "";
	});

	const borderStyle = computed(() => {
		const p = profile.value;
		const color =
			p.border.color && isValidHexColor(p.border.color)
				? p.border.color
				: (host.value?.color ?? "");

		if (p.border.style === "subtle" && color) {
			return { borderLeft: `2px solid ${color}` };
		}
		if (p.border.style === "strong" && color) {
			return {
				borderLeft: `3px solid ${color}`,
				borderRight: `3px solid ${color}`,
				borderBottom: `3px solid ${color}`,
			};
		}
		return {};
	});

	const tintStyle = computed(() => {
		const p = profile.value;
		if (!p.tint.enabled || !p.tint.color || !isValidHexColor(p.tint.color)) return null;
		const opacity = clampOpacity(p.tint.opacity) / 100;
		// Convert hex to rgb for rgba()
		const hex = p.tint.color;
		const r = Number.parseInt(hex.slice(1, 3), 16);
		const g = Number.parseInt(hex.slice(3, 5), 16);
		const b = Number.parseInt(hex.slice(5, 7), 16);
		return {
			backgroundColor: `rgba(${r}, ${g}, ${b}, ${opacity})`,
		};
	});

	return { profile, bannerText, borderStyle, tintStyle };
}
