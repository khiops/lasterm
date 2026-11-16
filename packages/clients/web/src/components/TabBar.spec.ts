/**
 * The tab bar from the keyboard (#637): one tab takes Tab, ← and → move along the bar, Enter or
 * Space activates a tab, Delete closes it as its × does.
 *
 * The bar is mounted with its real stores; it is given its tabs as App.vue gives them.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, type Component, createApp, h, nextTick, ref } from "vue";
import { useChannelsStore } from "../stores/channels.js";
import { useThemeStore } from "../stores/theme.js";
import { shortcutLabel } from "../utils/app-shortcuts.js";
import TabBar from "./TabBar.vue";

let app: App | null = null;
let root: HTMLElement;
const activeTabIndex = ref(0);
const visibleTabIds = ref<ReadonlySet<string> | null>(null);
/** The bar's tabs, by id: a test closes one as App.vue does, by dropping it from the list. */
const tabList = ref<string[]>([]);
/** A tab's active pane's channel where a test moved it; `ch-<tab id>` otherwise. */
const activeChannel = new Map<string, string>();

function mountBar(tabIds: string[], active = 0, bar: Component = TabBar) {
	activeTabIndex.value = active;
	tabList.value = tabIds;
	const selectTab = vi.fn((index: number) => {
		activeTabIndex.value = index;
	});
	const closeTab = vi.fn();
	const renameTab = vi.fn();
	const reorderTab = vi.fn();
	const split = vi.fn();
	const pinia = createPinia();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(bar, {
				tabs: tabList.value.map((id) => ({ id })),
				activeTabIndex: activeTabIndex.value,
				getTabLabel: (id: string) => `Label ${id}`,
				getActiveChannelId: (id: string) => activeChannel.get(id) ?? `ch-${id}`,
				visibleTabIds: visibleTabIds.value,
				onSelectTab: selectTab,
				onCloseTab: closeTab,
				onRenameTab: renameTab,
				onReorderTab: reorderTab,
				onSplit: split,
			}),
	});
	app.use(pinia);
	app.mount(root);
	return { selectTab, closeTab, renameTab, reorderTab, split, pinia };
}

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	visibleTabIds.value = null;
	activeChannel.clear();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
	document.documentElement.removeAttribute("style");
});

function tab(id: string): HTMLElement {
	const el = root.querySelector(`[data-tab-id="${id}"]`);
	if (!el) throw new Error(`no tab ${id}`);
	return el as HTMLElement;
}

/** The tabs that take Tab. */
function tabStops(): string[] {
	return [...root.querySelectorAll('[role="tab"][tabindex="0"]')].map(
		(el) => el.getAttribute("data-tab-id") ?? "",
	);
}

function focused(): string | null {
	return document.activeElement?.getAttribute("data-tab-id") ?? null;
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const target = document.activeElement ?? root;
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	await nextTick();
	await nextTick();
	return event;
}

