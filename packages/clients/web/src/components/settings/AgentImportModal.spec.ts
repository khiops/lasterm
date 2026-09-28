/**
 * The agent import dialog from the keyboard (#637). Teleported out of Settings, none of the
 * panel's keys reached it: Esc did nothing, and Tab walked out behind it. It is a modal dialog now:
 * the keyboard goes into it, Esc closes it and gives the keyboard back, and Tab stays inside.
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import AgentImportModal from "./AgentImportModal.vue";
import SOURCE from "./AgentImportModal.vue?raw";

let app: App | null = null;
let root: HTMLElement;
let opener: HTMLButtonElement;
const show = ref(false);

beforeEach(() => {
	setActivePinia(createPinia());
	show.value = false;
	opener = document.createElement("button");
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	app?.unmount();
	app = null;
	root?.remove();
	document.body.replaceChildren();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await nextTick();
}

function mountDialog() {
	const close = vi.fn(() => {
		show.value = false;
	});
	root = document.createElement("div");
	document.body.appendChild(root);
	app = createApp({ render: () => h(AgentImportModal, { show: show.value, onClose: close }) });
	app.use(createPinia());
	app.mount(root);
	return { close };
}

describe("AgentImportModal", () => {
	it("takes the keyboard on open, closes on Esc, and gives the keyboard back", async () => {
		const { close } = mountDialog();
		show.value = true;
		await settle();
		const dialog = document.querySelector(".agent-import-dialog") as HTMLElement;
		expect(dialog.contains(document.activeElement)).toBe(true);
		const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		document.activeElement?.dispatchEvent(esc);
		await settle();
		expect(close).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(opener);
	});

	it("keeps Tab inside", async () => {
		mountDialog();
		show.value = true;
		await settle();
		const dialog = document.querySelector(".agent-import-dialog") as HTMLElement;
		const back = new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		document.activeElement?.dispatchEvent(back);
		await settle();
		expect(back.defaultPrevented).toBe(true);
		expect(dialog.contains(document.activeElement)).toBe(true);
	});

	// They were clickable divs: only the mouse could choose a file.
	it("chooses each file from its drop zone with Enter or Space, as with a click", async () => {
		mountDialog();
		show.value = true;
		await settle();
		const zones = [...document.querySelectorAll<HTMLElement>(".drop-zone")];
		expect(zones).toHaveLength(2);
		for (const zone of zones) {
			expect(zone.getAttribute("role")).toBe("button");
			expect(zone.tabIndex).toBe(0);
			const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
			const opened = vi.spyOn(input, "click").mockImplementation(() => {});
			for (const key of ["Enter", " "]) {
				const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
				zone.dispatchEvent(event);
				expect(event.defaultPrevented, key).toBe(true);
			}
			expect(opened).toHaveBeenCalledTimes(2);
		}
	});

	it("draws the keyboard's ring from the theme", () => {
		expect(SOURCE).toMatch(
			/\.agent-import-dialog :deep\(:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--nt-accent\)/,
		);
	});
});
