/**
 * The wallpaper thumbnails' blobs on the desktop (#194): one load per listed file, and each blob
 * given back once nothing shows it. `settingsKeyboard.spec.ts` mounts this component too, for what
 * a screen reader is told; this is about the thumbnails' lifetime.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";

const mocks = vi.hoisted(() => ({
	hubFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock("../../../utils/hub-fetch.js", () => ({ hubFetch: mocks.hubFetch }));

import { useAuthStore } from "../../../stores/auth.js";
import { invalidateAsset, resetAssetHolderForTests } from "../../../utils/asset-holder.js";
import { setHubPortForTests } from "../../../utils/hub-url.js";
import WallpaperCategory from "./WallpaperCategory.vue";

let app: App | null = null;
let root: HTMLElement;
let listed: string[];
let created: string[];
let revoked: string[];
/** Files whose load waits for the test, by name. */
let held: Map<string, () => void>;
let holdNext: Set<string>;

async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++) await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
	await nextTick();
}

async function mount(): Promise<void> {
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(WallpaperCategory, { scope: "global" });
	app.mount(root);
	await settle();
}

function shown(): string[] {
	return [...root.querySelectorAll<HTMLImageElement>(".wallpaper-thumb img")].map(
		(img) => img.getAttribute("src") ?? "",
	);
}

function fileLoads(): string[] {
	return mocks.hubFetch.mock.calls
		.map(([url]) => new URL(url).pathname)
		.filter((path) => path.startsWith("/public/wallpapers/"));
}

beforeEach(() => {
	setActivePinia(createPinia());
	useAuthStore().setToken("bearer-1");
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: { invoke: () => undefined },
		configurable: true,
	});
	setHubPortForTests(4100);
	listed = ["dunes.jpg", "forest.png"];
	created = [];
	revoked = [];
	held = new Map();
	holdNext = new Set();
	let next = 0;
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
		const url = `blob:thumb/${++next}`;
		created.push(url);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
		revoked.push(url);
	});
	mocks.hubFetch.mockReset();
	mocks.hubFetch.mockImplementation(async (url, init) => {
		const path = new URL(url).pathname;
		if (path === "/api/wallpapers") return Response.json({ wallpapers: [...listed] });
		if (init?.method === "DELETE") {
			listed = listed.filter((name) => `/api/wallpapers/${encodeURIComponent(name)}` !== path);
			return Response.json({ ok: true });
		}
		const name = decodeURIComponent(path.split("/").pop() ?? "");
		if (holdNext.delete(name)) {
			return new Promise<Response>((resolve) =>
				held.set(name, () => resolve(new Response("img", { status: 200 }))),
			);
		}
		return new Response("img", { status: 200 });
	});
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	resetAssetHolderForTests();
	setHubPortForTests(null);
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
});

describe("wallpaper thumbnails on the desktop (#194)", () => {
	it("loads each listed file once, however often the grid renders", async () => {
		await mount();
		root.querySelector<HTMLButtonElement>(".wallpaper-thumb")?.click();
		await settle();

		expect(fileLoads().sort()).toEqual([
			"/public/wallpapers/dunes.jpg",
			"/public/wallpapers/forest.png",
		]);
		expect([...shown()].sort()).toEqual([...created].sort());
		expect(created).toHaveLength(2);
	});

	it("gives back a deleted file's thumbnail, and every thumbnail when Settings closes", async () => {
		await mount();
		const [dunesUrl] = shown();

		root.querySelector<HTMLButtonElement>('[aria-label="Delete wallpaper dunes.jpg"]')?.click();
		await settle();

		expect(revoked).toEqual([dunesUrl]);
		app?.unmount();
		app = null;
		expect([...revoked].sort()).toEqual([...created].sort());
	});

	it("never shows a thumbnail that arrives after its file left or Settings closed", async () => {
		holdNext.add("dunes.jpg");
		await mount();
		app?.unmount();
		app = null;

		held.get("dunes.jpg")?.();
		await settle();

		expect([...revoked].sort()).toEqual([...created].sort());
	});

	it("loads a listed file again after a same-name upload, and gives back the old blob", async () => {
		await mount();
		const before = shown();

		invalidateAsset("wallpapers", "forest.png");
		await settle();

		expect(fileLoads().filter((path) => path.endsWith("forest.png"))).toHaveLength(2);
		expect(shown()).not.toEqual(before);
		expect(revoked).toEqual([before[1]]);
	});

	it("never shows the old file when a same-name upload lands while it still loads", async () => {
		holdNext.add("forest.png");
		await mount();

		invalidateAsset("wallpapers", "forest.png");
		await settle();
		const fresh = shown()[1];
		held.get("forest.png")?.();
		await settle();

		expect(shown()[1]).toBe(fresh);
		expect(fresh?.startsWith("blob:thumb/")).toBe(true);
		expect(revoked).toHaveLength(1);
		expect(revoked[0]).not.toBe(fresh);
	});
});
