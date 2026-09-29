<template>
	<!-- Hidden from screen readers, which name each control's role and state themselves (#639). -->
	<div v-if="hints !== null && hints.length > 0" class="key-hint-strip" aria-hidden="true">
		<div class="key-hint-strip__line">
			<KeyHints :hints="hints" />
		</div>
	</div>
</template>

<script setup lang="ts">
/**
 * The keys that work where the keyboard is, in one quiet line (#639): shown while the keyboard
 * took the focus there, not after a click, and not at all when Settings › Appearance turns the
 * key hints off. `resolve` says which keys, for the element the keyboard is on, or null where
 * this strip has nothing to say.
 */
import { computed } from "vue";
import { useKeyboardFocus } from "../composables/useKeyboardFocus.js";
import { useConfigStore } from "../stores/config.js";
import { type KeyHint, keyHintsShown } from "../utils/key-hints.js";
import KeyHints from "./KeyHints.vue";

const props = defineProps<{
	resolve: (el: Element) => readonly KeyHint[] | null;
}>();

const configStore = useConfigStore();
const keyboardFocus = useKeyboardFocus();

const hints = computed(() => {
	if (!keyHintsShown(configStore.uiConfig.keyboard)) return null;
	const el = keyboardFocus.value;
	return el === null ? null : props.resolve(el);
});
</script>

<style scoped>
/* The host picker's footer (VacantPane's .picker-keys): small, muted, under a hairline. */
.key-hint-strip {
	flex-shrink: 0;
	container: key-hint-strip / inline-size;
}

.key-hint-strip__line {
	padding: 6px 12px;
	border-top: 1px solid var(--nt-border);
	font-size: 11px;
	line-height: 16px;
	color: var(--nt-text-muted);
}

/* Too narrow for its keys — the rail alone, with the list folded away — it shows none. */
@container key-hint-strip (max-width: 159px) {
	.key-hint-strip__line {
		display: none;
	}
}
</style>
