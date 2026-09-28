import { afterEach, beforeEach, describe, expect, it } from "vitest";
import HOST_RAIL from "../components/HostRail.vue?raw";
import {
	APP_SHORTCUTS,
	type AppActionId,
	appShortcutOf,
	keyboardPlaceOf,
	matchesChord,
	movesKeyboard,
	OUTSIDE_TERMINAL_SHORTCUTS,
	outsideTerminalKeys,
	paneMoveOf,
	shortcutKeys,
	shortcutLabel,
	TAB_NUMBERS,
	tabNumberOf,
	windowShortcutOf,
} from "./app-shortcuts.js";

type KeyInit = Partial<KeyboardEventInit> & { altGraph?: boolean };

/**
 * A key event as a browser reports it. AltGraph is held only for AltGr: happy-dom answers
 * `getModifierState("AltGraph")` with `altKey`, which would make every Alt chord AltGr.
 */
function key(k: string, mods: KeyInit = {}, type = "keydown"): KeyboardEvent {
	const { altGraph = false, ...init } = mods;
	const event = new KeyboardEvent(type, { key: k, ...init });
	Object.defineProperty(event, "getModifierState", {
		value: (name: string) =>
			({
				AltGraph: altGraph,
				Alt: event.altKey,
				Control: event.ctrlKey,
				Meta: event.metaKey,
				Shift: event.shiftKey,
			})[name] ?? false,
	});
	return event;
}

const CTRL_SHIFT = { ctrlKey: true, shiftKey: true };
const CTRL_ALT = { ctrlKey: true, altKey: true };
const ALT_SHIFT = { altKey: true, shiftKey: true };
/** AltGr on Windows: Ctrl and Alt both set, and AltGraph held. */
const ALT_GR = { ctrlKey: true, altKey: true, altGraph: true };

const IDS = Object.keys(APP_SHORTCUTS) as AppActionId[];

