/**
 * The key hints of the window's zones (#639): one strip for the rail, the terminal list and the tab
 * bar, which names their keys while the keyboard is in one of them — for the keyboard only, never
 * in a pane, hidden from screen readers, and not at all when Settings › Appearance turns it off.
 * App.vue puts it under the rail and the list (App.spec.ts); Settings has its own
 * (settings/SettingsPanel.spec.ts).
 */
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { useConfigStore } from "../stores/config.js";
import { windowKeyHints } from "../utils/key-hints.js";
import KeyHintStrip from "./KeyHintStrip.vue";

/** The zones as the window marks them, the strip, and a pane with a terminal's input. */
const LAYOUT = `
	<div data-focus-zone="rail">
		<div class="badge" role="button" tabindex="0" data-zone-item></div>
		<button class="rail-footer" type="button">+</button>
	</div>
	<div data-focus-zone="sidebar">
		<div class="channel" tabindex="0" data-zone-item></div>
	</div>
	<div data-focus-zone="tabs" role="tablist">
		<button class="tab" role="tab" tabindex="0" data-zone-item>bash</button>
		<input class="rename" type="text" />
	</div>
	<div data-focus-zone="pane">
		<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>
	</div>
	<button class="outside" type="button">elsewhere</button>
	<div class="strip-host"></div>
`;

let app: App | null = null;
let layout: HTMLElement;

beforeEach(() => {
	const pinia = createPinia();
	setActivePinia(pinia);
	layout = document.createElement("div");
	layout.innerHTML = LAYOUT;
	document.body.appendChild(layout);
	app = createApp({ render: () => h(KeyHintStrip, { resolve: windowKeyHints }) });
	app.use(pinia);
	app.mount(pick(".strip-host"));
});

afterEach(() => {
	app?.unmount();
	app = null;
	document.body.replaceChildren();
});

function pick(selector: string): HTMLElement {
	const found = layout.querySelector<HTMLElement>(selector);
	if (found === null) throw new Error(`nothing matches ${selector}`);
	return found;
}

async function settle(): Promise<void> {
	await nextTick();
	await nextTick();
}

/** The keyboard takes the focus there, as F6 or an arrow would. */
async function reachByKeyboard(selector: string): Promise<void> {
	const target = pick(selector);
	(document.activeElement ?? document.body).dispatchEvent(
		new KeyboardEvent("keydown", { key: "F6", code: "F6", bubbles: true }),
	);
	target.focus();
	await settle();
}

/** A click puts the focus there. */
async function click(selector: string): Promise<void> {
	const target = pick(selector);
	target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	target.focus();
	await settle();
}

function strip(): HTMLElement | null {
	return layout.querySelector<HTMLElement>(".key-hint-strip");
}

/** The hints the strip shows, as they read, or null when it shows none. */
function shownHints(): string | null {
	const shown = strip();
	if (shown === null) return null;
	return [...shown.querySelectorAll(".key-hint")]
		.map((hint) => (hint.textContent ?? "").replace(/\s+/g, " ").trim())
		.join(" · ");
}

describe("the key hints of the window's zones", () => {
	it("name the keys of the rail, the list and the tab bar, on their items", async () => {
		await reachByKeyboard(".badge");
		expect(shownHints()).toBe("←→↑↓ hosts · Enter select · F6 next area");
		await reachByKeyboard(".channel");
		expect(shownHints()).toBe("↑↓ terminals · Enter open · F6 next area");
		await reachByKeyboard(".tab");
		expect(shownHints()).toBe("←→ tabs · Enter open · Delete close · F6 next area");
	});

	it("name F6 alone on another control of a zone", async () => {
		await reachByKeyboard(".rail-footer");
		expect(shownHints()).toBe("F6 next area");
	});

	// Never over a terminal: its keys are its program's.
	it("show nothing in a pane, in a text field, or outside the zones", async () => {
		await reachByKeyboard(".xterm-helper-textarea");
		expect(strip()).toBeNull();
		await reachByKeyboard(".rename");
		expect(strip()).toBeNull();
		await reachByKeyboard(".outside");
		expect(strip()).toBeNull();
	});

	it("show nothing for a click, and come back with a key", async () => {
		await click(".tab");
		expect(strip()).toBeNull();
		await reachByKeyboard(".tab");
		expect(shownHints()).toBe("←→ tabs · Enter open · Delete close · F6 next area");
		await click(".badge");
		expect(strip()).toBeNull();
	});

	it("leave the keyboard's place when it leaves the zone", async () => {
		await reachByKeyboard(".badge");
		expect(strip()).not.toBeNull();
		pick(".badge").blur();
		await settle();
		expect(strip()).toBeNull();
	});

	// A modifier may go with a click: pressing it alone is no use of the keyboard.
	it("do not take a modifier pressed alone for the keyboard", async () => {
		await click(".badge");
		pick(".badge").dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
		await settle();
		expect(strip()).toBeNull();
	});

	it("are hidden from screen readers, which name each control themselves", async () => {
		await reachByKeyboard(".badge");
		expect(strip()?.getAttribute("aria-hidden")).toBe("true");
	});

	it("show nothing when Settings › Appearance turns them off", async () => {
		const configStore = useConfigStore();
		configStore.uiConfig = { onChannelDead: "readonly", keyboard: { keyHints: false } };
		await reachByKeyboard(".badge");
		expect(strip()).toBeNull();
		configStore.uiConfig = { onChannelDead: "readonly", keyboard: { keyHints: true } };
		await settle();
		expect(shownHints()).toBe("←→↑↓ hosts · Enter select · F6 next area");
	});
});
