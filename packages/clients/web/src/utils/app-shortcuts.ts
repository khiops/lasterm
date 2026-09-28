/**
 * The app's own keyboard shortcuts: one table, keyed by a stable action id, each chord written as
 * data (#624, #631, #637). The chords are Windows Terminal's.
 *
 * Everything that knows a shortcut reads it here. The window's capture-phase listener runs the
 * action (App.vue), every terminal's key handler keeps the chord from its PTY
 * (`terminalKeyHandler`), and the command palette and Settings › Keybindings show it. What is
 * shown cannot drift from what works, and a shell keeps its own Ctrl+T (transpose), Ctrl+W
 * (delete a word), Ctrl+K, Ctrl+-, Ctrl+\ and Ctrl+←/→ (a word back and forth).
 *
 * These are the defaults. Making them configurable means overriding a chord by its id, which the
 * shape of the table leaves room for.
 */

/** A chord, as data. Each modifier is either held or not held: no other modifier may be. */
export interface Chord {
	/** Ctrl, or Cmd, which stands in for it as it always has for the palette. */
	readonly ctrl: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	/** The key as it is shown, and as `ev.key` names it, in either case, unless `code` is set. */
	readonly key: string;
	/**
	 * The physical key (`ev.code`), for a key whose character depends on the layout or on Shift,
	 * or whose name is not what its cap shows (an arrow). When set, it alone decides the match:
	 * `key` is only how the chord is shown.
	 */
	readonly code?: string;
}

/** The tabs Ctrl+Alt+digit goes to: the ninth is the last one, however many there are. */
export const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export type TabNumber = (typeof TAB_NUMBERS)[number];

/** A side of the focused pane, for moving the focus and the dividers. */
export type PaneDirection = "left" | "right" | "up" | "down";

/** The actions a shortcut runs. An id names the action, never the keys, and does not change. */
export type AppActionId =
	| "palette.open"
	| "tab.new"
	| "tab.next"
	| "tab.previous"
	| `tab.goTo${TabNumber}`
	| "pane.splitRight"
	| "pane.splitDown"
	| "pane.close"
	| "pane.focusLeft"
	| "pane.focusRight"
	| "pane.focusUp"
	| "pane.focusDown"
	| "pane.resizeLeft"
	| "pane.resizeRight"
	| "pane.resizeUp"
	| "pane.resizeDown"
	| "zone.next"
	| "zone.previous";

const CTRL_ALT = { ctrl: true, alt: true, shift: false } as const;
const ALT = { ctrl: false, alt: true, shift: false } as const;
const ALT_SHIFT = { ctrl: false, alt: true, shift: true } as const;

/** Each action's chord. */
export const APP_SHORTCUTS: Readonly<Record<AppActionId, Chord>> = {
	"palette.open": { ctrl: true, alt: false, shift: true, key: "P" },
	"tab.new": { ctrl: true, alt: false, shift: true, key: "T" },
	// A browser tab keeps these two for itself; the desktop app gets them.
	"tab.next": { ctrl: true, alt: false, shift: false, key: "Tab" },
	"tab.previous": { ctrl: true, alt: false, shift: true, key: "Tab" },
	// The digit row, whatever the layout prints on it: on AZERTY the 1 key types &.
	"tab.goTo1": { ...CTRL_ALT, key: "1", code: "Digit1" },
	"tab.goTo2": { ...CTRL_ALT, key: "2", code: "Digit2" },
	"tab.goTo3": { ...CTRL_ALT, key: "3", code: "Digit3" },
	"tab.goTo4": { ...CTRL_ALT, key: "4", code: "Digit4" },
	"tab.goTo5": { ...CTRL_ALT, key: "5", code: "Digit5" },
	"tab.goTo6": { ...CTRL_ALT, key: "6", code: "Digit6" },
	"tab.goTo7": { ...CTRL_ALT, key: "7", code: "Digit7" },
	"tab.goTo8": { ...CTRL_ALT, key: "8", code: "Digit8" },
	"tab.goTo9": { ...CTRL_ALT, key: "9", code: "Digit9" },
	// Matched on the physical key, not on `ev.key`: with Shift held, a US layout reports "+" and
	// "_", and AZERTY or QWERTZ put = and - on other keys, or behind Shift. The chords are the two
	// keys right of 0, where a US keyboard has - and =, whatever the layout prints on them: on
	// AZERTY, split down is Alt+Shift+).
	"pane.splitRight": { ...ALT_SHIFT, key: "=", code: "Equal" },
	"pane.splitDown": { ...ALT_SHIFT, key: "-", code: "Minus" },
	// The focused pane; a tab closes with its last one.
	"pane.close": { ctrl: true, alt: false, shift: true, key: "W" },
	// The arrow keys themselves: the numeric keypad's, with Num Lock off, are left alone.
	"pane.focusLeft": { ...ALT, key: "←", code: "ArrowLeft" },
	"pane.focusRight": { ...ALT, key: "→", code: "ArrowRight" },
	"pane.focusUp": { ...ALT, key: "↑", code: "ArrowUp" },
	"pane.focusDown": { ...ALT, key: "↓", code: "ArrowDown" },
	"pane.resizeLeft": { ...ALT_SHIFT, key: "←", code: "ArrowLeft" },
	"pane.resizeRight": { ...ALT_SHIFT, key: "→", code: "ArrowRight" },
	"pane.resizeUp": { ...ALT_SHIFT, key: "↑", code: "ArrowUp" },
	"pane.resizeDown": { ...ALT_SHIFT, key: "↓", code: "ArrowDown" },
	// Between the host rail, the terminal list, the tab bar and the pane, as Windows does.
	"zone.next": { ctrl: false, alt: false, shift: false, key: "F6" },
	"zone.previous": { ctrl: false, alt: false, shift: true, key: "F6" },
};

