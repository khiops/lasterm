import {
	type BackgroundMode,
	DEFAULT_PROFILE,
	type TerminalProfile,
	type WindowEffect,
} from "@lasterm/shared";
import { computed, onUnmounted, type Ref, ref, watch } from "vue";
import { useConfigStore } from "../stores/config.js";
import { useResolvedProfile } from "./useResolvedProfile.js";
import type { Tab } from "./useTabManager.js";
import { useWallpaper } from "./useWallpaper.js";

export const UNRESOLVED_WALLPAPER_FALLBACK_MS = 1_000;

interface UseActiveWallpaperOptions {
	activeTab: Ref<Tab | null>;
	getActiveChannelId: (tabId: string) => string | null;
	channelHostMap: Ref<ReadonlyMap<string, string>>;
}

type WallpaperProfile = Required<
	Pick<TerminalProfile, "wallpaper" | "wallpaperBlur" | "wallpaperDim">
>;
type WindowBackgroundProfile = WallpaperProfile & {
	backgroundMode: BackgroundMode;
	windowEffect: WindowEffect;
};

/** What `useWindowEffects` reads to derive the desired native effect. */
export type DisplayedEffectState = {
	mode: BackgroundMode;
	windowEffect: WindowEffect;
};

export function normalizeBackgroundMode(value: unknown): BackgroundMode {
	if (value === "image" || value === "solid" || value === "transparent") return value;
	return "image";
}

export function shouldRenderWallpaper(profile: WindowBackgroundProfile): boolean {
	return profile.backgroundMode === "image" && profile.wallpaper.length > 0;
}

export function shouldUseTransparentBackground(
	backgroundMode: BackgroundMode,
	isTauriRuntime: boolean,
): boolean {
	return backgroundMode === "transparent" && isTauriRuntime;
}

function wallpaperScopeKey(hostId: string | null, channelId: string | null): string | null {
	if (channelId === null) return null;
	return JSON.stringify([hostId, channelId]);
}

function wallpaperFields(profile: TerminalProfile): WallpaperProfile {
	return {
		wallpaper: profile.wallpaper ?? DEFAULT_PROFILE.wallpaper ?? "",
		wallpaperBlur: profile.wallpaperBlur ?? DEFAULT_PROFILE.wallpaperBlur ?? 0,
		wallpaperDim: profile.wallpaperDim ?? DEFAULT_PROFILE.wallpaperDim ?? 0,
	};
}

function backgroundFields(profile: TerminalProfile): WindowBackgroundProfile {
	return {
		...wallpaperFields(profile),
		backgroundMode: normalizeBackgroundMode(
			profile.backgroundMode ?? DEFAULT_PROFILE.backgroundMode,
		),
		windowEffect: profile.windowEffect ?? DEFAULT_PROFILE.windowEffect ?? "none",
	};
}

function terminalProfileFromBackground(profile: WindowBackgroundProfile): TerminalProfile {
	return { ...DEFAULT_PROFILE, ...profile };
}

/**
 * Resolves the single window wallpaper from the active tab's focused pane.
 * The host/channel cascade still comes from the existing resolved-profile API.
 */
