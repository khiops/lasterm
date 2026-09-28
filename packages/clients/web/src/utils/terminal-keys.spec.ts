import { describe, expect, it, vi } from "vitest";
import { altArrowSequence, type TerminalKeyTarget, terminalKeyHandler } from "./terminal-keys.js";

function key(k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
	return new KeyboardEvent("keydown", { key: k, altKey: true, ...mods });
}

describe("altArrowSequence", () => {
	it("sends Ctrl+arrow for Alt+arrow outside macOS", () => {
		expect(altArrowSequence(key("ArrowLeft"), false)).toBe("\x1b[1;5D");
		expect(altArrowSequence(key("ArrowRight"), false)).toBe("\x1b[1;5C");
		expect(altArrowSequence(key("ArrowUp"), false)).toBe("\x1b[1;5A");
		expect(altArrowSequence(key("ArrowDown"), false)).toBe("\x1b[1;5B");
	});

	it("sends the emacs word motions for Option+Left/Right on macOS", () => {
		expect(altArrowSequence(key("ArrowLeft"), true)).toBe("\x1bb");
		expect(altArrowSequence(key("ArrowRight"), true)).toBe("\x1bf");
		expect(altArrowSequence(key("ArrowUp"), true)).toBeNull();
	});

	it("leaves every other combination to xterm", () => {
		expect(altArrowSequence(key("ArrowLeft", { altKey: false }), false)).toBeNull();
		expect(altArrowSequence(key("ArrowLeft", { shiftKey: true }), false)).toBeNull();
		expect(altArrowSequence(key("ArrowLeft", { ctrlKey: true }), false)).toBeNull();
		expect(altArrowSequence(key("ArrowLeft", { metaKey: true }), true)).toBeNull();
		expect(altArrowSequence(key("b"), false)).toBeNull();
	});
});

describe("terminalKeyHandler", () => {
	function pane(opts: { searchOpen?: boolean; selection?: boolean } = {}) {
		const target = {
			openSearch: vi.fn(),
			isSearchOpen: () => opts.searchOpen ?? false,
			input: vi.fn(),
			hasSelection: () => opts.selection ?? false,
			isMac: false,
		} satisfies TerminalKeyTarget;
		return { target, handle: terminalKeyHandler(target) };
	}

	function event(type: string, k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
		return new KeyboardEvent(type, { key: k, ...mods });
	}

	// `false` is the only way to keep a key from the PTY: xterm ignores
	// defaultPrevented, so the chord that opened the palette reached the shell (#624).
	it("keeps the palette's shortcut from the PTY, on every event of it", () => {
		const { target, handle } = pane();
		for (const type of ["keydown", "keypress", "keyup"]) {
			expect(handle(event(type, "P", { ctrlKey: true, shiftKey: true }))).toBe(false);
			expect(handle(event(type, "P", { metaKey: true, shiftKey: true }))).toBe(false);
		}
		expect(target.input).not.toHaveBeenCalled();
		expect(target.openSearch).not.toHaveBeenCalled();
	});

	it("leaves Ctrl+K to xterm, which sends it to the shell", () => {
		const { handle } = pane();
		for (const type of ["keydown", "keypress", "keyup"]) {
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

	it("sends Alt+arrow as the word motion, on keydown only", () => {
		const { target, handle } = pane();
		expect(handle(event("keydown", "ArrowLeft", { altKey: true }))).toBe(false);
		expect(handle(event("keyup", "ArrowLeft", { altKey: true }))).toBe(false);
		expect(target.input).toHaveBeenCalledTimes(1);
		expect(target.input).toHaveBeenCalledWith("\x1b[1;5D");
	});

	it("leaves paste, and copy of a selection, to the browser", () => {
		expect(pane().handle(event("keydown", "v", { ctrlKey: true }))).toBe(false);
		expect(pane({ selection: true }).handle(event("keydown", "c", { ctrlKey: true }))).toBe(false);
		expect(pane().handle(event("keydown", "c", { ctrlKey: true }))).toBe(true);
	});
});
