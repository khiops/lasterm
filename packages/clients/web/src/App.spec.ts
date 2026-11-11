/**
 * The window, mounted whole (App.fixture.ts) against a hub the test answers, and driven as a user
 * drives it: keys on the window, clicks on what it draws, frames from the hub. What each part
 * decides on its own is tested beside it (utils/*.spec.ts, components/*.spec.ts); here, that the
 * window wires them together (#936).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { type ChannelRow, type FakeHub, type HostRow, json } from "./App.doubles.fixture.js";
import {
	asking,
	click,
	dialogs,
	focusPane,
	HOST_A,
	HOST_B,
	mountWindow,
	mouseDown,
	pane,
	panesShown,
	paneWithKeyboard,
	press,
	rightClick,
	runPaletteRow,
	settle,
	shareOf,
	split,
	splitAround,
	tabs,
	term,
	unmountWindow,
	vacant,
} from "./App.fixture.js";
import { APP_SHORTCUTS, type AppActionId } from "./utils/app-shortcuts.js";
import { CONFIRMATIONS } from "./utils/confirmations.js";

const live = (id: string, hostId = HOST_A): ChannelRow => ({
	id,
	hostId,
	status: "live",
	title: id,
});
const ended = (id: string, hostId = HOST_A): ChannelRow => ({
	id,
	hostId,
	status: "dead",
	title: id,
});
const ALPHA: HostRow = { id: HOST_A, label: "alpha", type: "local" };
const BRAVO: HostRow = { id: HOST_B, label: "bravo", type: "ssh", sort_order: 1, connected: true };
/** Bravo with no session yet, as in a window just opened: its first SPAWN connects it. */
const BRAVO_AWAY: HostRow = { id: HOST_B, label: "bravo", type: "ssh", sort_order: 1 };

/** The DELETEs the window sent for terminals, by id. */
function deleted(hub: { rest: Array<{ method: string; path: string }> }): string[] {
	return hub.rest
		.filter((c) => c.method === "DELETE" && c.path.startsWith("/api/channels/"))
		.map((c) => c.path.slice("/api/channels/".length));
}

/** What the window sent a terminal's program, one INPUT frame an entry, decoded. */
function typed(hub: FakeHub, channelId: string): string[] {
	return hub
		.frames("INPUT")
		.filter((frame) => frame.channelId === channelId)
		.map((frame) => new TextDecoder().decode(frame.data as Uint8Array));
}

/** Whether the sidebar lists a terminal. */
function listed(channelId: string): boolean {
	return document.querySelector(`.channel-sidebar [data-channel-id="${channelId}"]`) !== null;
}

/** The ended terminal's card in a pane, once the hub said it ended. */
async function cardIn(paneId: string): Promise<HTMLElement> {
	await vi.waitFor(() => {
		if (pane(paneId)?.querySelector(".exit-card") == null) throw new Error(`no card in ${paneId}`);
	});
	return pane(paneId)?.querySelector<HTMLElement>(".exit-card") as HTMLElement;
}

afterEach(() => {
	unmountWindow();
	vi.restoreAllMocks();
});

// "Delete this dead terminal?" is no longer asked: the overlay's options, and the setting, answer
// it (#574). What keeping or deleting means is tested in utils/exit-action.spec.ts.
describe("closing an ended terminal asks nothing", () => {
	// The card closes the pane at once, without a question, and deletes the terminal.
	it("closes an ended terminal's pane from its card at once, and deletes the terminal", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1"), ended("T2")],
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
		const card = await cardIn("P2");

		await click("Close", card);

		expect(asking()).toBe(false);
		expect(panesShown()).toEqual(["P1"]);
		await vi.waitFor(() => expect(deleted(hub)).toEqual(["T2"]));
	});

	// The overlay says whether to keep it, as "Keep ended terminals in the sidebar" says.
	it("keeps an ended terminal listed when its card closes it and the setting keeps them", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1"), ended("T2")],
			ui: { panes: { keepEnded: true } },
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
		const card = await cardIn("P2");

		await click("Close", card);

		expect(panesShown()).toEqual(["P1"]);
		expect(deleted(hub)).toEqual([]);
		expect(listed("T2")).toBe(true);
	});

	// An end the pane learnt itself, from the hub's refusal, counts as one the list reports.
	it("deletes a terminal its pane found ended though the list says it runs", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1"), { ...live("T2"), attach: "ended" }],
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
		const card = await cardIn("P2");

		await click("Close", card);

		expect(panesShown()).toEqual(["P1"]);
		await vi.waitFor(() => expect(deleted(hub)).toEqual(["T2"]));
	});

	// A live terminal keeps running when its pane goes: it can be put back from the sidebar.
	it("closes a live terminal's pane from its menu and leaves the terminal running", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1"), live("T2")],
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});

		await rightClick(pane("P1")?.querySelector(".terminal-pane"));
		await click("Close Pane", pane("P1") ?? document);

		expect(panesShown()).toEqual(["P2"]);
		await settle();
		expect(deleted(hub)).toEqual([]);
		expect(hub.frames("KILL")).toEqual([]);
		expect(listed("T1")).toBe(true);
	});

	// The pane's own close, from the keyboard, of a terminal the list says ended.
	it("deletes an ended terminal whose pane closes on Ctrl+Shift+W", async () => {
		const { hub } = await mountWindow({
			channels: [ended("T1"), live("T2")],
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
		(await cardIn("P1")).focus();

		await press("W", { ctrl: true, shift: true });

		expect(panesShown()).toEqual(["P2"]);
		await vi.waitFor(() => expect(deleted(hub)).toEqual(["T1"]));
	});

	it("keeps an ended terminal whose pane closes on Ctrl+Shift+W when the setting keeps them", async () => {
		const { hub } = await mountWindow({
			channels: [ended("T1"), live("T2")],
			ui: { panes: { keepEnded: true } },
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
		(await cardIn("P1")).focus();

		await press("W", { ctrl: true, shift: true });

		expect(panesShown()).toEqual(["P2"]);
		await settle();
		expect(deleted(hub)).toEqual([]);
		expect(listed("T1")).toBe(true);
	});

	// Closing a tab deletes the ended terminals it showed, at once; the live ones keep running.
	it("closes a tab at once and deletes the ended terminals it showed, not the live ones", async () => {
		const { hub } = await mountWindow({
			channels: [ended("T1"), live("T2"), live("T3")],
			layout: {
				tabs: [
					{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) },
					{ id: "TAB2", root: term("T3", "P3") },
				],
			},
		});

		await click("Close T1");

		expect(asking()).toBe(false);
		expect(tabs().map((tab) => tab.label)).toEqual(["T3"]);
		await vi.waitFor(() => expect(deleted(hub)).toEqual(["T1"]));
	});

	it("closes a tab over an ended terminal and keeps it listed when the setting keeps them", async () => {
		const { hub } = await mountWindow({
			channels: [ended("T1"), live("T3")],
			ui: { panes: { keepEnded: true } },
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: term("T3", "P3") },
				],
			},
		});

		await click("Close T1");

		expect(tabs().map((tab) => tab.label)).toEqual(["T3"]);
		await settle();
		expect(deleted(hub)).toEqual([]);
		expect(listed("T1")).toBe(true);
	});

	// The old question is gone from the list of confirmations a user can turn back on.
	it("lists no question about closing an ended terminal among the confirmations", () => {
		expect(CONFIRMATIONS.map((entry) => entry.key)).not.toContain("ConfirmCloseDeadTab");
	});
});

