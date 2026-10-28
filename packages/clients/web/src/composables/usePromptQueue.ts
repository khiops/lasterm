import { computed, type Ref, ref } from "vue";

export interface UsePromptQueueOptions {
	stalePromptWarning?: string;
}

export function usePromptQueue<TEntry extends { promptId: string }>(
	options: UsePromptQueueOptions = {},
) {
	const pendingPrompts = ref<TEntry[]>([]) as Ref<TEntry[]>;
	const currentPrompt = computed(() => pendingPrompts.value[0] ?? null);

	function enqueue(entry: TEntry): boolean {
		if (pendingPrompts.value.some((pending) => pending.promptId === entry.promptId)) return false;
		pendingPrompts.value = [...pendingPrompts.value, entry];
		return true;
	}

	function resolveHead(): TEntry | null {
		const head = currentPrompt.value;
		if (!head) return null;
		pendingPrompts.value = pendingPrompts.value.slice(1);
		return head;
	}

	function removeByPromptId(promptId: string): void {
		pendingPrompts.value = pendingPrompts.value.filter((prompt) => prompt.promptId !== promptId);
	}

	function withHeadPrompt(
		promptId: string | undefined,
		fn: (headEntry: TEntry) => void,
		action?: string,
	): boolean {
		const head = currentPrompt.value;
		if (!head) return false;
		const currentPromptId = head.promptId;
		if (promptId === undefined || currentPromptId === promptId) {
			fn(head);
			return true;
		}
		if (options.stalePromptWarning) {
			console.warn(options.stalePromptWarning, {
				action,
				promptId,
				currentPromptId,
			});
		}
		return false;
	}

	function handlePromptCancel(promptId: string): void {
		removeByPromptId(promptId);
	}

	return {
		pendingPrompts,
		currentPrompt,
		enqueue,
		resolveHead,
		removeByPromptId,
		withHeadPrompt,
		handlePromptCancel,
	};
}
