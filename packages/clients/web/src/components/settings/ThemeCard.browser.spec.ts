/**
 * A theme card's edit button (#637, #936): it showed only under the mouse. It shows with the card
 * under the mouse and whenever the keyboard is on the card or on it, at full strength on itself.
 * happy-dom draws neither `:hover` nor `:focus-within`, so this runs in a browser: the card
 * mounted with its own rules.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { type App, createApp, h } from "vue";
import "../../styles/base.css";
import ThemeCard from "./ThemeCard.vue";

const THEME = BUNDLED_THEMES["one-half-dark"]!;

let app: App | null = null;
let root: HTMLElement;

beforeEach(async () => {
	// The pointer away from where the card will be.
	await userEvent.unhover(document.body);
	root = document.createElement("div");
	root.style.cssText = "width: 200px; margin: 80px";
	document.body.appendChild(root);
	app = createApp({
		render: () => h(ThemeCard, { theme: THEME, isActive: false, isCustom: true }),
	});
	app.mount(root);
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

const wrapper = (): HTMLElement => root.querySelector(".theme-card-wrapper") as HTMLElement;
const card = (): HTMLButtonElement => root.querySelector(".theme-card") as HTMLButtonElement;
const edit = (): HTMLButtonElement => root.querySelector(".theme-card-edit") as HTMLButtonElement;

/** How much of the edit button shows, once its fade is over. */
const shown = () => expect.poll(() => getComputedStyle(edit()).opacity);

it("hides its edit button while neither the mouse nor the keyboard is on the card", async () => {
	expect(wrapper().matches(":hover")).toBe(false);
	await shown().toBe("0");
});

it("shows its edit button with the card under the mouse", async () => {
	await userEvent.hover(card());
	await shown().toBe("0.7");
});

it("shows its edit button with the keyboard on the card", async () => {
	expect(wrapper().matches(":hover")).toBe(false);
	card().focus();
	await shown().toBe("0.7");
});

it("shows its edit button at full strength with the keyboard on it", async () => {
	expect(wrapper().matches(":hover")).toBe(false);
	await userEvent.keyboard("{Tab}");
	await userEvent.keyboard("{Tab}");
	expect(document.activeElement).toBe(edit());
	await shown().toBe("1");
});