// "Always do this" on one overlay reaches the overlays already waiting only on screen (#586):
// every pane of the tab shown, not only the one selected. Which overlays follow a choice is
// tested in utils/exit-action.spec.ts.
describe("the panes on screen", () => {
	async function threeEnded() {
		return mountWindow({
			channels: [ended("T1"), ended("T2"), ended("T3")],
			layout: {
				tabs: [
					{
						id: "TAB1",
						root: split("vertical", term("T1", "P1"), term("T2", "P2")),
						activePane: "P1",
					},
					{ id: "TAB2", root: term("T3", "P3") },
				],
			},
		});
	}

	/** "Always do this" checked on a pane's card, then Close. */
	async function alwaysClose(paneId: string): Promise<void> {
		const card = await cardIn(paneId);
		const always = card.querySelector<HTMLInputElement>('.exit-option input[type="checkbox"]');
		always?.click();
		await settle(2);
		await click("Close", card);
	}

	it("answers every ended pane of the tab shown when Always do this is chosen on one", async () => {
		const { hub } = await threeEnded();
		await cardIn("P2");

		await alwaysClose("P1");

		await vi.waitFor(() => expect(deleted(hub).sort()).toEqual(["T1", "T2"]));
		expect(panesShown()).not.toContain("P2");
	});

	it("answers an ended pane of a tab not shown only once its tab is shown", async () => {
		const { hub } = await threeEnded();
		await cardIn("P2");
		await cardIn("P3");
		await alwaysClose("P1");
		await vi.waitFor(() => expect(deleted(hub).sort()).toEqual(["T1", "T2"]));
		await settle();
		expect(deleted(hub)).not.toContain("T3");

		await press("Tab", { ctrl: true });

		await vi.waitFor(() => expect(deleted(hub)).toContain("T3"));
	});

	// The tab shown is the active one: the others are kept, hidden.
	it("shows the panes of the active tab and keeps the others hidden", async () => {
		await mountWindow({
			channels: [live("T1"), live("T3")],
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: term("T3", "P3") },
				],
			},
		});
		expect(panesShown()).toEqual(["P1"]);

		await press("Tab", { ctrl: true });

		expect(panesShown()).toEqual(["P3"]);
		expect(pane("P1")).not.toBeNull();
	});
});

// The empty pane is a host picker, and a new tab follows [tabs] scope (#625). What the picker
// does is tested in useHostPicker.spec.ts; what a new tab opens, in useLayout.spec.ts.
describe("an empty pane's host, and a new tab", () => {
	/** Choose a host in the empty pane's picker. */
	async function pickHost(label: string): Promise<void> {
		const row = [...document.querySelectorAll<HTMLElement>('.vacant-pane [role="option"]')].find(
			(option) => option.querySelector(".host-pick-row__label")?.textContent?.trim() === label,
		);
		if (row === undefined) throw new Error(`no host "${label}" in the picker`);
		row.click();
		await settle();
	}

	/** The host the rail has selected. */
	function hostInView(): string | null {
		return (
			document.querySelector('.host-rail [aria-pressed="true"]')?.getAttribute("aria-label") ?? null
		);
	}

	it("spawns an empty pane's terminal on the host its picker chose, not the host in view", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});
		expect(hostInView()).toBe("alpha");

		await pickHost("bravo");

		await vi.waitFor(() => expect(hub.frames("SPAWN")).toHaveLength(1));
		expect(hub.frames("SPAWN")[0]).toMatchObject({ hostId: HOST_B });
	});

	it("opens Add Host from an empty pane's picker", async () => {
		await mountWindow({ layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] } });

		await click("Add a host", document.querySelector(".vacant-pane") ?? document);

		expect(document.querySelector(".host-modal .dialog-title")?.textContent?.trim()).toBe(
			"Add Host",
		);
	});

	// With the bar showing one host's tabs, the tab in front taking a terminal on another host,
	// and none left on the host in view, would leave the bar: that host comes into view.
	it("brings the host its picker chose into view where the bar shows one host's tabs", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});

		await pickHost("bravo");

		await vi.waitFor(() => expect(hostInView()).toBe("bravo"));
		expect(hub.calls("GET", "/api/channels").some((c) => c.query.get("host_id") === HOST_B)).toBe(
			true,
		);
	});

	it("leaves the host in view where the bar shows every host's tabs", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});

		await pickHost("bravo");

		await vi.waitFor(() => expect(hub.frames("SPAWN")).toHaveLength(1));
		expect(hostInView()).toBe("alpha");
	});

	it("leaves the host in view while the tab still shows one of its terminals", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1")],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), vacant("V1")) }] },
		});

		await pickHost("bravo");

		await vi.waitFor(() => expect(hub.frames("SPAWN")).toHaveLength(1));
		expect(hostInView()).toBe("alpha");
	});

	/** Choose a detached terminal in the empty pane's picker, by its title. */
	async function pickTerminal(title: string): Promise<void> {
		const row = [...document.querySelectorAll<HTMLElement>('.vacant-pane [role="option"]')].find(
			(option) => option.querySelector(".picker-terminal-title")?.textContent?.trim() === title,
		);
		if (row === undefined) throw new Error(`no terminal "${title}" in the picker`);
		row.click();
		await settle();
	}

	/** The terminals the empty pane's picker offers to put back, by title. */
	function terminalsOffered(): string[] {
		return [...document.querySelectorAll(".vacant-pane .picker-terminal-title")].map(
			(el) => el.textContent?.trim() ?? "",
		);
	}

	/** The titles of the panes the tab shown holds. */
	function titlesShown(): string[] {
		return [
			...document.querySelectorAll(".pane-tab-container:not([style*='none']) .pane-title"),
		].map((el) => el.textContent?.trim() ?? "");
	}

	// A terminal that runs, shown in no pane, is put back in the empty one: nothing is spawned.
	it("fills an empty pane with a detached terminal of the host in view", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});

		await pickTerminal("T1");

		expect(titlesShown()).toEqual(["T1"]);
		expect(hub.frames("SPAWN")).toEqual([]);
		expect(hostInView()).toBe("alpha");
	});

	it("fills an empty pane with a detached terminal and keeps its host in view with a per-host bar", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1"), live("T2")],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: split("vertical", term("T2", "P2"), vacant("V1")) }] },
		});

		await pickTerminal("T1");

		expect(titlesShown()).toEqual(["T2", "T1"]);
		expect(hub.frames("SPAWN")).toEqual([]);
		expect(hostInView()).toBe("alpha");
	});

	// A detached terminal put back is the host in view's: that fill brings no other host into
	// view. Another host's terminal fills a pane when the picker connects that host: its own SPAWN
	// opens the terminal, which then fills the pane as a detached one would (useHostPicker.ts).
	it("offers to put back only the detached terminals of the host in view", async () => {
		await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1"), live("T9", HOST_B)],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});

		expect(terminalsOffered()).toEqual(["T1"]);
	});

	// With the bar showing one host's tabs, the tab in front filled with a terminal of a host it
	// connected, and none left of the host in view, would leave the bar: that host comes into view.
	it("brings into view the host it connects to fill an empty pane where the bar shows one host's tabs", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO_AWAY],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});

		await pickHost("bravo");

		await vi.waitFor(() => expect(hostInView()).toBe("bravo"));
		expect(hub.frames("SPAWN")).toHaveLength(1);
		expect(hub.frames("SPAWN")[0]).toMatchObject({ hostId: HOST_B });
	});

	it("leaves the host in view when it connects another to fill an empty pane where the bar shows every host", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO_AWAY],
			layout: { tabs: [{ id: "TAB1", root: vacant("V1") }] },
		});

		await pickHost("bravo");

		await vi.waitFor(() => expect(emptyPaneShown()).toBeNull());
		await settle();
		expect(hub.frames("SPAWN")).toHaveLength(1);
		expect(hub.frames("SPAWN")[0]).toMatchObject({ hostId: HOST_B });
		expect(hostInView()).toBe("alpha");
	});

	it("leaves the host in view when it connects another to fill a pane beside one of its terminals", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO_AWAY],
			channels: [live("T1")],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), vacant("V1")) }] },
		});

		await pickHost("bravo");

		await vi.waitFor(() => expect(emptyPaneShown()).toBeNull());
		await settle();
		expect(titlesShown()).toHaveLength(2);
		expect(hub.frames("SPAWN")).toHaveLength(1);
		expect(hub.frames("SPAWN")[0]).toMatchObject({ hostId: HOST_B });
		expect(hostInView()).toBe("alpha");
	});

	it("opens an empty pane in a new tab from the tab bar's + where the bar shows every host", async () => {
		const { hub } = await mountWindow({
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});

		await click("Open new terminal");

		expect(tabs()).toHaveLength(2);
		expect(tabs()[1]?.selected).toBe(true);
		expect(
			document.querySelector(".pane-tab-container:not([style*='none']) .vacant-pane"),
		).not.toBeNull();
		expect(hub.frames("SPAWN")).toEqual([]);
	});

	it("opens a terminal on the host in view from the tab bar's + where the bar shows one host", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1")],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});

		await click("Open new terminal");

		expect(tabs()).toHaveLength(2);
		await vi.waitFor(() => expect(hub.frames("SPAWN")).toHaveLength(1));
		expect(hub.frames("SPAWN")[0]).toMatchObject({ hostId: HOST_A });
	});

	// Enter on a host in the palette: a new tab with a terminal on it, there before the hub answers.
	it("opens the palette's host in a new tab with a terminal on it", async () => {
		const { hub } = await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		hub.answersSpawns = false;

		await runPaletteRow("bravo");

		expect(tabs()).toHaveLength(2);
		await vi.waitFor(() => expect(hub.frames("SPAWN")).toHaveLength(1));
		expect(hub.frames("SPAWN")[0]).toMatchObject({ hostId: HOST_B });
		expect(hostInView()).toBe("alpha");
	});

	it("brings the palette's host into view with it where the bar shows one host's tabs", async () => {
		await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1")],
			ui: { tabs: { scope: "perHost" } },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});

		await runPaletteRow("bravo");

		await vi.waitFor(() => expect(hostInView()).toBe("bravo"));
	});
});

