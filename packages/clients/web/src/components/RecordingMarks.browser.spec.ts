/**
 * The recording controls' text on its own fill, in every bundled theme (#80):
 * the Recordings list's Save and Discard buttons, its full mark and file
 * error, and the rail's count of waiting recordings. happy-dom computes no theme colours, so this runs in a browser
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

/** What `el` is drawn on: its own background over each ancestor's, down to the first opaque one. */
function groundOf(el: Element): [number, number, number] {
	const layers: Array<[number, number, number, number]> = [];
	for (let at: Element | null = el; at !== null; at = at.parentElement) {
		const m = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(
			getComputedStyle(at).backgroundColor,
		);
		if (m === null) throw new Error("cannot read a background");
		const layer: [number, number, number, number] = [
			Number(m[1]),
			Number(m[2]),
			Number(m[3]),
			Number(m[4] ?? 1),
		];
		if (layer[3] > 0) layers.push(layer);
		if (layer[3] === 1) break;
	}
	const base = layers.pop();
	if (base === undefined || base[3] !== 1) throw new Error("no opaque ground under the element");
	let ground: [number, number, number] = [base[0], base[1], base[2]];
	for (const [r, g, b, a] of layers.reverse()) {
		ground = [
			r * a + ground[0] * (1 - a),
			g * a + ground[1] * (1 - a),
			b * a + ground[2] * (1 - a),
		];
	}
	return ground;
}

/** The contrast of `el`'s text on what it is drawn on. */
function textOnGround(el: Element, what: string): number {
	return contrastRatio(solid(getComputedStyle(el).color, `${what} text`), groundOf(el));
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
		it(`reads the list's buttons, full mark and file error in ${name}`, async () => {
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

			// Mutation caught: the confirmation's white on red, and red text from the ANSI palette.
			[...document.querySelectorAll("button")]
				.find((b) => b.textContent?.trim() === "Discard")
				?.click();
			await nextTick();
			const confirm = document.querySelector(".btn-danger");
			if (confirm === null) throw new Error("no Discard confirmation");
			const danger = textOnFill(confirm, "Discard confirmation");
			expect(danger, `Discard: ${danger.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);

			store.usedBytes = 2048;
			store.capBytes = 1024;
			await nextTick();
			const fullMark = document.querySelector(".rec-usage--full");
			if (fullMark === null) throw new Error("no full mark");
			const full = textOnGround(fullMark, "full mark");
			expect(full, `Full: ${full.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);

			// A file over the player's limit, as a picker would hand it over.
			const big = new File(["x"], "huge.cast");
			Object.defineProperty(big, "size", { value: 2 * 1024 ** 3 });
			const input = document.querySelector<HTMLInputElement>('input[type="file"]');
			if (input === null) throw new Error("no file input");
			Object.defineProperty(input, "files", { value: [big], configurable: true });
			input.dispatchEvent(new Event("change"));
			await nextTick();
			const fileError = document.querySelector(".rec-file-error");
			if (fileError === null) throw new Error("no file error");
			const error = textOnGround(fileError, "file error");
			expect(error, `File error: ${error.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
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
