/**
 * An imported font's card from the keyboard (#637). It was a clickable div, which the keyboard
 * never reached, with a delete button that showed only under the mouse. Choosing the font is a
 * button now, and the delete button shows whenever the keyboard is on the card.
 */
import { BUNDLED_THEMES, type FontFamily } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useThemeStore } from "../../stores/theme.js";
import FontCard from "./FontCard.vue";

const FAMILY = { family: "Iosevka Term", files: [] } as unknown as FontFamily;

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.documentElement.removeAttribute("style");
});

function mountCard(selected: boolean) {
	const handlers = { onSelect: vi.fn(), onDelete: vi.fn() };
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(FontCard, { family: FAMILY, selected, ...handlers }) });
	app.mount(root);
	return handlers;
}

const select = (): HTMLButtonElement =>
	root.querySelector(".font-card-select") as HTMLButtonElement;

describe("FontCard", () => {
	it("chooses the font with a button the keyboard reaches, which says whether it is chosen", () => {
		const { onSelect } = mountCard(true);
		expect(select().tagName).toBe("BUTTON");
		expect(select().getAttribute("aria-label")).toBe("Iosevka Term");
		expect(select().getAttribute("aria-pressed")).toBe("true");
		select().focus();
		expect(document.activeElement).toBe(select());
		select().click();
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("deletes from the keyboard too, after asking, without choosing the font", async () => {
		const { onSelect, onDelete } = mountCard(false);
		const remove = root.querySelector(".font-card-delete") as HTMLButtonElement;
		expect(remove.getAttribute("aria-label")).toBe("Delete Iosevka Term");
		remove.click();
		await nextTick();
		(root.querySelector(".font-card-confirm-btn--danger") as HTMLButtonElement).click();
		expect(onDelete).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
		// The delete control is not inside the choosing button.
		expect(select().querySelector("button")).toBeNull();
	});

	// Its delete button with the keyboard on the card, or the mouse: FontCard.browser.spec.ts.
	it.each([
		["one-half-dark", "2px solid #61afef"],
		["solarized-light", "2px solid #268bd2"],
	])("draws the keyboard's ring from the theme: %s", (theme, ring) => {
		setActivePinia(createPinia());
		useThemeStore().applyTheme(BUNDLED_THEMES[theme]!);
		mountCard(false);
		const outline = (): string => {
			const style = getComputedStyle(select());
			return `${style.outlineWidth} ${style.outlineStyle} ${style.outlineColor}`;
		};
		expect(outline()).not.toBe(ring);
		select().focus();
		// happy-dom keeps computed styles until the DOM changes, and a focus change is not one.
		const mark = document.createComment("");
		document.body.append(mark);
		mark.remove();
		expect(outline()).toBe(ring);
	});
});
