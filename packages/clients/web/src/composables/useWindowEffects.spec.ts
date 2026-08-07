import type { BackgroundMode, WindowEffect } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";
import type { DisplayedEffectState } from "./useActiveWallpaper.js";
import {
	resetWindowEffectsPlatformInfoForTests,
	resolveWindowEffect,
	useWindowEffects,
	type WindowEffectsPlatformInfo,
	type WindowEffectsWindow,
} from "./useWindowEffects.js";

function withSetup<T>(setup: () => T): { result: T; unmount: () => void } {
	let result!: T;
	const app = createApp(
		defineComponent({
			setup() {
				result = setup();
				return {};
			},
			template: "<div />",
		}),
	);
	const el = document.createElement("div");
	app.mount(el);
	return { result, unmount: () => app.unmount() };
}

async function flushAsync(): Promise<void> {
	await nextTick();
	await Promise.resolve();
	await Promise.resolve();
	await nextTick();
}

function deferred(): { promise: Promise<void>; reject: () => void; resolve: () => void } {
	let reject!: () => void;
	let resolve!: () => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = () => fail(new Error("deferred rejection"));
	});
	return { promise, reject, resolve };
}

function displayedState(
	mode: BackgroundMode,
	windowEffect: WindowEffect = "auto",
): DisplayedEffectState {
	return { mode, windowEffect };
}

describe("resolveWindowEffect", () => {
	it("resolves auto and per-OS native effects", () => {
		const win11: WindowEffectsPlatformInfo = { os: "windows", windowsBuild: 26_100 };
		const win10: WindowEffectsPlatformInfo = { os: "windows", windowsBuild: 19_045 };
		const macos: WindowEffectsPlatformInfo = { os: "macos", windowsBuild: null };
		const linux: WindowEffectsPlatformInfo = { os: "linux", windowsBuild: null };

		expect(resolveWindowEffect(displayedState("transparent", "auto"), win11)).toBe("mica");
		expect(resolveWindowEffect(displayedState("transparent", "auto"), win10)).toBe("blur");
		expect(resolveWindowEffect(displayedState("transparent", "auto"), macos)).toBe(
			"underWindowBackground",
		);
		expect(resolveWindowEffect(displayedState("transparent", "auto"), linux)).toBeNull();
	});

	it("degrades invalid combinations and unknown values to none", () => {
		const win10: WindowEffectsPlatformInfo = { os: "windows", windowsBuild: 19_045 };
		const win11: WindowEffectsPlatformInfo = { os: "windows", windowsBuild: 26_100 };

		expect(resolveWindowEffect(displayedState("transparent", "mica"), win10)).toBeNull();
		expect(resolveWindowEffect(displayedState("solid", "auto"), win11)).toBeNull();
		expect(
			resolveWindowEffect({ mode: "transparent", windowEffect: "shimmer" as WindowEffect }, win11),
		).toBeNull();
		expect(
			resolveWindowEffect({ mode: "garbage" as BackgroundMode, windowEffect: "auto" }, win11),
		).toBeNull();
	});
});

