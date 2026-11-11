/**
 * A toast's close button under the pointer (#830, #936). happy-dom draws no
 * `:hover`, so this runs in a browser: the toast mounted with its own rules
 * and base.css, a bundled theme applied, the pointer moved onto the button.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { type App, createApp, h, nextTick } from "vue";
import "../styles/base.css";
import { useThemeStore } from "../stores/theme.js";
import { useToastStore } from "../stores/toast.js";
import ToastContainer from "./ToastContainer.vue";

let app: App | null = null;

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
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
	expect(getComputedStyle(close).borderTopColor).toBe(getComputedStyle(toast).color);
});