/** One tab with one live terminal, T1 in pane P1. */
function oneTerminal(setup: { ui?: Record<string, unknown> } = {}) {
	return mountWindow({
		channels: [live("T1")],
		layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		...setup,
	});
}

/**
 * Three tabs: the first split side by side, P1 on the left and, on the right, P2 above P3; then
 * P4 and P5, one a tab. P1 is the first tab's active pane.
 */
function threeTabs(setup: { ui?: Record<string, unknown> } = {}) {
	return mountWindow({
		channels: [live("T1"), live("T2"), live("T3"), live("T4"), live("T5")],
		layout: {
			tabs: [
				{
					id: "TAB1",
					root: split(
						"vertical",
						term("T1", "P1"),
						split("horizontal", term("T2", "P2"), term("T3", "P3")),
					),
					activePane: "P1",
				},
				{ id: "TAB2", root: term("T4", "P4") },
				{ id: "TAB3", root: term("T5", "P5") },
			],
		},
		...setup,
	});
}

/** Ten tabs of one terminal each, T1 to T10 in P1 to P10, the one at `active` shown. */
function tenTabs(active: number) {
	const ids = Array.from({ length: 10 }, (_, i) => i + 1);
	return mountWindow({
		channels: ids.map((n) => live(`T${n}`)),
		layout: { tabs: ids.map((n) => ({ id: `TAB${n}`, root: term(`T${n}`, `P${n}`) })), active },
	});
}

/** The window's zone the keyboard is in: rail, sidebar, tabs, pane or files. */
function zoneWithKeyboard(): string | null {
	return (
		document.activeElement?.closest("[data-focus-zone]")?.getAttribute("data-focus-zone") ?? null
	);
}

/** The label of the tab shown. */
function tabShown(): string | undefined {
	return tabs().find((tab) => tab.selected)?.label;
}

/** The empty pane in the tab shown, if any. */
function emptyPaneShown(): Element | null {
	return document.querySelector(".pane-tab-container:not([style*='none']) .vacant-pane");
}

/** Give the empty pane of the tab shown the keyboard, as a click in its search field would. */
function focusEmptyPane(): HTMLElement {
	const field = emptyPaneShown()?.querySelector<HTMLElement>(".picker-input");
	if (field === null || field === undefined) throw new Error("no empty pane shown");
	field.focus();
	expect(document.activeElement).toBe(field);
	return field;
}

