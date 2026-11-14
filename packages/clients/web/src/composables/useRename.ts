import { nextTick, type Ref, ref } from "vue";

export interface UseRenameOptions {
	/** Called with the new trimmed value when it differs from the original. */
	onCommit: (newValue: string) => void;
}

export function useRename(options: UseRenameOptions) {
	const isEditing = ref(false);
	const editValue = ref("");
	const editInput: Ref<HTMLInputElement | null> = ref(null);

	let originalLabel = "";

	function startRename(currentLabel: string): void {
		isEditing.value = true;
		originalLabel = currentLabel;
		editValue.value = currentLabel;
		nextTick(() => {
			// select() is not required to move the focus, and happy-dom's does not.
			editInput.value?.focus();
			editInput.value?.select();
		});
	}

	function commitRename(): void {
		if (!isEditing.value) return;
		const trimmed = editValue.value.trim();
		isEditing.value = false;
		if (trimmed.length > 0 && trimmed !== originalLabel) {
			options.onCommit(trimmed);
		}
	}

	function cancelRename(): void {
		isEditing.value = false;
	}

	return {
		isEditing,
		editValue,
		editInput,
		startRename,
		commitRename,
		cancelRename,
	};
}
