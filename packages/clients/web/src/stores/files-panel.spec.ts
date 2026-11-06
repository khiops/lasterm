/**
 * The files panel's state (#836): open or closed, the terminal it is attached to, its pin, what
 * it remembers per terminal in this browser, and the terminals' live directories (#834).
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { liveCwdOf, REMEMBERED_TERMINALS, useFilesPanelStore } from "./files-panel.js";

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FAB";

beforeEach(() => {
	localStorage.clear();
	setActivePinia(createPinia());
});

function panelOn(...inTabs: string[]) {
	const store = useFilesPanelStore();
	store.setChannelsInTabs(new Set(inTabs));
	return store;
}

describe("opening and closing", () => {
	it("opens on the focused terminal, and closes", () => {
		const store = panelOn(A, B);
		store.setFocused(A);
		expect(store.open).toBe(false);
		store.openFor(null);
		expect(store.open).toBe(true);
		expect(store.attachedChannelId).toBe(A);
		expect(store.isOpenOn(A)).toBe(true);
		expect(store.isOpenOn(B)).toBe(false);
		store.close();
		expect(store.open).toBe(false);
		expect(store.isOpenOn(A)).toBe(false);
	});

	// A pane's folder button: pressed while the panel shows its terminal.
	it("toggles from a pane's folder button, on that pane's terminal", () => {
		const store = panelOn(A, B);
		store.setFocused(A);
		store.toggleFor(A);
		expect(store.isOpenOn(A)).toBe(true);
		store.toggleFor(A);
		expect(store.open).toBe(false);
	});

	// The button of a pane that is not the focused one: its pane takes the focus (App.vue).
	it("asks for the pane of a terminal that is not the focused one", () => {
		const store = panelOn(A, B);
		store.setFocused(A);
		store.toggleFor(B);
		expect(store.open).toBe(true);
		expect(store.paneRequest).toEqual({ channelId: B, at: 1 });
		store.setFocused(B);
		expect(store.isOpenOn(B)).toBe(true);
		// Pressed again, it closes.
		store.toggleFor(B);
		expect(store.open).toBe(false);
	});

	it("asks for the keyboard when an entry point says so", () => {
		const store = panelOn(A);
		store.setFocused(A);
		store.openFor(null);
		expect(store.keyboardRequests).toBe(0);
		store.openFor(A, { keyboard: true });
		expect(store.keyboardRequests).toBe(1);
	});

	it("remembers being open in this browser", () => {
		panelOn(A).openFor(null);
		setActivePinia(createPinia());
		expect(useFilesPanelStore().open).toBe(true);
		useFilesPanelStore().close();
		setActivePinia(createPinia());
		expect(useFilesPanelStore().open).toBe(false);
	});
});

describe("the focus and the pin", () => {
	it("follows the focus from terminal to terminal", () => {
		const store = panelOn(A, B);
		store.setFocused(A);
		store.openFor(null);
		store.setFocused(B);
		expect(store.attachedChannelId).toBe(B);
		// An empty pane: no terminal.
		store.setFocused(null);
		expect(store.attachedChannelId).toBeNull();
	});

	it("holds on the pinned terminal while the focus moves, and lets go when unpinned", () => {
		const store = panelOn(A, B);
		store.setFocused(A);
		store.openFor(null);
		store.togglePin();
		expect(store.pinned).toBe(true);
		store.setFocused(B);
		expect(store.attachedChannelId).toBe(A);
		expect(store.isOpenOn(A)).toBe(true);
		store.togglePin();
		expect(store.pinned).toBe(false);
		expect(store.attachedChannelId).toBe(B);
	});

	it("moves the pin to the terminal an entry point names", () => {
		const store = panelOn(A, B);
		store.setFocused(A);
		store.openFor(null);
		store.togglePin();
		store.openFor(B);
		expect(store.attachedChannelId).toBe(B);
		expect(store.pinned).toBe(true);
		expect(store.paneRequest).toBeNull();
	});

	it("follows the focus again once no tab shows the pinned terminal, and remembers the pin", () => {
		const store = panelOn(A, B);
		store.setFocused(B);
		store.setPin(A);
		expect(store.attachedChannelId).toBe(A);
		store.setChannelsInTabs(new Set([B]));
		expect(store.attachedChannelId).toBe(B);
		expect(store.pinned).toBe(false);
		setActivePinia(createPinia());
		expect(useFilesPanelStore().pinnedChannelId).toBe(A);
	});
});

describe("following the directory, per terminal", () => {
	it("follows by default as the setting says, until a folder is browsed", () => {
		const store = panelOn(A);
		expect(store.terminalFiles(A, true)).toEqual({ following: true, path: null });
		expect(store.terminalFiles(A, false)).toEqual({ following: false, path: null });
		store.browse(A, "/var/log");
		expect(store.terminalFiles(A, true)).toEqual({ following: false, path: "/var/log" });
		// "Go there", or the toggle: following again.
		store.follow(A);
		expect(store.terminalFiles(A, false)).toEqual({ following: true, path: null });
	});

	it("keeps each terminal's own, in this browser", () => {
		const store = panelOn(A, B);
		store.browse(A, "/srv");
		expect(store.terminalFiles(B, true)).toEqual({ following: true, path: null });
		setActivePinia(createPinia());
		expect(useFilesPanelStore().terminalFiles(A, true)).toEqual({ following: false, path: "/srv" });
	});

	it("forgets the oldest terminals past the hundredth", () => {
		const store = panelOn();
		for (let i = 0; i <= REMEMBERED_TERMINALS; i++) store.browse(`T${i}`, `/d${i}`);
		expect(Object.keys(store.terminals)).toHaveLength(REMEMBERED_TERMINALS);
		expect(store.terminals.T0).toBeUndefined();
		expect(store.terminals[`T${REMEMBERED_TERMINALS}`]).toEqual({
			following: false,
			path: `/d${REMEMBERED_TERMINALS}`,
		});
	});
});

describe("the terminals' live directories (#834)", () => {
	it("reads CWD_CHANGE, and ATTACH_OK's and STATE_SYNC's fields, only when they say one", () => {
		expect(liveCwdOf({ channelId: A, cwd: "/home/pi", source: "process", atPrompt: true })).toEqual(
			{
				cwd: "/home/pi",
				source: "process",
				atPrompt: true,
			},
		);
		expect(
			liveCwdOf({ channelId: A, cwd: "C:\\x", cwdSource: "shell", foreground: "vim" }),
		).toEqual({
			cwd: "C:\\x",
			source: "shell",
			foreground: "vim",
		});
		expect(liveCwdOf({ cwd: null, source: "shell", otherHost: "db01" })).toEqual({
			cwd: null,
			source: "shell",
			otherHost: "db01",
		});
		// A hub that does not relay it: ATTACH_OK without the fields.
		expect(liveCwdOf({ channelId: A, snapshot: {} })).toBeNull();
		expect(liveCwdOf({ cwd: "/x", source: "guess" })).toBeNull();
	});

	it("keeps the last one per terminal, and forgets it when the terminal ends", () => {
		const store = panelOn(A);
		store.takeCwd({ channelId: A, cwd: "/a", source: "process" });
		store.takeCwd({ channelId: A, snapshot: {} });
		expect(store.liveCwdFor(A)?.cwd).toBe("/a");
		store.takeCwd({ channelId: A, cwd: "/b", source: "shell" });
		expect(store.liveCwdFor(A)).toEqual({ cwd: "/b", source: "shell" });
		store.forgetCwd(A);
		expect(store.liveCwdFor(A)).toBeUndefined();
	});
});

describe("Options, the split and Transfers, in this browser", () => {
	it("remembers each", () => {
		const store = panelOn();
		expect([store.optionsExpanded, store.transfersCollapsed, store.transfersShare]).toEqual([
			false,
			false,
			0.3,
		]);
		store.setOptionsExpanded(true);
		store.setTransfersCollapsed(true);
		store.setTransfersShare(0.95);
		setActivePinia(createPinia());
		const again = useFilesPanelStore();
		expect([again.optionsExpanded, again.transfersCollapsed, again.transfersShare]).toEqual([
			true,
			true,
			0.7,
		]);
		again.resetTransfersShare();
		setActivePinia(createPinia());
		expect(useFilesPanelStore().transfersShare).toBe(0.3);
	});
});