// Ctrl+K opened the palette and still reached the shell as ^K (#624), and the shortcuts listed for
// tabs and panes did nothing (#631). What the chords are, and that a terminal keeps them from its
// PTY, is tested in utils/app-shortcuts.spec.ts and utils/terminal-keys.spec.ts.
describe("the window's shortcuts", () => {
	// The window listens in the capture phase, before an element's own handler can stop the key:
	// here the terminal search's field, which stops every key it gets.
	it("runs a shortcut typed in a field that stops its keys, and takes the key", async () => {
		await oneTerminal();
		focusPane("P1");
		await press("F", { ctrl: true, shift: true });
		const search = pane("P1")?.querySelector(".search-overlay__input");
		expect(document.activeElement).toBe(search);

		const event = await press("P", { ctrl: true, shift: true });

		expect(event.defaultPrevented).toBe(true);
		expect(dialogs()).toContain("Command Palette");
	});

	// Where the key was typed decides whether F6 is a chord: in a terminal it is the program's,
	// and only Ctrl+F6 moves between the zones (utils/app-shortcuts.spec.ts, #637).
	it("leaves F6 to the program in a terminal", async () => {
		const { hub } = await oneTerminal();
		const input = focusPane("P1");

		const event = await press("F6");

		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(input);
		expect(typed(hub, "T1")).toEqual(["\u001b[17~"]);
	});

	it("moves to the next zone on F6 outside a terminal", async () => {
		await oneTerminal();
		document.querySelector<HTMLElement>('.tab-bar [role="tab"]')?.focus();

		const event = await press("F6");

		expect(event.defaultPrevented).toBe(true);
		expect(paneWithKeyboard()).toBe("P1");
	});

	// F6 behind Settings would leave the keyboard behind the dialog (#637).
	it("takes a chord that moves the keyboard, but does not run it, while a modal dialog has it", async () => {
		await mountWindow({
			channels: [live("T1"), live("T2")],
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: term("T2", "P2") },
				],
			},
		});
		focusPane("P1");
		await press("P", { ctrl: true, shift: true });
		const input = document.querySelector(".palette-input");
		expect(document.activeElement).toBe(input);

		const event = await press("Tab", { ctrl: true });

		expect(event.defaultPrevented).toBe(true);
		expect(tabShown()).toBe("T1");
		expect(document.activeElement).toBe(input);
	});

	it("runs a chord that moves no keyboard from inside a modal dialog", async () => {
		await oneTerminal();
		focusPane("P1");
		await press("/", { ctrl: true });
		expect(dialogs()).toContain("Keyboard shortcuts");
		expect(document.activeElement?.closest('[aria-modal="true"]')).not.toBeNull();

		await press("/", { ctrl: true });

		expect(dialogs()).not.toContain("Keyboard shortcuts");
	});

	it("leaves Ctrl+K to the shell", async () => {
		const { hub } = await oneTerminal();
		focusPane("P1");

		const event = await press("k", { ctrl: true });

		expect(event.defaultPrevented).toBe(false);
		expect(dialogs()).toEqual([]);
		expect(typed(hub, "T1")).toEqual(["\u000b"]);
	});

	// What a terminal's key handler lets through, xterm sends its program; the chords of the table
	// it keeps (utils/terminal-keys.ts), whatever the window did with them. Each chord here is one
	// xterm turns into input. Left out, those it sends nothing for even let through (xtermInput):
	// Ctrl+Shift+P, T, W and E (palette.open, tab.new, pane.close, files.toggle), Ctrl+/
	// (help.shortcuts) and Ctrl+, (settings.open). Their actions are run on their chords above.
	it.each([
		["tab.next", "Tab", { ctrl: true }],
		["tab.previous", "Tab", { ctrl: true, shift: true }],
		["tab.goTo1", "1", { ctrl: true, alt: true, code: "Digit1" }],
		["tab.goTo2", "2", { ctrl: true, alt: true, code: "Digit2" }],
		["tab.goTo3", "3", { ctrl: true, alt: true, code: "Digit3" }],
		["tab.goTo4", "4", { ctrl: true, alt: true, code: "Digit4" }],
		["tab.goTo5", "5", { ctrl: true, alt: true, code: "Digit5" }],
		["tab.goTo6", "6", { ctrl: true, alt: true, code: "Digit6" }],
		["tab.goTo7", "7", { ctrl: true, alt: true, code: "Digit7" }],
		["tab.goTo8", "8", { ctrl: true, alt: true, code: "Digit8" }],
		["tab.goTo9", "9", { ctrl: true, alt: true, code: "Digit9" }],
		["pane.splitRight", "+", { alt: true, shift: true, code: "Equal" }],
		["pane.splitDown", "_", { alt: true, shift: true, code: "Minus" }],
		["pane.focusLeft", "ArrowLeft", { alt: true, code: "ArrowLeft" }],
		["pane.focusRight", "ArrowRight", { alt: true, code: "ArrowRight" }],
		["pane.focusUp", "ArrowUp", { alt: true, code: "ArrowUp" }],
		["pane.focusDown", "ArrowDown", { alt: true, code: "ArrowDown" }],
		["pane.resizeLeft", "ArrowLeft", { alt: true, shift: true, code: "ArrowLeft" }],
		["pane.resizeRight", "ArrowRight", { alt: true, shift: true, code: "ArrowRight" }],
		["pane.resizeUp", "ArrowUp", { alt: true, shift: true, code: "ArrowUp" }],
		["pane.resizeDown", "ArrowDown", { alt: true, shift: true, code: "ArrowDown" }],
		["zone.next", "F6", { ctrl: true }],
		["zone.previous", "F6", { ctrl: true, shift: true }],
	] as const)("keeps the chord of %s from the shell", async (_id, key, mods) => {
		const { hub } = await oneTerminal({ ui: { experimental: { fileTransfer: true } } });
		focusPane("P1");

		await press(key, mods);

		expect(typed(hub, "T1")).toEqual([]);
	});
});

