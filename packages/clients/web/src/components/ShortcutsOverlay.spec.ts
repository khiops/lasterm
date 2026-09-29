/**
 * The keyboard shortcuts overlay (#639): every action of the shortcut table, grouped, with the keys
 * inside each area, a search field that filters them, and a modal dialog's keyboard — it goes in
 * on the search field, Esc closes, Tab stays inside, and it comes back where it was.
 *
 * Ctrl+/ and the palette's row reach it through App.vue (App.spec.ts), its chord is the table's
 * (utils/app-shortcuts.spec.ts), and the palette's row is tested in useCommandPalette.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, nextTick } from "vue";
import { useShortcutsOverlay } from "../composables/useShortcutsOverlay.js";
import {
	APP_SHORTCUT_NAMES,
	APP_SHORTCUTS,
	type AppActionId,
	shortcutKeys,
} from "../utils/app-shortcuts.js";
import ShortcutsOverlay from "./ShortcutsOverlay.vue";

let app: App | null = null;
let opener: HTMLButtonElement;
const overlay = useShortcutsOverlay();

beforeEach(() => {
	overlay.close();
	// Where the keyboard was: a terminal, say.
	opener = document.createElement("button");
	opener.className = "opener";
	document.body.appendChild(opener);
	opener.focus();
	const root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp(ShortcutsOverlay);
	app.mount(root);
});

afterEach(() => {
	overlay.close();
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await nextTick();
}

async function openOverlay(): Promise<void> {
	overlay.open();
	await settle();
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

async function search(text: string): Promise<void> {
	const field = el(".shortcuts-search-input") as HTMLInputElement;
	field.value = text;
	field.dispatchEvent(new Event("input", { bubbles: true }));
	await settle();
}

const listedIds = (): string[] =>
	[...document.querySelectorAll("[data-shortcut-id]")].map(
		(row) => row.getAttribute("data-shortcut-id") ?? "",
	);

const groupNames = (): string[] =>
	[...document.querySelectorAll(".shortcuts-group-title")].map((title) => title.textContent ?? "");

describe("the keyboard shortcuts overlay", () => {
	it("is a modal dialog, shown only while open", async () => {
		expect(document.querySelector(".shortcuts-dialog")).toBeNull();
		await openOverlay();
		const dialog = el(".shortcuts-dialog");
		expect(dialog.getAttribute("role")).toBe("dialog");
		expect(dialog.getAttribute("aria-modal")).toBe("true");
		expect(el(`#${dialog.getAttribute("aria-labelledby")}`).textContent).toBe("Keyboard shortcuts");
	});

	it("lists every action of the table, with its name and its chord", async () => {
		await openOverlay();
		const ids = Object.keys(APP_SHORTCUTS) as AppActionId[];
		expect(new Set(listedIds())).toEqual(new Set(ids));
		expect(listedIds()).toHaveLength(ids.length);
		for (const id of ids) {
			const row = el(`[data-shortcut-id="${id}"]`);
			expect(row.querySelector(".shortcuts-name")?.textContent, id).toBe(APP_SHORTCUT_NAMES[id]);
			const caps = [...row.querySelectorAll(".shortcuts-keys > .shortcuts-cap")].map(
				(cap) => cap.textContent,
			);
			expect(caps, id).toEqual(shortcutKeys(id));
		}
		// F6 outside a terminal, beside Ctrl+F6.
		const alias = el('[data-shortcut-id="zone.next"] .shortcuts-alias').textContent ?? "";
		expect(alias.replace(/\s+/g, " ").trim()).toBe("(F6 outside a terminal)");
	});

	it("groups them General, Tabs, Panes, Areas and Settings, with the keys inside each area", async () => {
		await openOverlay();
		expect(groupNames()).toEqual(["General", "Tabs", "Panes", "Areas", "Settings"]);
		// Each place and its keys, as its strip names them.
		const places = [...document.querySelectorAll(".shortcuts-row")].flatMap((row) => {
			const hints = [...row.querySelectorAll(".key-hint")].map((hint) =>
				(hint.textContent ?? "").replace(/\s+/g, " ").trim(),
			);
			const name = row.querySelector(".shortcuts-name")?.textContent ?? "";
			return hints.length === 0 ? [] : [`${name}: ${hints.join(" · ")}`];
		});
		expect(places).toContain("Host rail: ←→↑↓ hosts · Enter select · F6 next area");
		expect(places).toContain("Tab bar: ←→ tabs · Enter open · Delete close · F6 next area");
		expect(places).toContain("Terminal list: ↑↓ terminals · Enter open · F6 next area");
		expect(places).toContain("Switch: Space toggle · Esc back to the menu");
		expect(places).toContain("Menu: ↑↓ categories · → or Enter open · Esc close");
	});

	it("starts on its search field, which filters the list", async () => {
		await openOverlay();
		expect(document.activeElement).toBe(el(".shortcuts-search-input"));
		await search("split");
		expect(listedIds()).toEqual(["pane.splitRight", "pane.splitDown"]);
		expect(groupNames()).toEqual(["Panes"]);
		await search("F6");
		expect(listedIds()).toEqual(["zone.next", "zone.previous"]);
		expect(groupNames()).toEqual(["Areas"]);
		await search("no such key");
		expect(listedIds()).toEqual([]);
		expect(el(".shortcuts-empty").textContent).toContain("no such key");
	});

	it("starts again from the whole list each time it opens", async () => {
		await openOverlay();
		await search("split");
		overlay.close();
		await settle();
		await openOverlay();
		expect((el(".shortcuts-search-input") as HTMLInputElement).value).toBe("");
		expect(listedIds()).toHaveLength(Object.keys(APP_SHORTCUTS).length);
	});

	it("closes on Esc, and gives the keyboard back where it was", async () => {
		await openOverlay();
		const esc = await press("Escape");
		expect(esc.defaultPrevented).toBe(true);
		expect(overlay.isOpen.value).toBe(false);
		expect(document.querySelector(".shortcuts-dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});

	it("closes on its close button and on a click beside it, the keyboard back where it was", async () => {
		await openOverlay();
		el(".shortcuts-close").click();
		await settle();
		expect(overlay.isOpen.value).toBe(false);
		expect(document.activeElement).toBe(opener);
		await openOverlay();
		el(".shortcuts-overlay").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		await settle();
		expect(overlay.isOpen.value).toBe(false);
	});

	it("keeps Tab inside", async () => {
		await openOverlay();
		// The close button, the search field and the list, which the keyboard can scroll.
		el(".shortcuts-list").focus();
		await press("Tab");
		expect(document.activeElement).toBe(el(".shortcuts-close"));
		await press("Tab", { shiftKey: true });
		expect(document.activeElement).toBe(el(".shortcuts-list"));
	});
});
