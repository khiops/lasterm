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

afterEach(() => {
	unmountWindow();
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
