/**
 * The window, mounted whole as in App.spec.ts, where happy-dom cannot answer: where things sit,
 * and what a real click does with the keyboard (#936). The same harness (App.fixture.ts), in a
 * browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

vi.mock("./services/ws-client.js", () =>
	import("./App.doubles.fixture.js").then((m) => m.wsClientModule),
);
vi.mock("@xterm/xterm", () => import("./App.doubles.fixture.js").then((m) => m.xtermModule));
vi.mock("@xterm/addon-fit", () => import("./App.doubles.fixture.js").then((m) => m.fitAddonModule));
vi.mock("@xterm/addon-unicode11", () =>
	import("./App.doubles.fixture.js").then((m) => m.unicodeAddonModule),
);
vi.mock("@xterm/addon-search", () =>
	import("./App.doubles.fixture.js").then((m) => m.searchAddonModule),
);
vi.mock("./composables/terminal-font.js", () => ({ awaitTerminalFont: () => Promise.resolve() }));
vi.mock("./composables/useBellSound.js", () => ({ playBellSound: vi.fn() }));

import "./styles/base.css";
import type { ChannelRow } from "./App.doubles.fixture.js";
import {
	click,
	dialogs,
	focusPane,
	HOST_A,
	mountWindow,
	mouseDown,
	pane,
	paneWithKeyboard,
	press,
	runPaletteRow,
	settle,
	split,
	term,
	unmountWindow,
} from "./App.fixture.js";

const live = (id: string, writer?: string): ChannelRow => ({
	id,
	hostId: HOST_A,
	status: "live",
	title: id,
	...(writer !== undefined && { writer }),
});

/** A box's place and size, as numbers `toEqual` compares. */
const placeOf = (rect: DOMRect): number[] => [rect.x, rect.y, rect.width, rect.height];

const box = (selector: string): DOMRect => {
	const el = document.querySelector(selector);
	if (el === null) throw new Error(`no ${selector}`);
	return el.getBoundingClientRect();
};

beforeEach(async () => {
	await page.viewport(1400, 900);
});

afterEach(async () => {
	await unmountWindow();
	vi.restoreAllMocks();
});

