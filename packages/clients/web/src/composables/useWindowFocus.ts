import { type Ref, readonly, ref } from "vue";

/**
 * Whether this window has the focus, kept up to date.
 *
 * An end a pane found follows "When a terminal ends" only in the window that
 * has the focus, so that two windows showing the same terminal do not both
 * restart it or close it (#592). It acts when the focus comes back, too.
 *
 * One listener for the whole window, however many panes ask.
 */
let focused: Ref<boolean> | null = null;

function readFocus(): boolean {
	return typeof document !== "undefined" && document.hasFocus();
}

export function useWindowFocus(): Readonly<Ref<boolean>> {
	if (focused === null) {
		const state = ref(readFocus());
		focused = state;
		if (typeof window !== "undefined") {
			const update = (): void => {
				state.value = readFocus();
			};
			window.addEventListener("focus", update);
			window.addEventListener("blur", update);
			document.addEventListener("visibilitychange", update);
		}
	}
	return readonly(focused);
}