describe("TabBar keyboard", () => {
	it("is one zone, whose tabs are its items", () => {
		mountBar(["t0", "t1"]);
		expect(root.querySelector(".tab-bar")?.getAttribute("data-focus-zone")).toBe("tabs");
		expect(tab("t0").hasAttribute("data-zone-item")).toBe(true);
		expect(tab("t1").hasAttribute("data-zone-item")).toBe(true);
	});

	it("gives Tab to the active tab only", () => {
		mountBar(["t0", "t1", "t2"], 1);
		expect(tabStops()).toEqual(["t1"]);
	});

	it("moves along the bar with ← and →, without switching, and stops at its ends", async () => {
		const { selectTab } = mountBar(["t0", "t1", "t2"], 0);
		tab("t0").focus();
		await press("ArrowRight");
		expect(focused()).toBe("t1");
		expect(tabStops()).toEqual(["t1"]);
		await press("ArrowRight");
		await press("ArrowRight");
		expect(focused()).toBe("t2");
		await press("ArrowLeft");
		expect(focused()).toBe("t1");
		await press("Home");
		expect(focused()).toBe("t0");
		await press("ArrowLeft");
		expect(focused()).toBe("t0");
		await press("End");
		expect(focused()).toBe("t2");
		expect(selectTab).not.toHaveBeenCalled();
	});

	it("activates the tab on Enter or Space", async () => {
		const { selectTab } = mountBar(["t0", "t1", "t2"], 0);
		tab("t0").focus();
		await press("ArrowRight");
		const enter = await press("Enter");
		expect(selectTab).toHaveBeenLastCalledWith(1);
		// Instead of the button's own click, which would come on top.
		expect(enter.defaultPrevented).toBe(true);
		await press("ArrowRight");
		await press(" ");
		expect(selectTab).toHaveBeenLastCalledWith(2);
		expect(selectTab).toHaveBeenCalledTimes(2);
	});

	it("closes the tab on Delete, as its × does", async () => {
		const { closeTab } = mountBar(["t0", "t1", "t2"], 0);
		tab("t0").focus();
		await press("ArrowRight");
		await press("Delete");
		expect(closeTab).toHaveBeenCalledExactlyOnceWith(1);
		// Its × emits the same.
		(tab("t2").querySelector(".tab__close") as HTMLElement).click();
		expect(closeTab).toHaveBeenLastCalledWith(2);
	});

	it("moves among the tabs the bar shows only", async () => {
		visibleTabIds.value = new Set(["t0", "t2", "t3"]);
		const { selectTab } = mountBar(["t0", "t1", "t2", "t3"], 0);
		expect(root.querySelector('[data-tab-id="t1"]')).toBeNull();
		tab("t0").focus();
		await press("ArrowRight");
		expect(focused()).toBe("t2");
		await press("Enter");
		// The index is the tab's among all of them.
		expect(selectTab).toHaveBeenLastCalledWith(2);
	});

	it("leaves the keys of a tab being renamed, and the chords, alone", async () => {
		const { selectTab, closeTab } = mountBar(["t0", "t1"], 0);
		const input = document.createElement("input");
		tab("t0").appendChild(input);
		input.focus();
		await press("ArrowRight");
		await press("Delete");
		await press("Enter");
		expect(document.activeElement).toBe(input);
		expect(closeTab).not.toHaveBeenCalled();
		expect(selectTab).not.toHaveBeenCalled();
		input.remove();
		tab("t0").focus();
		// Alt+→ is the window's: the focus goes to the pane on the right.
		await press("ArrowRight", { altKey: true });
		expect(focused()).toBe("t0");
	});

	it.each([
		["one-half-dark", "2px solid #61afef"],
		["solarized-light", "2px solid #268bd2"],
	])("draws the keyboard's ring from the theme: %s", (theme, ring) => {
		useThemeStore().applyTheme(BUNDLED_THEMES[theme]!);
		mountBar(["t0", "t1"]);
		const outline = (id: string): string => {
			const style = getComputedStyle(tab(id));
			return `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`;
		};
		expect(outline("t0")).not.toBe(ring);
		tab("t0").focus();
		// happy-dom keeps computed styles until the DOM changes, and a focus change is not one.
		const mark = document.createComment("");
		document.body.append(mark);
		mark.remove();
		expect(outline("t0")).toBe(ring);
		expect(outline("t1")).not.toBe(ring);
	});
});

// The shortcuts where the mouse is, read from the table the window runs them from (#637).
describe("TabBar tooltips", () => {
	const SWITCH = `${shortcutLabel("tab.next")} / ${shortcutLabel("tab.previous")}: next / previous tab`;

	const tooltip = (id: string): string => tab(id).getAttribute("title") ?? "";

	it("give each tab its name, its Ctrl+Alt+N, and the keys to the next and previous tab", () => {
		mountBar(["t0", "t1", "t2"]);
		expect(tooltip("t0")).toBe(`Label t0 — ${shortcutLabel("tab.goTo1")}\n${SWITCH}`);
		expect(tooltip("t2")).toBe(`Label t2 — ${shortcutLabel("tab.goTo3")}\n${SWITCH}`);
		expect(shortcutLabel("tab.goTo3")).toBe("Ctrl+Alt+3");
		expect(SWITCH).toBe("Ctrl+Tab / Ctrl+Shift+Tab: next / previous tab");
	});

	// Ctrl+Alt+9 goes to the last tab, however many there are: the ninth of ten has no chord.
	it("name the chord that truly reaches the tab", () => {
		const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
		mountBar(ids);
		expect(tooltip("t7").split("\n")[0]).toBe(`Label t7 — ${shortcutLabel("tab.goTo8")}`);
		expect(tooltip("t8").split("\n")[0]).toBe("Label t8");
		expect(tooltip("t9").split("\n")[0]).toBe(`Label t9 — ${shortcutLabel("tab.goTo9")}`);
	});

	it("count the tabs the bar shows, as the chords do", () => {
		visibleTabIds.value = new Set(["t0", "t2", "t3"]);
		mountBar(["t0", "t1", "t2", "t3"]);
		expect(tooltip("t2").split("\n")[0]).toBe(`Label t2 — ${shortcutLabel("tab.goTo2")}`);
		expect(tooltip("t3").split("\n")[0]).toBe(`Label t3 — ${shortcutLabel("tab.goTo3")}`);
	});

	it("name the new tab's chord on the + button", () => {
		mountBar(["t0"]);
		const add = root.querySelector(".tab-bar__add--main");
		expect(add?.getAttribute("title")).toBe(`New terminal (${shortcutLabel("tab.new")})`);
	});

	// Ctrl+Shift+W closes the focused pane, not the tab: the × does not claim it.
	it("keep the tab's × to what it does, without a chord it does not run", () => {
		mountBar(["t0"]);
		const close = tab("t0").querySelector(".tab__close");
		expect(close?.getAttribute("title")).toBe("Close tab");
	});

	// The table relabelled: the bar says the new labels, and no chord is left that it wrote itself.
	it("write no chord of their own", async () => {
		vi.resetModules();
		vi.doMock("../utils/app-shortcuts.js", async (importOriginal) => ({
			...(await importOriginal<typeof import("../utils/app-shortcuts.js")>()),
			shortcutLabel: (id: string) => `[${id}]`,
		}));
		try {
			const relabelled = (await import("./TabBar.vue")).default;
			mountBar(
				Array.from({ length: 10 }, (_, i) => `t${i}`),
				0,
				relabelled,
			);
			const said = [root, ...root.querySelectorAll("*")].flatMap((el) => [
				el.getAttribute("title") ?? "",
				el.getAttribute("aria-label") ?? "",
			]);
			said.push(root.textContent ?? "");
			for (const text of said) expect(text).not.toMatch(/\b(Ctrl|Alt|Shift)\+/);
			expect(tooltip("t0")).toBe(
				"Label t0 — [tab.goTo1]\n[tab.next] / [tab.previous]: next / previous tab",
			);
			expect(tooltip("t9").split("\n")[0]).toBe("Label t9 — [tab.goTo9]");
			expect(root.querySelector(".tab-bar__add--main")?.getAttribute("title")).toBe(
				"New terminal ([tab.new])",
			);
		} finally {
			vi.doUnmock("../utils/app-shortcuts.js");
			vi.resetModules();
		}
	});
});

