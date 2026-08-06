import { DEFAULT_PROFILE, type TerminalProfile } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";
import type { ProfileChangeEvent } from "../stores/config.js";
import { setAssetTokenForTests } from "../utils/hub-url.js";
import type { PaneNode } from "./usePaneTree.js";
import type { Tab } from "./useTabManager.js";

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
	app.use(createPinia());
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

vi.mock("../stores/config.js", async () => {
	const shared = await vi.importActual<typeof import("@lasterm/shared")>("@lasterm/shared");
	const vue = await vi.importActual<typeof import("vue")>("vue");
	let listeners = new Set<(e: ProfileChangeEvent) => void>();
	const profile = vue.ref<TerminalProfile>({ ...shared.DEFAULT_PROFILE });
	return {
		useConfigStore: () => ({
			get profile() {
				return profile.value;
			},
			set profile(next: TerminalProfile) {
				profile.value = next;
			},
			onProfileChange(cb: (e: ProfileChangeEvent) => void) {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
			_setProfile(next: TerminalProfile) {
				profile.value = next;
			},
			_reset() {
				listeners = new Set();
				profile.value = { ...shared.DEFAULT_PROFILE };
			},
		}),
	};
});

vi.mock("../stores/auth.js", () => ({
	useAuthStore: () => ({ token: "test-token" }),
}));

vi.mock("../utils/hub-url.js", async () => {
	const actual = await vi.importActual<typeof import("../utils/hub-url.js")>("../utils/hub-url.js");
	const vue = await vi.importActual<typeof import("vue")>("vue");
	return {
		hubBaseUrl: () => "http://hub",
		hubPortReady: vue.ref(true),
		// Expose the real assetTokenReady and setAssetTokenForTests so reactivity
		// tests can control the token while Vue tracks the dependency correctly.
		assetTokenReady: actual.assetTokenReady,
		setAssetTokenForTests: actual.setAssetTokenForTests,
		namedPublicAssetUrl: (
			kind: string,
			filename: string,
			params?: Record<string, string | number>,
		) => {
			// Reading assetTokenReady establishes a Vue reactive dependency so
			// any computed that calls this function re-runs when the token arrives.
			const hasToken = actual.assetTokenReady.value;
			const url = new URL(`http://hub/public/${kind}/${encodeURIComponent(filename)}`);
			if (hasToken) {
				url.searchParams.set("asset_token", "mock-token");
			}
			if (params) {
				for (const [key, value] of Object.entries(params)) {
					url.searchParams.set(key, String(value));
				}
			}
			return url.toString();
		},
	};
});

describe("useActiveWallpaper", () => {
	let useActiveWallpaper: typeof import("./useActiveWallpaper.js").useActiveWallpaper;
	let shouldUseTransparentBackground: typeof import("./useActiveWallpaper.js").shouldUseTransparentBackground;
	let unresolvedWallpaperFallbackMs: number;
	let usePaneTree: typeof import("./usePaneTree.js").usePaneTree;
	let useConfigStore: () => ReturnType<typeof import("../stores/config.js").useConfigStore> & {
		_reset: () => void;
		_setProfile: (profile: TerminalProfile) => void;
	};

	beforeEach(async () => {
		setActivePinia(createPinia());
		vi.clearAllMocks();
		const activeWallpaperMod = await import("./useActiveWallpaper.js");
		const paneTreeMod = await import("./usePaneTree.js");
		const configMod = await import("../stores/config.js");
		useActiveWallpaper = activeWallpaperMod.useActiveWallpaper;
		shouldUseTransparentBackground = activeWallpaperMod.shouldUseTransparentBackground;
		unresolvedWallpaperFallbackMs = activeWallpaperMod.UNRESOLVED_WALLPAPER_FALLBACK_MS;
		usePaneTree = paneTreeMod.usePaneTree;
		// biome-ignore lint/suspicious/noExplicitAny: test helper cast
		useConfigStore = configMod.useConfigStore as any;
		useConfigStore()._reset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		// Reset the real asset token so tests don't bleed into each other.
		setAssetTokenForTests(null);
	});

	it("resolves the window wallpaper from the active pane and updates when focus changes", async () => {
		const profilesByChannel: Record<string, Partial<TerminalProfile>> = {
			"ch-a": { wallpaper: "alpha.jpg", wallpaperBlur: 4, wallpaperDim: 25 },
			"ch-b": { wallpaper: "beta.png", wallpaperBlur: 0, wallpaperDim: 40 },
			"ch-c": { wallpaper: "", wallpaperBlur: 0, wallpaperDim: 0 },
		};
		const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const channelId = url.searchParams.get("channel_id") ?? "";
			return {
				ok: true,
				json: async () => ({
					terminal: {
						resolved: {
							...DEFAULT_PROFILE,
							...profilesByChannel[channelId],
						},
					},
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result, unmount } = withSetup(() => {
			const tabs = ref([{ id: "tab-1" }]);
			const activeTabIndex = ref(0);
			const layouts = ref<Record<string, PaneNode | null>>({
				"tab-1": {
					type: "split",
					direction: "vertical",
					ratio: 0.5,
					first: { type: "terminal", channelId: "ch-a", paneId: "pane-a" },
					second: {
						type: "split",
						direction: "horizontal",
						ratio: 0.5,
						first: { type: "terminal", channelId: "ch-b", paneId: "pane-b" },
						second: { type: "terminal", channelId: "ch-c", paneId: "pane-c" },
					},
				},
			});
			const activePaneIds = ref<Record<string, string>>({ "tab-1": "pane-a" });
			const paneTree = usePaneTree(tabs, activeTabIndex, layouts, activePaneIds);
			const channelHostMap = ref<ReadonlyMap<string, string>>(
				new Map([
					["ch-a", "host-1"],
					["ch-b", "host-1"],
					["ch-c", "host-1"],
				]),
			);
			const wallpaper = useActiveWallpaper({
				activeTab: paneTree.activeTab,
				getActiveChannelId: paneTree.getActiveChannelId,
				channelHostMap,
			});

			return {
				...wallpaper,
				activeTabIndex,
				setActivePaneId: paneTree.setActivePaneId,
			};
		});

		await flushAsync();

		expect(result.activeChannelId.value).toBe("ch-a");
		expect(result.activeHostId.value).toBe("host-1");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		expect(result.wallpaperStyle.value?.filter).toBe("blur(4px)");
		expect(result.dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.25)");

		result.setActivePaneId("tab-1", "pane-b");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		await flushAsync();

		expect(result.activeChannelId.value).toBe("ch-b");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("beta.png");
		expect(result.wallpaperStyle.value?.filter).toBeUndefined();
		expect(result.dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.4)");

		result.setActivePaneId("tab-1", "pane-c");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("beta.png");
		await flushAsync();

		expect(result.activeChannelId.value).toBe("ch-c");
		expect(result.wallpaperStyle.value).toBeNull();
		expect(result.dimStyle.value).toBeNull();

		result.setActivePaneId("tab-1", "pane-b");

		expect(result.activeChannelId.value).toBe("ch-b");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("beta.png");
		expect(result.dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.4)");

		result.activeTabIndex.value = 1;
		await nextTick();

		expect(result.activeChannelId.value).toBeNull();
		expect(result.wallpaperStyle.value).toBeNull();

		unmount();
	});

	it("uses the global profile appearance while no channel is active", async () => {
		const configStore = useConfigStore();
		configStore._setProfile({
			...DEFAULT_PROFILE,
			backgroundMode: "transparent",
			windowEffect: "mica",
			wallpaper: "global-glass.jpg",
			wallpaperBlur: 6,
			wallpaperDim: 35,
		});

		const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const channelId = url.searchParams.get("channel_id");
			return {
				ok: true,
				json: async () => ({
					terminal: {
						resolved: {
							...DEFAULT_PROFILE,
							...(channelId === "ch-1"
								? {
										backgroundMode: "solid",
										windowEffect: "none",
										wallpaper: "channel-hidden.jpg",
										wallpaperBlur: 1,
										wallpaperDim: 5,
									}
								: {
										backgroundMode: "image",
										wallpaper: "ignored-cascade-global.jpg",
										wallpaperBlur: 0,
										wallpaperDim: 0,
									}),
						},
					},
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result, unmount } = withSetup(() => {
			const activeTab = ref<Tab | null>(null);
			const channelHostMap = ref<ReadonlyMap<string, string>>(new Map([["ch-1", "host-1"]]));
			const wallpaper = useActiveWallpaper({
				activeTab,
				getActiveChannelId: (tabId) => (tabId === "tab-1" ? "ch-1" : null),
				channelHostMap,
			});

			return {
				...wallpaper,
				activeTab,
			};
		});

		await flushAsync();

		expect(result.activeChannelId.value).toBeNull();
		expect(result.backgroundMode.value).toBe("transparent");
		expect(result.displayedEffectState.value).toEqual({
			mode: "transparent",
			windowEffect: "mica",
		});
		expect(result.profile.value.wallpaper).toBe("global-glass.jpg");
		expect(result.profile.value.wallpaperBlur).toBe(6);
		expect(result.profile.value.wallpaperDim).toBe(35);
		expect(result.wallpaperStyle.value).toBeNull();

		configStore._setProfile({
			...DEFAULT_PROFILE,
			backgroundMode: "image",
			windowEffect: "auto",
			wallpaper: "global-wall.jpg",
			wallpaperBlur: 2,
			wallpaperDim: 45,
		});
		await flushAsync();

		expect(result.backgroundMode.value).toBe("image");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("global-wall.jpg");
		expect(result.wallpaperStyle.value?.filter).toBe("blur(2px)");
		expect(result.dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.45)");

		result.activeTab.value = { id: "tab-1" };
		await flushAsync();

		expect(result.activeChannelId.value).toBe("ch-1");
		expect(result.activeHostId.value).toBe("host-1");
		expect(result.backgroundMode.value).toBe("solid");
		expect(result.profile.value.wallpaper).toBe("channel-hidden.jpg");
		expect(result.wallpaperStyle.value).toBeNull();

		result.activeTab.value = null;
		await flushAsync();

		expect(result.activeChannelId.value).toBeNull();
		expect(result.backgroundMode.value).toBe("image");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("global-wall.jpg");

		unmount();
	});

	it("applies background mode rendering decisions and treats unknown modes as image", async () => {
		const profilesByChannel = new Map<string, Record<string, unknown>>([
			["ch-image", { backgroundMode: "image", wallpaper: "image.jpg" }],
			["ch-solid", { backgroundMode: "solid", wallpaper: "hidden-solid.jpg" }],
			["ch-transparent", { backgroundMode: "transparent", wallpaper: "hidden-glass.jpg" }],
			["ch-empty-image", { backgroundMode: "image", wallpaper: "" }],
			["ch-unknown", { backgroundMode: "garbage", wallpaper: "safe.jpg" }],
		]);
		const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const channelId = url.searchParams.get("channel_id") ?? "";
			return {
				ok: true,
				json: async () => ({
					terminal: {
						resolved: {
							...DEFAULT_PROFILE,
							...profilesByChannel.get(channelId),
						},
					},
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result, unmount } = withSetup(() => {
			const activeTab = ref({ id: "image" });
			const channelsByTab: Record<string, string> = {
				image: "ch-image",
				solid: "ch-solid",
				transparent: "ch-transparent",
				empty: "ch-empty-image",
				unknown: "ch-unknown",
			};
			const channelHostMap = ref<ReadonlyMap<string, string>>(
				new Map([
					["ch-image", "host-1"],
					["ch-solid", "host-1"],
					["ch-transparent", "host-1"],
					["ch-empty-image", "host-1"],
					["ch-unknown", "host-1"],
				]),
			);
			const wallpaper = useActiveWallpaper({
				activeTab,
				getActiveChannelId: (tabId) => channelsByTab[tabId] ?? null,
				channelHostMap,
			});

			return {
				...wallpaper,
				activeTab,
			};
		});

		await flushAsync();

		expect(result.backgroundMode.value).toBe("image");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("image.jpg");

		result.activeTab.value = { id: "solid" };
		await flushAsync();

		expect(result.backgroundMode.value).toBe("solid");
		expect(result.wallpaperStyle.value).toBeNull();
		expect(result.dimStyle.value).toBeNull();

		result.activeTab.value = { id: "transparent" };
		await flushAsync();

		expect(result.backgroundMode.value).toBe("transparent");
		expect(result.wallpaperStyle.value).toBeNull();
		expect(result.dimStyle.value).toBeNull();
		expect(shouldUseTransparentBackground(result.backgroundMode.value, true)).toBe(true);
		expect(shouldUseTransparentBackground(result.backgroundMode.value, false)).toBe(false);

		result.activeTab.value = { id: "empty" };
		await flushAsync();

		expect(result.backgroundMode.value).toBe("image");
		expect(result.wallpaperStyle.value).toBeNull();

		result.activeTab.value = { id: "unknown" };
		await flushAsync();

		expect(result.backgroundMode.value).toBe("image");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("safe.jpg");

		unmount();
	});

	it("serves cached scopes immediately and bounds uncached transitional wallpapers", async () => {
		vi.useFakeTimers();

		type CascadeResponse = {
			ok: true;
			json: () => Promise<{ terminal: { resolved: TerminalProfile } }>;
		};
		type PendingCascade = {
			channelId: string;
			hostId: string | null;
			resolve: (response: CascadeResponse) => void;
		};
		const pending: PendingCascade[] = [];
		const fetchMock = vi.fn((input: RequestInfo | URL): Promise<CascadeResponse> => {
			const url = new URL(String(input));
			return new Promise((resolve) => {
				pending.push({
					channelId: url.searchParams.get("channel_id") ?? "",
					hostId: url.searchParams.get("host_id"),
					resolve,
				});
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		function resolvePending(channelId: string, profile: Partial<TerminalProfile>): void {
			const index = pending.findIndex((request) => request.channelId === channelId);
			expect(index).toBeGreaterThanOrEqual(0);
			const [request] = pending.splice(index, 1);
			if (request === undefined) throw new Error(`No pending request for ${channelId}`);
			request.resolve({
				ok: true,
				json: async () => ({
					terminal: {
						resolved: {
							...DEFAULT_PROFILE,
							...profile,
						},
					},
				}),
			});
		}

		const { result, unmount } = withSetup(() => {
			const activeTab = ref({ id: "tab-a" });
			const channelsByTab: Record<string, string> = {
				"tab-a": "ch-a",
				"tab-b": "ch-b",
				"tab-c": "ch-c",
			};
			const channelHostMap = ref<ReadonlyMap<string, string>>(
				new Map([
					["ch-a", "host-1"],
					["ch-b", "host-1"],
					["ch-c", "host-2"],
				]),
			);
			const wallpaper = useActiveWallpaper({
				activeTab,
				getActiveChannelId: (tabId) => channelsByTab[tabId] ?? null,
				channelHostMap,
			});

			return {
				...wallpaper,
				activeTab,
			};
		});

		await flushAsync();
		resolvePending("ch-a", { wallpaper: "alpha.jpg", wallpaperBlur: 0, wallpaperDim: 20 });
		await flushAsync();

		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		expect(result.dimStyle.value?.background).toBe("rgba(0, 0, 0, 0.2)");

		result.activeTab.value = { id: "tab-b" };

		expect(result.activeChannelId.value).toBe("ch-b");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		await flushAsync();
		expect(pending.some((request) => request.channelId === "ch-b")).toBe(true);

		await vi.advanceTimersByTimeAsync(unresolvedWallpaperFallbackMs);
		await nextTick();

		expect(result.wallpaperStyle.value).toBeNull();
		expect(result.dimStyle.value).toBeNull();

		resolvePending("ch-b", { wallpaper: "beta.png", wallpaperBlur: 3, wallpaperDim: 30 });
		await flushAsync();

		expect(result.wallpaperStyle.value?.backgroundImage).toContain("beta.png");
		expect(result.wallpaperStyle.value?.filter).toBe("blur(3px)");

		result.activeTab.value = { id: "tab-a" };

		expect(result.activeChannelId.value).toBe("ch-a");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		await flushAsync();

		result.activeTab.value = { id: "tab-c" };

		expect(result.activeChannelId.value).toBe("ch-c");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		await flushAsync();
		await vi.advanceTimersByTimeAsync(unresolvedWallpaperFallbackMs);
		await nextTick();

		expect(result.wallpaperStyle.value).toBeNull();

		result.activeTab.value = { id: "tab-a" };
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		await flushAsync();

		resolvePending("ch-c", { wallpaper: "charlie.webp", wallpaperBlur: 0, wallpaperDim: 0 });
		await flushAsync();

		expect(result.activeChannelId.value).toBe("ch-a");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");

		result.activeTab.value = { id: "tab-c" };

		expect(result.activeChannelId.value).toBe("ch-c");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("alpha.jpg");
		await flushAsync();

		resolvePending("ch-c", { wallpaper: "charlie.webp", wallpaperBlur: 0, wallpaperDim: 0 });
		await flushAsync();

		expect(result.wallpaperStyle.value?.backgroundImage).toContain("charlie.webp");

		unmount();
	});

	it("omits host context for an unmapped active channel and updates when the map is populated", async () => {
		const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			const hostId = url.searchParams.get("host_id");
			const wallpaper = hostId === "host-correct" ? "correct.jpg" : "global.jpg";

			return {
				ok: true,
				json: async () => ({
					terminal: {
						resolved: {
							...DEFAULT_PROFILE,
							wallpaper,
							wallpaperBlur: 0,
							wallpaperDim: 0,
						},
					},
				}),
			};
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result, unmount } = withSetup(() => {
			const activeTab = ref({ id: "tab-1" });
			const channelHostMap = ref<ReadonlyMap<string, string>>(new Map());
			const wallpaper = useActiveWallpaper({
				activeTab,
				getActiveChannelId: () => "ch-late",
				channelHostMap,
			});

			return {
				...wallpaper,
				channelHostMap,
			};
		});

		await flushAsync();

		expect(result.activeChannelId.value).toBe("ch-late");
		expect(result.activeHostId.value).toBeNull();
		const initialUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(initialUrl.searchParams.get("channel_id")).toBe("ch-late");
		expect(initialUrl.searchParams.has("host_id")).toBe(false);
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("global.jpg");

		result.channelHostMap.value = new Map([["ch-late", "host-correct"]]);
		await flushAsync();

		expect(result.activeHostId.value).toBe("host-correct");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const mappedUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
		expect(mappedUrl.searchParams.get("host_id")).toBe("host-correct");
		expect(mappedUrl.searchParams.get("channel_id")).toBe("ch-late");
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("correct.jpg");

		unmount();
	});

	it("updates window wallpaper URL when asset token arrives after first render (pairing path)", async () => {
		// Arrange — no token at boot (pairing path)
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				terminal: {
					resolved: {
						...DEFAULT_PROFILE,
						wallpaper: "scenic.jpg",
						wallpaperBlur: 0,
						wallpaperDim: 0,
					},
				},
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const { result, unmount } = withSetup(() => {
			const activeTab = ref({ id: "tab-1" });
			const channelHostMap = ref<ReadonlyMap<string, string>>(new Map([["ch-1", "host-1"]]));
			const wallpaper = useActiveWallpaper({
				activeTab,
				getActiveChannelId: () => "ch-1",
				channelHostMap,
			});
			return wallpaper;
		});

		await flushAsync();

		// First render: profile resolved but token not yet set — URL has no asset_token
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("scenic.jpg");
		expect(result.wallpaperStyle.value?.backgroundImage).not.toContain("asset_token=");

		// Act — token arrives (e.g. pairing completes)
		setAssetTokenForTests("arrived-token");
		await nextTick();

		// Assert — wallpaper URL must now include the token
		expect(result.wallpaperStyle.value?.backgroundImage).toContain("asset_token=");

		unmount();
	});
});
