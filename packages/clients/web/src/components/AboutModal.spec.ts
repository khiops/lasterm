/**
 * About: where its three links take the user (#936). Each page is written out, so a link bound to
 * another of the app's pages fails here.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

// No hub: the version is not what is checked here.
vi.mock("../utils/hub-fetch.js", () => ({
	hubFetch: vi.fn(async () => new Response("{}", { status: 404 })),
}));

import AboutModal from "./AboutModal.vue";

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
});

describe("About", () => {
	it("links to the website, the repository and its issues", async () => {
		const pinia = createPinia();
		setActivePinia(pinia);
		root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(AboutModal, { show: true }) });
		app.use(pinia);
		app.mount(root);
		await nextTick();

		// Teleported to the body.
		const links = [...document.querySelectorAll<HTMLAnchorElement>(".about-modal a[href]")].map(
			(a) => [a.textContent?.replace("↗", "").trim(), a.getAttribute("href")],
		);
		expect(links).toEqual([
			["Website", "https://o2csi.com"],
			["GitHub", "https://github.com/khiops/lasterm"],
			["Report an issue", "https://github.com/khiops/lasterm/issues"],
		]);
	});
});
