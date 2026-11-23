<template>
	<div v-if="show" class="unread-lines-bar">
		<span class="unread-lines-text">{{ displayCount }} new lines</span>
		<button class="unread-lines-btn" @click="emit('mark-read')">Mark as read</button>
		<button class="unread-lines-btn unread-lines-btn--jump" @click="emit('jump-to-bottom')">
			Jump &#x2193;
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
	lineCount: number;
	show: boolean;
}>();

const emit = defineEmits<{
	"mark-read": [];
	"jump-to-bottom": [];
}>();

const displayCount = computed(() => {
	if (props.lineCount > 999) return "999+";
	return String(props.lineCount);
});
</script>

<style scoped>
.unread-lines-bar {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	z-index: 5;
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
	padding: 4px 12px;
	background: rgba(0, 0, 0, 0.7);
	backdrop-filter: blur(4px);
	font-size: 12px;
	color: var(--nt-fg, #e0e0e0);
}

.unread-lines-text {
	font-weight: 500;
}

.unread-lines-btn {
	padding: 2px 10px;
	font-size: 11px;
	font-family: inherit;
	font-weight: 500;
	background: var(--nt-tab-hover, #333);
	color: var(--nt-fg, #e0e0e0);
	border: 1px solid var(--nt-border, #444);
	border-radius: 3px;
	cursor: pointer;
	transition: background 0.12s;
}

.unread-lines-btn:hover {
	background: var(--nt-border, #555);
}

.unread-lines-btn--jump {
	background: var(--nt-accent, #6495ed);
	border-color: var(--nt-accent, #6495ed);
	color: var(--nt-accent-fg, #11111b);
}

.unread-lines-btn--jump:hover {
	background: var(--nt-accent, #6495ed);
	box-shadow: inset 0 0 0 1px currentColor;
}
</style>
