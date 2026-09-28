/**
 * The font picker from the keyboard (#637). A modal dialog: the keyboard goes into it on open and
 * back to the font button on close, Esc closes it, Tab stays inside; its two tabs are a tablist,
 * and the installed fonts a listbox that ↑ and ↓ walk.
 */
import type { SystemFontFamily } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { useConfigStore } from "../../stores/config.js";
import FontPicker from "./FontPicker.vue";
import SOURCE from "./FontPicker.vue?raw";

const SYSTEM: SystemFontFamily[] = [
	{ family: "Cascadia Mono", monospace: true },
	{ family: "Consolas", monospace: true },
	{ family: "Fira Code", monospace: true },
] as SystemFontFamily[];

let app: App | null = null;
let root: HTMLElement;
let opener: HTMLButtonElement;
const show = ref(false);

function mountPicker(modelValue?: string) {
	const configStore = useConfigStore();
	configStore.systemFonts = SYSTEM;
	vi.spyOn(configStore, "loadSystemFonts").mockResolvedValue();
	vi.spyOn(configStore, "loadFonts").mockResolvedValue();
	const close = vi.fn(() => {
		show.value = false;
	});
	const choose = vi.fn();
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({
		render: () =>
			h(FontPicker, {
				show: show.value,
				modelValue,
				onClose: close,
				"onUpdate:modelValue": choose,
			}),
	});
	app.use(pinia);
	app.mount(root);
	return { close, choose };
}

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
	pinia = createPinia();
	setActivePinia(pinia);
	show.value = false;
	// The font button of a Settings row, which opens the picker.
	opener = document.createElement("button");
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await nextTick();
}

function el(selector: string): HTMLElement {
	const found = document.querySelector<HTMLElement>(selector);
	if (found === null) throw new Error(`nothing matches ${selector}`);
	return found;
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
	(document.activeElement ?? document.body).dispatchEvent(event);
	await settle();
	return event;
}

const font = (family: string): HTMLElement => el(`.system-font-item[data-family="${family}"]`);

describe("FontPicker", () => {
	it("is a modal dialog the keyboard goes into, onto the search, and comes back from on Esc", async () => {
		const { close } = mountPicker("Consolas");
		show.value = true;
		await settle();
		const dialog = el(".font-picker-dialog");
		expect(dialog.getAttribute("role")).toBe("dialog");
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(document.activeElement).toBe(el(".system-font-search"));
		await press("Escape");
		expect(close).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(opener);
	});

	it("walks the installed fonts with ↑ and ↓, from the search too, and chooses with a click", async () => {
		const { choose } = mountPicker("Consolas");
		show.value = true;
		await settle();
		// The chosen font takes Tab in the list.
		const stops = [...document.querySelectorAll('.system-font-item[tabindex="0"]')];
		expect(stops.map((item) => item.getAttribute("data-family"))).toEqual(["Consolas"]);
		await press("ArrowDown");
		expect(document.activeElement).toBe(font("Consolas"));
		await press("ArrowDown");
		expect(document.activeElement).toBe(font("Fira Code"));
		await press("Home");
		expect(document.activeElement).toBe(font("Cascadia Mono"));
		await press("End");
		expect(document.activeElement).toBe(font("Fira Code"));
		(document.activeElement as HTMLElement).click();
		expect(choose).toHaveBeenCalledWith("Fira Code");
	});

	it("has its two tabs as a tablist, with ← and →", async () => {
		mountPicker("Consolas");
		show.value = true;
		await settle();
		el('.font-picker-tab[data-tab="system"]').focus();
		expect(el(".font-picker-tabs").getAttribute("role")).toBe("tablist");
		await press("ArrowRight");
		expect(document.activeElement).toBe(el('.font-picker-tab[data-tab="imported"]'));
		expect(el('.font-picker-tab[data-tab="imported"]').getAttribute("aria-selected")).toBe("true");
		expect(el('.font-picker-tab[data-tab="system"]').getAttribute("tabindex")).toBe("-1");
		await press("ArrowLeft");
		expect(document.activeElement).toBe(el('.font-picker-tab[data-tab="system"]'));
	});

	it("keeps Tab inside", async () => {
		mountPicker("Consolas");
		show.value = true;
		await settle();
		el(".dialog-close").focus();
		const back = await press("Tab", { shiftKey: true });
		expect(back.defaultPrevented).toBe(true);
		expect(el(".font-picker-dialog").contains(document.activeElement)).toBe(true);
	});

	it("draws the keyboard's ring from the theme, on its cards too", () => {
		expect(SOURCE).toMatch(
			/\.font-picker-dialog :deep\(:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--nt-accent\)/,
		);
	});
});
