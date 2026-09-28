/**
 * Settings' Scrollbar Markers, from the toggle to the terminal (#614).
 *
 * Settings wrote `[search] scrollbar_markers`, and the terminals read their
 * resolved profile's `scrollbarMarkers`, `[terminal] scrollbar_markers`: the
 * toggle changed nothing. Here the toggle goes through the settings store as
 * the panel drives it, to a hub that keeps what it is sent, and the terminal
 * is the one `useTerminal` makes, fed its resolved profile the way a pane
 * feeds it. Only xterm and its addons are stand-ins.
 */
import {
	type CascadeResponse,
	DEFAULT_APPEARANCE,
	DEFAULT_ELEVATION_CONFIG,
	DEFAULT_PROFILE,
	DEFAULT_SSH_CONFIG,
	deepMerge,
	type TerminalProfile,
} from "@lasterm/shared";
import { createPinia, type Pinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref, watch } from "vue";
import { useResolvedProfile } from "../../composables/useResolvedProfile.js";
import { useTerminal } from "../../composables/useTerminal.js";
import type { IWsClient } from "../../services/ws-client.js";
import { useSettingsStore } from "../../stores/settings.js";
import { useThemeStore } from "../../stores/theme.js";
import { initHubPort } from "../../utils/hub-url.js";
import { settingsSchema, toStoreParams } from "./settingsSchema.js";

// ─── xterm stand-ins ─────────────────────────────────────────────────────────

const xterm = vi.hoisted(() => ({
	/** Every search addon made, with the decorations each search asked for. */
	searchAddons: [] as { findNext: { mock: { calls: unknown[][] } } }[],
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		options: Record<string, unknown>;
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "" };
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
		}
		loadAddon(): void {}
		open(): void {}
		onData() {
			return { dispose() {} };
		}
		onResize() {
			return { dispose() {} };
		}
		onTitleChange() {
			return { dispose() {} };
		}
		dispose(): void {}
	},
}));

vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit(): void {}
	},
}));

vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

vi.mock("@xterm/addon-search", () => ({
	SearchAddon: class {
		findNext = vi.fn(() => true);
		findPrevious = vi.fn(() => true);
		clearDecorations = vi.fn();
		clearActiveDecoration = vi.fn();
		dispose = vi.fn();
		onDidChangeResults = vi.fn(() => ({ dispose() {} }));
		constructor() {
			xterm.searchAddons.push(this);
		}
	},
}));

// A font the browser has, at once: nothing here measures cells.
vi.mock("../../composables/terminal-font.js", () => ({
	awaitTerminalFont: () => Promise.resolve(),
}));

// ─── A hub that keeps what it is sent ────────────────────────────────────────

type Layer = Partial<TerminalProfile>;

function fakeHub() {
	const global: Layer = {};
	const hosts = new Map<string, Layer>();
	const channels = new Map<string, Layer>();
	const ui: Record<string, Record<string, unknown>> = {};

	function cascade(url: URL): CascadeResponse {
		const hostId = url.searchParams.get("host_id");
		const channelId = url.searchParams.get("channel_id");
		const host = hostId ? hosts.get(hostId) : undefined;
		const channel = channelId ? channels.get(channelId) : undefined;
		return {
			terminal: {
				defaults: DEFAULT_PROFILE,
				global: { ...global },
				...(host !== undefined && { host: { ...host } }),
				...(channel !== undefined && { channel: { ...channel } }),
				resolved: deepMerge<TerminalProfile>(DEFAULT_PROFILE, global, host, channel),
			},
			ui: { defaults: {}, global: ui, resolved: ui } as unknown as CascadeResponse["ui"],
			appearance: DEFAULT_APPEARANCE,
			elevation: DEFAULT_ELEVATION_CONFIG,
			ssh: DEFAULT_SSH_CONFIG,
		};
	}

	const answer = (data: unknown) => ({ ok: true, status: 200, json: async () => data });

	const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = new URL(input.toString(), "https://hub.test");
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		const profile = url.pathname.match(/^\/api\/(hosts|channels)\/([^/]+)\/profile$/);

		if (method === "GET" && url.pathname === "/api/config/cascade") return answer(cascade(url));
		if (method === "GET" && url.pathname === "/api/config/ui") return answer(ui);
		if (method === "PUT" && url.pathname === "/api/config/global") {
			Object.assign(global, body.terminal);
			return answer({ ok: true });
		}
		if (method === "PUT" && url.pathname === "/api/config/ui") {
			for (const [section, values] of Object.entries(body as Record<string, object>)) {
				ui[section] = { ...ui[section], ...values };
			}
			return answer({ ok: true });
		}
		if (method === "PATCH" && profile) {
			const layers = profile[1] === "hosts" ? hosts : channels;
			const id = profile[2] as string;
			layers.set(id, { ...layers.get(id), ...body.profile });
			return answer({ ok: true });
		}
		return { ok: false, status: 404, json: async () => ({}) };
	});

	return { fetch };
}

// ─── A pane, as far as its profile goes ──────────────────────────────────────

