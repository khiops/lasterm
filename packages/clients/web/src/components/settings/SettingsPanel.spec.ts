/**
 * Settings from the keyboard (#637): the keyboard lands on the current category when the panel
 * opens and goes back where it was when it closes; ↑ and ↓ walk the menu, → or Enter go into the
 * detail, Esc or Shift+Tab come back, Esc in the menu closes; F6 moves between the menu, the
 * detail and the close button; Tab stays inside; the scope tabs are a tablist.
 *
 * The panel is mounted with its real stores. Each category but Keybindings, which has no control,
 * is stood in for by what Settings › Tabs begins with — a row whose control is a switch — then a
 * button and a text field, so that the detail has controls without the hub's data.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useChannelsStore } from "../../stores/channels.js";
import { useHostsStore } from "../../stores/hosts.js";
import { useSettingsStore } from "../../stores/settings.js";
import SettingsPanel from "./SettingsPanel.vue";
import SOURCE from "./SettingsPanel.vue?raw";

/** A category: a row with a real switch, as Settings › Tabs begins, then a button and a text field. */
const stubCategory = vi.hoisted(() => async () => {
	const { defineComponent, h: render } = await import("vue");
	const SettingRow = (await import("./SettingRow.vue")).default;
	const SettingControl = (await import("./SettingControl.vue")).default;
	return {
		default: defineComponent({
			inheritAttrs: false,
			setup: () => () =>
				render("div", { class: "stub-detail" }, [
					render(SettingRow, { label: "Close Button", scope: "global", isOverridden: true }, () =>
						render(SettingControl, { type: "toggle", modelValue: true }),
					),
					render("button", { class: "stub-button", type: "button" }, "A button"),
					render("input", { class: "stub-input", type: "text" }),
				]),
		}),
	};
});

vi.mock("./categories/SchemaCategory.vue", stubCategory);
vi.mock("./categories/AppearanceCategory.vue", stubCategory);
vi.mock("./categories/WallpaperCategory.vue", stubCategory);
vi.mock("./categories/EnvironmentCategory.vue", stubCategory);
vi.mock("./categories/ElevationCategory.vue", stubCategory);
vi.mock("./categories/AgentManagerCategory.vue", stubCategory);
vi.mock("./categories/DesktopCategory.vue", stubCategory);
vi.mock("./categories/ConfirmationsCategory.vue", stubCategory);
vi.mock("./ProfilesSettings.vue", stubCategory);

let app: App | null = null;
let root: HTMLElement;
let opener: HTMLButtonElement;
const visible = ref(false);

function mountPanel(options: { category?: string; hostAndChannel?: boolean } = {}) {
	const settingsStore = useSettingsStore();
	vi.spyOn(settingsStore, "loadCascade").mockResolvedValue();
	settingsStore.activeCategory = options.category ?? "terminal";
	settingsStore.activeScope = "global";
	if (options.hostAndChannel === true) {
		useHostsStore().selectedHostId = "h1";
		useChannelsStore().selectedChannelId = "c1";
	}
	const close = vi.fn(() => {
		visible.value = false;
	});
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(SettingsPanel, { visible: visible.value, onClose: close }) });
	app.use(pinia);
	app.mount(root);
	return { settingsStore, close };
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
	localStorage.clear();
	pinia = createPinia();
	setActivePinia(pinia);
	visible.value = false;
	// Where the keyboard was before Settings opened: a terminal, say.
	opener = document.createElement("button");
	opener.className = "opener";
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await nextTick();
}

async function open(): Promise<void> {
	visible.value = true;
	await settle();
}

function el(selector: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(selector);
	if (found === null) throw new Error(`nothing matches ${selector}`);
	return found;
}

const menuItem = (id: string): HTMLElement => el(`.category-nav [data-category-id="${id}"]`);

/** The switch that begins the stand-in category, as Close Button begins Settings › Tabs. */
const SWITCH = '.stub-detail input[role="switch"]';

/** Press a key where the keyboard is, as the browser would send it. */
async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	(document.activeElement ?? document.body).dispatchEvent(event);
	await settle();
	return event;
}

describe("Settings: opening and closing", () => {
	it("puts the keyboard on the current category when it opens, and gives it back when it closes", async () => {
		const { close } = mountPanel({ category: "terminal" });
		expect(document.activeElement).toBe(opener);
		await open();
		expect(document.activeElement).toBe(menuItem("terminal"));
		await press("Escape");
		expect(close).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(opener);
	});
});

describe("Settings: the menu", () => {
	it("gives Tab to the current category only", async () => {
		mountPanel({ category: "tabs" });
		await open();
		const stops = [...document.querySelectorAll('.category-nav [tabindex="0"]')];
		expect(stops.map((item) => item.getAttribute("data-category-id"))).toEqual(["tabs"]);
		expect(menuItem("tabs").getAttribute("aria-current")).toBe("page");
	});

	it("moves with ↑ and ↓, showing each category, and goes to its ends with Home and End", async () => {
		const { settingsStore } = mountPanel({ category: "terminal" });
		await open();
		await press("ArrowDown");
		expect(settingsStore.activeCategory).toBe("environment");
		expect(document.activeElement).toBe(menuItem("environment"));
		await press("ArrowUp");
		await press("ArrowUp");
		expect(settingsStore.activeCategory).toBe("wallpaper");
		expect(document.activeElement).toBe(menuItem("wallpaper"));
		await press("End");
		expect(settingsStore.activeCategory).toBe("keybindings");
		await press("Home");
		expect(settingsStore.activeCategory).toBe("appearance");
		expect(document.activeElement).toBe(menuItem("appearance"));
	});
});

