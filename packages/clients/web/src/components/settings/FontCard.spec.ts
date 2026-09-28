/**
 * An imported font's card from the keyboard (#637). It was a clickable div, which the keyboard
 * never reached, with a delete button that showed only under the mouse. Choosing the font is a
 * button now, and the delete button shows whenever the keyboard is on the card.
 */
import type { FontFamily } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import FontCard from "./FontCard.vue";
import SOURCE from "./FontCard.vue?raw";

const FAMILY = { family: "Iosevka Term", files: [] } as unknown as FontFamily;

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
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

	it("shows its delete button whenever the keyboard is on the card, and a ring from the theme", () => {
		expect(SOURCE).toMatch(
			/\.font-card:hover \.font-card-delete,\s*\.font-card:focus-within \.font-card-delete\s*\{[^}]*opacity:\s*1/,
		);
		expect(SOURCE).toMatch(
			/\.font-card-select:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--nt-accent\)/,
		);
	});
});