describe("useWindowEffects", () => {
	afterEach(() => {
		resetWindowEffectsPlatformInfoForTests();
		vi.restoreAllMocks();
	});

	// ── Proof test 1: round-5 repro — cached scope short-circuits fallback timer ──────────────────

	it("clears mica immediately when switching to a cached solid scope (round-5 repro: no fallback timer needed)", async () => {
		// Scope A: transparent+mica applied.
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "auto"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(async () => {
				calls.push("clear");
			}),
		};

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow: async () => win,
			}),
		);
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);

		// Switch to scope B: the cache displays its solid background immediately
		// (cascade fetch for B never completes — simulated by never resolving).
		// useActiveWallpaper already shows B's solid cached state, so displayedEffectState
		// reflects that immediately — no fallback timer needed, no IPC race.
		displayed.value = displayedState("solid", "auto");
		await flushAsync();

		// The contract: displayed solid → desired null → clearEffects called.
		expect(calls).toEqual(["set:mica", "clear"]);
		unmount();
	});

	// ── Proof test 2: last pane closed ────────────────────────────────────────────────────────────

	it("clears an applied effect when the last pane closes (null/default displayed state)", async () => {
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "auto"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(async () => {
				calls.push("clear");
			}),
		};

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow: async () => win,
			}),
		);
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);

		// Last pane closed: useActiveWallpaper reverts to DEFAULT_PROFILE (backgroundMode "image").
		displayed.value = displayedState("image", "auto");
		await flushAsync();

		expect(calls).toEqual(["set:mica", "clear"]);
		unmount();
	});

	// ── Proof test 3: permanent-unresolved with fallback display ──────────────────────────────────

	it("clears when the fallback timer fires and useActiveWallpaper shows the default (solid/image) state", async () => {
		// Start with mica applied for a transparent scope.
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "mica"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(async () => {
				calls.push("clear");
			}),
		};

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow: async () => win,
			}),
		);
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);

		// Fallback timer fires: useActiveWallpaper switches displayedBackground to DEFAULT_PROFILE
		// which has backgroundMode "image" — the displayed state changes to non-transparent.
		displayed.value = displayedState("image", "mica");
		await flushAsync();

		expect(calls).toEqual(["set:mica", "clear"]);
		unmount();
	});

	// ── Proof test 4: transient switch — no spurious clear/re-apply (anti-flicker) ────────────────

	it("does not spuriously clear/re-apply during a scope switch that stays transparent+mica", async () => {
		// Both scope A and B use transparent+mica. During the switch, useActiveWallpaper shows
		// cached B immediately (also transparent+mica) → displayedEffectState never changes →
		// no intermediate IPC.
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "mica"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(async () => {
				calls.push("clear");
			}),
		};

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow: async () => win,
			}),
		);
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);

		// Scope switch: displayed state is identical (cached B is also transparent+mica).
		// Anti-flicker falls out of the contract: desired hasn't changed → no IPC.
		displayed.value = { ...displayedState("transparent", "mica") };
		await flushAsync();

		// No intermediate clear or re-set: the desired effect matches the applied effect.
		expect(calls).toEqual(["set:mica"]);
		unmount();
	});

	// ── Preserved coverage (S7/S8 per-OS matrix — pure function, input adapted) ───────────────────

	it("discards a stale pending set when the displayed state becomes non-transparent mid-flight", async () => {
		// Generation token ensures the stale async body aborts when desired changes before
		// the window handle resolves. Because the set never completed, appliedEffect stays
		// null, so no clearEffects call is needed afterward.
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "auto"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(async () => {
				calls.push("clear");
			}),
		};
		let resolveWindow!: (value: WindowEffectsWindow) => void;
		const pendingWindow = new Promise<WindowEffectsWindow | null>((resolve) => {
			resolveWindow = resolve;
		});
		let firstWindowLookup = true;
		const getWindow = vi.fn(() => {
			if (firstWindowLookup) {
				firstWindowLookup = false;
				return pendingWindow;
			}
			return Promise.resolve(win);
		});

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow,
			}),
		);
		await flushAsync();
		// Async body is pending (getWindow #1 not yet resolved).

		// displayedEffectState changes to solid → desiredEffect = null, generation bumped.
		displayed.value = displayedState("solid", "auto");
		await flushAsync();
		// Resolve the stale window handle — async body sees runGeneration !== generation → aborts.
		resolveWindow(win);
		await flushAsync();
		// finally reconciliation: appliedEffect is null, desiredEffect is null → no IPC.
		expect(calls).toEqual([]);

		// Subsequent transparency transition triggers correctly.
		displayed.value = displayedState("transparent", "mica");
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);
		unmount();
	});

	it("re-applies the latest desired effect after a stale IPC mutates native state", async () => {
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "mica"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const setDeferreds: ReturnType<typeof deferred>[] = [];
		const clearDeferreds: ReturnType<typeof deferred>[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(({ effects }) => {
				calls.push(`set:${effects[0]}`);
				const pending = deferred();
				setDeferreds.push(pending);
				return pending.promise;
			}),
			clearEffects: vi.fn(() => {
				calls.push("clear");
				const pending = deferred();
				clearDeferreds.push(pending);
				return pending.promise;
			}),
		};

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow: async () => win,
			}),
		);
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);

		setDeferreds[0]?.resolve();
		await flushAsync();

		displayed.value = displayedState("image", "none");
		await flushAsync();
		expect(calls).toEqual(["set:mica", "clear"]);

		displayed.value = displayedState("transparent", "mica");
		await flushAsync();
		expect(calls).toEqual(["set:mica", "clear"]);

		clearDeferreds[0]?.resolve();
		await flushAsync();

		expect(calls).toEqual(["set:mica", "clear", "set:mica"]);
		setDeferreds[1]?.resolve();
		await flushAsync();
		unmount();
	});

	it("retries the same desired effect after the window handle becomes available", async () => {
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "mica"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(async () => {
				calls.push("clear");
			}),
		};
		const getWindow = vi.fn(async () => (getWindow.mock.calls.length === 1 ? null : win));

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow,
			}),
		);
		await flushAsync();
		expect(calls).toEqual([]);

		displayed.value = { ...displayedState("transparent", "mica") };
		await flushAsync();

		expect(calls).toEqual(["set:mica"]);
		expect(getWindow).toHaveBeenCalledTimes(2);
		unmount();
	});

	it("retries clearing the same desired no-effect state after a clear failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "mica"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "windows",
			windowsBuild: 26_100,
		});
		const calls: string[] = [];
		const clearDeferreds: ReturnType<typeof deferred>[] = [];
		const win: WindowEffectsWindow = {
			setEffects: vi.fn(async ({ effects }) => {
				calls.push(`set:${effects[0]}`);
			}),
			clearEffects: vi.fn(() => {
				calls.push("clear");
				const pending = deferred();
				clearDeferreds.push(pending);
				return pending.promise;
			}),
		};

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow: async () => win,
			}),
		);
		await flushAsync();
		expect(calls).toEqual(["set:mica"]);

		displayed.value = displayedState("image", "none");
		await flushAsync();
		expect(calls).toEqual(["set:mica", "clear"]);

		clearDeferreds[0]?.reject();
		await flushAsync();

		displayed.value = { ...displayedState("image", "none") };
		await flushAsync();

		expect(calls).toEqual(["set:mica", "clear", "clear"]);
		clearDeferreds[1]?.resolve();
		await flushAsync();
		unmount();
	});

	it("does not call into Tauri for platform paths that never applied an effect", async () => {
		const displayed = ref<DisplayedEffectState>(displayedState("transparent", "auto"));
		const platformInfo = ref<WindowEffectsPlatformInfo | null>({
			os: "linux",
			windowsBuild: null,
		});
		const getWindow = vi.fn(async () => null);

		const { unmount } = withSetup(() =>
			useWindowEffects({
				displayedEffectState: displayed,
				platformInfo,
				getWindow,
			}),
		);
		await flushAsync();

		displayed.value = displayedState("image", "none");
		await flushAsync();

		expect(getWindow).not.toHaveBeenCalled();
		unmount();
	});
});
