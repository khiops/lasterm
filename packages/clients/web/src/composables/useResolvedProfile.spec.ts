import { DEFAULT_PROFILE } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, type Ref, ref } from "vue";
import { useAuthStore } from "../stores/auth.js";
import type { ProfileChangeEvent } from "../stores/config.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mount a composable inside a minimal Vue app to activate lifecycle hooks. */
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

// ─── Mocks ────────────────────────────────────────────────────────────────────

// We mock the stores and fetch rather than exercising real HTTP
vi.mock("../stores/config.js", () => {
	let listeners = new Set<(e: ProfileChangeEvent) => void>();
	return {
		useConfigStore: () => ({
			onProfileChange(cb: (e: ProfileChangeEvent) => void) {
				listeners.add(cb);
				return () => listeners.delete(cb);
			},
			_emit(event: ProfileChangeEvent) {
				for (const cb of listeners) cb(event);
			},
			_reset() {
				listeners = new Set();
			},
		}),
	};
});

vi.mock("../utils/hub-url.js", async () => {
	const vue = await vi.importActual<typeof import("vue")>("vue");
	const hubPortReady = vue.ref(true);
	return {
		hubBaseUrl: () => (hubPortReady.value ? "http://hub" : "http://localhost:4100"),
		hubPortReady,
	};
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("useResolvedProfile", () => {
	// Import after mocks are defined
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	let useResolvedProfile: typeof import("./useResolvedProfile.js").useResolvedProfile;
	let useConfigStore: () => ReturnType<typeof import("../stores/config.js").useConfigStore> & {
		_emit: (e: ProfileChangeEvent) => void;
		_reset: () => void;
	};
	let hubPortReady: Ref<boolean>;

	beforeEach(async () => {
		setActivePinia(createPinia());
		localStorage.setItem("lasterm_token", "test-token");
		vi.clearAllMocks();
		const mod = await import("./useResolvedProfile.js");
		useResolvedProfile = mod.useResolvedProfile;
		const configMod = await import("../stores/config.js");
		const hubUrlMod = await import("../utils/hub-url.js");
		hubPortReady = hubUrlMod.hubPortReady as Ref<boolean>;
		hubPortReady.value = true;
		// biome-ignore lint/suspicious/noExplicitAny: test helper cast
		useConfigStore = configMod.useConfigStore as any;
		useConfigStore()._reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
	});

	it("fetches resolved profile on mount with no context", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 18 } } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>(undefined);
		const channelId = ref<string | undefined>(undefined);

		const { result, unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();

		expect(fetchMock).toHaveBeenCalledWith(
			"http://hub/api/config/cascade",
			expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
		);
		expect(result.profile.value.fontSize).toBe(18);
		unmount();
	});

	it("does not fetch while auth token is unavailable", async () => {
		localStorage.removeItem("lasterm_token");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { result, unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await flushAsync();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.profile.value).toEqual(DEFAULT_PROFILE);
		expect(result.resolvedFor.value).toBeNull();
		unmount();
	});

	it("does not fetch with Authorization before hub port readiness and fetches once ready", async () => {
		hubPortReady.value = false;
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 19 } } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { result, unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await flushAsync();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.profile.value).toEqual(DEFAULT_PROFILE);
		expect(result.resolvedFor.value).toBeNull();

		hubPortReady.value = true;
		await flushAsync();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"http://hub/api/config/cascade?host_id=host-1&channel_id=ch-1",
			expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
		);
		expect(
			fetchMock.mock.calls.some(([input, init]) => {
				const headers = (init as RequestInit | undefined)?.headers as
					| Record<string, string>
					| undefined;
				return (
					String(input).startsWith("http://localhost:4100") &&
					headers?.Authorization?.startsWith("Bearer ") === true
				);
			}),
		).toBe(false);
		expect(result.profile.value.fontSize).toBe(19);
		expect(result.resolvedFor.value).toEqual({ hostId: "host-1", channelId: "ch-1" });
		unmount();
	});

	it("fetches when auth token becomes available and re-fetches when it changes", async () => {
		localStorage.removeItem("lasterm_token");
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 22 } } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { result, unmount } = withSetup(() => {
			const authStore = useAuthStore();
			return {
				...useResolvedProfile(hostId, channelId),
				authStore,
			};
		});

		await flushAsync();

		expect(fetchMock).not.toHaveBeenCalled();

		result.authStore.setToken("loaded-token");
		await flushAsync();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"http://hub/api/config/cascade?host_id=host-1&channel_id=ch-1",
			expect.objectContaining({ headers: { Authorization: "Bearer loaded-token" } }),
		);

		result.authStore.setToken("rotated-token");
		await flushAsync();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenLastCalledWith(
			"http://hub/api/config/cascade?host_id=host-1&channel_id=ch-1",
			expect.objectContaining({ headers: { Authorization: "Bearer rotated-token" } }),
		);
		expect(result.profile.value.fontSize).toBe(22);
		unmount();
	});

	it("clears stale profile when auth token is lost", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 24 } } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { result, unmount } = withSetup(() => {
			const authStore = useAuthStore();
			return {
				...useResolvedProfile(hostId, channelId),
				authStore,
			};
		});

		await flushAsync();

		expect(result.profile.value.fontSize).toBe(24);
		expect(result.resolvedFor.value).toEqual({ hostId: "host-1", channelId: "ch-1" });

		result.authStore.clearToken();
		await flushAsync();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.profile.value).toEqual(DEFAULT_PROFILE);
		expect(result.resolvedFor.value).toBeNull();
		unmount();
	});

	it("fetches resolved profile on mount with host_id and channel_id", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 20 } } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { result, unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();

		expect(fetchMock).toHaveBeenCalledWith(
			"http://hub/api/config/cascade?host_id=host-1&channel_id=ch-1",
			expect.anything(),
		);
		expect(result.profile.value.fontSize).toBe(20);
		unmount();
	});

	it("clears stale profile on context change until the new context resolves", async () => {
		let resolveSecond!: (value: unknown) => void;
		const secondFetch = new Promise((resolve) => {
			resolveSecond = resolve;
		});
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 26 } } }),
			})
			.mockReturnValueOnce(secondFetch);
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { result, unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await flushAsync();

		expect(result.profile.value.fontSize).toBe(26);
		expect(result.resolvedFor.value).toEqual({ hostId: "host-1", channelId: "ch-1" });

		channelId.value = "ch-2";
		await flushAsync();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.profile.value).toEqual(DEFAULT_PROFILE);
		expect(result.resolvedFor.value).toBeNull();

		resolveSecond({
			ok: true,
			json: async () => ({ terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 28 } } }),
		});
		await flushAsync();

		expect(result.profile.value.fontSize).toBe(28);
		expect(result.resolvedFor.value).toEqual({ hostId: "host-1", channelId: "ch-2" });
		unmount();
	});

	it("re-fetches on global profile change event", async () => {
		let callCount = 0;
		const fetchMock = vi.fn().mockImplementation(async () => ({
			ok: true,
			json: async () => ({
				terminal: { resolved: { ...DEFAULT_PROFILE, fontSize: 14 + callCount++ } },
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>(undefined);

		const { unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Emit a global change — should trigger re-fetch
		useConfigStore()._emit({ scope: "global" });
		await nextTick();
		await nextTick();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		unmount();
	});

	it("re-fetches on matching host profile change event", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: DEFAULT_PROFILE } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>(undefined);

		const { unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Emit a host change for a different host — should NOT re-fetch
		useConfigStore()._emit({ scope: "host", hostId: "host-2" });
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Emit a host change for our host — should re-fetch
		useConfigStore()._emit({ scope: "host", hostId: "host-1" });
		await nextTick();
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		unmount();
	});

	it("re-fetches on matching channel profile change event", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: DEFAULT_PROFILE } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>("host-1");
		const channelId = ref<string | undefined>("ch-1");

		const { unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Emit a channel change for a different channel — should NOT re-fetch
		useConfigStore()._emit({ scope: "channel", channelId: "ch-99" });
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Emit a channel change for our channel — should re-fetch
		useConfigStore()._emit({ scope: "channel", channelId: "ch-1" });
		await nextTick();
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		unmount();
	});

	it("unsubscribes from profile change events on unmount", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ terminal: { resolved: DEFAULT_PROFILE } }),
		});
		vi.stubGlobal("fetch", fetchMock);

		const hostId = ref<string | undefined>(undefined);
		const channelId = ref<string | undefined>(undefined);

		const { unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();
		const countAfterMount = fetchMock.mock.calls.length;

		unmount();
		await nextTick();

		// After unmount, global events should NOT trigger re-fetch
		useConfigStore()._emit({ scope: "global" });
		await nextTick();
		await nextTick();
		expect(fetchMock).toHaveBeenCalledTimes(countAfterMount);
	});

	it("keeps DEFAULT_PROFILE when fetch fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const hostId = ref<string | undefined>(undefined);
		const channelId = ref<string | undefined>(undefined);

		const { result, unmount } = withSetup(() => useResolvedProfile(hostId, channelId));

		await nextTick();
		await nextTick();

		// Should fall back to DEFAULT_PROFILE
		expect(result.profile.value.fontSize).toBe(DEFAULT_PROFILE.fontSize);
		expect(warnSpy).toHaveBeenCalledWith("[useResolvedProfile] failed to load:", expect.any(Error));
		unmount();
	});
});