// Each action of the table, run on its chord as the tab bar and the panes run it: the tab bar's
// "+", a pane's split and its "Close Pane" are the same handlers. Which pane and which divider the
// keys reach is tested in utils/pane-geometry.spec.ts, the tabs in utils/tab-switch.spec.ts, and
// the zones' order in utils/focus-zones.spec.ts (#631, #637).
describe("each action of the shortcut table, on its chord", () => {
	/** Ctrl+Alt+`n`, from the tab at index `from` of ten: the tab `shown` comes to the front. */
	const goTo = (n: number, from: number, shown: string) => async () => {
		await tenTabs(from);
		focusPane(`P${from + 1}`);
		await press(String(n), { ctrl: true, alt: true, code: `Digit${n}` });
		expect(tabShown()).toBe(shown);
		expect(paneWithKeyboard()).toBe(`P${shown.slice(1)}`);
	};

	const SCENARIOS: Record<AppActionId, () => Promise<void>> = {
		"palette.open": async () => {
			await oneTerminal();
			focusPane("P1");
			await press("P", { ctrl: true, shift: true });
			expect(dialogs()).toEqual(["Command Palette"]);
		},
		"settings.open": async () => {
			await oneTerminal();
			focusPane("P1");
			await press(",", { ctrl: true });
			expect(dialogs()).toEqual(["Settings"]);
		},
		"help.shortcuts": async () => {
			await oneTerminal();
			focusPane("P1");
			await press("/", { ctrl: true });
			expect(dialogs()).toEqual(["Keyboard shortcuts"]);
		},
		"tab.new": async () => {
			await oneTerminal();
			focusPane("P1");
			await press("T", { ctrl: true, shift: true });
			expect(tabs()).toHaveLength(2);
			expect(tabs()[1]?.selected).toBe(true);
			expect(emptyPaneShown()).not.toBeNull();
		},
		"tab.next": async () => {
			await threeTabs();
			focusPane("P1");
			await press("Tab", { ctrl: true });
			expect(tabShown()).toBe("T4");
			expect(paneWithKeyboard()).toBe("P4");
		},
		"tab.previous": async () => {
			await threeTabs();
			focusPane("P1");
			await press("Tab", { ctrl: true, shift: true });
			expect(tabShown()).toBe("T5");
			expect(paneWithKeyboard()).toBe("P5");
		},
		"tab.goTo1": goTo(1, 9, "T1"),
		"tab.goTo2": goTo(2, 9, "T2"),
		"tab.goTo3": goTo(3, 9, "T3"),
		"tab.goTo4": goTo(4, 9, "T4"),
		"tab.goTo5": goTo(5, 9, "T5"),
		"tab.goTo6": goTo(6, 9, "T6"),
		"tab.goTo7": goTo(7, 9, "T7"),
		"tab.goTo8": goTo(8, 9, "T8"),
		// The ninth is the last tab, however many there are.
		"tab.goTo9": goTo(9, 0, "T10"),
		// The pane holding the keyboard, P2, not the tab's active one, P1.
		"pane.splitRight": async () => {
			await threeTabs();
			focusPane("P2");
			await press("+", { alt: true, shift: true, code: "Equal" });
			expect(splitAround("P2")).toEqual({ direction: "vertical", halves: [["P2"], ["empty"]] });
			expect(splitAround("P1")).toEqual({
				direction: "vertical",
				halves: [["P1"], ["P2", "empty", "P3"]],
			});
		},
		"pane.splitDown": async () => {
			await threeTabs();
			focusPane("P2");
			await press("_", { alt: true, shift: true, code: "Minus" });
			expect(splitAround("P2")).toEqual({ direction: "horizontal", halves: [["P2"], ["empty"]] });
			expect(splitAround("P1")).toEqual({
				direction: "vertical",
				halves: [["P1"], ["P2", "empty", "P3"]],
			});
		},
		"pane.close": async () => {
			const { hub } = await threeTabs();
			focusPane("P1");
			await press("W", { ctrl: true, shift: true });
			expect(panesShown()).toEqual(["P2", "P3"]);
			expect(deleted(hub)).toEqual([]);
		},
		"pane.focusLeft": async () => {
			await threeTabs();
			focusPane("P2");
			await press("ArrowLeft", { alt: true, code: "ArrowLeft" });
			expect(paneWithKeyboard()).toBe("P1");
		},
		"pane.focusRight": async () => {
			await threeTabs();
			focusPane("P1");
			await press("ArrowRight", { alt: true, code: "ArrowRight" });
			expect(paneWithKeyboard()).toBe("P2");
		},
		"pane.focusUp": async () => {
			await threeTabs();
			focusPane("P3");
			await press("ArrowUp", { alt: true, code: "ArrowUp" });
			expect(paneWithKeyboard()).toBe("P2");
		},
		"pane.focusDown": async () => {
			await threeTabs();
			focusPane("P2");
			await press("ArrowDown", { alt: true, code: "ArrowDown" });
			expect(paneWithKeyboard()).toBe("P3");
		},
		"pane.resizeLeft": async () => {
			await threeTabs();
			focusPane("P1");
			await press("ArrowLeft", { alt: true, shift: true, code: "ArrowLeft" });
			expect(shareOf("P1")).toBeCloseTo(45);
		},
		"pane.resizeRight": async () => {
			await threeTabs();
			focusPane("P1");
			await press("ArrowRight", { alt: true, shift: true, code: "ArrowRight" });
			expect(shareOf("P1")).toBeCloseTo(55);
		},
		"pane.resizeUp": async () => {
			await threeTabs();
			focusPane("P2");
			await press("ArrowUp", { alt: true, shift: true, code: "ArrowUp" });
			expect(shareOf("P2")).toBeCloseTo(45);
			expect(shareOf("P1")).toBeCloseTo(50);
		},
		"pane.resizeDown": async () => {
			await threeTabs();
			focusPane("P2");
			await press("ArrowDown", { alt: true, shift: true, code: "ArrowDown" });
			expect(shareOf("P2")).toBeCloseTo(55);
			expect(shareOf("P1")).toBeCloseTo(50);
		},
		"zone.next": async () => {
			await threeTabs();
			focusPane("P1");
			await press("F6", { ctrl: true });
			expect(zoneWithKeyboard()).toBe("rail");
		},
		"zone.previous": async () => {
			await threeTabs();
			focusPane("P1");
			await press("F6", { ctrl: true, shift: true });
			expect(zoneWithKeyboard()).toBe("tabs");
		},
		"files.toggle": async () => {
			await oneTerminal({ ui: { experimental: { fileTransfer: true } } });
			focusPane("P1");
			await press("E", { ctrl: true, shift: true });
			expect(document.getElementById("files-panel")).not.toBeNull();
			expect(zoneWithKeyboard()).toBe("files");
		},
	};

	it("has a scenario for every action of the table", () => {
		expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(APP_SHORTCUTS).sort());
	});

	it.each(Object.keys(SCENARIOS) as AppActionId[])("runs %s", async (id) => {
		await SCENARIOS[id]();
	});

	it("splits a terminal from its pane's menu as its chord does", async () => {
		await threeTabs();
		await rightClick(pane("P2")?.querySelector(".terminal-pane"));

		await click("Split Right", pane("P2") ?? document);

		expect(splitAround("P2")).toEqual({ direction: "vertical", halves: [["P2"], ["empty"]] });
	});

	it("splits the tab's terminal from the tab's menu", async () => {
		await oneTerminal();
		await rightClick(document.querySelector('.tab-bar [role="tab"]'));

		await click("Split Right");

		expect(splitAround("P1")).toEqual({ direction: "vertical", halves: [["P1"], ["empty"]] });
	});

	// The split is the focused pane's, and only a terminal's: an empty pane has none.
	it("splits nothing while the keyboard is in an empty pane", async () => {
		await mountWindow({
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), vacant("V1")) }] },
		});
		focusEmptyPane();

		await press("+", { alt: true, shift: true, code: "Equal" });

		expect(panesShown()).toEqual(["P1", "V1"]);
	});
});

// The palette's rows for those actions run them as their chords do (#631, #639).
describe("the palette's rows for the window's actions", () => {
	it("opens a new tab from New Channel as Ctrl+Shift+T does", async () => {
		await oneTerminal();

		await runPaletteRow("New Channel");

		expect(tabs()).toHaveLength(2);
		expect(emptyPaneShown()).not.toBeNull();
	});

	it("closes the focused pane from Close Pane", async () => {
		await threeTabs();

		await runPaletteRow("Close Pane");

		expect(panesShown()).toEqual(["P2", "P3"]);
	});

	it("splits the focused pane from Split Right", async () => {
		await threeTabs();

		await runPaletteRow("Split Right");

		expect(splitAround("P1")).toEqual({ direction: "vertical", halves: [["P1"], ["empty"]] });
	});

	it("splits the focused pane from Split Down", async () => {
		await threeTabs();

		await runPaletteRow("Split Down");

		expect(splitAround("P1")).toEqual({ direction: "horizontal", halves: [["P1"], ["empty"]] });
	});

	// No chord closes a whole tab any more; the palette's row still does, as its × does.
	it("closes the tab shown from Close Tab, deleting its ended terminal", async () => {
		const { hub } = await mountWindow({
			channels: [ended("T1"), live("T2")],
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: term("T2", "P2") },
				],
			},
		});

		await runPaletteRow("Close Tab");

		expect(tabs().map((tab) => tab.label)).toEqual(["T2"]);
		await vi.waitFor(() => expect(deleted(hub)).toEqual(["T1"]));
	});

	// The palette's Keyboard Shortcuts row opens the overlay Ctrl+/ toggles (#639).
	it("opens the shortcuts overlay from Keyboard Shortcuts", async () => {
		await oneTerminal();

		await runPaletteRow("Keyboard Shortcuts");

		expect(dialogs()).toEqual(["Keyboard shortcuts"]);
	});

	it("leaves the shortcuts overlay open when Keyboard Shortcuts is chosen over it", async () => {
		await oneTerminal();
		focusPane("P1");
		await press("/", { ctrl: true });

		await runPaletteRow("Keyboard Shortcuts");

		expect(dialogs()).toEqual(["Keyboard shortcuts"]);
	});
});

