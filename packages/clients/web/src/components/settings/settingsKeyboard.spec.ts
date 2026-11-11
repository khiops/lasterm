/**
 * Settings from the keyboard alone, over every category (#637): nothing is left that only the
 * mouse can use. The components that needed more than markup have their own specs (SettingControl,
 * ThemeCard, FontCard, FontPicker, ProfilesSettings, AgentImportModal); these mount the rest and
 * read what a screen reader is told. That no element of Settings acts on a click out of the
 * keyboard's reach is Biome's a11y rules over Settings' templates (biome.json).
 */
import {
	BUNDLED_THEMES,
	type CascadeResponse,
	DEFAULT_APPEARANCE,
	DEFAULT_ELEVATION_CONFIG,
	DEFAULT_PROFILE,
	DEFAULT_SSH_CONFIG,
	type Host,
	type TerminalProfile,
	type UiConfig,
} from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, type Component, createApp, nextTick } from "vue";
import { useAuthStore } from "../../stores/auth.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useSettingsStore } from "../../stores/settings.js";
import { useThemeStore } from "../../stores/theme.js";
import WallpaperCategory from "./categories/WallpaperCategory.vue";
import HostOverridesTable from "./HostOverridesTable.vue";
import ThemeEditor from "./ThemeEditor.vue";

/** The hub, as these components ask it: the wallpapers, and a host's profiles. */
const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

let app: App | null = null;
let root: HTMLElement;

beforeEach(() => {
	const pinia = createPinia();
	setActivePinia(pinia);
	mocks.hubFetch.mockReset();
	mocks.hubFetch.mockImplementation(async (url: string) =>
		url.endsWith("/api/wallpapers")
			? json({ wallpapers: ["dunes.jpg", "forest.png"] })
			: json([{ id: "P1", name: "fish", shell: "/usr/bin/fish" }]),
	);
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

async function mount(component: Component, props: Record<string, unknown> = {}): Promise<void> {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(component, props);
	app.mount(root);
	await settle();
}

/** A settings cascade where the global layer chose `wallpaper`. */
function cascadeChoosing(wallpaper: string): CascadeResponse {
	const global: Partial<TerminalProfile> = { wallpaper };
	return {
		terminal: {
			defaults: DEFAULT_PROFILE,
			global,
			host: {},
			channel: {},
			resolved: { ...DEFAULT_PROFILE, ...global },
		},
		ui: { defaults: {} as UiConfig, global: {}, resolved: {} as UiConfig },
		appearance: DEFAULT_APPEARANCE,
		elevation: DEFAULT_ELEVATION_CONFIG,
		ssh: DEFAULT_SSH_CONFIG,
	};
}

describe("Settings from the keyboard", () => {
	it("says which wallpaper is chosen, and names each one's delete button", async () => {
		const settingsStore = useSettingsStore();
		settingsStore.cascade = cascadeChoosing("forest.png");
		await mount(WallpaperCategory, { scope: "global" });

		/** Each thumbnail, by the name its image gives it, and whether it says it is pressed. */
		const thumbnails = () =>
			[...root.querySelectorAll(".wallpaper-thumb")].map((button) => [
				button.querySelector("img")?.getAttribute("alt"),
				button.getAttribute("aria-pressed"),
			]);
		expect(thumbnails()).toEqual([
			["dunes.jpg", "false"],
			["forest.png", "true"],
		]);
		expect(
			[...root.querySelectorAll(".wallpaper-delete")].map((b) => b.getAttribute("aria-label")),
		).toEqual(["Delete wallpaper dunes.jpg", "Delete wallpaper forest.png"]);

		settingsStore.cascade = cascadeChoosing("dunes.jpg");
		await nextTick();
		expect(thumbnails()).toEqual([
			["dunes.jpg", "true"],
			["forest.png", "false"],
		]);
	});

	it("says which of Dark and Light a theme being edited is", async () => {
		const theme = BUNDLED_THEMES["one-half-dark"];
		if (theme === undefined) throw new Error("no one-half-dark theme");
		useThemeStore().availableThemes = Object.values(BUNDLED_THEMES);
		await mount(ThemeEditor, { theme });

		const group = root.querySelector('[role="group"]');
		const labelledBy = group?.getAttribute("aria-labelledby") ?? "";
		expect(document.getElementById(labelledBy)?.textContent).toBe("Type");
		const pressed = () =>
			[...(group?.querySelectorAll("button") ?? [])].map((b) => [
				b.textContent?.trim(),
				b.getAttribute("aria-pressed"),
			]);
		expect(pressed()).toEqual([
			["Dark", "true"],
			["Light", "false"],
		]);

		const light = [...(group?.querySelectorAll("button") ?? [])].find(
			(b) => b.textContent?.trim() === "Light",
		);
		light?.click();
		await nextTick();
		expect(pressed()).toEqual([
			["Dark", "false"],
			["Light", "true"],
		]);
	});

	it("names each host's override", async () => {
		useAuthStore().token = "token";
		useHostsStore().hosts = [
			{ id: "H1", type: "ssh", label: "pi", sshHost: "pi.test" } as Host,
			{ id: "H2", type: "ssh", label: "nas", sshHost: "nas.test" } as Host,
		];
		await mount(HostOverridesTable, { profileId: "P1" });

		expect(
			[...root.querySelectorAll("select.override-select")].map((s) => s.getAttribute("aria-label")),
		).toEqual(["Override for pi", "Override for nas"]);
	});
});
