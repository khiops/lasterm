/**
 * The tab bar's fit (#1194): tabs share the bar's width before anything
 * overflows, and no scrollbar ever shows. Real layout, which happy-dom does not
 * give (TabBar.spec.ts covers the behaviour).
 */
/// <reference types="@vitest/browser-playwright" />
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import "../styles/base.css";
import TabBar from "./TabBar.vue";

let app: App | null = null;
let host: HTMLElement | null = null;
const active = ref(0);
const ids = ref<string[]>([]);

afterEach(() => {
	app?.unmount();
	app = null;
	host?.remove();
	host = null;
});

async function mountBar(count: number, widthPx: number): Promise<HTMLElement> {
	ids.value = Array.from({ length: count }, (_, i) => `t${i}`);
	active.value = 0;
	const pinia = createPinia();
	setActivePinia(pinia);
	host = document.createElement("div");
	host.style.cssText = `width:${widthPx}px;display:flex;flex-direction:column`;
	document.body.appendChild(host);
	app = createApp({
		render: () =>
			h(TabBar, {
				tabs: ids.value.map((id) => ({ id })),
				activeTabIndex: active.value,
				getTabLabel: (id: string) => `A fairly long terminal title ${id}`,
				getActiveChannelId: (id: string) => `ch-${id}`,
				getTabChannelIds: (id: string) => [`ch-${id}`],
				visibleTabIds: null,
				onSelectTab: (i: number) => {
					active.value = i;
				},
			}),
	});
	app.use(pinia);
	app.mount(host);
	await nextTick();
	const bar = host.querySelector<HTMLElement>(".tab-bar");
	if (bar === null) throw new Error("no tab bar");
	return bar;
}

const tabs = (bar: HTMLElement) => [...bar.querySelectorAll<HTMLElement>('[role="tab"]')];

describe("TabBar fit (#1194)", () => {
	it("shrinks the tabs, without overflow, when they exceed the width at full size", async () => {
		const bar = await mountBar(6, 600); // 6 x 180 = 1080 > 600
		const widths = tabs(bar).map((t) => t.getBoundingClientRect().width);
		expect(Math.max(...widths)).toBeLessThan(120);
		expect(Math.min(...widths)).toBeGreaterThanOrEqual(80);
		expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
	});

	it("ellipsizes a shrunken tab's title", async () => {
		const bar = await mountBar(6, 600);
		const label = bar.querySelector<HTMLElement>(".tab__label");
		expect(label?.scrollWidth).toBeGreaterThan(label?.clientWidth ?? 0);
		expect(getComputedStyle(label as HTMLElement).textOverflow).toBe("ellipsis");
	});

	it("shows no scrollbar, and still scrolls, when the tabs do not fit at their smallest", async () => {
		const bar = await mountBar(20, 600); // 20 x 80 = 1600 > 600
		const border = Number.parseFloat(getComputedStyle(bar).borderBottomWidth);
		expect(bar.offsetHeight - bar.clientHeight).toBe(border); // nothing else: no scrollbar track
		expect(bar.scrollWidth).toBeGreaterThan(bar.clientWidth);
		bar.scrollLeft = 200;
		expect(bar.scrollLeft).toBe(200);
	});

	it("brings the active tab into view when it changes", async () => {
		const bar = await mountBar(20, 600);
		active.value = 19;
		await nextTick();
		await new Promise((r) => setTimeout(r, 600)); // smooth scroll
		const last = tabs(bar)[19]?.getBoundingClientRect();
		const box = bar.getBoundingClientRect();
		expect(last?.right).toBeLessThanOrEqual(box.right + 1);
		expect(last?.left).toBeGreaterThanOrEqual(box.left);
	});
});

const counter = (bar: HTMLElement, side: "left" | "right") =>
	bar.querySelector<HTMLButtonElement>(`.tab-bar__more--${side}`);
const settle = () => new Promise((r) => setTimeout(r, 650)); // smooth scroll + observers

describe("TabBar hidden-tab counters (#1200)", () => {
	it("shows only the right counter at the start, counting the tabs not wholly in view", async () => {
		const bar = await mountBar(20, 600);
		await settle();
		const hidden = tabs(bar).filter(
			(t) => t.getBoundingClientRect().right > bar.getBoundingClientRect().right + 1,
		);
		expect(counter(bar, "left")).toBeNull();
		expect(counter(bar, "right")?.textContent?.trim()).toBe(String(hidden.length));
		expect(counter(bar, "right")?.getAttribute("aria-label")).toBe(
			`${hidden.length} more tabs to the right`,
		);
	});

	it("shows nothing while every tab is in view", async () => {
		const bar = await mountBar(3, 600);
		await settle();
		expect(counter(bar, "left")).toBeNull();
		expect(counter(bar, "right")).toBeNull();
	});

	it("shows the left counter and drops the right one at the end", async () => {
		const bar = await mountBar(20, 600);
		bar.scrollLeft = bar.scrollWidth;
		await settle();
		expect(counter(bar, "right")).toBeNull();
		expect(counter(bar, "left")?.textContent?.trim()).toMatch(/^\d+$/);
		expect(counter(bar, "left")?.getAttribute("aria-label")).toMatch(/^\d+ more tabs to the left$/);
	});

	it("costs the tabs no height", async () => {
		const overflowing = await mountBar(20, 600);
		await settle();
		const withCue = tabs(overflowing)[0]?.getBoundingClientRect().height;
		app?.unmount();
		host?.remove();
		const fitting = await mountBar(2, 600);
		await settle();
		expect(counter(fitting, "right")).toBeNull();
		expect(withCue).toBe(tabs(fitting)[0]?.getBoundingClientRect().height);
	});

	it("scrolls the next hidden tab into view when the right counter is clicked", async () => {
		const bar = await mountBar(20, 600);
		await settle();
		const box = bar.getBoundingClientRect();
		const next = tabs(bar).find((t) => t.getBoundingClientRect().right > box.right + 1);
		counter(bar, "right")?.click();
		await settle();
		expect(next?.getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 1);
		expect(counter(bar, "left")).not.toBeNull();
	});

	it("scrolls back with the left counter, and hands the keyboard to the tab when it was the last", async () => {
		const bar = await mountBar(20, 600);
		bar.scrollLeft = 20; // one tab partly out on the left
		await settle();
		expect(counter(bar, "left")?.textContent?.trim()).toBe("1");
		counter(bar, "left")?.click();
		await settle();
		expect(bar.scrollLeft).toBe(0);
		expect(counter(bar, "left")).toBeNull();
		expect(document.activeElement).toBe(tabs(bar)[0]);
	});

	it("updates when the bar is resized", async () => {
		const bar = await mountBar(20, 600);
		await settle();
		const before = Number(counter(bar, "right")?.textContent);
		(host as HTMLElement).style.width = "1000px";
		await settle();
		expect(Number(counter(bar, "right")?.textContent)).toBeLessThan(before);
	});

	it("updates when a tab is added", async () => {
		const bar = await mountBar(20, 600);
		await settle();
		const before = Number(counter(bar, "right")?.textContent);
		ids.value = [...ids.value, "extra"];
		await settle();
		expect(Number(counter(bar, "right")?.textContent)).toBe(before + 1);
	});

	it("is not the profile menu's chevron, and takes no layout width", async () => {
		const bar = await mountBar(20, 600);
		await settle();
		const more = counter(bar, "right") as HTMLElement;
		expect(more.textContent).not.toContain("▾");
		expect(more.closest(".tab-bar__add-group")).toBeNull();
		expect(more.parentElement?.getBoundingClientRect().width).toBe(0);
	});
});
