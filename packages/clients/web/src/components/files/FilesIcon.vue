<template>
	<svg class="files-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
		<path v-for="(d, i) in PATHS[name]" :key="i" :d="d" />
	</svg>
</template>

<script setup lang="ts">
/** The files panel's line icons (#836), drawn in the text's colour. */
type FilesIconName =
	| "folder"
	| "file"
	| "link"
	| "up"
	| "refresh"
	| "follow"
	| "folder-plus"
	| "pin"
	| "close"
	| "chevron-right"
	| "chevron-down"
	| "alert";

const PATHS: Readonly<Record<FilesIconName, readonly string[]>> = {
	folder: [
		"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
	],
	file: [
		"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
		"M14 2v4a2 2 0 0 0 2 2h4",
	],
	link: [
		"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
		"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
	],
	up: ["m5 12 7-7 7 7", "M12 19V5"],
	refresh: [
		"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
		"M21 3v5h-5",
		"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
		"M8 16H3v5",
	],
	follow: [
		"M2 12h3",
		"M19 12h3",
		"M12 2v3",
		"M12 19v3",
		"M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14",
		"M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
	],
	"folder-plus": [
		"M12 10v6",
		"M9 13h6",
		"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
	],
	pin: [
		"M12 17v5",
		"M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z",
	],
	close: ["M18 6 6 18", "m6 6 12 12"],
	"chevron-right": ["m9 18 6-6-6-6"],
	"chevron-down": ["m6 9 6 6 6-6"],
	alert: [
		"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
		"M12 9v4",
		"M12 17h.01",
	],
};

defineProps<{ name: FilesIconName }>();
</script>

<style scoped>
.files-icon {
	width: 14px;
	height: 14px;
	flex-shrink: 0;
	fill: none;
	stroke: currentColor;
	stroke-width: 2;
	stroke-linecap: round;
	stroke-linejoin: round;
}
</style>
