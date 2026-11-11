import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { useThemeStore } from "../stores/theme.js";
import { useToastStore } from "../stores/toast.js";
import ToastContainer from "./ToastContainer.vue";

// ─── A toast reads in every theme (#830) ─────────────────────────────────────
//
// Toasts named `--nt-sidebar-bg`, which nothing defines, for a dark fallback
// ground, and each level's rule then replaced that ground with a 12% tint of
// its colour: whatever lay behind showed through, in every theme. They now take
// the exit card's ground and text, and mark their level in its border and its
// icon. Checked here on mounted toasts, drawn with the component's rules and
// base.css: before a theme is applied (base.css's own values) and in a dark and
// a light theme, so a colour neither declares nor follows shows. Their contrast
// in every bundled theme is checked in a browser (ToastContainer.browser.spec.ts),
// which computes the colour-mix() text levels happy-dom does not.

const LEVELS = ["error", "warning", "info"] as const;
type Level = (typeof LEVELS)[number];

interface Drawn {
	ground: string;
	text: string;
	shadow: string;
	level: Record<Level, string>;
}

/** What each is drawn in, read off base.css and the theme files, and off the theme store's
 * readable text for the two whose pair falls short (`--nt-text-strong`, `--nt-status-*`). */
const DRAWN: Record<string, Drawn> = {
	"base.css alone": {
		ground: "rgb(30, 30, 46)",
		text: "#cdd6f4",
		shadow: "0 4px 24px rgba(0, 0, 0, 0.6)",
		level: { error: "#f38ba8", warning: "#f9e2af", info: "#89b4fa" },
	},
	"one-half-dark": {
		ground: "rgb(40, 44, 52)",
		text: "#dcdfe4",
		shadow: "0 4px 24px rgba(0, 0, 0, 0.6)",
		level: { error: "#e17079", warning: "#e5c07b", info: "#61afef" },
	},
	"solarized-light": {
		ground: "rgb(253, 246, 227)",
		text: "#5f747b",
		shadow: "0 4px 24px rgba(0, 0, 0, 0.15)",
		level: { error: "#d5312e", warning: "#8f6c00", info: "#2076b3" },
	},
};

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
	document.documentElement.removeAttribute("style");
});

/** A toast of each level, drawn under `theme` (none: base.css's values), past its entrance. */
async function mountToasts(theme: string): Promise<Map<Level, HTMLElement>> {
	const pinia = createPinia();
	setActivePinia(pinia);
	const bundled = BUNDLED_THEMES[theme];
	if (bundled !== undefined) useThemeStore().applyTheme(bundled);
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(ToastContainer) });
	app.use(pinia);
	app.mount(root);
	for (const level of LEVELS) useToastStore().show(level, `A toast at ${level}`, 60_000);
	await nextTick();
	// A toast enters transparent; its transition classes go two frames later.
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	const toasts = new Map<Level, HTMLElement>();
	for (const level of LEVELS) {
		const toast = document.querySelector<HTMLElement>(`.toast-item--${level}`);
		if (toast === null) throw new Error(`no ${level} toast`);
		toasts.set(level, toast);
	}
	return toasts;
}

/** Drawn at full strength: no opacity of its own. */
function opaque(el: Element): boolean {
	return ["", "1"].includes(getComputedStyle(el).opacity);
}

describe.each(Object.entries(DRAWN))("a toast, %s (#830)", (theme, drawn) => {
	it("is drawn on the theme's opaque ground, in its text, under its shadow", async () => {
		for (const toast of (await mountToasts(theme)).values()) {
			const style = getComputedStyle(toast);
			expect(style.backgroundColor).toBe(drawn.ground);
			expect(style.color).toBe(drawn.text);
			expect(style.boxShadow).toBe(drawn.shadow);
			expect(opaque(toast)).toBe(true);
		}
	});

	it("marks its level in its border and its icon, never with a fill", async () => {
		for (const [level, toast] of await mountToasts(theme)) {
			const style = getComputedStyle(toast);
			expect(style.borderTopColor, `${level} border`).toBe(drawn.level[level]);
			expect(getComputedStyle(toast.querySelector(".toast-icon") as Element).color).toBe(
				drawn.level[level],
			);
			// The same ground and text as every other level.
			expect(style.backgroundColor, `${level} ground`).toBe(drawn.ground);
			expect(style.color, `${level} text`).toBe(drawn.text);
		}
	});

	// A dimmed or tinted close button would take it below what it was checked
	// for. Under the pointer: ToastContainer.browser.spec.ts.
	it("keeps the close button at the toast's own colours", async () => {
		for (const toast of (await mountToasts(theme)).values()) {
			const close = toast.querySelector(".toast-close") as HTMLElement;
			expect(close.getAttribute("aria-label")).toBe("Dismiss");
			expect(getComputedStyle(close).color).toBe(drawn.text);
			expect(["none", "transparent", ""]).toContain(getComputedStyle(close).backgroundColor);
			expect(opaque(close)).toBe(true);
		}
	});
});