const wsClient = {
	isConnected: false,
	send: vi.fn(),
	on: vi.fn(() => () => {}),
} as unknown as IWsClient;

/**
 * A terminal on `hostId`/`channelId`: the profile the cascade resolves for it,
 * applied to its `useTerminal` whenever it changes, as TerminalPane does.
 */
function mountTerminal(pinia: Pinia, hostId: string, channelId: string) {
	let pane!: {
		profile: ReturnType<typeof useResolvedProfile>["profile"];
		terminal: ReturnType<typeof useTerminal>;
	};
	const app = createApp(
		defineComponent({
			setup() {
				const { profile } = useResolvedProfile(ref(hostId), ref(channelId));
				const terminal = useTerminal(ref(document.createElement("div")), wsClient);
				terminal.init();
				watch(profile, (p) => terminal.applyProfile(p), { deep: true });
				pane = { profile, terminal };
				return {};
			},
			template: "<div />",
		}),
	);
	app.use(pinia);
	app.mount(document.createElement("div"));
	const searchAddon = xterm.searchAddons.at(-1);
	if (!searchAddon) throw new Error("useTerminal loaded no search addon");

	return {
		...pane,
		unmount: () => app.unmount(),
		/** Whether the last search drew its matches in the scrollbar. */
		marksScrollbar(): boolean {
			const last = searchAddon.findNext.mock.calls.at(-1) as
				| [string, { decorations: { matchOverviewRuler: string } }]
				| undefined;
			if (!last) throw new Error("no search ran");
			return last[1].decorations.matchOverviewRuler !== "transparent";
		},
		/** The width xterm gives its scrollbar and ruler. */
		rulerWidth(): number {
			const options = pane.terminal.terminal.value?.options as {
				overviewRuler: { width: number };
			};
			return options.overviewRuler.width;
		},
	};
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		await nextTick();
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Settings' Scrollbar Markers reach the terminal", () => {
	const markers = settingsSchema.find((d) => d.key === "scrollbarMarkers");
	if (!markers) throw new Error("no Scrollbar Markers in the settings schema");
	const { storeSection, storeKey } = toStoreParams(markers);

	let pinia: Pinia;
	let mounted: { unmount: () => void }[];

	beforeEach(async () => {
		xterm.searchAddons.length = 0;
		mounted = [];
		localStorage.setItem("lasterm_token", "test-token");
		vi.stubGlobal("fetch", fakeHub().fetch);
		pinia = createPinia();
		setActivePinia(pinia);
		await initHubPort();
		// A hidden scrollbar keeps a gutter only for the markers, so the
		// terminal's ruler width shows them too.
		const theme = useThemeStore();
		theme.appearance = {
			...DEFAULT_APPEARANCE,
			scrollbar: { ...DEFAULT_APPEARANCE.scrollbar, style: "hidden" },
		};
	});

	afterEach(() => {
		for (const pane of mounted) pane.unmount();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	function terminalOn(hostId: string, channelId: string) {
		const pane = mountTerminal(pinia, hostId, channelId);
		mounted.push(pane);
		return pane;
	}

	/** Flip the toggle at `scope` with Settings open on that terminal. */
	async function toggle(scope: "global" | "host" | "channel", value: boolean): Promise<void> {
		const settings = useSettingsStore();
		await settings.loadCascade("host-1", "chan-1");
		vi.useFakeTimers();
		void settings.updateSetting(scope, storeSection, storeKey, value);
		// Past the store's 500 ms debounce, then the requests it starts.
		await vi.advanceTimersByTimeAsync(600);
		vi.useRealTimers();
		await settle();
	}

	for (const scope of markers.scopes) {
		it(`turning them off at ${scope} scope removes them from that terminal's search`, async () => {
			const pane = terminalOn("host-1", "chan-1");
			await settle();
			pane.terminal.search.search("needle");
			expect(pane.profile.value.scrollbarMarkers).toBe(true);
			expect(pane.marksScrollbar()).toBe(true);
			const withMarkers = pane.rulerWidth();

			await toggle(scope, false);

			expect(pane.profile.value.scrollbarMarkers).toBe(false);
			expect(pane.marksScrollbar()).toBe(false);
			expect(pane.rulerWidth()).toBeLessThan(withMarkers);

			await toggle(scope, true);

			expect(pane.profile.value.scrollbarMarkers).toBe(true);
			expect(pane.marksScrollbar()).toBe(true);
			expect(pane.rulerWidth()).toBe(withMarkers);
		});
	}

	it("turned off for one terminal, leaves its neighbour's", async () => {
		const pane = terminalOn("host-1", "chan-1");
		const neighbour = terminalOn("host-1", "chan-2");
		await settle();
		neighbour.terminal.search.search("needle");

		await toggle("channel", false);

		expect(pane.profile.value.scrollbarMarkers).toBe(false);
		expect(neighbour.profile.value.scrollbarMarkers).toBe(true);
		expect(neighbour.marksScrollbar()).toBe(true);
	});
});
