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

afterEach(() => {
	app?.unmount();
	app = null;
	host?.remove();
	host = null;
});

async function mountBar(count: number, widthPx: number): Promise<HTMLElement> {
	const ids = Array.from({ length: count }, (_, i) => `t${i}`);
	active.value = 0;
	const pinia = createPinia();
	setActivePinia(pinia);
	host = document.createElement("div");
	host.style.cssText = `width:${widthPx}px;display:flex;flex-direction:column`;
	document.body.appendChild(host);
	app = createApp({
		render: () =>
			h(TabBar, {
				tabs: ids.map((id) => ({ id })),
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