// The strip for the rail, the list and the tab bar (#639): the terminals take both rows, so the
// strip coming and going never resizes one, and it is never drawn over one.
describe("the key hints of the window's zones", () => {
	it("sit under the rail and the list, never over a terminal", async () => {
		await mountWindow({
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		focusPane("P1");
		const before = box(".terminal-main");

		await press("F6", { ctrl: true });

		const strip = box(".zone-key-hints");
		const rail = box(".app-layout > .host-rail");
		const list = box(".app-layout > .channel-sidebar");
		const main = box(".terminal-main");
		expect(strip.height).toBeGreaterThan(0);
		// Its row is as tall as its line, no taller.
		expect(strip.height).toBe(box(".zone-key-hints .key-hint-strip__line").height);
		expect(placeOf(main)).toEqual(placeOf(before));
		expect(strip.top).toBeGreaterThanOrEqual(rail.bottom);
		expect(strip.top).toBeGreaterThanOrEqual(list.bottom);
		expect(strip.left).toBe(rail.left);
		expect(strip.right).toBe(list.right);
		expect(strip.right).toBeLessThanOrEqual(main.left);
		expect(strip.bottom).toBe(main.bottom);
	});
});

// The window's own panel docks, narrowing every pane of the tab; the writer's panel a reader only
// follows floats over that terminal's pane, below its header, and resizes nothing (#838,
// utils/files-panel.spec.ts, stores/files-panel-sharing.spec.ts).
describe("the files panel's form", () => {
	const ON = { experimental: { fileTransfer: true } };

	it("docks the window's own panel beside the panes, which it narrows", async () => {
		await mountWindow({
			channels: [live("T1")],
			ui: ON,
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		const area = box(".pane-area").width;
		focusPane("P1");

		await press("E", { ctrl: true, shift: true });

		expect(document.querySelector(".files-panel--docked")).not.toBeNull();
		expect(document.querySelector(".files-resize-handle")).not.toBeNull();
		expect(box(".pane-area").width).toBeCloseTo(area - 300, 0);
	});

	// T1, which another window writes, in the middle column of three, above P4.
	it("floats the writer's panel a reader follows over that terminal's pane, and resizes nothing", async () => {
		const { hub } = await mountWindow({
			channels: [live("T2"), live("T1", "client-other"), live("T4"), live("T3")],
			ui: ON,
			layout: {
				tabs: [
					{
						id: "TAB1",
						root: split(
							"vertical",
							term("T2", "P1"),
							split(
								"vertical",
								split("horizontal", term("T1", "P2"), term("T4", "P4")),
								term("T3", "P3"),
							),
							0.33,
						),
						activePane: "P2",
					},
				],
			},
		});
		const area = box(".pane-area").width;
		focusPane("P2");

		hub.hear({ type: "FILES_PANEL", channelId: "T1", open: true });
		await settle();

		const panel = box("#files-panel");
		const followed = pane("P2")?.querySelector(".terminal-pane")?.getBoundingClientRect();
		const header = pane("P2")?.querySelector(".pane-header")?.getBoundingClientRect();
		expect(document.querySelector(".files-panel--overlay")).not.toBeNull();
		expect(document.querySelector(".files-resize-handle")).toBeNull();
		expect(box(".pane-area").width).toBe(area);
		expect(panel.left).toBeGreaterThanOrEqual(followed?.left ?? Number.NaN);
		expect(panel.right).toBeLessThanOrEqual(followed?.right ?? Number.NaN);
		expect(panel.top).toBeGreaterThanOrEqual(header?.bottom ?? Number.NaN);
		expect(panel.bottom).toBeLessThanOrEqual(followed?.bottom ?? Number.NaN);
		expect(panel.width).toBeGreaterThan(0);
		expect(panel.height).toBeGreaterThan(0);
	});

	// Only a docked panel has an edge to drag; its width is `[layout] transfer_panel_width`.
	it("keeps the width its edge is dragged to", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1")],
			ui: ON,
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		const area = box(".pane-area").width;
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		const edge = document.querySelector(".files-resize-handle");
		const x = box(".files-resize-handle").left;

		edge?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x }));
		document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x - 40 }));
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x - 40 }));
		await settle();

		const saved = hub.calls("PUT", "/api/config/ui").map((call) => call.body);
		expect(saved).toEqual([{ layout: { transferPanelWidth: 340 } }]);
		expect(box("#files-panel").width).toBe(340);
		expect(box(".pane-area").width).toBeCloseTo(area - 340, 0);
	});

	it("opens at the width it was left at", async () => {
		await mountWindow({
			channels: [live("T1")],
			ui: { ...ON, layout: { transferPanelWidth: 340 } },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		const area = box(".pane-area").width;
		focusPane("P1");

		await press("E", { ctrl: true, shift: true });

		expect(box("#files-panel").width).toBe(340);
		expect(box(".pane-area").width).toBeCloseTo(area - 340, 0);
	});

	// #1208: no fixed 520 px; the widest is half of what the panes and the panel share.
	it("is dragged past 520 px, up to half of the area", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1")],
			ui: ON,
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		const body = box(".terminal-body").width;
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		const x = box(".files-resize-handle").left;

		document
			.querySelector(".files-resize-handle")
			?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x }));
		document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x - 2000 }));
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x - 2000 }));
		await settle();

		const widest = Math.floor(body / 2);
		expect(widest).toBeGreaterThan(520);
		expect(box("#files-panel").width).toBe(widest);
		expect(hub.calls("PUT", "/api/config/ui").map((call) => call.body)).toEqual([
			{ layout: { transferPanelWidth: widest } },
		]);
		expect(document.querySelector(".files-resize-handle")?.getAttribute("aria-valuemax")).toBe(
			String(widest),
		);
	});

	it("moves by 16 px on the arrows from the width it shows, never past the widest", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1")],
			ui: { ...ON, layout: { transferPanelWidth: 1000 } },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		const widest = Math.floor(box(".terminal-body").width / 2);
		const edge = document.querySelector<HTMLElement>(".files-resize-handle");

		// The panel shows `widest`, not the 1000 it was saved at: one step starts from what shows.
		await press("ArrowRight", {}, edge);
		await settle();
		expect(box("#files-panel").width).toBe(widest - 16);

		await press("ArrowLeft", {}, edge);
		await press("ArrowLeft", {}, edge);
		await settle();
		expect(box("#files-panel").width).toBe(widest);
		expect(hub.calls("PUT", "/api/config/ui").map((call) => call.body)).toEqual([
			{ layout: { transferPanelWidth: widest - 16 } },
			{ layout: { transferPanelWidth: widest } },
			{ layout: { transferPanelWidth: widest } },
		]);
	});

	it("clamps a saved width over the widest, and gives it back when the window grows", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1")],
			ui: { ...ON, layout: { transferPanelWidth: 1000 } },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		expect(box("#files-panel").width).toBe(Math.floor(box(".terminal-body").width / 2));

		await page.viewport(2600, 900);
		await vi.waitFor(() => expect(box("#files-panel").width).toBe(1000));
		expect(hub.calls("PUT", "/api/config/ui")).toEqual([]);
	});
});

