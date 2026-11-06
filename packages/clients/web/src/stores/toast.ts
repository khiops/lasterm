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

	function show(
		level: ToastMessage["level"],
		text: string,
		durationMs = 5000,
		action?: ToastAction,
	): void {
		const id = nextId++;
		messages.value = [...messages.value, { id, level, text, ...(action ? { action } : {}) }];
		setTimeout(() => dismiss(id), durationMs);
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

	return { messages, show, dismiss, act };
});
