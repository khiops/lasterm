<template>
	<!-- Keys and what they do, as the host picker's footer names them: "↑↓ move", "Enter open". -->
	<span class="key-hints">
		<span v-for="hint in hints" :key="keyHintText([hint])" class="key-hint">
			<template v-for="(cap, index) in hint.keys" :key="cap">
				<template v-if="index > 0"> or </template>
				<kbd>{{ cap }}</kbd>
			</template>
			{{ hint.does }}
		</span>
	</span>
</template>

<script setup lang="ts">
import { type KeyHint, keyHintText } from "../utils/key-hints.js";

defineProps<{
	hints: readonly KeyHint[];
}>();
</script>

<style scoped>
.key-hints {
	display: inline-flex;
	flex-wrap: wrap;
	column-gap: 14px;
	row-gap: 2px;
}

.key-hint {
	white-space: nowrap;
}

.key-hint kbd {
	font-family: ui-monospace, monospace;
	font-size: 11px;
	color: var(--nt-text-secondary);
}
</style>
