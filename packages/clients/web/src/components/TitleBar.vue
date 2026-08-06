<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

const BUILD_HASH: string = import.meta.env.VITE_BUILD_HASH ?? "dev";

const isTauri = ref(false);
const isMaximized = ref(false);

let unlisten: (() => void) | null = null;
let win: any = null;

async function initTauri() {
	try {
		const { getCurrentWindow } = await import("@tauri-apps/api/window");
		win = getCurrentWindow();
		isTauri.value = true;
		isMaximized.value = await win.isMaximized();
		unlisten = await win.onResized(async () => {
			if (win) isMaximized.value = await win.isMaximized();
		});
	} catch {
		// Not in Tauri context
	}
}

async function minimize() {
	await win?.minimize();
}

async function toggleMaximize() {
	await win?.toggleMaximize();
}

async function closeWindow() {
	await win?.close();
}

async function startDrag() {
	await win?.startDragging();
}

onMounted(initTauri);

onUnmounted(() => {
	unlisten?.();
});
</script>

<template>
	<div v-if="isTauri" class="titlebar">
		<!-- Drag region: only this part is draggable -->
		<div class="titlebar-drag" @mousedown.left="startDrag" @dblclick="toggleMaximize">
			<svg class="titlebar-icon" width="20" height="20" viewBox="0 0 1024 1024">
				<rect x="120" y="120" width="784" height="784" rx="80" fill="#151832" stroke="#7c6fef" stroke-width="30" />
				<text x="380" y="620" font-family="monospace" font-weight="bold" font-size="480" fill="#7c6fef">></text>
				<text x="570" y="600" font-family="monospace" font-weight="bold" font-size="260" fill="#a0e8af">_</text>
			</svg>
			<span class="titlebar-title">Lasterm</span>
			<span class="titlebar-build">{{ BUILD_HASH }}</span>
		</div>

		<!-- Buttons: separate from drag region, no interference -->
		<div class="titlebar-buttons">
			<button class="titlebar-btn" aria-label="Minimize" @click.stop="minimize">
				<svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg>
			</button>
			<button class="titlebar-btn" aria-label="Maximize" @click.stop="toggleMaximize">
				<svg v-if="!isMaximized" width="10" height="10" viewBox="0 0 10 10">
					<rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1" />
				</svg>
				<svg v-else width="10" height="10" viewBox="0 0 10 10">
					<rect x="2.5" y="0.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1" />
					<rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="var(--nt-bg, #1e1e2e)" stroke="currentColor" stroke-width="1" />
				</svg>
			</button>
			<button class="titlebar-btn titlebar-btn-close" aria-label="Close" @click.stop="closeWindow">
				<svg width="10" height="10" viewBox="0 0 10 10">
					<line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" />
					<line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.2" />
				</svg>
			</button>
		</div>
	</div>
</template>

<style scoped>
.titlebar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 32px;
	background: var(--nt-bg, #1e1e2e);
	border-bottom: 1px solid var(--nt-border, #333);
	color: var(--nt-fg-muted, #888);
	user-select: none;
	-webkit-user-select: none;
	flex-shrink: 0;
	/* Stay above PairingScreen overlay (z-index: 1000) */
	position: relative;
	z-index: 1100;
}

.titlebar-drag {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-left: 10px;
	flex: 1;
	height: 100%;
	cursor: default;
}

.titlebar-icon {
	flex-shrink: 0;
}

.titlebar-title {
	font-size: 12px;
	font-weight: 500;
}

.titlebar-build {
	font-size: 10px;
	font-family: monospace;
	color: var(--nt-fg-muted, #888);
	opacity: 0.55;
	letter-spacing: 0.02em;
}

.titlebar-buttons {
	display: flex;
	height: 100%;
	flex-shrink: 0;
}

.titlebar-btn {
	display: flex;
	align-items: center;
	justify-content: center;
	width: 46px;
	height: 100%;
	border: none;
	background: transparent;
	color: var(--nt-fg-muted, #888);
	cursor: pointer;
	transition: background 0.1s;
}

.titlebar-btn:hover {
	background: rgba(255, 255, 255, 0.1);
}

.titlebar-btn-close:hover {
	background: #e81123;
	color: #fff;
}
</style>
