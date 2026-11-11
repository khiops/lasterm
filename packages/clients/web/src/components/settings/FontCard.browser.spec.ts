/**
 * An imported font's delete button (#637, #936): it showed only under the mouse, so the keyboard
 * could reach a button it could not see. It shows with the card under the mouse and whenever the
 * keyboard is on the card or on it. happy-dom draws neither `:hover` nor `:focus-within`, so this
 * runs in a browser: the card mounted with its own rules.
 */
import type { FontFamily } from "@lasterm/shared";
import { afterEach, beforeEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { type App, createApp, h } from "vue";
import "../../styles/base.css";
import FontCard from "./FontCard.vue";

const FAMILY = { family: "Iosevka Term", files: [] } as unknown as FontFamily;

let app: App | null = null;
let root: HTMLElement;

beforeEach(async () => {
	// The pointer away from where the card will be.
	await userEvent.unhover(document.body);
	root = document.createElement("div");
	root.style.cssText = "width: 240px; margin: 80px";
	document.body.appendChild(root);
	app = createApp({
		render: () => h(FontCard, { family: FAMILY, selected: false, onSelect() {}, onDelete() {} }),
	});
	app.mount(root);
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

const card = (): HTMLElement => root.querySelector(".font-card") as HTMLElement;
const select = (): HTMLButtonElement =>
	root.querySelector(".font-card-select") as HTMLButtonElement;
const remove = (): HTMLButtonElement =>
	root.querySelector(".font-card-delete") as HTMLButtonElement;

/** How much of the delete button shows, once its fade is over. */
const shown = () => expect.poll(() => getComputedStyle(remove()).opacity);

it("hides its delete button while neither the mouse nor the keyboard is on the card", async () => {
	expect(card().matches(":hover")).toBe(false);
	await shown().toBe("0");
});

it("shows its delete button with the card under the mouse", async () => {
	await userEvent.hover(card());
	await shown().toBe("1");
});

it("shows its delete button with the keyboard on the card's button", async () => {
	expect(card().matches(":hover")).toBe(false);
	select().focus();
	await shown().toBe("1");
});

it("shows its delete button with the keyboard on it", async () => {
	expect(card().matches(":hover")).toBe(false);
	remove().focus();
	expect(document.activeElement).toBe(remove());
	await shown().toBe("1");
});
