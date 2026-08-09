import type { TerminalProfile } from "@lasterm/shared";
import type { CSSProperties } from "vue";
import { computed, type Ref, ref, watch } from "vue";
import { assetTokenReady, domNamedPublicAssetUrl, namedPublicAssetUrl } from "../utils/hub-url.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";

/**
 * Composable: reactive wallpaper style computation for a terminal pane.
 *
 * Returns CSS style objects for the wallpaper background layer and the dim
 * overlay, both null when no wallpaper is configured (zero perf impact).
 */
export function useWallpaper(profile: Ref<TerminalProfile>) {
	const cacheBust = ref(Date.now());
	const resolvedWallpaperUrl = ref<string | null>(null);
	let resolution = 0;

	watch(
		[() => profile.value.wallpaper, cacheBust, assetTokenReady],
		([wallpaper, cacheBust]) => {
			const currentResolution = ++resolution;
			if (!wallpaper) {
				resolvedWallpaperUrl.value = null;
				return;
			}
			if (!isTauriRuntime()) {
				resolvedWallpaperUrl.value = namedPublicAssetUrl("wallpapers", wallpaper, { t: cacheBust });
				return;
			}
			resolvedWallpaperUrl.value = null;
			void domNamedPublicAssetUrl("wallpapers", wallpaper, { t: cacheBust })
				.then((url) => {
					if (currentResolution === resolution) resolvedWallpaperUrl.value = url;
				})
				.catch(() => undefined);
		},
		{ immediate: true, flush: "sync" },
	);

	const wallpaperStyle = computed<CSSProperties | null>(() => {
		if (!profile.value.wallpaper || !resolvedWallpaperUrl.value) return null;
		const blur = profile.value.wallpaperBlur ?? 0;
		return {
			backgroundImage: `url(${resolvedWallpaperUrl.value})`,
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
