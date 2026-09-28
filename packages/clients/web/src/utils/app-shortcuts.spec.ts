import { describe, expect, it } from "vitest";
import HOST_RAIL from "../components/HostRail.vue?raw";
import KEYBINDINGS from "../components/settings/categories/KeybindingsCategory.vue?raw";
import {
	APP_SHORTCUTS,
	type AppActionId,
	appShortcutOf,
	matchesChord,
	shortcutKeys,
	shortcutLabel,
} from "./app-shortcuts.js";

function key(k: string, mods: Partial<KeyboardEventInit> = {}, type = "keydown"): KeyboardEvent {
	return new KeyboardEvent(type, { key: k, ...mods });
}

const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };
const ALT_SHIFT = { altKey: true, shiftKey: true };

const IDS = Object.keys(APP_SHORTCUTS) as AppActionId[];

describe("the table of the app's shortcuts", () => {
	it("holds the palette, new and close tab, and the two splits", () => {
		expect(IDS).toEqual([
			"palette.open",
			"tab.new",
			"tab.close",
			"pane.splitRight",
			"pane.splitDown",
		]);
	});

	it("has Windows Terminal's chords", () => {
		expect(IDS.map(shortcutLabel)).toEqual([
			"Ctrl+Shift+P",
			"Ctrl+Shift+T",
			"Ctrl+Shift+W",
			"Alt+Shift+=",
			"Alt+Shift+-",
		]);
	});

	it("gives each chord to one action only", () => {
		const labels = IDS.map(shortcutLabel);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("names each chord's keys one cap each, modifiers first", () => {
		expect(shortcutKeys("tab.new")).toEqual(["Ctrl", "Shift", "T"]);
		expect(shortcutKeys("pane.splitDown")).toEqual(["Alt", "Shift", "-"]);
	});
});

describe("the palette's chord", () => {
	it("is Ctrl+Shift+P, with Cmd standing in for Ctrl", () => {
		expect(appShortcutOf(key("P", CTRL_SHIFT))).toBe("palette.open");
		expect(appShortcutOf(key("P", { metaKey: true, shiftKey: true }))).toBe("palette.open");
		// Caps Lock turns Shift+P back into "p".
		expect(appShortcutOf(key("p", CTRL_SHIFT))).toBe("palette.open");
	});

	// Ctrl+K is the shell's: readline's kill-line, nano's cut (#624).
	it("leaves Ctrl+K, the palette's key before, alone", () => {
		expect(appShortcutOf(key("k", { ctrlKey: true }))).toBeNull();
		expect(appShortcutOf(key("K", CTRL_SHIFT))).toBeNull();
		expect(appShortcutOf(key("k", { metaKey: true }))).toBeNull();
	});

	it("is no other chord of P", () => {
		expect(appShortcutOf(key("p", { ctrlKey: true }))).toBeNull();
		expect(appShortcutOf(key("P", { shiftKey: true }))).toBeNull();
		expect(appShortcutOf(key("p"))).toBeNull();
		expect(appShortcutOf(key("P", { ...CTRL_SHIFT, altKey: true }))).toBeNull();
	});
});

describe("the tab chords", () => {
	it("are Ctrl+Shift+T and Ctrl+Shift+W, in either case", () => {
		expect(appShortcutOf(key("T", CTRL_SHIFT))).toBe("tab.new");
		expect(appShortcutOf(key("t", CTRL_SHIFT))).toBe("tab.new");
		expect(appShortcutOf(key("W", CTRL_SHIFT))).toBe("tab.close");
		expect(appShortcutOf(key("w", CTRL_SHIFT))).toBe("tab.close");
	});

	// A shell's Ctrl+T transposes and its Ctrl+W deletes a word.
	it("leave Ctrl+T and Ctrl+W to the shell", () => {
		expect(appShortcutOf(key("t", { ctrlKey: true }))).toBeNull();
		expect(appShortcutOf(key("w", { ctrlKey: true }))).toBeNull();
	});

	it("are no other chord of T or W", () => {
		expect(appShortcutOf(key("T", { shiftKey: true }))).toBeNull();
		expect(appShortcutOf(key("T", ALT_SHIFT))).toBeNull();
		expect(appShortcutOf(key("W", { ...CTRL_SHIFT, altKey: true }))).toBeNull();
		// Alt+W toggles whole word in an open search.
		expect(appShortcutOf(key("w", { altKey: true }))).toBeNull();
	});
});

describe("the split chords", () => {
	it("are Alt+Shift+= and Alt+Shift+- on a US layout, where Shift makes them + and _", () => {
		expect(appShortcutOf(key("+", { ...ALT_SHIFT, code: "Equal" }))).toBe("pane.splitRight");
		expect(appShortcutOf(key("_", { ...ALT_SHIFT, code: "Minus" }))).toBe("pane.splitDown");
	});

	// AZERTY: the key right of 0 prints ) and °, and the next one = and +. QWERTZ: ß and ?,
	// then a dead accent. The chord is the physical key, whatever it prints.
	it("are the same two keys on AZERTY and QWERTZ", () => {
		expect(appShortcutOf(key("°", { ...ALT_SHIFT, code: "Minus" }))).toBe("pane.splitDown");
		expect(appShortcutOf(key("Dead", { ...ALT_SHIFT, code: "Equal" }))).toBe("pane.splitRight");
		expect(appShortcutOf(key("?", { ...ALT_SHIFT, code: "Minus" }))).toBe("pane.splitDown");
	});

	it("are not a key that prints = or - elsewhere on the keyboard", () => {
		// AZERTY's - is on the 6; the numeric keypad has its own.
		expect(appShortcutOf(key("-", { ...ALT_SHIFT, code: "Digit6" }))).toBeNull();
		expect(appShortcutOf(key("-", { ...ALT_SHIFT, code: "NumpadSubtract" }))).toBeNull();
		expect(appShortcutOf(key("=", { ...ALT_SHIFT, code: "Slash" }))).toBeNull();
	});

	// Ctrl+- and Ctrl+\ stay the shell's (readline's undo, SIGQUIT).
	it("need Alt and Shift, and nothing else", () => {
		expect(appShortcutOf(key("-", { ctrlKey: true, code: "Minus" }))).toBeNull();
		expect(appShortcutOf(key("\\", { ctrlKey: true, code: "Backslash" }))).toBeNull();
		expect(appShortcutOf(key("=", { altKey: true, code: "Equal" }))).toBeNull();
		expect(appShortcutOf(key("_", { shiftKey: true, code: "Minus" }))).toBeNull();
		// AltGr, which Windows reports as Ctrl+Alt.
		expect(appShortcutOf(key("}", { ...ALT_SHIFT, ctrlKey: true, code: "Equal" }))).toBeNull();
		expect(appShortcutOf(key("+", { ...ALT_SHIFT, metaKey: true, code: "Equal" }))).toBeNull();
	});
});

describe("matching an event", () => {
	it("matches every event xterm hands its key handler", () => {
		for (const type of ["keydown", "keypress", "keyup"]) {
			expect(appShortcutOf(key("P", CTRL_SHIFT, type))).toBe("palette.open");
			expect(appShortcutOf(key("W", CTRL_SHIFT, type))).toBe("tab.close");
			expect(appShortcutOf(key("_", { ...ALT_SHIFT, code: "Minus" }, type))).toBe("pane.splitDown");
		}
	});

	it("takes a keydown that carries no key for none", () => {
		expect(appShortcutOf(new KeyboardEvent("keydown", CTRL_SHIFT))).toBeNull();
		// A browser's autofill can send one whose `key` is not even set.
		const bare = new KeyboardEvent("keydown", CTRL_SHIFT);
		Object.defineProperty(bare, "key", { value: undefined });
		expect(appShortcutOf(bare)).toBeNull();
	});

	it("tests an event against a chord given as data", () => {
		const chord = { ctrl: false, alt: true, shift: false, key: "N" };
		expect(matchesChord(key("n", { altKey: true }), chord)).toBe(true);
		expect(matchesChord(key("n", { altKey: true, shiftKey: true }), chord)).toBe(false);
	});

	it("matches each action's chord as the table writes it", () => {
		for (const id of IDS) {
			const chord = APP_SHORTCUTS[id];
			const event = key(chord.key, {
				ctrlKey: chord.ctrl,
				altKey: chord.alt,
				shiftKey: chord.shift,
				...(chord.code !== undefined && { code: chord.code }),
			});
			expect(appShortcutOf(event)).toBe(id);
		}
	});
});

describe("the shortcuts where they are named", () => {
	// Settings › Keybindings said Ctrl+P while Ctrl+K opened the palette, and listed
	// Ctrl+T, Ctrl+W, Ctrl+\ and Ctrl+- that nothing handled (#624, #631).
	it("are what Settings › Keybindings shows, read from the table", () => {
		for (const [label, id] of [
			["Command Palette", "palette.open"],
			["New Channel", "tab.new"],
			["Close Tab", "tab.close"],
			["Split Right", "pane.splitRight"],
			["Split Down", "pane.splitDown"],
		]) {
			expect(KEYBINDINGS).toContain(`{ label: "${label}", keys: shortcutKeys("${id}") }`);
		}
		for (const stale of ['["Ctrl", "T"]', '["Ctrl", "W"]', '["Ctrl", "\\\\"]', '["Ctrl", "-"]']) {
			expect(KEYBINDINGS).not.toContain(stale);
		}
	});

	it("is what the rail's palette button says", () => {
		expect(HOST_RAIL).toContain(`Command palette (${shortcutLabel("palette.open")})`);
		expect(HOST_RAIL).not.toContain("Ctrl+K");
	});
});