// Double-clicking a tab's name renames it in place (#941).
describe("TabBar rename", () => {
	it("gives the rename field the keyboard with the whole name selected", async () => {
		mountBar(["t0", "t1"], 0);
		const label = tab("t1").querySelector(".tab__label");
		if (!label) throw new Error("no label on t1");
		label.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		await nextTick();
		await nextTick();
		const input = tab("t1").querySelector("input.tab-rename-input") as HTMLInputElement | null;
		expect(input).not.toBeNull();
		expect(document.activeElement).toBe(input);
		expect(input?.value).toBe("Label t1");
		expect(input?.selectionStart).toBe(0);
		expect(input?.selectionEnd).toBe("Label t1".length);
	});

	// Middle-clicking a tab closes it and leaves the field focused, so no blur ends the rename (#990).
	it("stays on the tab being renamed when a tab before it closes", async () => {
		const { closeTab, renameTab } = mountBar(["t0", "t1", "t2"], 0);
		const input = await rename("t1", "Build");
		const draggable = () => [tab("t1"), tab("t2")].map((el) => el.getAttribute("draggable"));
		expect(draggable()).toEqual(["false", "true"]);
		tab("t0").dispatchEvent(
			new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }),
		);
		expect(closeTab).toHaveBeenCalledWith(0);
		await closeTabs("t0");
		expect(draggable()).toEqual(["false", "true"]);
		const drag = new Map<string, string>();
		tab("t1").dispatchEvent(dragEvent("dragstart", drag));
		expect(drag.size).toBe(0);
		expect(renameField("t2")).toBeNull();
		expect(renameField("t1")).toBe(input);
		expect(input.value).toBe("Build");
		expect(document.activeElement).toBe(input);
		await press("Enter");
		expect(renameTab).toHaveBeenCalledExactlyOnceWith("ch-t1", "Build");
	});

	// The tab's active pane can change under the field: its terminal ends, or a chord moves the focus.
	it("renames the terminal whose name was being edited, not the pane active since", async () => {
		const { renameTab } = mountBar(["t0", "t1"], 0);
		await rename("t1", "Build");
		activeChannel.set("t1", "ch-t1-other");
		await press("Enter");
		expect(renameTab).toHaveBeenCalledExactlyOnceWith("ch-t1", "Build");
	});

	it("ends the rename, renaming nothing, when the tab being renamed closes", async () => {
		const { closeTab, renameTab } = mountBar(["t0", "t1", "t2"], 0);
		const input = await rename("t1", "Build");
		tab("t1").dispatchEvent(
			new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }),
		);
		expect(closeTab).toHaveBeenCalledWith(1);
		expect(renameField("t1")).toBe(input);
		await closeTabs("t1");
		expect(root.querySelector("input.tab-rename-input")).toBeNull();
		// Chromium may blur a focused field as it removes it, happy-dom does not: a blur commits.
		input.dispatchEvent(new Event("blur"));
		expect(renameTab).not.toHaveBeenCalled();
		// The next rename starts from the tab's own name, not the text typed for the closed tab.
		const next = await rename("t2");
		expect(next.value).toBe("Label t2");
		await press("Enter");
		expect(renameTab).not.toHaveBeenCalled();
	});
});