/**
 * Whether `ev` is `chord`: on keydown, keypress and keyup alike, since xterm hands its key handler
 * all three.
 *
 * AltGr is none of these chords. It types a character — on AZERTY, AltGr+3 is # — and a browser on
 * Windows reports it with `ctrlKey` and `altKey` both set, which would be Ctrl+Alt+3.
 */
export function matchesChord(ev: KeyboardEvent, chord: Chord): boolean {
	if (ev.getModifierState?.("AltGraph") === true) return false;
	if ((ev.ctrlKey || ev.metaKey) !== chord.ctrl) return false;
	if (ev.altKey !== chord.alt || ev.shiftKey !== chord.shift) return false;
	if (chord.code !== undefined) return ev.code === chord.code;
	// Shift makes `key` "P", or "p" under Caps Lock. A synthetic keydown, such as one from a
	// browser's autofill, can carry no `key` at all.
	return typeof ev.key === "string" && ev.key.toLowerCase() === chord.key.toLowerCase();
}

/** The action `ev` is the shortcut of, or null. */
export function appShortcutOf(ev: KeyboardEvent): AppActionId | null {
	for (const [id, chord] of Object.entries(APP_SHORTCUTS) as [AppActionId, Chord][]) {
		if (matchesChord(ev, chord)) return id;
	}
	return null;
}

/** The tab a Ctrl+Alt+digit action goes to, or null for any other action. */
export function tabNumberOf(id: AppActionId): TabNumber | null {
	const match = /^tab\.goTo([1-9])$/.exec(id);
	return match === null ? null : (Number(match[1]) as TabNumber);
}

/** What an Alt+arrow or Alt+Shift+arrow action does, and towards which side, or null. */
export function paneMoveOf(
	id: AppActionId,
): { move: "focus" | "resize"; direction: PaneDirection } | null {
	const match = /^pane\.(focus|resize)(Left|Right|Up|Down)$/.exec(id);
	if (match === null) return null;
	return {
		move: match[1] as "focus" | "resize",
		direction: (match[2] as string).toLowerCase() as PaneDirection,
	};
}

/**
 * Whether an action takes the keyboard somewhere else: to another tab, pane or zone. Those do
 * nothing while a modal dialog has the keyboard, which would otherwise be left behind it.
 */
export function movesKeyboard(id: AppActionId): boolean {
	return (
		id === "tab.next" ||
		id === "tab.previous" ||
		tabNumberOf(id) !== null ||
		paneMoveOf(id)?.move === "focus" ||
		id === "zone.next" ||
		id === "zone.previous"
	);
}

/** An action's chord as Settings › Keybindings shows it, one key a cap: ["Ctrl", "Shift", "T"]. */
export function shortcutKeys(id: AppActionId): string[] {
	const chord = APP_SHORTCUTS[id];
	return [
		...(chord.ctrl ? ["Ctrl"] : []),
		...(chord.alt ? ["Alt"] : []),
		...(chord.shift ? ["Shift"] : []),
		chord.key,
	];
}

/** An action's chord as the command palette shows it: "Ctrl+Shift+T". */
export function shortcutLabel(id: AppActionId): string {
	return shortcutKeys(id).join("+");
}
