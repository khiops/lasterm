/**
 * The title bar's Restore icon, drawn in the desktop when the window is
 * maximised: two squares, the front one filled with the bar's ground so that
 * it hides the one behind it. Run in a browser, which paints SVG; the window
 * is Tauri's, stood in for a maximised one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		isMaximized: async () => true,
		onResized: async () => () => {},
	}),
}));

import TitleBar from "./TitleBar.vue";

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

/** The fill of each square of the Restore icon, back first. */
async function restoreSquares(): Promise<string[]> {
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(TitleBar) });
	app.mount(root);
	await vi.waitFor(() => {
		if (root.querySelector('button[aria-label="Maximize"] rect + rect') === null) {
			throw new Error("the Restore icon is not drawn");
		}
	});
	await nextTick();
	return [...root.querySelectorAll('button[aria-label="Maximize"] rect')].map(
		(rect) => getComputedStyle(rect).fill,
	);
}

describe("TitleBar's Restore icon", () => {
	it("fills its front square with the bar's ground, and leaves the back one empty", async () => {
		document.documentElement.style.setProperty("--nt-bg", "rgb(1, 2, 3)");
		expect(await restoreSquares()).toEqual(["none", "rgb(1, 2, 3)"]);
	});

	it("fills it with the default ground before a theme is applied", async () => {
		expect(await restoreSquares()).toEqual(["none", "rgb(30, 30, 46)"]);
	});
});
