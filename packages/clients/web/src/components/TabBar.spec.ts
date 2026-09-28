/**
 * The tab bar from the keyboard (#637): one tab takes Tab, ← and → move along the bar, Enter or
 * Space activates a tab, Delete closes it as its × does.
 *
 * The bar is mounted with its real stores; it is given its tabs as App.vue gives them.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import TabBar from "./TabBar.vue";
import SOURCE from "./TabBar.vue?raw";

let app: App | null = null;
let root: HTMLElement;
const activeTabIndex = ref(0);
const visibleTabIds = ref<ReadonlySet<string> | null>(null);

function mountBar(tabIds: string[], active = 0) {
	activeTabIndex.value = active;
	const selectTab = vi.fn((index: number) => {
		activeTabIndex.value = index;
	});
	const closeTab = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(TabBar, {
				tabs: tabIds.map((id) => ({ id })),
				activeTabIndex: activeTabIndex.value,
				getTabLabel: (id: string) => `Label ${id}`,
				getActiveChannelId: () => null,
				visibleTabIds: visibleTabIds.value,
				onSelectTab: selectTab,
				onCloseTab: closeTab,
			}),
	});
	app.use(createPinia());
	app.mount(root);
	return { selectTab, closeTab };
}

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
	visibleTabIds.value = null;
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	vi.restoreAllMocks();
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

	it("draws the keyboard's ring from the theme", () => {
		const ring = /\.tab:focus-visible\s*\{[^}]*\}/.exec(SOURCE)?.[0] ?? "";
		expect(ring).toMatch(/outline:\s*2px solid var\(--nt-accent\)/);
		expect(ring).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
	});
});
