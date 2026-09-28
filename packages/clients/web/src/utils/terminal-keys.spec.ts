import { describe, expect, it, vi } from "vitest";
import { APP_SHORTCUTS, type AppActionId } from "./app-shortcuts.js";
import { type TerminalKeyTarget, terminalKeyHandler } from "./terminal-keys.js";

type KeyInit = Partial<KeyboardEventInit> & { altGraph?: boolean };

/**
 * A key event as a browser reports it. AltGraph is held only for AltGr: happy-dom answers
 * `getModifierState("AltGraph")` with `altKey`, which would make every Alt chord AltGr.
 */
function event(type: string, k: string, mods: KeyInit = {}): KeyboardEvent {
	const { altGraph = false, ...init } = mods;
	const ev = new KeyboardEvent(type, { key: k, ...init });
	Object.defineProperty(ev, "getModifierState", {
		value: (name: string) => (name === "AltGraph" ? altGraph : false),
	});
	return ev;
}

const TYPES = ["keydown", "keypress", "keyup"];

describe("terminalKeyHandler", () => {
	function pane(opts: { searchOpen?: boolean; selection?: boolean } = {}) {
		const target = {
			openSearch: vi.fn(),
			isSearchOpen: () => opts.searchOpen ?? false,
			hasSelection: () => opts.selection ?? false,
		} satisfies TerminalKeyTarget;
		return { target, handle: terminalKeyHandler(target) };
	}

	// `false` is the only way to keep a key from the PTY: xterm ignores
	// defaultPrevented, so the chord that opened the palette reached the shell (#624).
	it("keeps the palette's shortcut from the PTY, on every event of it", () => {
		const { target, handle } = pane();
		for (const type of TYPES) {
			expect(handle(event(type, "P", { ctrlKey: true, shiftKey: true }))).toBe(false);
			expect(handle(event(type, "P", { metaKey: true, shiftKey: true }))).toBe(false);
		}
		expect(target.openSearch).not.toHaveBeenCalled();
	});

	// The window runs them; a terminal with the keyboard must not also send them (#631, #637).
	it("keeps every chord of the table from the PTY, on every event of it", () => {
		const { target, handle } = pane();
		for (const id of Object.keys(APP_SHORTCUTS) as AppActionId[]) {
			const chord = APP_SHORTCUTS[id];
			const mods = {
				ctrlKey: chord.ctrl,
				altKey: chord.alt,
				shiftKey: chord.shift,
				...(chord.code !== undefined && { code: chord.code }),
			};
			// An arrow's `key` is its name, not the cap the table shows.
			const k = chord.code?.startsWith("Arrow") === true ? chord.code : chord.key;
			for (const type of TYPES) {
				expect(handle(event(type, k, mods)), `${type} ${id}`).toBe(false);
			}
		}
		expect(target.openSearch).not.toHaveBeenCalled();
	});

	it("keeps the chords from the PTY as other layouts report them", () => {
		const { handle } = pane();
		const chords: [string, KeyInit][] = [
			// US: Shift turns = and - into + and _.
			["+", { altKey: true, shiftKey: true, code: "Equal" }],
			["_", { altKey: true, shiftKey: true, code: "Minus" }],
			// AZERTY: Shift turns the key right of 0 into °, and the 1 key types &.
			["°", { altKey: true, shiftKey: true, code: "Minus" }],
			["&", { ctrlKey: true, altKey: true, code: "Digit1" }],
			["ç", { ctrlKey: true, altKey: true, code: "Digit9" }],
			["w", { ctrlKey: true, shiftKey: true, code: "KeyW" }],
		];
		for (const [k, mods] of chords) {
			for (const type of TYPES) {
				expect(handle(event(type, k, mods)), `${type} ${k}`).toBe(false);
			}
		}
	});

	// A browser reports AltGr as Ctrl+Alt; on AZERTY, AltGr+3 types # (#637).
	it("lets AltGr+digits through to xterm, which types their character", () => {
		const { handle } = pane();
		const altGr: [string, string][] = [
			["~", "Digit2"],
			["#", "Digit3"],
			["{", "Digit4"],
			["[", "Digit5"],
			["|", "Digit6"],
			["\\", "Digit8"],
			["^", "Digit9"],
			["@", "Digit0"],
		];
		for (const [k, code] of altGr) {
			for (const type of TYPES) {
				const ev = event(type, k, { ctrlKey: true, altKey: true, altGraph: true, code });
				expect(handle(ev), `${type} AltGr+${code}`).toBe(true);
			}
		}
	});

	// A shell moves by word on Ctrl+←/→, as in Windows Terminal: xterm sends them as they are.
	it("lets Ctrl+arrows and plain arrows through to xterm", () => {
		const { handle } = pane();
		for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			for (const type of TYPES) {
				expect(handle(event(type, arrow, { ctrlKey: true, code: arrow })), arrow).toBe(true);
				expect(handle(event(type, arrow, { code: arrow })), arrow).toBe(true);
				expect(handle(event(type, arrow, { shiftKey: true, code: arrow })), arrow).toBe(true);
			}
		}
	});

	// Alt+arrows were rewritten into a word motion, as xterm 5 did (#340); they move between
	// panes now, and nothing of them reaches the shell (#637).
	it("sends nothing for Alt+arrows, which move between panes", () => {
		const { handle } = pane();
		for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			for (const type of TYPES) {
				expect(handle(event(type, arrow, { altKey: true, code: arrow }))).toBe(false);
			}
		}
	});

	// A shell's own: transpose, delete a word, readline's undo, SIGQUIT.
	it("leaves Ctrl+T, Ctrl+W, Ctrl+- and Ctrl+\\ to xterm, which sends them to the shell", () => {
		const { handle } = pane();
		for (const type of TYPES) {
			expect(handle(event(type, "t", { ctrlKey: true, code: "KeyT" }))).toBe(true);
			expect(handle(event(type, "w", { ctrlKey: true, code: "KeyW" }))).toBe(true);
			expect(handle(event(type, "-", { ctrlKey: true, code: "Minus" }))).toBe(true);
			expect(handle(event(type, "\\", { ctrlKey: true, code: "Backslash" }))).toBe(true);
		}
		// Alt+= and Alt+- without Shift, which readline binds too.
		expect(handle(event("keydown", "=", { altKey: true, code: "Equal" }))).toBe(true);
		expect(handle(event("keydown", "-", { altKey: true, code: "Minus" }))).toBe(true);
		// Tab and Shift+Tab complete; F5 and Ctrl+F6 are a program's.
		expect(handle(event("keydown", "Tab", { code: "Tab" }))).toBe(true);
		expect(handle(event("keydown", "Tab", { shiftKey: true, code: "Tab" }))).toBe(true);
		expect(handle(event("keydown", "F5", { code: "F5" }))).toBe(true);
		expect(handle(event("keydown", "F6", { ctrlKey: true, code: "F6" }))).toBe(true);
	});

	it("leaves Ctrl+K to xterm, which sends it to the shell", () => {
		const { handle } = pane();
		for (const type of TYPES) {
			expect(handle(event(type, "k", { ctrlKey: true }))).toBe(true);
		}
		// Ctrl+P too: the shell's previous-history.
		expect(handle(event("keydown", "p", { ctrlKey: true }))).toBe(true);
	});

	it("opens search on Ctrl+Shift+F, once, without sending it", () => {
		const { target, handle } = pane();
		expect(handle(event("keydown", "F", { ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(handle(event("keyup", "F", { ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(target.openSearch).toHaveBeenCalledTimes(1);
	});

	it("gives Escape and Alt+C/R/W to an open search", () => {
		expect(pane({ searchOpen: true }).handle(event("keydown", "Escape"))).toBe(false);
		expect(pane({ searchOpen: true }).handle(event("keydown", "r", { altKey: true }))).toBe(false);
		expect(pane().handle(event("keydown", "Escape"))).toBe(true);
		expect(pane().handle(event("keydown", "r", { altKey: true }))).toBe(true);
	});

	it("leaves paste, and copy of a selection, to the browser", () => {
		expect(pane().handle(event("keydown", "v", { ctrlKey: true }))).toBe(false);
		expect(pane({ selection: true }).handle(event("keydown", "c", { ctrlKey: true }))).toBe(false);
		expect(pane().handle(event("keydown", "c", { ctrlKey: true }))).toBe(true);
	});
});
