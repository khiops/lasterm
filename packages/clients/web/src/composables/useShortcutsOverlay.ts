import { ref } from "vue";

/**
 * The keyboard shortcuts overlay (#639): one for the window. Ctrl+/ (`help.shortcuts`) opens and
 * closes it, and the palette's "Keyboard Shortcuts" row and Settings › Keybindings open it.
 */
const isOpen = ref(false);

export function useShortcutsOverlay() {
	return {
		isOpen,
		open(): void {
			isOpen.value = true;
		},
		close(): void {
			isOpen.value = false;
		},
		toggle(): void {
			isOpen.value = !isOpen.value;
		},
	};
}
