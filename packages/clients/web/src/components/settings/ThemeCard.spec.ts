/**
 * A theme card from the keyboard (#637). Its edit button sat inside the card's own button, which
 * the keyboard cannot reach, and showed only under the mouse. They are side by side now; the card
 * says whether it is the theme in use, previews on focus as it does on hover, and its edit button
 * shows whenever the keyboard is on either.
 */
import { BUNDLED_THEMES } from "@lasterm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h } from "vue";
import ThemeCard from "./ThemeCard.vue";
import SOURCE from "./ThemeCard.vue?raw";

const THEME = Object.values(BUNDLED_THEMES)[0]!;

let app: App | null = null;
let root: HTMLElement;

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
});

function mountCard(props: { isActive: boolean; isCustom?: boolean }) {
	const handlers = {
		onPreview: vi.fn(),
		"onPreview-clear": vi.fn(),
		onSelect: vi.fn(),
		onEdit: vi.fn(),
	};
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(ThemeCard, { theme: THEME, ...props, ...handlers }) });
	app.mount(root);
	return handlers;
}

const card = (): HTMLButtonElement => root.querySelector(".theme-card") as HTMLButtonElement;
const edit = (): HTMLButtonElement | null => root.querySelector(".theme-card-edit");

describe("ThemeCard", () => {
	it("keeps its edit button beside the card, not inside it", () => {
		mountCard({ isActive: false, isCustom: true });
		expect(card().querySelector("button")).toBeNull();
		expect(edit()?.parentElement).toBe(card().parentElement);
		expect(edit()?.getAttribute("aria-label")).toBe(`Edit ${THEME.name}`);
	});

	it("says whether it is the theme in use", () => {
		mountCard({ isActive: true });
		expect(card().getAttribute("aria-pressed")).toBe("true");
		app?.unmount();
		root.remove();
		mountCard({ isActive: false });
		expect(card().getAttribute("aria-pressed")).toBe("false");
	});

	it("previews on focus as on hover, and selects and edits from the keyboard's click", () => {
		const handlers = mountCard({ isActive: false, isCustom: true });
		card().dispatchEvent(new FocusEvent("focus"));
		expect(handlers.onPreview).toHaveBeenCalledWith(THEME);
		card().dispatchEvent(new FocusEvent("blur"));
		expect(handlers["onPreview-clear"]).toHaveBeenCalled();
		card().click();
		expect(handlers.onSelect).toHaveBeenCalledWith(THEME);
		edit()?.click();
		expect(handlers.onEdit).toHaveBeenCalledWith(THEME);
		expect(handlers.onSelect).toHaveBeenCalledTimes(1);
	});

	it("shows its edit button whenever the keyboard is on the card or on it", () => {
		const shown =
			/\.theme-card-wrapper:hover \.theme-card-edit,\s*\.theme-card-wrapper:focus-within \.theme-card-edit\s*\{[^}]*opacity:\s*0\.7/;
		expect(SOURCE).toMatch(shown);
		expect(SOURCE).toMatch(/\.theme-card-edit:focus-visible\s*\{[^}]*opacity:\s*1/);
	});
});
