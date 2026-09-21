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

	/**
	 * The dim veils whatever is behind the app's own drawing.
	 *
	 * With a wallpaper that is the image; on a see-through window it is the
	 * desktop, or whatever window is under this one. Same setting, because it
	 * is the same gesture — turn down what is behind — and a second slider
	 * elsewhere would only ask which of the two you meant.
	 *
	 * A solid background has nothing behind it, so there the dim does nothing
	 * and says so in the settings rather than moving in silence.
	 */
	const dimStyle = computed<CSSProperties | null>(() => {
		const dim = profile.value.wallpaperDim ?? 0;
		if (dim === 0) return null;
		const showsSomethingBehind =
			profile.value.backgroundMode === "transparent" || Boolean(profile.value.wallpaper);
		if (!showsSomethingBehind) return null;
		return { background: `rgba(0, 0, 0, ${dim / 100})` };
	});

	function refreshCache(): void {
		cacheBust.value = Date.now();
	}

	return { wallpaperStyle, dimStyle, refreshCache };
}
