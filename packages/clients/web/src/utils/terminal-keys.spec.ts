import { describe, expect, it } from "vitest";
import { altArrowSequence } from "./terminal-keys.js";

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
