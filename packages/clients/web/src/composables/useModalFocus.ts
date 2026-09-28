import { nextTick, type Ref, watch } from "vue";
import { firstTabbable, trapTab } from "../utils/focusable.js";

/**
 * A modal dialog's keyboard (#637): when it opens the keyboard goes into it, onto `initial` or its
 * first control; when it closes the keyboard goes back where it was. Esc closes it, and Tab goes
 * round inside it. `onKeydown` goes on the dialog's element.
 *
 * The window leaves a modal dialog's keys to it (App.vue runs none of its own behind one), so the
 * dialog is where they are handled.
 */
export function useModalFocus(options: {
	/** Whether the dialog is open. */
	open: () => boolean;
	/** The dialog's element. */
	root: Ref<HTMLElement | null>;
	/** What Esc does: close the dialog. */
	close: () => void;
	/** Where the keyboard lands on open, when not the first control. */
	initial?: () => HTMLElement | null;
	/** Where it goes on close when what it came from is gone: a deleted item's button. */
	fallback?: () => HTMLElement | null;
}): { onKeydown: (event: KeyboardEvent) => void } {
	let returnTo: HTMLElement | null = null;

	watch(
		options.open,
		(isOpen, wasOpen) => {
			if (isOpen) {
				const active = document.activeElement;
				returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
				void nextTick(() => {
					(options.initial?.() ?? firstTabbable(options.root.value))?.focus();
				});
				return;
			}
			if (wasOpen !== true) return;
			const back = returnTo;
			returnTo = null;
			// What it came from can go with the dialog's work: look once the page has caught up.
			void nextTick(() => {
				if (back?.isConnected === true) back.focus();
				else options.fallback?.()?.focus();
			});
		},
		{ immediate: true },
	);

	function onKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
		if (event.key === "Escape" && !event.shiftKey) {
			event.preventDefault();
			options.close();
			return;
		}
		trapTab(event, options.root.value);
	}

	return { onKeydown };
}
