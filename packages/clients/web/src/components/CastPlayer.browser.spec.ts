/**
 * The player's Position bar in a browser (#80): a browser rounds a range
 * input's value to its step, which happy-dom does not, so the end of the bar
 * is checked here, with the real xterm.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h } from "vue";
import CastPlayer from "./CastPlayer.vue";

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

async function* parts(...texts: string[]): AsyncGenerator<string> {
	for (const text of texts) yield text;
}

describe("CastPlayer in a browser", () => {
	// Mutation caught: a step on the bar that stops short of the last event (step="0.01").
	it("shows the last event when the Position bar is moved to its end", async () => {
		const cast = [
			'{"version":3,"term":{"cols":80,"rows":24}}',
			'[0, "o", "hello "]',
			'[100.005, "o", "end"]',
			"",
		].join("\n");
		setActivePinia(createPinia());
		const root = document.createElement("div");
		document.body.appendChild(root);
		app = createApp({ render: () => h(CastPlayer, { chunks: () => parts(cast), title: "build" }) });
		app.use(createPinia());
		app.mount(root);
		const seek = await vi.waitFor(() => {
			const el = document.querySelector<HTMLInputElement>(".player__seek");
			if (el === null || Number(el.max) === 0) throw new Error("the cast is not loaded");
			return el;
		}, 10_000);
		document.querySelector<HTMLButtonElement>('[aria-label="Pause"]')?.click();
		// Skip idle off: the bar ends at 100.005 s, between two of its 0.01 s steps.
		const skip = document.querySelector<HTMLInputElement>('.player__field input[type="checkbox"]');
		if (skip?.checked) skip.click();
		await vi.waitFor(() => expect(Number(seek.max)).toBe(100.005));
		// Paused before the last event: only the seek can show it.
		expect(document.querySelector(".player__screen .xterm-rows")?.textContent).not.toContain("end");
		seek.value = seek.max;
		seek.dispatchEvent(new Event("input", { bubbles: true }));
		await vi.waitFor(() => {
			expect(document.querySelector(".player__screen .xterm-rows")?.textContent).toContain(
				"hello end",
			);
		});
	});
});