describe("the table of the app's shortcuts", () => {
	it("holds the palette, Settings, the tabs, the panes and the focus zones", () => {
		expect(IDS).toEqual([
			"palette.open",
			"settings.open",
			"tab.new",
			"tab.next",
			"tab.previous",
			...TAB_NUMBERS.map((n) => `tab.goTo${n}`),
			"pane.splitRight",
			"pane.splitDown",
			"pane.close",
			"pane.focusLeft",
			"pane.focusRight",
			"pane.focusUp",
			"pane.focusDown",
			"pane.resizeLeft",
			"pane.resizeRight",
			"pane.resizeUp",
			"pane.resizeDown",
			"zone.next",
			"zone.previous",
		]);
	});

	it("has Windows Terminal's chords, and Windows' F6", () => {
		expect(IDS.map(shortcutLabel)).toEqual([
			"Ctrl+Shift+P",
			"Ctrl+,",
			"Ctrl+Shift+T",
			"Ctrl+Tab",
			"Ctrl+Shift+Tab",
			...TAB_NUMBERS.map((n) => `Ctrl+Alt+${n}`),
			"Alt+Shift+=",
			"Alt+Shift+-",
			"Ctrl+Shift+W",
			"Alt+←",
			"Alt+→",
			"Alt+↑",
			"Alt+↓",
			"Alt+Shift+←",
			"Alt+Shift+→",
			"Alt+Shift+↑",
			"Alt+Shift+↓",
			"Ctrl+F6",
			"Ctrl+Shift+F6",
		]);
	});

	it("gives F6 and Shift+F6 to the zones outside a terminal only", () => {
		expect(Object.keys(OUTSIDE_TERMINAL_SHORTCUTS)).toEqual(["zone.next", "zone.previous"]);
		expect(outsideTerminalKeys("zone.next")).toEqual(["F6"]);
		expect(outsideTerminalKeys("zone.previous")).toEqual(["Shift", "F6"]);
		expect(outsideTerminalKeys("pane.close")).toBeNull();
	});

	it("gives each chord to one action only, those for outside a terminal included", () => {
		const labels = [
			...IDS.map(shortcutLabel),
			...IDS.flatMap((id) => outsideTerminalKeys(id)?.join("+") ?? []),
		];
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("names each chord's keys one cap each, modifiers first", () => {
		expect(shortcutKeys("tab.new")).toEqual(["Ctrl", "Shift", "T"]);
		expect(shortcutKeys("pane.splitDown")).toEqual(["Alt", "Shift", "-"]);
		expect(shortcutKeys("tab.goTo3")).toEqual(["Ctrl", "Alt", "3"]);
		expect(shortcutKeys("pane.resizeUp")).toEqual(["Alt", "Shift", "↑"]);
		expect(shortcutKeys("zone.previous")).toEqual(["Ctrl", "Shift", "F6"]);
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
	it("are Ctrl+Shift+T for a new tab, in either case", () => {
		expect(appShortcutOf(key("T", CTRL_SHIFT))).toBe("tab.new");
		expect(appShortcutOf(key("t", CTRL_SHIFT))).toBe("tab.new");
	});

	it("are Ctrl+Tab and Ctrl+Shift+Tab for the next and the previous tab", () => {
		expect(appShortcutOf(key("Tab", { ctrlKey: true, code: "Tab" }))).toBe("tab.next");
		expect(appShortcutOf(key("Tab", { ...CTRL_SHIFT, code: "Tab" }))).toBe("tab.previous");
		// Tab and Shift+Tab stay the terminal's, and the page's.
		expect(appShortcutOf(key("Tab", { code: "Tab" }))).toBeNull();
		expect(appShortcutOf(key("Tab", { shiftKey: true, code: "Tab" }))).toBeNull();
		expect(appShortcutOf(key("Tab", { altKey: true, code: "Tab" }))).toBeNull();
	});

	it("are Ctrl+Alt+1..9 on the digit row of a US keyboard", () => {
		for (const n of TAB_NUMBERS) {
			expect(appShortcutOf(key(String(n), { ...CTRL_ALT, code: `Digit${n}` }))).toBe(
				`tab.goTo${n}`,
			);
		}
	});

	// AZERTY's digit row types & é " ' ( - è _ ç without Shift: the chord is the key, whatever
	// it prints.
	it("are the same keys on AZERTY", () => {
		const row = ["&", "é", '"', "'", "(", "-", "è", "_", "ç"];
		row.forEach((printed, i) => {
			expect(appShortcutOf(key(printed, { ...CTRL_ALT, code: `Digit${i + 1}` }))).toBe(
				`tab.goTo${i + 1}`,
			);
		});
	});

	it("are no other chord of the digits", () => {
		// Ctrl+Shift+1..9 open profile N (App.vue), and Ctrl+1 and Alt+1 are the shell's.
		expect(appShortcutOf(key("!", { ...CTRL_SHIFT, code: "Digit1" }))).toBeNull();
		expect(appShortcutOf(key("1", { ctrlKey: true, code: "Digit1" }))).toBeNull();
		expect(appShortcutOf(key("1", { altKey: true, code: "Digit1" }))).toBeNull();
		expect(appShortcutOf(key("0", { ...CTRL_ALT, code: "Digit0" }))).toBeNull();
		expect(appShortcutOf(key("1", { ...CTRL_ALT, code: "Numpad1" }))).toBeNull();
	});
});

// A browser on Windows reports AltGr as Ctrl+Alt: on AZERTY, AltGr+digit types ~ # { [ | ` \ ^ @,
// which Ctrl+Alt+digit would otherwise have taken for a tab (#637).
describe("AltGr", () => {
	const AZERTY_ALT_GR: [string, string][] = [
		["~", "Digit2"],
		["#", "Digit3"],
		["{", "Digit4"],
		["[", "Digit5"],
		["|", "Digit6"],
		["`", "Digit7"],
		["\\", "Digit8"],
		["^", "Digit9"],
		["@", "Digit0"],
		["]", "Minus"],
		["}", "Equal"],
	];

	it("is no chord: AltGr+3 on AZERTY is #", () => {
		expect(appShortcutOf(key("#", { ...ALT_GR, code: "Digit3" }))).toBeNull();
		for (const [printed, code] of AZERTY_ALT_GR) {
			for (const type of ["keydown", "keypress", "keyup"]) {
				expect(
					appShortcutOf(key(printed, { ...ALT_GR, code }, type)),
					`${code} ${type}`,
				).toBeNull();
			}
		}
	});

	it("is no chord whatever else is held with it", () => {
		for (const id of IDS) {
			const chord = APP_SHORTCUTS[id];
			const event = key(chord.key, {
				ctrlKey: chord.ctrl,
				altKey: chord.alt,
				shiftKey: chord.shift,
				altGraph: true,
				...(chord.code !== undefined && { code: chord.code }),
			});
			expect(matchesChord(event, chord), id).toBe(false);
		}
	});

	it("leaves the same keys with Ctrl and Alt, and no AltGr, to their chord", () => {
		expect(appShortcutOf(key("#", { ...CTRL_ALT, code: "Digit3" }))).toBe("tab.goTo3");
	});

	it("tolerates an event that cannot say which modifiers are held", () => {
		const bare = new KeyboardEvent("keydown", { key: "3", ...CTRL_ALT, code: "Digit3" });
		Object.defineProperty(bare, "getModifierState", { value: undefined });
		expect(appShortcutOf(bare)).toBe("tab.goTo3");
	});
});

describe("the pane chords", () => {
	it("are Alt+Shift+= and Alt+Shift+- on a US layout, where Shift makes them + and _", () => {
		expect(appShortcutOf(key("+", { ...ALT_SHIFT, code: "Equal" }))).toBe("pane.splitRight");
		expect(appShortcutOf(key("_", { ...ALT_SHIFT, code: "Minus" }))).toBe("pane.splitDown");
	});

	// AZERTY: the key right of 0 prints ) and °, and the next one = and +. QWERTZ: ß and ?,
	// then a dead accent. The chord is the physical key, whatever it prints.
	it("split on the same two keys on AZERTY and QWERTZ", () => {
		expect(appShortcutOf(key("°", { ...ALT_SHIFT, code: "Minus" }))).toBe("pane.splitDown");
		expect(appShortcutOf(key("Dead", { ...ALT_SHIFT, code: "Equal" }))).toBe("pane.splitRight");
		expect(appShortcutOf(key("?", { ...ALT_SHIFT, code: "Minus" }))).toBe("pane.splitDown");
	});

	it("do not split on a key that prints = or - elsewhere on the keyboard", () => {
		// AZERTY's - is on the 6; the numeric keypad has its own.
		expect(appShortcutOf(key("-", { ...ALT_SHIFT, code: "Digit6" }))).toBeNull();
		expect(appShortcutOf(key("-", { ...ALT_SHIFT, code: "NumpadSubtract" }))).toBeNull();
		expect(appShortcutOf(key("=", { ...ALT_SHIFT, code: "Slash" }))).toBeNull();
	});

	// Ctrl+- and Ctrl+\ stay the shell's (readline's undo, SIGQUIT).
	it("split with Alt and Shift, and nothing else", () => {
		expect(appShortcutOf(key("-", { ctrlKey: true, code: "Minus" }))).toBeNull();
		expect(appShortcutOf(key("\\", { ctrlKey: true, code: "Backslash" }))).toBeNull();
		expect(appShortcutOf(key("=", { altKey: true, code: "Equal" }))).toBeNull();
		expect(appShortcutOf(key("_", { shiftKey: true, code: "Minus" }))).toBeNull();
		expect(appShortcutOf(key("}", { ...ALT_SHIFT, ctrlKey: true, code: "Equal" }))).toBeNull();
		expect(appShortcutOf(key("+", { ...ALT_SHIFT, metaKey: true, code: "Equal" }))).toBeNull();
	});

	// Windows Terminal's: Ctrl+Shift+W closed the whole tab until #637.
	it("close the focused pane on Ctrl+Shift+W, in either case", () => {
		expect(appShortcutOf(key("W", CTRL_SHIFT))).toBe("pane.close");
		expect(appShortcutOf(key("w", CTRL_SHIFT))).toBe("pane.close");
	});

	// A shell's Ctrl+T transposes and its Ctrl+W deletes a word.
	it("leave Ctrl+T and Ctrl+W to the shell", () => {
		expect(appShortcutOf(key("t", { ctrlKey: true }))).toBeNull();
		expect(appShortcutOf(key("w", { ctrlKey: true }))).toBeNull();
		expect(appShortcutOf(key("T", { shiftKey: true }))).toBeNull();
		expect(appShortcutOf(key("T", ALT_SHIFT))).toBeNull();
		expect(appShortcutOf(key("W", { ...CTRL_SHIFT, altKey: true }))).toBeNull();
		// Alt+W toggles whole word in an open search.
		expect(appShortcutOf(key("w", { altKey: true }))).toBeNull();
	});

	it("move the focus on Alt+arrows, and the dividers on Alt+Shift+arrows", () => {
		const arrows = [
			["ArrowLeft", "Left"],
			["ArrowRight", "Right"],
			["ArrowUp", "Up"],
			["ArrowDown", "Down"],
		] as const;
		for (const [arrow, side] of arrows) {
			expect(appShortcutOf(key(arrow, { altKey: true, code: arrow }))).toBe(`pane.focus${side}`);
			expect(appShortcutOf(key(arrow, { ...ALT_SHIFT, code: arrow }))).toBe(`pane.resize${side}`);
		}
	});

	// The shell moves by word on Ctrl+←/→, as in Windows Terminal; a plain or shifted arrow is
	// the shell's too, and the keypad's arrows are Alt codes on Windows.
	it("leave every other arrow alone", () => {
		for (const arrow of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			expect(appShortcutOf(key(arrow, { code: arrow }))).toBeNull();
			expect(appShortcutOf(key(arrow, { ctrlKey: true, code: arrow }))).toBeNull();
			expect(appShortcutOf(key(arrow, { shiftKey: true, code: arrow }))).toBeNull();
			expect(appShortcutOf(key(arrow, { ...CTRL_SHIFT, code: arrow }))).toBeNull();
			expect(appShortcutOf(key(arrow, { ...CTRL_ALT, code: arrow }))).toBeNull();
		}
		expect(appShortcutOf(key("ArrowLeft", { altKey: true, code: "Numpad4" }))).toBeNull();
	});
});

// htop sorts and Midnight Commander moves files with F6: in a terminal it is theirs. Elsewhere
// it moves between the zones, as Windows' F6 does, and Ctrl+F6 does from anywhere.
describe("the focus zone chords", () => {
	const F6 = { code: "F6" };
	const SHIFT_F6 = { shiftKey: true, code: "F6" };
	const CTRL_F6 = { ctrlKey: true, code: "F6" };
	const CTRL_SHIFT_F6 = { ...CTRL_SHIFT, code: "F6" };

	it("are Ctrl+F6 and Ctrl+Shift+F6 anywhere, a terminal included", () => {
		for (const place of ["terminal", "elsewhere"] as const) {
			expect(appShortcutOf(key("F6", CTRL_F6), place)).toBe("zone.next");
			expect(appShortcutOf(key("F6", CTRL_SHIFT_F6), place)).toBe("zone.previous");
		}
	});

	it("are F6 and Shift+F6 outside a terminal only", () => {
		expect(appShortcutOf(key("F6", F6), "elsewhere")).toBe("zone.next");
		expect(appShortcutOf(key("F6", SHIFT_F6), "elsewhere")).toBe("zone.previous");
		expect(appShortcutOf(key("F6", F6), "terminal")).toBeNull();
		expect(appShortcutOf(key("F6", SHIFT_F6), "terminal")).toBeNull();
		// A terminal's key handler asks without saying: the strict set.
		expect(appShortcutOf(key("F6", F6))).toBeNull();
	});

	it("are no other chord of F6", () => {
		for (const place of ["terminal", "elsewhere"] as const) {
			expect(appShortcutOf(key("F6", { altKey: true, code: "F6" }), place)).toBeNull();
			expect(appShortcutOf(key("F6", { ...CTRL_ALT, code: "F6" }), place)).toBeNull();
			expect(appShortcutOf(key("F5", { code: "F5" }), place)).toBeNull();
		}
	});

	it("leave the other chords the same outside a terminal", () => {
		for (const id of IDS) {
			const chord = APP_SHORTCUTS[id];
			const event = key(chord.key, {
				ctrlKey: chord.ctrl,
				altKey: chord.alt,
				shiftKey: chord.shift,
				...(chord.code !== undefined && { code: chord.code }),
			});
			expect(appShortcutOf(event, "elsewhere"), id).toBe(id);
		}
	});
});

// The window's listener asks with the place the key was typed in: the event's target.
describe("the window's shortcut for a key", () => {
	let terminalInput: HTMLTextAreaElement;
	let railBadge: HTMLDivElement;
	const seen: (string | null)[] = [];
	const listen = (ev: Event): void => {
		seen.push(windowShortcutOf(ev as KeyboardEvent));
	};

	beforeEach(() => {
		// xterm's input sits in its `.xterm` element; a badge of the rail does not.
		const xterm = document.createElement("div");
		xterm.className = "xterm";
		terminalInput = document.createElement("textarea");
		xterm.appendChild(terminalInput);
		railBadge = document.createElement("div");
		railBadge.tabIndex = 0;
		document.body.append(xterm, railBadge);
		seen.length = 0;
		window.addEventListener("keydown", listen, { capture: true });
	});

	afterEach(() => {
		window.removeEventListener("keydown", listen, { capture: true });
		document.body.replaceChildren();
	});

	const press = (target: Element, init: KeyInit): void => {
		target.dispatchEvent(key("F6", { ...init, bubbles: true, cancelable: true }));
	};

	it("cycles the zones on F6 only when the keyboard is outside a terminal", () => {
		press(railBadge, { code: "F6" });
		press(terminalInput, { code: "F6" });
		press(railBadge, { shiftKey: true, code: "F6" });
		press(terminalInput, { shiftKey: true, code: "F6" });
		expect(seen).toEqual(["zone.next", null, "zone.previous", null]);
	});

	it("cycles them on Ctrl+F6 wherever the keyboard is", () => {
		press(terminalInput, { ctrlKey: true, code: "F6" });
		press(railBadge, { ctrlKey: true, code: "F6" });
		press(terminalInput, { ctrlKey: true, shiftKey: true, code: "F6" });
		expect(seen).toEqual(["zone.next", "zone.next", "zone.previous"]);
	});

	it("reads the place from where the key is typed", () => {
		expect(keyboardPlaceOf(terminalInput)).toBe("terminal");
		expect(keyboardPlaceOf(railBadge)).toBe("elsewhere");
		expect(keyboardPlaceOf(null)).toBe("elsewhere");
		expect(keyboardPlaceOf(window)).toBe("elsewhere");
	});
});

describe("what an action is", () => {
	it("reads the tab of Ctrl+Alt+digit", () => {
		expect(tabNumberOf("tab.goTo1")).toBe(1);
		expect(tabNumberOf("tab.goTo9")).toBe(9);
		expect(tabNumberOf("tab.next")).toBeNull();
	});

	it("reads the move and the side of Alt+arrows and Alt+Shift+arrows", () => {
		expect(paneMoveOf("pane.focusLeft")).toEqual({ move: "focus", direction: "left" });
		expect(paneMoveOf("pane.resizeDown")).toEqual({ move: "resize", direction: "down" });
		expect(paneMoveOf("pane.close")).toBeNull();
		expect(paneMoveOf("pane.splitRight")).toBeNull();
	});

	// Nothing takes the keyboard behind a modal dialog.
	it("knows which actions take the keyboard elsewhere", () => {
		const moving = IDS.filter(movesKeyboard);
		expect(moving).toEqual([
			"tab.next",
			"tab.previous",
			...TAB_NUMBERS.map((n) => `tab.goTo${n}`),
			"pane.focusLeft",
			"pane.focusRight",
			"pane.focusUp",
			"pane.focusDown",
			"zone.next",
			"zone.previous",
		]);
	});
});

describe("matching an event", () => {
	it("matches every event xterm hands its key handler", () => {
		for (const type of ["keydown", "keypress", "keyup"]) {
			expect(appShortcutOf(key("P", CTRL_SHIFT, type))).toBe("palette.open");
			expect(appShortcutOf(key("W", CTRL_SHIFT, type))).toBe("pane.close");
			expect(appShortcutOf(key("_", { ...ALT_SHIFT, code: "Minus" }, type))).toBe("pane.splitDown");
			expect(appShortcutOf(key("ArrowUp", { altKey: true, code: "ArrowUp" }, type))).toBe(
				"pane.focusUp",
			);
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
			expect(appShortcutOf(event), id).toBe(id);
		}
	});
});

// Settings opens and closes on Ctrl+, as in Windows Terminal and VS Code (#637).
describe("the Settings chord", () => {
	it("is Ctrl+, on every layout that types a comma unshifted", () => {
		// US and QWERTZ have the comma on the key right of M; AZERTY on the M key itself.
		expect(appShortcutOf(key(",", { ctrlKey: true, code: "Comma" }))).toBe("settings.open");
		expect(appShortcutOf(key(",", { ctrlKey: true, code: "KeyM" }))).toBe("settings.open");
	});

	it("is kept from a terminal, and is no other chord of the comma", () => {
		expect(appShortcutOf(key(",", { ctrlKey: true }), "terminal")).toBe("settings.open");
		expect(appShortcutOf(key(",", { altKey: true }))).toBeNull();
		expect(appShortcutOf(key("<", { ...CTRL_SHIFT, code: "Comma" }))).toBeNull();
		expect(appShortcutOf(key(",", {}))).toBeNull();
	});

	// Settings is a modal dialog: its chord must still close it from inside.
	it("runs from inside a modal dialog", () => {
		expect(movesKeyboard("settings.open")).toBe(false);
	});
});

describe("the shortcuts where they are named", () => {
	it("are what the rail's buttons say, read from the table", () => {
		expect(HOST_RAIL).toMatch(/`Command palette \(\$\{shortcutLabel\("palette\.open"\)\}\)`/);
		expect(HOST_RAIL).toMatch(/`Settings \(\$\{shortcutLabel\("settings\.open"\)\}\)`/);
		expect(HOST_RAIL).not.toMatch(/\b(Ctrl|Alt|Shift)\+/);
		expect(HOST_RAIL).not.toContain("Ctrl+K");
	});
});
