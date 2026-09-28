/**
 * The app's own keyboard shortcuts: one table, keyed by a stable action id, each chord written as
 * data (#624, #631). The chords are Windows Terminal's.
 *
 * Everything that knows a shortcut reads it here. The window's capture-phase listener runs the
 * action (App.vue), every terminal's key handler keeps the chord from its PTY
 * (`terminalKeyHandler`), and the command palette and Settings › Keybindings show it. What is
 * shown cannot drift from what works, and a shell keeps its own Ctrl+T (transpose), Ctrl+W
 * (delete a word), Ctrl+K, Ctrl+- and Ctrl+\.
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
	 * The physical key (`ev.code`), for a key whose character depends on the layout or on Shift.
	 * When set, it alone decides the match: `key` is only how the chord is shown.
	 */
	readonly code?: string;
}

/** The actions a shortcut runs. An id names the action, never the keys, and does not change. */
export type AppActionId =
	| "palette.open"
	| "tab.new"
	| "tab.close"
	| "pane.splitRight"
	| "pane.splitDown";

/** Each action's chord. */
export const APP_SHORTCUTS: Readonly<Record<AppActionId, Chord>> = {
	"palette.open": { ctrl: true, alt: false, shift: true, key: "P" },
	"tab.new": { ctrl: true, alt: false, shift: true, key: "T" },
	"tab.close": { ctrl: true, alt: false, shift: true, key: "W" },
	// Matched on the physical key, not on `ev.key`: with Shift held, a US layout reports "+" and
	// "_", and AZERTY or QWERTZ put = and - on other keys, or behind Shift. The chords are the two
	// keys right of 0, where a US keyboard has - and =, whatever the layout prints on them: on
	// AZERTY, split down is Alt+Shift+).
	"pane.splitRight": { ctrl: false, alt: true, shift: true, key: "=", code: "Equal" },
	"pane.splitDown": { ctrl: false, alt: true, shift: true, key: "-", code: "Minus" },
};

/**
 * Whether `ev` is `chord`: on keydown, keypress and keyup alike, since xterm hands its key handler
 * all three. AltGr, which Windows reports as Ctrl+Alt, is none of these chords.
 */
export function matchesChord(ev: KeyboardEvent, chord: Chord): boolean {
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
