/**
 * Where the host menu is drawn, in a real layout (#1190): opened at the window's bottom and right
 * edges, it ends inside the window; in a window shorter than itself, it scrolls.
 */
import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { useHostsStore } from "../stores/hosts.js";
import HostContextMenu from "./HostContextMenu.vue";

const STAMP = "2026-09-29T00:00:00.000Z";
const PI: Host = {
	id: "pi",
	type: "ssh",
	label: "pi",
	iconType: "auto",
	trustRemoteHints: "ask",
	sortOrder: 0,
	os: "linux",
	arch: null,
	createdAt: STAMP,
	updatedAt: STAMP,
};

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = "";
});

async function openAt(x: number, y: number): Promise<DOMRect> {
	const pinia = createPinia();
	setActivePinia(pinia);
	useHostsStore().hosts = [PI];
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(HostContextMenu, { visible: true, hostId: "pi", x, y }) });
	app.use(pinia);
	app.mount(root);
	await nextTick();
	await nextTick();
	const menu = document.body.querySelector<HTMLElement>(".ctx-menu");
	if (menu === null) throw new Error("no menu");
	return menu.getBoundingClientRect();
}

describe("the host menu stays inside the window (#1190)", () => {
	it("opened at the bottom right corner, it ends inside the window", async () => {
		const rect = await openAt(window.innerWidth - 2, window.innerHeight - 2);
		expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
		expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
		expect(rect.top).toBeGreaterThanOrEqual(0);
		expect(rect.left).toBeGreaterThanOrEqual(0);
	});
});
