import type { WindowEffect } from "@lasterm/shared";
import { onMounted, onUnmounted, type Ref, ref, watch } from "vue";
import { type DisplayedEffectState, normalizeBackgroundMode } from "./useActiveWallpaper.js";

export type WindowEffectsPlatform = "linux" | "windows" | "macos";

export interface WindowEffectsPlatformInfo {
	os: WindowEffectsPlatform;
	windowsBuild: number | null;
}

export type NativeWindowEffect =
	| "mica"
	| "blur"
	| "acrylic"
	| "underWindowBackground"
	| "sidebar"
	| "hudWindow";

export interface WindowEffectOption {
	label: string;
	value: WindowEffect;
}

export interface WindowEffectsWindow {
	setEffects(effects: { effects: NativeWindowEffect[] }): Promise<void>;
	clearEffects(): Promise<void>;
}

export type WindowEffectsAdapter = () => Promise<WindowEffectsWindow | null>;

const WINDOWS_11_BUILD = 22_000;
const KNOWN_WINDOW_EFFECTS = new Set<WindowEffect>([
	"none",
	"auto",
	"mica",
	"blur",
	"acrylic",
	"vibrancy-under-window",
	"vibrancy-sidebar",
	"vibrancy-hud",
]);

const platformInfo = ref<WindowEffectsPlatformInfo | null>(null);
let _platformInfoLoad: Promise<WindowEffectsPlatformInfo | null> | null = null;

