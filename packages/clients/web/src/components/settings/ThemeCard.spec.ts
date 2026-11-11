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

	// With the mouse or the keyboard on the card, it shows at 0.7: ThemeCard.browser.spec.ts.
	it("shows its edit button at full strength with the keyboard on it", () => {
		mountCard({ isActive: false, isCustom: true });
		const button = edit() as HTMLButtonElement;
		expect(getComputedStyle(button).opacity).toBe("0");
		button.focus();
		// happy-dom keeps computed styles until the DOM changes, and a focus change is not one.
		const mark = document.createComment("");
		document.body.append(mark);
		mark.remove();
		expect(getComputedStyle(button).opacity).toBe("1");
	});
});
