<template>
	<span
		class="host-badge"
		:style="{ width: `${size}px`, height: `${size}px` }"
		aria-hidden="true"
	>
		<span class="host-badge__disc" :style="{ backgroundColor: color }">
			<img
				v-if="host.iconType === 'image' && isDisplayableIconImage(host.iconValue)"
				:src="host.iconValue"
				alt=""
				class="host-badge__img"
			/>
			<span v-else class="host-badge__text" :style="{ fontSize: `${fontSize}px` }">{{ text }}</span>
		</span>
		<span
			v-if="status"
			class="host-badge__dot"
			:class="`host-badge__dot--${status}`"
			:style="{ width: `${dotSize}px`, height: `${dotSize}px` }"
		></span>
	</span>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { computed } from "vue";
import { getColorFromLabel, getInitials } from "../composables/useHostIcon.js";
import type { HostStatus } from "../stores/hosts.js";
import { isDisplayableIconImage } from "../utils/host-icon.js";

/**
 * A host's badge, as the rail draws it — its image, its emoji or its
 * initials on its colour — with the status dot, at any size (#625). An image
 * the page cannot load (#208) gives way to the initials.
 */
const props = withDefaults(
	defineProps<{
		host: Host;
		status?: HostStatus | null;
		size?: number;
	}>(),
	{ status: null, size: 24 },
);

const color = computed(() => props.host.color || getColorFromLabel(props.host.label));
const isEmoji = computed(() => props.host.iconType === "emoji" && !!props.host.iconValue);
const text = computed(() =>
	isEmoji.value ? (props.host.iconValue ?? "") : getInitials(props.host.label),
);
/** The rail's 14px initials on a 36px badge, and an emoji a little larger. */
const fontSize = computed(() => Math.round(props.size * (isEmoji.value ? 0.5 : 0.4)));
const dotSize = computed(() => Math.max(8, Math.round(props.size * 0.375)));
</script>

<style scoped>
.host-badge {
	position: relative;
	display: inline-block;
	flex-shrink: 0;
}

.host-badge__disc {
	position: absolute;
	inset: 0;
	border-radius: 50%;
	display: flex;
	align-items: center;
	justify-content: center;
	overflow: hidden;
	user-select: none;
}

.host-badge__img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

.host-badge__text {
	font-weight: 700;
	line-height: 1;
	color: var(--nt-bright-white);
	text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

/* The rail's dot, ringed with the surface the badge sits on. */
.host-badge__dot {
	position: absolute;
	right: -2px;
	bottom: -2px;
	box-sizing: border-box;
	border-radius: 50%;
	border: 2px solid var(--host-badge-ring, var(--nt-tab-bar));
}

.host-badge__dot--live {
	background: var(--nt-green);
}

.host-badge__dot--offline {
	background: var(--nt-tab-hover);
}

.host-badge__dot--error {
	background: var(--nt-badge);
}

/* Offline on purpose (#648): the offline dot, hollow. */
.host-badge__dot--disconnected {
	background: var(--host-badge-ring, var(--nt-tab-bar));
	box-shadow: inset 0 0 0 2px var(--nt-text-muted);
}

.host-badge__dot--reconnecting {
	background: var(--nt-yellow);
	animation: host-badge-pulse 1.4s ease-in-out infinite;
}

@keyframes host-badge-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.4;
	}
}

@media (prefers-reduced-motion: reduce) {
	.host-badge__dot--reconnecting {
		animation: none;
	}
}
</style>