export function useActiveWallpaper(options: UseActiveWallpaperOptions) {
	const configStore = useConfigStore();
	const activeChannelId = computed<string | null>(() => {
		const tab = options.activeTab.value;
		if (tab === null) return null;
		return options.getActiveChannelId(tab.id);
	});

	const activeHostId = computed<string | null>(() => {
		const channelId = activeChannelId.value;
		if (channelId === null) return null;
		return options.channelHostMap.value.get(channelId) ?? null;
	});

	const {
		profile: resolvedProfile,
		resolvedFor,
		reload,
	} = useResolvedProfile(activeHostId, activeChannelId);

	const activeScopeKey = computed(() =>
		wallpaperScopeKey(activeHostId.value, activeChannelId.value),
	);
	const globalBackground = computed(() => backgroundFields(configStore.profile ?? DEFAULT_PROFILE));
	const resolvedForActivePane = computed(() => {
		const channelId = activeChannelId.value;
		if (channelId === null) return false;
		const context = resolvedFor.value;
		return context?.channelId === channelId && context.hostId === activeHostId.value;
	});

	const wallpaperCache = new Map<string, WindowBackgroundProfile>();
	const displayedBackground = ref<WindowBackgroundProfile>(backgroundFields(DEFAULT_PROFILE));
	/** True once the unresolved-fallback timer fires for the current scope key. Resets on scope change or successful resolution. */
	const fallbackActive = ref(false);
	let unresolvedFallbackTimer: ReturnType<typeof setTimeout> | null = null;

	function clearUnresolvedFallbackTimer(): void {
		if (unresolvedFallbackTimer === null) return;
		clearTimeout(unresolvedFallbackTimer);
		unresolvedFallbackTimer = null;
	}

	function showWallpaper(profile: WindowBackgroundProfile): void {
		clearUnresolvedFallbackTimer();
		fallbackActive.value = false;
		displayedBackground.value = { ...profile };
	}

	function showGlobalWallpaper(): void {
		showWallpaper(globalBackground.value);
	}

	function showCachedWallpaper(key: string): boolean {
		const cached = wallpaperCache.get(key);
		if (cached === undefined) return false;
		showWallpaper(cached);
		return true;
	}

	function startUnresolvedFallbackTimer(key: string): void {
		clearUnresolvedFallbackTimer();
		fallbackActive.value = false;
		unresolvedFallbackTimer = setTimeout(() => {
			unresolvedFallbackTimer = null;
			if (activeScopeKey.value !== key || resolvedForActivePane.value) return;
			fallbackActive.value = true;
			if (showCachedWallpaper(key)) return;
			displayedBackground.value = backgroundFields(DEFAULT_PROFILE);
		}, UNRESOLVED_WALLPAPER_FALLBACK_MS);
	}

	watch(
		activeScopeKey,
		(key) => {
			if (key === null) {
				showGlobalWallpaper();
				return;
			}
			if (showCachedWallpaper(key)) return;
			startUnresolvedFallbackTimer(key);
		},
		{ immediate: true, flush: "sync" },
	);

	watch(
		[resolvedFor, resolvedProfile, activeScopeKey],
		() => {
			const key = activeScopeKey.value;
			if (key === null) {
				showGlobalWallpaper();
				return;
			}
			if (!resolvedForActivePane.value) return;

			const profile = backgroundFields(resolvedProfile.value);
			wallpaperCache.set(key, { ...profile });
			showWallpaper(profile);
		},
		{ immediate: true, flush: "sync" },
	);

	watch(
		globalBackground,
		() => {
			if (activeScopeKey.value === null) showGlobalWallpaper();
		},
		{ flush: "sync" },
	);

	onUnmounted(() => {
		clearUnresolvedFallbackTimer();
	});

	const backgroundProfile = computed<TerminalProfile>(() => {
		return terminalProfileFromBackground(displayedBackground.value);
	});
	const wallpaperProfile = computed<TerminalProfile>(() => ({
		...backgroundProfile.value,
		wallpaper: shouldRenderWallpaper(displayedBackground.value)
			? displayedBackground.value.wallpaper
			: "",
	}));
	const backgroundMode = computed<BackgroundMode>(() => displayedBackground.value.backgroundMode);

	/**
	 * The displayed effect state — derived from `displayedBackground`, the same internal state
	 * that drives the painted background (resolved, cached, or default-fallback).
	 * `useWindowEffects` watches this ref instead of the raw resolved profile + boolean gates.
	 */
	const displayedEffectState = computed<DisplayedEffectState>(() => ({
		mode: displayedBackground.value.backgroundMode,
		windowEffect: displayedBackground.value.windowEffect,
	}));

	const { wallpaperStyle, dimStyle, refreshCache } = useWallpaper(wallpaperProfile);

	return {
		activeChannelId,
		activeHostId,
		profile: backgroundProfile,
		resolvedProfile,
		resolvedForActivePane,
		fallbackActive,
		backgroundMode,
		displayedEffectState,
		wallpaperStyle,
		dimStyle,
		reload,
		refreshCache,
	};
}