export function isTauriRuntime(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeWindowEffect(value: unknown): WindowEffect {
	return KNOWN_WINDOW_EFFECTS.has(value as WindowEffect) ? (value as WindowEffect) : "none";
}

function isWindows11(platform: WindowEffectsPlatformInfo): boolean {
	return platform.os === "windows" && (platform.windowsBuild ?? 0) >= WINDOWS_11_BUILD;
}

export function resolveWindowEffect(
	displayed: DisplayedEffectState,
	currentPlatformInfo: WindowEffectsPlatformInfo | null,
): NativeWindowEffect | null {
	if (normalizeBackgroundMode(displayed.mode) !== "transparent") return null;
	if (currentPlatformInfo === null) return null;

	const effect = normalizeWindowEffect(displayed.windowEffect);
	if (effect === "none") return null;

	if (currentPlatformInfo.os === "linux") return null;

	if (currentPlatformInfo.os === "windows") {
		if (effect === "auto") return isWindows11(currentPlatformInfo) ? "mica" : "blur";
		if (effect === "mica") return isWindows11(currentPlatformInfo) ? "mica" : null;
		if (effect === "blur" || effect === "acrylic") return effect;
		return null;
	}

	if (effect === "auto" || effect === "vibrancy-under-window") return "underWindowBackground";
	if (effect === "vibrancy-sidebar") return "sidebar";
	if (effect === "vibrancy-hud") return "hudWindow";
	return null;
}

export function windowEffectOptionsForPlatform(
	currentPlatformInfo: WindowEffectsPlatformInfo | null,
): WindowEffectOption[] {
	if (currentPlatformInfo === null) return [];
	const options: WindowEffectOption[] = [{ label: "None — see through", value: "none" }];

	if (currentPlatformInfo.os === "windows") {
		// Windows 11 materials only. Blur is the legacy accent: it drags and
		// resizes badly on 22621+, and it looks like the materials without
		// being one, which is how the picker read as broken (#62).
		if (isWindows11(currentPlatformInfo)) {
			options.push(
				{ label: "Mica — wallpaper tint", value: "mica" },
				{ label: "Acrylic — frosted blur", value: "acrylic" },
			);
		}
	} else if (currentPlatformInfo.os === "macos") {
		options.push(
			{ label: "Vibrancy Under Window", value: "vibrancy-under-window" },
			{ label: "Vibrancy Sidebar", value: "vibrancy-sidebar" },
			{ label: "Vibrancy HUD", value: "vibrancy-hud" },
		);
	}

	return options;
}

async function loadPlatformInfo(): Promise<WindowEffectsPlatformInfo | null> {
	if (!isTauriRuntime()) {
		platformInfo.value = null;
		return null;
	}

	try {
		const osPlugin = await import("@tauri-apps/plugin-os");
		const os = osPlugin.platform();
		if (os !== "linux" && os !== "windows" && os !== "macos") {
			platformInfo.value = null;
			return null;
		}
		const windowsBuild =
			os === "windows" ? Number.parseInt(osPlugin.version().split(".")[2] ?? "", 10) : null;
		platformInfo.value = {
			os,
			windowsBuild: Number.isFinite(windowsBuild) ? windowsBuild : null,
		};
		return platformInfo.value;
	} catch {
		platformInfo.value = null;
		return null;
	}
}

export function usePlatformInfo(): Ref<WindowEffectsPlatformInfo | null> {
	onMounted(() => {
		_platformInfoLoad ??= loadPlatformInfo();
	});
	return platformInfo;
}

/** What the desktop answers when it is asked for a background. */
interface WindowBackgroundOutcome {
	applied: boolean;
	needsRestart: boolean;
}

/** Named for the person reading the notice, not for the enum. */
const EFFECT_NAMES: Record<string, string> = {
	none: "See through",
	mica: "Mica",
	micaDark: "Mica",
	micaLight: "Mica",
	tabbed: "Mica",
	acrylic: "Acrylic",
	blur: "Blur",
};

async function askForWindowBackground(effect: string): Promise<void> {
	const { invoke } = await import("@tauri-apps/api/core");
	const outcome = await invoke<WindowBackgroundOutcome>("apply_window_background", { effect });
	if (!outcome?.needsRestart) return;
	// The window a Windows material needs is not the window a see-through
	// background needs — DWM paints its material for an opaque window and skips
	// one carrying per-pixel alpha — and which of the two a window is, is
	// settled when it is created. So this one is kept for the next launch.
	const { useToastStore } = await import("../stores/toast.js");
	useToastStore().show(
		"info",
		`${EFFECT_NAMES[effect] ?? effect} needs a window of its own — restart Lasterm to see it.`,
		8000,
	);
}

async function getCurrentTauriWindowForEffects(): Promise<WindowEffectsWindow | null> {
	if (!isTauriRuntime()) return null;
	return {
		async setEffects({ effects }) {
			await askForWindowBackground(effects[0] ?? "none");
		},
		async clearEffects() {
			await askForWindowBackground("none");
		},
	};
}

export function useWindowEffects(options: {
	displayedEffectState: Ref<DisplayedEffectState>;
	platformInfo: Ref<WindowEffectsPlatformInfo | null>;
	getWindow?: WindowEffectsAdapter;
}): void {
	const getWindow = options.getWindow ?? getCurrentTauriWindowForEffects;
	let generation = 0;
	let desiredEffect: NativeWindowEffect | null = null;
	let appliedEffect: NativeWindowEffect | null = null;
	let applying = false;
	let stopped = false;
	/** Nothing has been said to the window yet, whatever it may already carry. */
	let neverApplied = true;

	/**
	 * Whether the window still has to be told its background once.
	 *
	 * Only Windows moves the window between two shapes, and a window rebuilt
	 * for a material stays one: at startup it must hear the stored background
	 * even when that is see-through. Nowhere else is there anything to say.
	 */
	function owesFirstWord(): boolean {
		return neverApplied && options.platformInfo.value?.os === "windows";
	}

	function runApply(): void {
		if (applying || stopped) return;
		if (desiredEffect === appliedEffect && !owesFirstWord()) return;

		const runGeneration = generation;
		const effectAtStart = desiredEffect;
		applying = true;
		void (async () => {
			// The window keeps the shape a previous run left it in, so the first
			// word is always said: a window rebuilt for a material stays one
			// until it is told the background is see-through again.
			if (effectAtStart === null && appliedEffect === null && !owesFirstWord()) return;
			neverApplied = false;

			const win = await getWindow();
			if (win === null || stopped) return;
			if (runGeneration !== generation) return;

			if (effectAtStart === null) {
				await win.clearEffects();
				appliedEffect = null;
			} else {
				await win.setEffects({ effects: [effectAtStart] });
				appliedEffect = effectAtStart;
			}
		})()
			.catch((err) => {
				console.warn("[useWindowEffects] failed to apply native effect:", err);
			})
			.finally(() => {
				applying = false;
				if (!stopped && runGeneration !== generation) {
					runApply();
				}
			});
	}

	const stop = watch(
		[options.displayedEffectState, options.platformInfo],
		() => {
			const nextEffect = resolveWindowEffect(
				options.displayedEffectState.value,
				options.platformInfo.value,
			);
			if (nextEffect === desiredEffect && nextEffect === appliedEffect && !owesFirstWord()) return;
			desiredEffect = nextEffect;
			generation += 1;
			runApply();
		},
		{ immediate: true, flush: "sync" },
	);

	onUnmounted(() => {
		stopped = true;
		stop();
	});
}

export function resetWindowEffectsPlatformInfoForTests(): void {
	platformInfo.value = null;
	_platformInfoLoad = null;
}
