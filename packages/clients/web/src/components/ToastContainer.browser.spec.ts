/**
 * A toast's close button under the pointer, and a toast's contrast in every
 * bundled theme (#830, #936). happy-dom draws no `:hover` and computes no
 * colour-mix(), so this runs in a browser: the toast mounted with its own
 * rules and base.css, a bundled theme applied.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { contrastRatio, TEXT_CONTRAST_AA, useThemeStore } from "../stores/theme.js";
import { useToastStore } from "../stores/toast.js";
import ToastContainer from "./ToastContainer.vue";

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

/** What a pointer resting on it would change in how the button reads. */
function reading(el: Element): Record<string, string> {
	const style = getComputedStyle(el);
	return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
}

// A dimmed or tinted close button would take it below the contrast the toast
// is checked for (ToastContainer.spec.ts).
it("keeps the close button at the toast's own colours under the pointer", async () => {
	const pinia = createPinia();
	setActivePinia(pinia);
	useThemeStore().applyTheme(BUNDLED_THEMES["one-half-dark"]!);
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(ToastContainer) });
	app.use(pinia);
	app.mount(root);
	useToastStore().show("error", "Could not restart it", 60_000);
	await nextTick();

	const close = document.querySelector(".toast-close");
	if (close === null) throw new Error("no close button");
	const toast = close.closest(".toast-item");
	if (toast === null) throw new Error("no toast");
	const before = reading(close);

	await userEvent.hover(close);

	expect(close.matches(":hover")).toBe(true);
	expect(reading(close)).toEqual(before);
	expect(reading(close).color).toBe(getComputedStyle(toast).color);
	// What hover does draw: its outline, in the toast's own colour.
	const outline = getComputedStyle(close);
	expect([outline.borderTopWidth, outline.borderTopStyle]).toEqual(["1px", "solid"]);
	expect(outline.borderTopColor).toBe(getComputedStyle(toast).color);
});

// ─── Contrast (#830) ─────────────────────────────────────────────────────────

/** WCAG 2.1 SC 1.4.11, for what is not text: a border. */
const NON_TEXT_CONTRAST = 3;

const LEVELS = ["error", "warning", "info"] as const;

/** A colour as the browser computes it: red, green and blue from 0 to 255, and its alpha. */
function channels(css: string): { rgb: [number, number, number]; alpha: number } {
	const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(css);
	if (rgb !== null) {
		return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha: Number(rgb[4] ?? 1) };
	}
	// colour-mix() comes back in this form.
	const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(css);
	if (srgb !== null) {
		const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map((v) => Number(v) * 255);
		return { rgb: [r ?? 0, g ?? 0, b ?? 0], alpha: Number(srgb[4] ?? 1) };
	}
	throw new Error(`cannot read the colour ${css}`);
}

/** A solid colour: what is drawn with it lets nothing through. */
function solid(css: string, what: string): [number, number, number] {
	const { rgb, alpha } = channels(css);
	expect(alpha, `${what} (${css}) is see-through`).toBe(1);
	return rgb;
}

describe("a toast's contrast (#830)", () => {
	for (const [name, theme] of Object.entries(BUNDLED_THEMES)) {
		it(`reads in ${name}`, async () => {
			const pinia = createPinia();
			setActivePinia(pinia);
			useThemeStore().applyTheme(theme);
			const root = document.createElement("div");
			document.body.appendChild(root);
			app = createApp({ render: () => h(ToastContainer) });
			app.use(pinia);
			app.mount(root);
			for (const level of LEVELS) useToastStore().show(level, `A toast at ${level}`, 60_000);
			await nextTick();

			for (const level of LEVELS) {
				const toast = document.querySelector(`.toast-item--${level}`);
				if (toast === null) throw new Error(`no ${level} toast`);
				const style = getComputedStyle(toast);
				const ground = solid(style.backgroundColor, `${level} ground`);
				for (const part of [".toast-text", ".toast-close"]) {
					const color = getComputedStyle(toast.querySelector(part) as Element).color;
					const ratio = contrastRatio(solid(color, `${level} ${part}`), ground);
					expect(ratio, `${level} ${part}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
						TEXT_CONTRAST_AA,
					);
				}
				expect([style.borderTopWidth, style.borderTopStyle], `${level} border`).toEqual([
					"1px",
					"solid",
				]);
				const border = contrastRatio(solid(style.borderTopColor, `${level} border`), ground);
				expect(border, `${level} border: ${border.toFixed(2)}`).toBeGreaterThanOrEqual(
					NON_TEXT_CONTRAST,
				);
				const iconColor = getComputedStyle(toast.querySelector(".toast-icon") as Element).color;
				const icon = contrastRatio(solid(iconColor, `${level} icon`), ground);
				expect(icon, `${level} icon: ${icon.toFixed(2)}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_AA);
			}
		});
	}
});
