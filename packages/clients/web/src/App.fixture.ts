/**
 * Test-only: the whole window, mounted (#936). `App.vue` with a real Pinia, against the hub of
 * `App.doubles.fixture.ts`, after the layout a reload would find; a spec drives it with the keys
 * and clicks a user gives it, and reads what the user and the hub see.
 *
 * The spec that uses it mocks, as `App.spec.ts` does, `services/ws-client.js`, `@xterm/xterm`
 * and its addons, `composables/terminal-font.js` and `composables/useBellSound.js`.
 */
import { createPinia, setActivePinia } from "pinia";
import { expect, vi } from "vitest";
import { createApp, h, nextTick, type App as VueApp } from "vue";
import {
	type ChannelRow,
	type FakeHub,
	type HostGroupRow,
	type HostRow,
	startHub,
} from "./App.doubles.fixture.js";
import App from "./App.vue";
import { useCommandPalette } from "./composables/useCommandPalette.js";
import { useShortcutsOverlay } from "./composables/useShortcutsOverlay.js";
import { useAuthStore } from "./stores/auth.js";
import { useThemeStore } from "./stores/theme.js";

export const HOST_A = "01HZZZZZZZZZZZZZZZZZZZZHA1";
export const HOST_B = "01HZZZZZZZZZZZZZZZZZZZZHB2";

/** A pane of a layout, as `useLayout` keeps it. */
export type PaneNode =
	| { type: "terminal"; channelId: string; paneId: string }
	| { type: "vacant"; id: string }
	| {
			type: "split";
			direction: "horizontal" | "vertical";
			ratio: number;
			first: PaneNode;
			second: PaneNode;
	  };

export const term = (channelId: string, paneId: string): PaneNode => ({
	type: "terminal",
	channelId,
	paneId,
});
export const vacant = (id: string): PaneNode => ({ type: "vacant", id });
/** Side by side ("vertical", a divider standing up) or one above the other ("horizontal"). */
export const split = (
	direction: "horizontal" | "vertical",
	first: PaneNode,
	second: PaneNode,
	ratio = 0.5,
): PaneNode => ({ type: "split", direction, ratio, first, second });

/** The tabs a reload finds, each with its panes; the first tab shown unless `active` says. */
export interface LayoutSetup {
	tabs: Array<{ id: string; root: PaneNode; activePane?: string }>;
	active?: number;
}

export interface WindowSetup {
	hosts?: HostRow[];
	hostGroups?: HostGroupRow[];
	channels?: ChannelRow[];
	/** `[ui]` settings the hub holds, over `onChannelDead = "readonly"`. */
	ui?: Record<string, unknown>;
	layout?: LayoutSetup;
	/** What this browser kept from before, in `localStorage`. */
	storage?: Record<string, string>;
}

export interface MountedWindow {
	hub: FakeHub;
	root: HTMLElement;
}

let app: VueApp | null = null;
let root: HTMLElement | null = null;

/** Let promises and watchers run. */
export async function settle(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await nextTick();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * Mount the window against a new hub holding `setup`, once it has loaded what it loads at start.
 * Host A, local, is the only host unless `hosts` says otherwise.
 */
export async function mountWindow(setup: WindowSetup = {}): Promise<MountedWindow> {
	localStorage.clear();
	sessionStorage.clear();
	const hub = startHub();
	hub.hosts = setup.hosts ?? [{ id: HOST_A, label: "alpha", type: "local" }];
	hub.hostGroups = setup.hostGroups ?? [];
	hub.channels = setup.channels ?? [];
	hub.ui = { onChannelDead: "readonly", ...(setup.ui ?? {}) };
	vi.spyOn(globalThis, "fetch").mockImplementation(hub.fetch);
	if (setup.layout !== undefined) {
		const { tabs, active = 0 } = setup.layout;
		localStorage.setItem(
			"lasterm:layout",
			JSON.stringify({
				tabs: tabs.map((tab) => ({ id: tab.id })),
				activeTabIndex: active,
				layouts: Object.fromEntries(tabs.map((tab) => [tab.id, tab.root])),
				activePaneIds: Object.fromEntries(
					tabs.flatMap((tab) => (tab.activePane === undefined ? [] : [[tab.id, tab.activePane]])),
				),
			}),
		);
	}
	for (const [key, value] of Object.entries(setup.storage ?? {})) localStorage.setItem(key, value);
	localStorage.setItem("lasterm_token", "a".repeat(64));

	const pinia = createPinia();
	setActivePinia(pinia);
	useThemeStore().initialize();
	expect(useAuthStore().token).not.toBeNull();
	root = document.createElement("div");
	root.id = "app";
	document.body.appendChild(root);
	app = createApp({ render: () => h(App) });
	app.use(pinia);
	app.mount(root);
	await vi.waitFor(() => {
		if (root?.querySelector(".app-layout") === null) throw new Error("the window is not ready");
	});
	await settle();
	return { hub, root };
}

/** Unmount the window, and close what stays open from one window to the next. */
export function unmountWindow(): void {
	useCommandPalette().close();
	useShortcutsOverlay().close();
	app?.unmount();
	app = null;
	root?.remove();
	root = null;
	document.body.replaceChildren();
	(document.activeElement as HTMLElement | null)?.blur?.();
}

/** Press a key where the keyboard is (or on `target`), as a keydown the page can stop. */
export async function press(
	key: string,
	mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; code?: string } = {},
	target: Element | null = document.activeElement,
): Promise<KeyboardEvent> {
	const event = new KeyboardEvent("keydown", {
		key,
		code: mods.code ?? "",
		ctrlKey: mods.ctrl === true,
		altKey: mods.alt === true,
		shiftKey: mods.shift === true,
		bubbles: true,
		cancelable: true,
	});
	// happy-dom reports AltGr for any Alt; a browser reports it only for AltGr itself.
	Object.defineProperty(event, "getModifierState", {
		value: (name: string) =>
			({ Alt: event.altKey, Control: event.ctrlKey, Shift: event.shiftKey })[name] ?? false,
	});
	(target ?? document.body).dispatchEvent(event);
	await settle(4);
	return event;
}