/** The rename field in a tab, or null. */
function renameField(id: string): HTMLInputElement | null {
	return tab(id).querySelector("input.tab-rename-input");
}

/** Double-click a tab's name, and type `text` into the field when given. */
async function rename(id: string, text?: string): Promise<HTMLInputElement> {
	tab(id)
		.querySelector(".tab__label")
		?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	await nextTick();
	await nextTick();
	const input = renameField(id);
	if (!input) throw new Error(`no rename field on ${id}`);
	if (text !== undefined) {
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	return input;
}

/** A drag event carrying `data`, as the browser gives it to the bar. */
function dragEvent(type: string, data: Map<string, string>, clientX = 0): DragEvent {
	const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX }) as DragEvent;
	const dataTransfer = {
		effectAllowed: "none",
		dropEffect: "none",
		get types() {
			return [...data.keys()];
		},
		setData: (format: string, value: string) => data.set(format, value),
		getData: (format: string) => data.get(format) ?? "",
	};
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
	return event;
}

/** The parent drops tabs from the list, as App.vue does on close-tab or when a terminal ends. */
async function closeTabs(...ids: string[]): Promise<void> {
	tabList.value = tabList.value.filter((id) => !ids.includes(id));
	await nextTick();
	await nextTick();
}

// A tab can close under the menu or a drag without a click: its terminal ended (App.vue closes it).
describe("TabBar, when a tab closes under the menu or a drag", () => {
	function menuItem(label: string): HTMLButtonElement {
		const item = [...document.querySelectorAll<HTMLButtonElement>(".ctx-menu .ctx-item")].find(
			(el) => el.textContent?.trim() === label,
		);
		if (!item) throw new Error(`no menu item ${label}`);
		return item;
	}

	async function openMenu(id: string): Promise<void> {
		tab(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
		await nextTick();
	}

	it("keeps the menu on the tab it was opened on", async () => {
		const { closeTab } = mountBar(["t0", "t1", "t2"], 0);
		await openMenu("t1");
		await closeTabs("t0");
		menuItem("Close").click();
		expect(closeTab).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("acts on, and describes, the tab it was opened on", async () => {
		const { split, pinia } = mountBar(["t0", "t1", "t2", "t3"], 0);
		const channel = (id: string, more: object = {}) => ({
			id,
			hostId: "h",
			status: "running",
			...more,
		});
		useChannelsStore(pinia).channels = [
			channel("ch-t0"),
			channel("ch-t1"),
			channel("ch-t2", { isWelcome: true, title: "Mine" }),
			channel("ch-t3"),
		] as never;
		await openMenu("t2");
		await closeTabs("t0");
		expect(menuItem("Unset Welcome Tab").disabled).toBe(false);
		expect(menuItem("Reset Title to Dynamic").disabled).toBe(false);
		menuItem("Split Right").click();
		expect(split).toHaveBeenCalledExactlyOnceWith("ch-t2", "vertical");
		await openMenu("t2");
		menuItem("Rename").click();
		await nextTick();
		await nextTick();
		expect(renameField("t2")).not.toBeNull();
		expect(root.querySelectorAll("input.tab-rename-input")).toHaveLength(1);
	});

	it("closes the menu when its tab closes", async () => {
		mountBar(["t0", "t1", "t2"], 0);
		await openMenu("t1");
		await closeTabs("t1");
		expect(document.querySelector(".ctx-menu")).toBeNull();
	});

	it("moves the tab that was dragged", async () => {
		const { reorderTab } = mountBar(["t0", "t1", "t2"], 0);
		const data = new Map<string, string>();
		tab("t2").dispatchEvent(dragEvent("dragstart", data));
		await nextTick();
		await closeTabs("t0");
		expect(tab("t2").classList.contains("tab--dragging")).toBe(true);
		expect(tab("t1").classList.contains("tab--dragging")).toBe(false);
		// Left of every tab's middle (happy-dom lays them all out at 0): before the first.
		tab("t1").dispatchEvent(dragEvent("drop", data, -1));
		expect(reorderTab).toHaveBeenCalledExactlyOnceWith(1, 0);
	});

	it("moves nothing when the tab dragged has closed", async () => {
		const { reorderTab } = mountBar(["t0", "t1", "t2"], 0);
		const data = new Map<string, string>();
		tab("t2").dispatchEvent(dragEvent("dragstart", data));
		await nextTick();
		await closeTabs("t2");
		tab("t1").dispatchEvent(dragEvent("drop", data, -1));
		expect(reorderTab).not.toHaveBeenCalled();
	});
});
