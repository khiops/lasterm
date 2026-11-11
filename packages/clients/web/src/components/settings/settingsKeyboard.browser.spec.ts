/**
 * A wallpaper's delete button shows with the keyboard as with the mouse (#637). happy-dom draws
 * neither `:hover` nor `:focus-within`, so this runs in a browser: Settings › Wallpaper mounted
 * with its own rules, the keyboard or the pointer brought to a thumbnail.
 */
import {
	type CascadeResponse,
	DEFAULT_APPEARANCE,
	DEFAULT_ELEVATION_CONFIG,
	DEFAULT_PROFILE,
	DEFAULT_SSH_CONFIG,
	type UiConfig,
} from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { type App, createApp, nextTick } from "vue";
import { useSettingsStore } from "../../stores/settings.js";
import WallpaperCategory from "./categories/WallpaperCategory.vue";

const mocks = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

let app: App | null = null;

beforeEach(async () => {
	mocks.hubFetch.mockResolvedValue(
		new Response(JSON.stringify({ wallpapers: ["dunes.jpg", "forest.png"] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	const pinia = createPinia();
	setActivePinia(pinia);
	useSettingsStore().cascade = {
		terminal: {
			defaults: DEFAULT_PROFILE,
			global: {},
			host: {},
			channel: {},
			resolved: DEFAULT_PROFILE,
		},
		ui: { defaults: {} as UiConfig, global: {}, resolved: {} as UiConfig },
		appearance: DEFAULT_APPEARANCE,
		elevation: DEFAULT_ELEVATION_CONFIG,
		ssh: DEFAULT_SSH_CONFIG,
	} satisfies CascadeResponse;
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(WallpaperCategory, { scope: "global" });
	app.use(pinia);
	app.mount(root);
	await expect.poll(() => document.querySelectorAll(".wallpaper-thumb").length).toBe(2);
	await nextTick();
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	mocks.hubFetch.mockReset();
});

/** The thumbnail of `name`, and its delete button. */
function wallpaper(name: string): { thumb: HTMLElement; remove: HTMLElement } {
	const thumb = document.querySelector<HTMLElement>(`.wallpaper-thumb:has(img[alt="${name}"])`);
	const remove = document.querySelector<HTMLElement>(`[aria-label="Delete wallpaper ${name}"]`);
	if (thumb === null || remove === null) throw new Error(`no wallpaper ${name}`);
	return { thumb, remove };
}

/** How opaque a delete button is drawn, once its fade is over. */
async function opacityOf(button: HTMLElement, expected: string): Promise<void> {
	await expect.poll(() => getComputedStyle(button).opacity).toBe(expected);
}

it("hides each delete button while nothing is on its thumbnail", async () => {
	await opacityOf(wallpaper("dunes.jpg").remove, "0");
	await opacityOf(wallpaper("forest.png").remove, "0");
});

it("shows the delete button of the thumbnail the keyboard is on, and only that one", async () => {
	wallpaper("dunes.jpg").thumb.focus();
	await opacityOf(wallpaper("dunes.jpg").remove, "1");
	await opacityOf(wallpaper("forest.png").remove, "0");
});

it("keeps the delete button shown while the keyboard is on it", async () => {
	wallpaper("forest.png").remove.focus();
	expect(document.activeElement).toBe(wallpaper("forest.png").remove);
	await opacityOf(wallpaper("forest.png").remove, "1");
});

it("shows the delete button of the thumbnail under the pointer", async () => {
	await userEvent.hover(wallpaper("forest.png").thumb);
	await opacityOf(wallpaper("forest.png").remove, "1");
	await opacityOf(wallpaper("dunes.jpg").remove, "0");
});