describe("Settings: the menu and the detail", () => {
	// Settings › Tabs: Enter from the menu passed over its first row's switch (#637).
	it("goes onto a switch that begins the detail, on Enter from the menu", async () => {
		mountPanel({ category: "tabs" });
		await open();
		await press("Enter");
		expect(document.activeElement).toBe(el(SWITCH));
		expect(el(SWITCH).getAttribute("role")).toBe("switch");
	});

	it("goes into the detail with → or Enter, onto its first control, and back with Esc", async () => {
		const { close } = mountPanel({ category: "terminal" });
		await open();
		await press("ArrowRight");
		expect(document.activeElement).toBe(el(SWITCH));
		// Esc in the detail comes back to the category, and does not close.
		await press("Escape");
		expect(document.activeElement).toBe(menuItem("terminal"));
		await press("Enter");
		expect(document.activeElement).toBe(el(SWITCH));
		el(".stub-input").focus();
		await press("Escape");
		expect(document.activeElement).toBe(menuItem("terminal"));
		expect(close).not.toHaveBeenCalled();
	});

	it("comes back to the menu with Shift+Tab from the detail's first control", async () => {
		mountPanel({ category: "terminal" });
		await open();
		await press("ArrowRight");
		const back = await press("Tab", { shiftKey: true });
		expect(back.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(menuItem("terminal"));
		// From a later control, Shift+Tab is the browser's.
		el(".stub-input").focus();
		const within = await press("Tab", { shiftKey: true });
		expect(within.defaultPrevented).toBe(false);
	});

	it("goes into a detail with no control, onto the detail itself", async () => {
		mountPanel({ category: "keybindings" });
		await open();
		await press("ArrowRight");
		expect(document.activeElement).toBe(el(".settings-content"));
		await press("Escape");
		expect(document.activeElement).toBe(menuItem("keybindings"));
	});

	it("leaves an Esc that a control used to the control", async () => {
		const { close } = mountPanel({ category: "terminal" });
		await open();
		el(".stub-input").addEventListener("keydown", (event) => event.preventDefault());
		el(".stub-input").focus();
		await press("Escape");
		expect(document.activeElement).toBe(el(".stub-input"));
		expect(close).not.toHaveBeenCalled();
	});

	it.each([
		["the menu", ".category-nav [tabindex='0']"],
		["the scope tabs", ".scope-tab"],
		["the close button", ".settings-close"],
	])("closes on Esc from %s", async (_where, selector) => {
		const { close } = mountPanel({ category: "terminal" });
		await open();
		el(selector).focus();
		await press("Escape");
		expect(close).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(opener);
	});
});

describe("Settings: F6", () => {
	it("moves between the menu, the detail and the close button, both ways", async () => {
		mountPanel({ category: "terminal" });
		await open();
		await press("F6", { code: "F6" });
		expect(document.activeElement).toBe(el(SWITCH));
		await press("F6", { code: "F6" });
		expect(document.activeElement).toBe(el(".settings-close"));
		await press("F6", { code: "F6" });
		expect(document.activeElement).toBe(menuItem("terminal"));
		await press("F6", { code: "F6", shiftKey: true });
		expect(document.activeElement).toBe(el(".settings-close"));
		// Ctrl+F6 too, the zones' chord from anywhere.
		await press("F6", { code: "F6", ctrlKey: true });
		expect(document.activeElement).toBe(menuItem("terminal"));
	});

	it("starts from the menu when the keyboard is elsewhere in the panel", async () => {
		mountPanel({ category: "terminal" });
		await open();
		el(".scope-tab").focus();
		await press("F6", { code: "F6" });
		expect(document.activeElement).toBe(menuItem("terminal"));
	});
});

describe("Settings: Tab", () => {
	it("stays inside the panel, which is modal", async () => {
		mountPanel({ category: "terminal" });
		await open();
		expect(el(".settings-panel").getAttribute("aria-modal")).toBe("true");
		el(".settings-about-btn").focus();
		await press("Tab");
		expect(document.activeElement).toBe(el(".settings-close"));
		await press("Tab", { shiftKey: true });
		expect(document.activeElement).toBe(el(".settings-about-btn"));
	});
});

describe("Settings: the scope tabs", () => {
	it("are a tablist whose selected tab takes Tab", async () => {
		mountPanel({ category: "terminal", hostAndChannel: true });
		await open();
		expect(el(".scope-tabs").getAttribute("role")).toBe("tablist");
		const tabs = [...document.querySelectorAll<HTMLElement>(".scope-tab")];
		expect(tabs.map((tab) => tab.getAttribute("role"))).toEqual(["tab", "tab", "tab"]);
		expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
		expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
			"true",
			"false",
			"false",
		]);
	});

	it("move with ← and →, selecting the scope, and go to their ends with Home and End", async () => {
		const { settingsStore } = mountPanel({ category: "terminal", hostAndChannel: true });
		await open();
		el('.scope-tab[data-scope="global"]').focus();
		await press("ArrowRight");
		expect(settingsStore.activeScope).toBe("host");
		expect(document.activeElement).toBe(el('.scope-tab[data-scope="host"]'));
		await press("ArrowRight");
		await press("ArrowRight");
		expect(settingsStore.activeScope).toBe("channel");
		await press("ArrowLeft");
		expect(settingsStore.activeScope).toBe("host");
		await press("Home");
		expect(settingsStore.activeScope).toBe("global");
		expect(document.activeElement).toBe(el('.scope-tab[data-scope="global"]'));
	});
});

describe("Settings: the focus ring", () => {
	it("is the theme's accent, on every control of the panel", () => {
		const ring = /\.settings-panel :deep\(:focus-visible\)\s*\{[^}]*\}/.exec(SOURCE)?.[0] ?? "";
		expect(ring).toMatch(/outline:\s*2px solid var\(--nt-accent\)/);
		expect(ring).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
	});
});
