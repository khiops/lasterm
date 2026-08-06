import type { TerminalProfile } from "@lasterm/shared";
import type { CSSProperties } from "vue";
import { computed, type Ref, ref } from "vue";
import { assetTokenReady, namedPublicAssetUrl } from "../utils/hub-url.js";

/**
 * Composable: reactive wallpaper style computation for a terminal pane.
 *
 * Returns CSS style objects for the wallpaper background layer and the dim
 * overlay, both null when no wallpaper is configured (zero perf impact).
 */
export function useWallpaper(profile: Ref<TerminalProfile>) {
	const cacheBust = ref(Date.now());

	const wallpaperStyle = computed<CSSProperties | null>(() => {
		// Track assetTokenReady so this computed re-runs when the token arrives
		// (pairing path: token arrives after first render — without this read the
		// computed has no reactive dependency on the token and stays stale).
		void assetTokenReady.value;
		if (!profile.value.wallpaper) return null;
		const url = namedPublicAssetUrl("wallpapers", profile.value.wallpaper, {
			t: cacheBust.value,
		});
		const blur = profile.value.wallpaperBlur ?? 0;
		return {
			backgroundImage: `url(${url})`,
			backgroundSize: "cover",
			backgroundPosition: "center",
			...(blur > 0 ? { filter: `blur(${blur}px)`, willChange: "filter" as const } : {}),
		};
	});

	const dimStyle = computed<CSSProperties | null>(() => {
		if (!profile.value.wallpaper) return null;
		const dim = profile.value.wallpaperDim ?? 0;
		if (dim === 0) return null;
		return { background: `rgba(0, 0, 0, ${dim / 100})` };
	});

	function refreshCache(): void {
		cacheBust.value = Date.now();
	}

	return { wallpaperStyle, dimStyle, refreshCache };
}
