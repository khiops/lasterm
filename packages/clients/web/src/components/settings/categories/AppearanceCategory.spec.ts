/**
 * Appearance › Host rail › Badge size (#623): one rail for every host, so the
 * setting is global and offered nowhere else.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, nextTick } from "vue";
import { useConfigStore } from "../../../stores/config.js";
import type { Scope } from "../../../stores/settings.js";
import AppearanceCategory from "./AppearanceCategory.vue";

// No hub: the theme picker's requests get nothing.
vi.mock("../../../utils/hub-fetch.js", () => ({
	hubFetch: vi.fn(async () => new Response("[]", { status: 404 })),
}));

let app: App | null = null;
let root: HTMLElement;

function mount(scope: Scope) {
	const pinia = createPinia();
	setActivePinia(pinia);
	const configStore = useConfigStore();
	const save = vi.spyOn(configStore, "saveUiSettings").mockResolvedValue(true);
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(AppearanceCategory, { scope });
	app.use(pinia);
	app.mount(root);
	return { configStore, save };
}

function badgeSizeGroup(): HTMLElement | null {
	return root.querySelector('[role="radiogroup"][aria-label="Badge size"]');
}

function radio(label: string): HTMLInputElement {
	const option = [...(badgeSizeGroup()?.querySelectorAll("label") ?? [])].find(
		(l) => l.textContent?.trim() === label,
	);
	const input = option?.querySelector("input");
	if (!input) throw new Error(`no ${label} option`);
	return input;
}

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
});

describe("Appearance › Host rail › Badge size", () => {
	it("offers Small, Medium and Large at global scope, Medium by default", () => {
		mount("global");
		const group = badgeSizeGroup();
		expect(group).not.toBeNull();
		const options = [...(group?.querySelectorAll("label") ?? [])].map((l) => l.textContent?.trim());
		expect(options).toEqual(["Small", "Medium", "Large"]);
		expect(radio("Medium").checked).toBe(true);
		expect(radio("Small").type).toBe("radio");
	});

	it("is not offered for a host or a terminal", () => {
		mount("host");
		expect(badgeSizeGroup()).toBeNull();
		app?.unmount();
		root.remove();
		mount("channel");
		expect(badgeSizeGroup()).toBeNull();
	});

	it("writes the size chosen to [layout], and shows the one the config holds", async () => {
		const { configStore, save } = mount("global");
		radio("Large").click();
		expect(save).toHaveBeenCalledExactlyOnceWith("layout", { hostRailBadgeSize: "large" });

		configStore.uiConfig = {
			onChannelDead: "readonly",
			layout: { hostRailColumns: 2, hostRailBadgeSize: "small", sidebarWidth: 200 },
		};
		await nextTick();
		expect(radio("Small").checked).toBe(true);
		expect(radio("Small").closest("label")?.classList.contains("badge-size-option--on")).toBe(true);
	});
});

// Appearance › Keyboard › Show key hints (#639): the window's keys, so global only.
describe("Appearance › Keyboard › Show key hints", () => {
	function keyHintsSwitch(): HTMLInputElement | null {
		const row = [...root.querySelectorAll(".setting-row")].find(
			(r) => r.querySelector(".setting-label")?.textContent === "Show key hints",
		);
		return row?.querySelector<HTMLInputElement>('input[role="switch"]') ?? null;
	}

	it("is offered at global scope, on by default", () => {
		mount("global");
		expect(keyHintsSwitch()?.checked).toBe(true);
	});

	it("is not offered for a host or a terminal", () => {
		mount("host");
		expect(keyHintsSwitch()).toBeNull();
		app?.unmount();
		root.remove();
		mount("channel");
		expect(keyHintsSwitch()).toBeNull();
	});

	it("writes [keyboard] key_hints, and shows what the config holds", async () => {
		const { configStore, save } = mount("global");
		keyHintsSwitch()?.click();
		expect(save).toHaveBeenCalledExactlyOnceWith("keyboard", { keyHints: false });

		configStore.uiConfig = { onChannelDead: "readonly", keyboard: { keyHints: false } };
		await nextTick();
		expect(keyHintsSwitch()?.checked).toBe(false);
	});
});
