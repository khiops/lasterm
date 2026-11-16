import { defineStore } from "pinia";
import { ref } from "vue";

/** A button in a toast: "Show", which opens what the toast is about (#837). */
export interface ToastAction {
	label: string;
	run: () => void;
}

export interface ToastMessage {
	id: number;
	level: "error" | "warning" | "info";
	text: string;
	action?: ToastAction;
}

let nextId = 1;

/**
 * Minimal in-app toast store.
 * Components can subscribe to `messages` and render them in a toast container.
 */
export const useToastStore = defineStore("toast", () => {
	const messages = ref<ToastMessage[]>([]);

	/**
	 * Show a toast, and return its id. It goes after `durationMs`; with `null`
	 * it stays until its owner dismisses it, as a paste's progress does (#1014).
	 */
	function show(
		level: ToastMessage["level"],
		text: string,
		durationMs: number | null = 5000,
		action?: ToastAction,
	): number {
		const id = nextId++;
		messages.value = [...messages.value, { id, level, text, ...(action ? { action } : {}) }];
		if (durationMs !== null) setTimeout(() => dismiss(id), durationMs);
		return id;
	}

	/** Change a shown toast's text; a toast already gone stays gone (#1014). */
	function update(id: number, text: string): void {
		messages.value = messages.value.map((m) => (m.id === id ? { ...m, text } : m));
	}

	function dismiss(id: number): void {
		messages.value = messages.value.filter((m) => m.id !== id);
	}

	/** Its button: what it does, and the toast goes. */
	function act(id: number): void {
		const message = messages.value.find((m) => m.id === id);
		dismiss(id);
		message?.action?.run();
	}

	return { messages, show, update, dismiss, act };
});
