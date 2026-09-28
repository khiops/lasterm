import { describe, expect, it } from "vitest";
import HOST_RAIL from "../components/HostRail.vue?raw";
import KEYBINDINGS from "../components/settings/categories/KeybindingsCategory.vue?raw";
import { isPaletteShortcut, PALETTE_SHORTCUT_KEYS } from "./palette-shortcut.js";

function key(k: string, mods: Partial<KeyboardEventInit> = {}, type = "keydown"): KeyboardEvent {
	return new KeyboardEvent(type, { key: k, ...mods });
}

describe("isPaletteShortcut", () => {
	it("is Ctrl+Shift+P, with Cmd standing in for Ctrl", () => {
		expect(isPaletteShortcut(key("P", { ctrlKey: true, shiftKey: true }))).toBe(true);
		expect(isPaletteShortcut(key("P", { metaKey: true, shiftKey: true }))).toBe(true);
		// Caps Lock turns Shift+P back into "p".
		expect(isPaletteShortcut(key("p", { ctrlKey: true, shiftKey: true }))).toBe(true);
	});

	it("is the chord on every event xterm hands its key handler", () => {
		for (const type of ["keydown", "keypress", "keyup"]) {
			expect(isPaletteShortcut(key("P", { ctrlKey: true, shiftKey: true }, type))).toBe(true);
		}
	});

	// Ctrl+K is the shell's: readline's kill-line, nano's cut (#624).
	it("leaves Ctrl+K, the palette's key before, alone", () => {
		expect(isPaletteShortcut(key("k", { ctrlKey: true }))).toBe(false);
		expect(isPaletteShortcut(key("K", { ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(isPaletteShortcut(key("k", { metaKey: true }))).toBe(false);
	});

	it("is no other chord of P", () => {
		expect(isPaletteShortcut(key("p", { ctrlKey: true }))).toBe(false);
		expect(isPaletteShortcut(key("P", { shiftKey: true }))).toBe(false);
		expect(isPaletteShortcut(key("p"))).toBe(false);
		expect(isPaletteShortcut(key("P", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(
			false,
		);
	});

	it("takes a keydown that carries no key for none", () => {
		expect(isPaletteShortcut(new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true }))).toBe(
			false,
		);
	});

	it("is the chord its keys name", () => {
		const [modifier, shift, letter] = PALETTE_SHORTCUT_KEYS;
		expect([modifier, shift]).toEqual(["Ctrl", "Shift"]);
		expect(PALETTE_SHORTCUT_KEYS).toHaveLength(3);
		expect(isPaletteShortcut(key(letter ?? "", { ctrlKey: true, shiftKey: true }))).toBe(true);
	});
});

describe("the palette's shortcut where it is named", () => {
	// Settings › Keybindings said Ctrl+P while Ctrl+K opened the palette.
	it("is what Settings › Keybindings shows", () => {
		expect(KEYBINDINGS).toContain('{ label: "Command Palette", keys: [...PALETTE_SHORTCUT_KEYS] }');
	});

	it("is what the rail's palette button says", () => {
		expect(HOST_RAIL).toContain("Command palette (Ctrl+Shift+P)");
		expect(HOST_RAIL).not.toContain("Ctrl+K");
	});
});