/** The element of a pane, by its id. */
export function pane(paneId: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`.pane-area [data-pane-id="${paneId}"]`);
}

/** The ids of the panes the tab shown holds, in order. */
export function panesShown(): string[] {
	const shown = [...document.querySelectorAll<HTMLElement>(".pane-tab-container")].filter(
		(tab) => tab.style.display !== "none",
	);
	return shown.flatMap((tab) =>
		[...tab.querySelectorAll<HTMLElement>("[data-pane-id]")].map(
			(el) => el.getAttribute("data-pane-id") ?? "",
		),
	);
}

/** Give a terminal pane the keyboard, as a click in it would: its terminal's input. */
export function focusPane(paneId: string): HTMLElement {
	const input = pane(paneId)?.querySelector<HTMLElement>(".xterm-helper-textarea");
	if (input === null || input === undefined) throw new Error(`no terminal in pane ${paneId}`);
	input.focus();
	return input;
}

/** The pane the keyboard is in, or null. */
export function paneWithKeyboard(): string | null {
	return document.activeElement?.closest("[data-pane-id]")?.getAttribute("data-pane-id") ?? null;
}

/** The tab bar's tabs, by label, and which is selected. */
export function tabs(): Array<{ label: string; selected: boolean }> {
	return [...document.querySelectorAll<HTMLElement>('.tab-bar [role="tab"]')].map((tab) => ({
		label: tab.querySelector(".tab__label")?.textContent?.trim() ?? "",
		selected: tab.getAttribute("aria-selected") === "true",
	}));
}

/** A button, by its text or its label. */
export function button(name: string, within: ParentNode = document): HTMLElement | undefined {
	return [...within.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
		(el) => el.textContent?.trim() === name || el.getAttribute("aria-label") === name,
	);
}

/** Click what `button` finds, and let the window answer. */
export async function click(name: string, within: ParentNode = document): Promise<void> {
	const el = button(name, within);
	if (el === undefined) throw new Error(`no button "${name}"`);
	el.click();
	await settle(4);
}

/** The modal dialogs open, by their label. */
export function dialogs(): string[] {
	return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].map(
		(el) => el.getAttribute("aria-label") ?? el.querySelector("h2, h3")?.textContent?.trim() ?? "",
	);
}

/** Right-click an element, as a user opening its menu does. */
export async function rightClick(el: Element | null | undefined): Promise<void> {
	if (el === null || el === undefined) throw new Error("nothing to right-click");
	el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	await settle(4);
}

/** Press the mouse on an element, as a click in a pane does before its terminal takes the keys. */
export async function mouseDown(el: Element | null | undefined): Promise<void> {
	if (el === null || el === undefined) throw new Error("nothing to press on");
	el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	await settle(4);
}

/** Whether the window asks a question (ConfirmDialog). */
export function asking(): boolean {
	return document.querySelector(".confirm-dialog") !== null;
}

/** Open the command palette with its chord and run the row with this label. */
export async function runPaletteRow(label: string): Promise<void> {
	await press("P", { ctrl: true, shift: true });
	const row = [...document.querySelectorAll<HTMLElement>(".palette-item")].find(
		(item) =>
			(
				item.querySelector(".palette-item-label") ?? item.querySelector(".host-pick-row__label")
			)?.textContent?.trim() === label,
	);
	if (row === undefined) throw new Error(`no palette row "${label}"`);
	row.click();
	await settle();
}

/**
 * The split holding a pane: which way it divides, and what its two halves hold, each a list of
 * pane ids, "empty" for an empty pane.
 */
export function splitAround(paneId: string): { direction: string; halves: string[][] } | null {
	const leaf = pane(paneId)?.closest(".pane-layout--terminal");
	const holder = leaf?.parentElement?.closest(".pane-layout--split");
	if (holder === null || holder === undefined) return null;
	const halves = [...holder.children].filter((child) => child.classList.contains("pane-layout"));
	return {
		direction: holder.classList.contains("pane-layout--split-vertical") ? "vertical" : "horizontal",
		halves: halves.map((half) =>
			[...half.querySelectorAll("[data-pane-id]")].map((el) =>
				el.querySelector(".vacant-pane") !== null
					? "empty"
					: (el.getAttribute("data-pane-id") ?? ""),
			),
		),
	};
}

/** The share of its split the half holding a pane takes, in percent. */
export function shareOf(paneId: string): number {
	const leaf = pane(paneId)?.closest<HTMLElement>(".pane-layout--terminal");
	if (leaf === null || leaf === undefined) throw new Error(`no pane ${paneId}`);
	return Number.parseFloat(leaf.style.flexBasis);
}
