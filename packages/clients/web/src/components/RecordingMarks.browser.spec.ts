/**
 * The recording controls' text on its own fill, in every bundled theme (#80):
 * the Recordings list's Save button and the rail's count of waiting
 * recordings. happy-dom computes no theme colours, so this runs in a browser
 * with base.css and the theme applied. New file: neither component had a
 * browser spec, and both mounts are a few lines.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { useHostsStore } from "../stores/hosts.js";
import { useRecordingsStore } from "../stores/recordings.js";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import HostRail from "./HostRail.vue";
import RecordingsModal from "./RecordingsModal.vue";

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

/** A colour as the browser computes it, which must be opaque. */
function solid(css: string, what: string): [number, number, number] {
	const m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(css);
	if (m === null) throw new Error(`cannot read the colour ${css} of ${what}`);
	expect(Number(m[4] ?? 1), `${what} (${css}) is see-through`).toBe(1);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** The contrast of `el`'s text on its own background. */
function textOnFill(el: Element, what: string): number {
	const style = getComputedStyle(el);
	return contrastRatio(solid(style.color, `${what} text`), solid(style.backgroundColor, what));
}

function mountWith(render: () => ReturnType<typeof h>): void {
	const pinia = createPinia();
	setActivePinia(pinia);
	vi.spyOn(useHostsStore(), "fetchHosts").mockResolvedValue();
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render });
	app.use(pinia);
	app.mount(root);
}

describe("recording controls' contrast (#80)", () => {
	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		// Mutation caught: white text on the accent fill (the Save button's #fff).
		it(`reads the Save button in ${name}`, async () => {
			const pinia = createPinia();
			setActivePinia(pinia);
			useThemeStore().applyTheme(theme);
			const store = useRecordingsStore();
			vi.spyOn(store, "refresh").mockResolvedValue();
			store.rows = [
				{
					id: "01K80REC000000000000000000",
					channel_id: "ch-1",
					host_label: "pi",
					title: "build",
					started_at: "2026-11-22T10:00:00.000Z",
					ended_at: "2026-11-22T10:05:00.000Z",
					end_reason: "exited",
					cols: 80,
					rows: 24,
					duration_ms: 300_000,
					bytes: 2048,
				},
			];
			const root = document.createElement("div");
			document.body.appendChild(root);
			app = createApp({ render: () => h(RecordingsModal) });
			app.use(pinia);
			app.mount(root);
			await nextTick();
			const save = [...document.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Save…",
			);
			if (save === undefined) throw new Error("no Save button");
			const ratio = textOnFill(save, "Save button");
			expect(ratio, `Save: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
		});

		// Mutation caught: white text on the theme's red (the count's #fff).
		it(`reads the rail's count of waiting recordings in ${name}`, async () => {
			for (const full of [false, true]) {
				mountWith(() => h(HostRail, { recordingCount: 3, recordingsFull: full }));
				useThemeStore().applyTheme(theme);
				await nextTick();
				const badge = document.querySelector(".rail-rec-badge");
				if (badge === null) throw new Error("no count on the Recordings button");
				const what = full ? "full mark" : "count";
				const ratio = textOnFill(badge, what);
				expect(ratio, `${what}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
				app?.unmount();
				app = null;
				document.body.replaceChildren();
			}
		});
	}
});
