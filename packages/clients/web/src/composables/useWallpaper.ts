import type { TerminalProfile } from "@lasterm/shared";
import type { CSSProperties } from "vue";
import { computed, onScopeDispose, type Ref, shallowRef, watch } from "vue";
import { type AssetHandle, acquireAsset, assetVersion } from "../utils/asset-holder.js";
import { assetAccessReady } from "../utils/hub-url.js";
import { cssString } from "../utils/system-fonts.js";

/** How long a window-wallpaper layer fades in or out; `App.vue` applies it inline. */
export const WALLPAPER_FADE_MS = 160;

/**
 * How long a replaced wallpaper's handle outlives the replacement, counted from
 * two animation frames after it: Vue starts a leave's own end timer two frames
 * after the leave begins and ends it at the fade + 1 ms, so the layer that still
 * shows the old URL has gone before that URL is released (#194).
 */
export const WALLPAPER_RELEASE_DELAY_MS = 2 * WALLPAPER_FADE_MS;

function versionOf(name: string): number {
	try {
		return assetVersion("wallpapers", name);
	} catch {
		// A name the holder refuses: its acquire fails, which shows no wallpaper.
		return 0;
	}
}

/**
 * Composable: reactive wallpaper style computation for a terminal pane.
 *
 * Returns CSS style objects for the wallpaper background layer and the dim
 * overlay, both null when no wallpaper is configured (zero perf impact).
 *
 * It holds the handle of the URL it exposes (#194). A new wallpaper replaces the
 * old one only once it has loaded, so the window never fades to nothing while a
 * file crosses the relay; the old handle is released once the layer fading it
 * out has gone.
 */
export function useWallpaper(profile: Ref<TerminalProfile>) {
	const exposed = shallowRef<AssetHandle | null>(null);
	const pendingReleases = new Set<() => void>();
	let attempt = 0;
	let disposed = false;

	function retire(handle: AssetHandle): void {
		let frame = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const releaseNow = () => {
			if (!pendingReleases.delete(releaseNow)) return;
			cancelAnimationFrame(frame);
			if (timer !== undefined) clearTimeout(timer);
			handle.release();
		};
		pendingReleases.add(releaseNow);
		frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				timer = setTimeout(releaseNow, WALLPAPER_RELEASE_DELAY_MS);
			});
		});
	}

	function expose(handle: AssetHandle | null): void {
		const previous = exposed.value;
		exposed.value = handle;
		if (previous !== null) retire(previous);
	}

	watch(
		[
			() => profile.value.wallpaper,
			assetAccessReady,
			() => versionOf(profile.value.wallpaper ?? ""),
		],
		([wallpaper, ready]) => {
			if (!wallpaper) {
				attempt++;
				expose(null);
				return;
			}
			// Any change makes a load still in flight stale, with or without access.
			const current = ++attempt;
			// Without access the current wallpaper stays; nothing new can load.
			if (!ready) return;
			acquireAsset("wallpapers", wallpaper).then(
				(handle) => {
					// A wallpaper or version chosen since then wins; this one never shows.
					if (disposed || current !== attempt) {
						handle.release();
						return;
					}
					expose(handle);
				},
				() => {
					// Only the failure of the wallpaper still wanted clears the window.
					if (disposed || current !== attempt) return;
					expose(null);
				},
			);
		},
		{ immediate: true, flush: "sync" },
	);

	onScopeDispose(() => {
		disposed = true;
		for (const releaseNow of [...pendingReleases]) releaseNow();
		exposed.value?.release();
		exposed.value = null;
	});

	const wallpaperStyle = computed<CSSProperties | null>(() => {
		const url = exposed.value?.url;
		if (!profile.value.wallpaper || !url) return null;
		const blur = profile.value.wallpaperBlur ?? 0;
		return {
			backgroundImage: `url(${cssString(url)})`,
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

	return { wallpaperStyle, dimStyle };
}