// The strip for the rail, the list and the tab bar (#639). Which keys it names, and when it shows,
// is tested in utils/key-hints.spec.ts and components/KeyHintStrip.spec.ts; where it sits, in
// App.browser.spec.ts.
describe("the key hints of the window's zones", () => {
	const strips = () => [...document.querySelectorAll(".key-hint-strip")];
	/** Each hint of the one strip, its keys then what they do. */
	const hints = () =>
		[...(strips()[0]?.querySelectorAll(".key-hint") ?? [])].map(
			(hint) => hint.textContent?.replace(/\s+/g, " ").trim() ?? "",
		);

	it("name the keys of the rail while the keyboard is in it, in one strip", async () => {
		await oneTerminal();
		focusPane("P1");

		await press("F6", { ctrl: true });

		expect(zoneWithKeyboard()).toBe("rail");
		expect(strips()).toHaveLength(1);
		expect(hints()).toEqual(["←→↑↓ hosts", "Enter select", "F6 next area"]);
	});

	it("name the keys of the terminal list while the keyboard is in it", async () => {
		await oneTerminal();
		focusPane("P1");
		await press("F6", { ctrl: true });

		await press("F6", { ctrl: true });

		expect(zoneWithKeyboard()).toBe("sidebar");
		expect(strips()).toHaveLength(1);
		expect(hints()).toEqual(["↑↓ terminals", "Enter open", "F6 next area"]);
	});

	it("name the keys of the tab bar while the keyboard is in it", async () => {
		await oneTerminal();
		focusPane("P1");

		await press("F6", { ctrl: true, shift: true });

		expect(zoneWithKeyboard()).toBe("tabs");
		expect(strips()).toHaveLength(1);
		expect(hints()).toEqual(["←→ tabs", "Enter open", "Delete close", "F6 next area"]);
	});
});

// Windows Terminal's: the tab closes with its last pane (#637).
describe("closing the focused pane", () => {
	// An ended terminal goes as the setting says, as its tab's × does.
	it("closes the tab with its last pane, deleting its ended terminal", async () => {
		const { hub } = await mountWindow({
			channels: [ended("T1"), live("T2")],
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: term("T2", "P2") },
				],
			},
		});
		(await cardIn("P1")).focus();

		await press("W", { ctrl: true, shift: true });

		expect(tabs().map((tab) => tab.label)).toEqual(["T2"]);
		await vi.waitFor(() => expect(deleted(hub)).toEqual(["T1"]));
	});

	// The pane closed had the keyboard: it goes to the one that takes its place.
	it("gives the keyboard to the pane that takes the closed one's place", async () => {
		await mountWindow({
			channels: [live("T1"), live("T2")],
			layout: {
				tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), term("T2", "P2")) }],
			},
		});
		focusPane("P1");

		await press("W", { ctrl: true, shift: true });

		expect(paneWithKeyboard()).toBe("P2");
	});

	// An empty pane gives its room to its neighbour, as its own "Close pane" does.
	it("gives an empty pane's room to its neighbour", async () => {
		await mountWindow({
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), vacant("V1")) }] },
		});
		focusEmptyPane();

		await press("W", { ctrl: true, shift: true });

		expect(panesShown()).toEqual(["P1"]);
		expect(tabs()).toHaveLength(1);
	});

	it("gives an empty pane's room to its neighbour from its own Close pane", async () => {
		await mountWindow({
			channels: [live("T1")],
			layout: { tabs: [{ id: "TAB1", root: split("vertical", term("T1", "P1"), vacant("V1")) }] },
		});

		await click("Close pane", pane("V1") ?? document);

		expect(panesShown()).toEqual(["P1"]);
	});
});

// Which pane and which divider the keys reach is tested in utils/pane-geometry.spec.ts, the tabs
// in utils/tab-switch.spec.ts, and the zones' order in utils/focus-zones.spec.ts (#637).
describe("the keyboard among tabs, panes and zones", () => {
	// The divider stops where the mouse can drag it.
	it("stops a divider moved from the keyboard where the mouse can drag it", async () => {
		await threeTabs();
		focusPane("P1");

		for (let i = 0; i < 10; i++)
			await press("ArrowRight", { alt: true, shift: true, code: "ArrowRight" });

		expect(shareOf("P1")).toBeCloseTo(90);
	});

	it("switches among the tabs the bar shows where it shows one host's tabs", async () => {
		await mountWindow({
			hosts: [ALPHA, BRAVO],
			channels: [live("T1"), live("T2", HOST_B), live("T3")],
			ui: { tabs: { scope: "perHost" } },
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: term("T2", "P2") },
					{ id: "TAB3", root: term("T3", "P3") },
				],
			},
		});
		focusPane("P1");

		await press("Tab", { ctrl: true });

		expect(tabShown()).toBe("T3");
		expect(paneWithKeyboard()).toBe("P3");
	});

	// A terminal takes the keyboard itself when it becomes the selected one; an empty pane does not.
	it("takes the keyboard into the empty pane of the tab it switches to", async () => {
		await mountWindow({
			channels: [live("T1")],
			layout: {
				tabs: [
					{ id: "TAB1", root: term("T1", "P1") },
					{ id: "TAB2", root: vacant("V2") },
				],
			},
		});
		focusPane("P1");

		await press("Tab", { ctrl: true });

		expect(tabs()[1]?.selected).toBe(true);
		expect(document.activeElement).toBe(emptyPaneShown()?.querySelector(".picker-input"));
	});

	it("goes back to the pane on Esc from the tab bar", async () => {
		await oneTerminal();
		document.querySelector<HTMLElement>('.tab-bar [role="tab"]')?.focus();

		const event = await press("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(paneWithKeyboard()).toBe("P1");
	});

	// A text field there, such as a terminal being renamed in the list, keeps its own Esc.
	it("leaves Esc to a terminal being renamed in the list", async () => {
		await oneTerminal();
		document
			.querySelector('.channel-sidebar [data-channel-id="T1"] .channel-item__label')
			?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		await settle(4);
		const field = document.querySelector<HTMLInputElement>(".channel-rename-input");
		field?.focus();
		expect(document.activeElement).toBe(field);

		const event = await press("Escape");

		expect(event.defaultPrevented).toBe(false);
		expect(paneWithKeyboard()).toBeNull();
	});

	// Each pane is marked, so that Alt+arrows start from the pane holding the keyboard, whichever
	// the tab last made active.
	it("moves the focus from the terminal pane holding the keyboard", async () => {
		await mountWindow({
			channels: [live("T1"), live("T2")],
			layout: {
				tabs: [
					{
						id: "TAB1",
						root: split("vertical", term("T1", "P1"), term("T2", "P2")),
						activePane: "P1",
					},
				],
			},
		});
		focusPane("P2");

		await press("ArrowLeft", { alt: true, code: "ArrowLeft" });

		expect(paneWithKeyboard()).toBe("P1");
	});

	it("moves the focus from the empty pane holding the keyboard", async () => {
		await mountWindow({
			channels: [live("T2")],
			layout: {
				tabs: [
					{ id: "TAB1", root: split("vertical", vacant("V1"), term("T2", "P2")), activePane: "P2" },
				],
			},
		});
		focusEmptyPane();

		await press("ArrowRight", { alt: true, code: "ArrowRight" });

		expect(paneWithKeyboard()).toBe("P2");
	});

	// Settings' own Esc goes from its detail back to its menu (components/settings/SettingsPanel.spec.ts).
	it("leaves Esc inside Settings to Settings", async () => {
		await oneTerminal();
		focusPane("P1");
		await press(",", { ctrl: true });
		const detail = document.querySelector<HTMLElement>(".settings-content");
		detail?.focus();

		await press("Escape");

		expect(dialogs()).toEqual(["Settings"]);
	});

	it("closes Settings on an Esc from outside it", async () => {
		await oneTerminal();
		focusPane("P1");
		await press(",", { ctrl: true });

		await press("Escape", {}, document.body);

		expect(dialogs()).toEqual([]);
	});

	// Opened from the palette, the shortcuts overlay has nothing to give the keyboard back to (#639).
	it("gives the keyboard to the pane when the shortcuts overlay closes with nowhere to give it back", async () => {
		await oneTerminal();
		await runPaletteRow("Keyboard Shortcuts");

		await click("Close keyboard shortcuts");

		expect(dialogs()).toEqual([]);
		expect(paneWithKeyboard()).toBe("P1");
	});

	it("opens a terminal from the list on Enter, with the keyboard in its pane", async () => {
		await mountWindow({
			channels: [live("T1"), live("T2")],
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});
		document.querySelector<HTMLElement>('.channel-sidebar [data-channel-id="T2"]')?.focus();

		await press("Enter");

		expect(tabShown()).toBe("T2");
		expect(
			document.activeElement?.closest(".terminal-pane")?.querySelector(".pane-title")?.textContent,
		).toBe("T2");
	});

	it("takes the keyboard into the pane of the terminal already shown on Enter in the list", async () => {
		await oneTerminal();
		const row = document.querySelector<HTMLElement>('.channel-sidebar [data-channel-id="T1"]');
		row?.focus();
		expect(document.activeElement).toBe(row);

		await press("Enter");

		expect(paneWithKeyboard()).toBe("P1");
	});
});

