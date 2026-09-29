import { type ComputedRef, computed, shallowRef } from "vue";

/**
 * Where the keyboard is, when the keyboard took it there (#639): the focused element while the
 * last thing the user did was press a key, and nothing after a click or a touch. That is the
 * rule `:focus-visible` follows for the focus ring, kept here so the key hints can follow it
 * too: a hint names keys for someone using them, and says nothing to a mouse.
 *
 * A modifier pressed alone changes nothing, since it may go with a click. One tracker for the
 * window, listening from the first use on, so a panel that opens on a key already knows it came
 * from the keyboard.
 */

const focused = shallowRef<Element | null>(null);
const byKeyboard = shallowRef(false);
let listening = false;

/** Keys that are only modifiers: pressed alone, they are no use of the keyboard. */
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Meta", "OS", "Shift"]);

function activeElement(): Element | null {
	const active = document.activeElement;
	return active === null || active === document.body ? null : active;
}

function listen(): void {
	if (listening || typeof window === "undefined") return;
	listening = true;
	window.addEventListener(
		"keydown",
		(event) => {
			if (!MODIFIER_KEYS.has(event.key)) byKeyboard.value = true;
			// A focused element that went away with no focusout is let go of here.
			focused.value = activeElement();
		},
		{ capture: true },
	);
	const byPointer = (): void => {
		byKeyboard.value = false;
	};
	window.addEventListener("pointerdown", byPointer, { capture: true });
	window.addEventListener("mousedown", byPointer, { capture: true });
	document.addEventListener(
		"focusin",
		(event) => {
			focused.value = event.target instanceof Element ? event.target : activeElement();
		},
		{ capture: true },
	);
	document.addEventListener(
		"focusout",
		() => {
			focused.value = null;
		},
		{ capture: true },
	);
	focused.value = activeElement();
}

/** The element the keyboard is on when the keyboard took it there, else null. */
export function useKeyboardFocus(): ComputedRef<Element | null> {
	listen();
	return computed(() => (byKeyboard.value ? focused.value : null));
}
