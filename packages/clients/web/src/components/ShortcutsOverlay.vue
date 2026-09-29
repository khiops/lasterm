<template>
	<Teleport to="body">
		<div v-if="overlay.isOpen.value" class="shortcuts-overlay" @mousedown.self="overlay.close">
			<div
				ref="dialogEl"
				class="shortcuts-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="shortcuts-title"
				@keydown="onKeydown"
			>
				<div class="shortcuts-header">
					<h2 id="shortcuts-title" class="shortcuts-title">Keyboard shortcuts</h2>
					<button
						type="button"
						class="shortcuts-close"
						aria-label="Close keyboard shortcuts"
						@click="overlay.close"
					>
						&#10005;
					</button>
				</div>

				<div class="shortcuts-search">
					<input
						ref="searchEl"
						v-model="query"
						type="search"
						class="shortcuts-search-input"
						placeholder="Search shortcuts"
						aria-label="Search shortcuts"
						autocomplete="off"
						spellcheck="false"
					/>
				</div>

				<!-- Focusable, so that the keyboard can scroll it. -->
				<div class="shortcuts-list" tabindex="0" role="region" aria-label="Shortcuts">
					<section v-for="group in shownGroups" :key="group.name" class="shortcuts-group">
						<h3 class="shortcuts-group-title">{{ group.name }}</h3>
						<dl class="shortcuts-rows">
							<div
								v-for="row in group.rows"
								:key="row.key"
								class="shortcuts-row"
								:data-shortcut-id="row.kind === 'chord' ? row.id : undefined"
							>
								<dt class="shortcuts-name">{{ row.name }}</dt>
								<dd class="shortcuts-keys">
									<template v-if="row.kind === 'chord'">
										<kbd v-for="cap in row.chord" :key="cap" class="shortcuts-cap">{{ cap }}</kbd>
										<span v-if="row.outsideTerminal" class="shortcuts-alias">
											(<kbd v-for="cap in row.outsideTerminal" :key="cap" class="shortcuts-cap">{{ cap }}</kbd>
											outside a terminal)
										</span>
									</template>
									<KeyHints v-else :hints="row.hints" class="shortcuts-hints" />
								</dd>
							</div>
						</dl>
					</section>
					<p v-if="shownGroups.length === 0" class="shortcuts-empty">
						No shortcut matches “{{ query }}”.
					</p>
				</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
/**
 * Every shortcut in one place (#639): the actions of the shortcut table (utils/app-shortcuts.ts),
 * grouped General, Tabs, Panes, Areas and Settings, and the keys that work inside the zones and
 * inside Settings, from the same source as the key hints (utils/key-hints.ts). A search field
 * filters the list. A modal dialog: the keyboard goes into it, Esc closes it, and the keyboard
 * goes back where it was.
 */
import { computed, ref, watch } from "vue";
import { useModalFocus } from "../composables/useModalFocus.js";
import { useShortcutsOverlay } from "../composables/useShortcutsOverlay.js";
import { filterShortcutGroups, SHORTCUT_GROUPS } from "../utils/key-hints.js";
import KeyHints from "./KeyHints.vue";

const overlay = useShortcutsOverlay();

const dialogEl = ref<HTMLElement | null>(null);
const searchEl = ref<HTMLInputElement | null>(null);
const query = ref("");

const shownGroups = computed(() => filterShortcutGroups(SHORTCUT_GROUPS, query.value));

// Each opening starts from the whole list.
watch(overlay.isOpen, (open) => {
	if (open) query.value = "";
});

const { onKeydown } = useModalFocus({
	open: () => overlay.isOpen.value,
	root: dialogEl,
	close: overlay.close,
	initial: () => searchEl.value,
});
</script>

<style scoped>
.shortcuts-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay);
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding-top: 10vh;
	/* Above Settings (900) and the palette (1000), which it can be opened from. */
	z-index: 1100;
}

.shortcuts-dialog {
	width: 560px;
	max-width: calc(100vw - 48px);
	max-height: 76vh;
	display: flex;
	flex-direction: column;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	box-shadow: var(--nt-shadow);
	overflow: hidden;
}

.shortcuts-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 14px 20px;
	border-bottom: 1px solid var(--nt-border);
	flex-shrink: 0;
}

.shortcuts-title {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
	color: var(--nt-fg);
}

.shortcuts-close {
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 14px;
	cursor: pointer;
	padding: 4px;
	line-height: 1;
	border-radius: 4px;
}

.shortcuts-close:hover {
	color: var(--nt-fg);
	background: var(--nt-hover);
}

.shortcuts-search {
	padding: 12px 20px 8px;
	flex-shrink: 0;
}

.shortcuts-search-input {
	width: 100%;
	padding: 6px 10px;
	font-size: 13px;
	font-family: inherit;
	background: var(--nt-input-bg);
	color: var(--nt-fg);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
}

.shortcuts-list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 4px 20px 16px;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-scrollbar-thumb) var(--nt-scrollbar-track);
}

.shortcuts-dialog :focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

.shortcuts-list:focus-visible {
	outline-offset: -2px;
}

.shortcuts-group + .shortcuts-group {
	margin-top: 14px;
}

.shortcuts-group-title {
	margin: 8px 0 4px;
	font-size: 12px;
	font-weight: 600;
	color: var(--nt-fg);
	text-transform: uppercase;
	letter-spacing: 0.04em;
}

.shortcuts-rows {
	margin: 0;
}

.shortcuts-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 5px 8px;
	border-radius: 4px;
}

.shortcuts-row:hover {
	background: var(--nt-hover);
}

.shortcuts-name {
	font-size: 13px;
	color: var(--nt-fg);
}

.shortcuts-keys {
	margin: 0;
	display: flex;
	align-items: center;
	justify-content: flex-end;
	flex-wrap: wrap;
	gap: 4px;
	font-size: 11px;
	color: var(--nt-text-muted);
	text-align: right;
}

.shortcuts-cap {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 22px;
	height: 22px;
	padding: 0 6px;
	background: var(--nt-host-rail);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	color: var(--nt-text-secondary);
	font-size: 11px;
	font-family: ui-monospace, monospace;
	line-height: 1;
}

.shortcuts-alias {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--nt-text-secondary);
}

.shortcuts-hints {
	justify-content: flex-end;
}

.shortcuts-empty {
	margin: 16px 0;
	font-size: 12px;
	color: var(--nt-text-secondary);
	text-align: center;
}
</style>