// The files panel beside the panes (#836). What it decides is tested in utils/files-panel.spec.ts,
// its state in stores/files-panel.spec.ts, and the panel itself in components/files/*.spec.ts;
// whether it docks or floats, in App.browser.spec.ts; here, how the window holds it.
describe("the files panel in the window", () => {
	const ON = { experimental: { fileTransfer: true } };
	const panel = () => document.getElementById("files-panel");
	const part = () =>
		document.activeElement?.closest("[data-files-part]")?.getAttribute("data-files-part") ?? null;

	it("shows the panel it was left open in once file transfer is on", async () => {
		await mountWindow({
			channels: [live("T1")],
			ui: ON,
			storage: { "lasterm:files:open": "true" },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});

		expect(panel()).not.toBeNull();
	});

	it("shows no files panel while file transfer is off, whatever it was left as", async () => {
		await mountWindow({
			channels: [live("T1")],
			storage: { "lasterm:files:open": "true" },
			layout: { tabs: [{ id: "TAB1", root: term("T1", "P1") }] },
		});

		expect(panel()).toBeNull();
	});

	// The shortcut table reads the switch from the UI config: off, the chord is the terminal's, as
	// it was before the panel (xterm itself sends nothing for Ctrl+Shift+E).
	it("leaves Ctrl+Shift+E to the terminal while file transfer is off", async () => {
		await oneTerminal();
		focusPane("P1");

		const event = await press("E", { ctrl: true, shift: true });

		expect(event.defaultPrevented).toBe(false);
		expect(panel()).toBeNull();
	});

	// The panes and the panel share the row under the tab bar; the panes keep their zone.
	it("shows the panel below the tab bar, beside the panes", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");

		await press("E", { ctrl: true, shift: true });

		const row = panel()?.parentElement;
		expect(row?.classList.contains("terminal-body")).toBe(true);
		expect(row?.querySelector(":scope > .pane-area")).not.toBeNull();
		expect(row?.previousElementSibling?.classList.contains("tab-bar")).toBe(true);
	});

	it("opens on Ctrl+Shift+E with the keyboard in its Files part", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");

		await press("E", { ctrl: true, shift: true });

		expect(part()).toBe("files");
	});

	// With the keyboard in it, the chord closes it back to the pane.
	it("closes on Ctrl+Shift+E from inside it, and the keyboard goes back to the pane", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });

		await press("E", { ctrl: true, shift: true });

		expect(panel()).toBeNull();
		expect(paneWithKeyboard()).toBe("P1");
	});

	// Open, the chord takes the keyboard into it.
	it("takes the keyboard into the open panel on Ctrl+Shift+E from a pane", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		focusPane("P1");

		await press("E", { ctrl: true, shift: true });

		expect(panel()).not.toBeNull();
		expect(part()).toBe("files");
	});

	it("opens from the palette's Files row with the keyboard in it", async () => {
		await oneTerminal({ ui: ON });

		await runPaletteRow("Files: Show panel");

		expect(part()).toBe("files");
	});

	it("closes from its own close button, and the keyboard goes back to the pane", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });

		await click("Close the files panel");

		expect(panel()).toBeNull();
		expect(paneWithKeyboard()).toBe("P1");
	});

	it("attaches the panel to the terminal of the focused pane", async () => {
		await mountWindow({
			channels: [live("T1"), live("T2")],
			ui: ON,
			layout: {
				tabs: [
					{
						id: "TAB1",
						root: split("vertical", term("T1", "P1"), term("T2", "P2")),
						activePane: "P1",
					},
				],
			},
		});
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		expect(panel()?.querySelector(".files-header__title")?.textContent).toBe("T1");

		await mouseDown(pane("P2"));

		expect(panel()?.querySelector(".files-header__title")?.textContent).toBe("T2");
	});

	// An empty pane has no terminal: the panel says so.
	it("says there is no terminal while an empty pane has the focus", async () => {
		await mountWindow({
			channels: [live("T1")],
			ui: ON,
			layout: {
				tabs: [
					{ id: "TAB1", root: split("vertical", term("T1", "P1"), vacant("V1")), activePane: "V1" },
				],
			},
		});
		focusEmptyPane();

		await press("E", { ctrl: true, shift: true });

		expect(panel()?.textContent).toContain("No terminal. Select one to see its files.");
	});

	// An entry point naming a terminal whose pane is not the focused one: its pane takes the focus.
	it("focuses the pane of the terminal a pane's Files button names", async () => {
		await mountWindow({
			channels: [live("T1"), live("T2")],
			ui: ON,
			layout: {
				tabs: [
					{
						id: "TAB1",
						root: split("vertical", term("T1", "P1"), term("T2", "P2")),
						activePane: "P1",
					},
				],
			},
		});
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });

		await click("Files (Ctrl+Shift+E)", pane("P2") ?? document);

		expect(panel()?.querySelector(".files-header__title")?.textContent).toBe("T2");
	});

	// F6 inside the panel goes from Files to Transfers before it leaves it.
	it("moves F6 from the panel's Files part to its Transfers part, then out of it", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });

		await press("F6", { ctrl: true });
		expect(part()).toBe("transfers");

		await press("F6", { ctrl: true });
		expect(zoneWithKeyboard()).toBe("rail");
	});

	it("moves Shift+F6 from the panel's Transfers part back to its Files part", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		await press("F6", { ctrl: true });
		expect(part()).toBe("transfers");

		await press("F6", { ctrl: true, shift: true });

		expect(part()).toBe("files");
	});

	// The panel's zone comes where it sits: on the left, before the panes.
	it("puts the panel in the F6 order where it sits", async () => {
		await oneTerminal({ ui: { ...ON, transfer: { panelSide: "left" } } });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		document.querySelector<HTMLElement>('.tab-bar [role="tab"]')?.focus();

		await press("F6", { ctrl: true });

		expect(zoneWithKeyboard()).toBe("files");
	});

	it("goes back to the pane on Esc in the panel", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });

		const event = await press("Escape");

		expect(event.defaultPrevented).toBe(true);
		expect(paneWithKeyboard()).toBe("P1");
	});

	// A question that Esc cancels keeps its Esc: the panel's "Keep this for".
	it("leaves Esc to a question of the panel that Esc cancels", async () => {
		await oneTerminal({ ui: ON });
		focusPane("P1");
		await press("E", { ctrl: true, shift: true });
		const toggle = panel()?.querySelector<HTMLElement>(".files-options__toggle");
		toggle?.click();
		await settle();
		const option = panel()?.querySelector<HTMLInputElement>('.files-option input[type="checkbox"]');
		option?.click();
		await settle();
		const question = panel()?.querySelector<HTMLElement>("[data-own-escape]");
		question?.querySelector<HTMLElement>("button")?.focus();
		expect(document.activeElement?.closest("[data-own-escape]")).not.toBeNull();
		// Where the keyboard goes on the way: a terminal given it, even for a moment, tells its
		// program (focus reporting).
		const visited: string[] = [];
		const visit = (event: FocusEvent) =>
			visited.push(
				(event.target as Element).closest("[data-focus-zone]")?.getAttribute("data-focus-zone") ??
					"none",
			);
		document.addEventListener("focusin", visit);

		await press("Escape");

		document.removeEventListener("focusin", visit);
		expect(panel()?.querySelector("[data-own-escape]")).toBeNull();
		expect(zoneWithKeyboard()).toBe("files");
		expect(visited).not.toContain("pane");
	});
});