// #1208: the panel fills the tab, in place of the panes, which keep running and keep their size.
describe("maximizing the files panel", () => {
	const ON = { experimental: { fileTransfer: true } };

	const open = async () => {
		const mounted = await mountWindow({
			channels: [live("T1")],
			ui: ON,
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		return mounted;
	};
	const maximizeButton = () =>
		document.querySelector<HTMLElement>('#files-panel [aria-label="Maximize the files panel"]');
	const maximize = async () => {
		const button = maximizeButton();
		if (button === null) throw new Error("no Maximize button");
		button.click();
		await settle(4);
	};

	it("fills the tab over the panes, which keep their place and size", async () => {
		await open();
		const terminal = pane("P1");
		const before = placeOf(box(".pane-area"));

		await maximize();

		expect(placeOf(box("#files-panel"))).toEqual(placeOf(box(".terminal-body")));
		expect(placeOf(box(".pane-area"))).toEqual(before);
		expect(pane("P1")).toBe(terminal);
		expect(document.querySelector(".pane-area")?.hasAttribute("inert")).toBe(true);
		expect(document.querySelector('#files-panel [aria-label="Restore the panes"]')).not.toBeNull();
	});

	it("brings the panes back at the width the panel had, on its button", async () => {
		await open();
		await maximize();

		document.querySelector<HTMLElement>('#files-panel [aria-label="Restore the panes"]')?.click();
		await settle(4);

		expect(box("#files-panel").width).toBe(300);
		expect(document.querySelector(".pane-area")?.hasAttribute("inert")).toBe(false);
		expect(maximizeButton()).not.toBeNull();
	});

	it("brings the panes back on Escape, the keyboard in the pane", async () => {
		await open();
		await maximize();

		await press("Escape");
		await settle(4);

		expect(box("#files-panel").width).toBe(300);
		expect(paneWithKeyboard()).toBe("P1");
	});

	it("keeps Escape for a text field, a question, a dialog and a modified press", async () => {
		await open();
		await maximize();
		const panel = document.querySelector("#files-panel") as HTMLElement;
		const field = Object.assign(document.createElement("input"), { type: "text" });
		const question = document.createElement("div");
		question.setAttribute("data-own-escape", "");
		question.tabIndex = 0;
		const dialog = document.createElement("div");
		dialog.setAttribute("aria-modal", "true");
		dialog.tabIndex = 0;
		panel.append(field, question, dialog);
		try {
			for (const target of [field, question, dialog]) {
				target.focus();
				await press("Escape");
				await settle(2);
				expect(document.querySelector(".pane-area")?.hasAttribute("inert")).toBe(true);
			}
			await press("Escape", { shift: true });
			await settle(2);
			expect(document.querySelector(".pane-area")?.hasAttribute("inert")).toBe(true);
		} finally {
			field.remove();
			question.remove();
			dialog.remove();
		}
	});

	it("fills the tab from a floating panel too", async () => {
		await page.viewport(900, 800);
		await open();
		expect(document.querySelector(".files-panel--overlay")).not.toBeNull();

		await maximize();

		expect(placeOf(box("#files-panel"))).toEqual(placeOf(box(".terminal-body")));
	});

	it("lets go of the maximized state when the window shrinks to a sheet", async () => {
		await open();
		await maximize();

		await page.viewport(500, 800);
		// A maximized panel is drawn as a sheet already: it is the window's shrinking that must be
		// seen, which lets go of the maximized state, before the window grows back.
		await vi.waitFor(
			() => {
				expect(document.querySelector(".files-panel--sheet")).not.toBeNull();
				expect(document.querySelector(".files-panel--maximized")).toBeNull();
			},
			{ timeout: 5000 },
		);
		await page.viewport(1400, 900);

		await vi.waitFor(() => expect(document.querySelector(".files-panel--docked")).not.toBeNull(), {
			timeout: 5000,
		});
		expect(document.querySelector(".pane-area")?.hasAttribute("inert")).toBe(false);
		expect(box("#files-panel").width).toBe(300);
	});

	it("is not kept: a panel closed while maximized opens docked again", async () => {
		const { hub } = await open();
		await maximize();
		document
			.querySelector<HTMLElement>('#files-panel [aria-label="Close the files panel"]')
			?.click();
		await settle(4);

		focusPane("P1");
		await press("E", { ctrl: true, shift: true });

		expect(box("#files-panel").width).toBe(300);
		expect(hub.calls("PUT", "/api/config/ui")).toEqual([]);
	});
});

// Opened from the palette, Settings has nowhere to give the keyboard back to: the keyboard goes to
// the pane, once the panel has left the page, whichever way it closes (#637, #940). happy-dom runs
// no leave transition, so only a browser keeps the panel's focused control past the close.
describe("closing Settings opened from the palette", () => {
	// Two panes, so that the pane given the keyboard is the one that had it, not the first.
	const twoPanes = () =>
		mountWindow({
			channels: [live("T1"), live("T2")],
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
	// As a click in the pane does: the pane becomes the tab's active one, its terminal takes the keys.
	const clickPane = async (paneId: string) => {
		await mouseDown(pane(paneId)?.querySelector(".terminal-pane"));
		focusPane(paneId);
	};

	const closings: Record<string, () => Promise<unknown>> = {
		"its ×": () => click("Close settings panel"),
		Esc: () => press("Escape"),
		"Ctrl+,": () => press(",", { ctrl: true }),
	};

	for (const [way, close] of Object.entries(closings)) {
		it(`gives the keyboard to the pane on ${way}`, async () => {
			await twoPanes();
			await clickPane("P2");
			await runPaletteRow("Settings");
			expect(dialogs()).toEqual(["Settings"]);
			expect(document.activeElement?.closest(".settings-panel")).not.toBeNull();

			await close();

			await vi.waitFor(() => expect(document.querySelector(".settings-panel")).toBeNull());
			expect(paneWithKeyboard()).toBe("P2");
		});
	}
});

// Opened from a control of the window, Settings gives the keyboard back to it, not to the pane.
describe("closing Settings opened from a control", () => {
	it("gives the keyboard back to the rail's gear Settings was opened from", async () => {
		await mountWindow({
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		const gear = document.querySelector<HTMLElement>('[aria-label="Open settings panel"]');
		gear?.focus();
		gear?.click();
		await settle();
		expect(dialogs()).toEqual(["Settings"]);

		await press("Escape");

		await vi.waitFor(() => expect(document.querySelector(".settings-panel")).toBeNull());
		expect(document.activeElement).toBe(gear);
	});
});