// The rail's Create, Rename and Delete group dialogs, refused (#734): each stays open and says why
// beside its buttons, and closes once the hub did it. What the reason is — the hub's, or that it
// did not answer — is tested in utils/hub-answer.spec.ts; how the dialog shows it, in
// GroupActionDialog.spec.ts.
describe("the host-group dialogs when the hub refuses", () => {
	const OPS: HostRow = {
		id: "01HZZZZZZZZZZZZZZZZZZZZHC3",
		label: "charlie",
		type: "ssh",
		host_group_id: "G1",
	};

	interface GroupDialog {
		title: string;
		request: string;
		open(): Promise<void>;
		confirm(): Promise<void>;
	}

	/** Type into the dialog's name field. */
	function typeName(name: string): void {
		const field = document.querySelector<HTMLInputElement>(".group-action-dialog .field-input");
		if (field === null) throw new Error("no name field");
		field.value = name;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}

	const DIALOGS: GroupDialog[] = [
		{
			title: "Create Group",
			request: "POST /api/host-groups",
			async open() {
				await rightClick(document.querySelector(".rail-hosts"));
				await click("Add new group");
			},
			async confirm() {
				typeName("dev");
				await settle(2);
				await click("Create", document.querySelector(".group-action-dialog") ?? document);
			},
		},
		{
			title: "Rename Group",
			request: "PUT /api/host-groups/G1",
			async open() {
				await rightClick(document.querySelector(".group-header"));
				await click("Rename Group");
			},
			async confirm() {
				typeName("dev");
				await settle(2);
				await click("Rename", document.querySelector(".group-action-dialog") ?? document);
			},
		},
		{
			title: "Delete Group",
			request: "DELETE /api/host-groups/G1",
			async open() {
				await rightClick(document.querySelector(".group-header"));
				await click("Delete Group");
			},
			async confirm() {
				await click("Delete", document.querySelector(".group-action-dialog") ?? document);
			},
		},
	];

	const groupWindow = () =>
		mountWindow({ hosts: [ALPHA, OPS], hostGroups: [{ id: "G1", name: "ops" }] });
	const dialogShown = () =>
		document.querySelector(".group-action-dialog .dialog-title")?.textContent?.trim() ?? null;
	const refusalShown = () =>
		document.querySelector('.group-action-dialog [role="alert"]')?.textContent?.trim() ?? null;
	const refuse = (hub: FakeHub, request: string) =>
		hub.answers.set(request, () =>
			json(
				{ error: { code: "GROUP_REFUSED", message: "The hub keeps that group as it is." } },
				409,
			),
		);

	it.each(DIALOGS)("keeps $title open with the hub's reason when it refuses", async (dialog) => {
		const { hub } = await groupWindow();
		refuse(hub, dialog.request);
		await dialog.open();

		await dialog.confirm();

		expect(dialogShown()).toBe(dialog.title);
		expect(refusalShown()).toBe("The hub keeps that group as it is.");
	});

	it.each(DIALOGS)("closes $title once the hub did it", async (dialog) => {
		const { hub } = await groupWindow();
		await dialog.open();

		await dialog.confirm();

		await vi.waitFor(() => expect(dialogShown()).toBeNull());
		expect(hub.rest.some((c) => `${c.method} ${c.path}` === dialog.request)).toBe(true);
	});

	// Closed only after the answer, never before it.
	it.each(DIALOGS)("keeps $title open until the hub answers", async (dialog) => {
		const { hub } = await groupWindow();
		let answer: (response: Response) => void = () => {};
		hub.answers.set(dialog.request, () => new Promise<Response>((resolve) => (answer = resolve)));
		await dialog.open();

		await dialog.confirm();
		expect(dialogShown()).toBe(dialog.title);

		answer(json({ ok: true }));
		await vi.waitFor(() => expect(dialogShown()).toBeNull());
	});

	it.each(DIALOGS)("opens $title without the last refusal", async (dialog) => {
		const { hub } = await groupWindow();
		refuse(hub, dialog.request);
		await dialog.open();
		await dialog.confirm();
		expect(refusalShown()).not.toBeNull();
		await click("Cancel", document.querySelector(".group-action-dialog") ?? document);
		expect(dialogShown()).toBeNull();

		await dialog.open();

		expect(dialogShown()).toBe(dialog.title);
		expect(refusalShown()).toBeNull();
	});
});
