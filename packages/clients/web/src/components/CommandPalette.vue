<template>
	<Teleport to="body">
		<div
			v-if="palette.isOpen.value"
			class="palette-overlay"
			@mousedown.self="palette.close"
		>
			<div
				class="palette-card"
				role="dialog"
				aria-label="Command Palette"
				aria-modal="true"
			>
				<!-- Search input -->
				<div class="palette-search">
					<span class="palette-search-icon" aria-hidden="true">🔍</span>
					<input
						ref="inputRef"
						v-model="localQuery"
						class="palette-input"
						type="text"
						placeholder="Search... (> actions, @ hosts, # channels, ~ profiles)"
						autocomplete="off"
						spellcheck="false"
						@input="palette.search(localQuery)"
						@keydown.up.prevent="palette.moveUp"
						@keydown.down.prevent="palette.moveDown"
						@keydown.enter.prevent="(e: KeyboardEvent) => palette.executeSelected({ switchOnly: e.shiftKey })"
						@keydown.esc.prevent="palette.close"
					/>
				</div>

				<!-- Results list -->
				<div
					v-if="palette.results.value.length > 0"
					class="palette-results"
					role="listbox"
				>
					<template v-for="row in displayRows" :key="row.key">
						<div
							v-if="row.kind === 'heading'"
							class="palette-group-label"
							:class="{ 'palette-group-label--sub': row.sub }"
						>{{ row.label }}</div>
						<button
							v-else
							class="palette-item"
							:class="{ selected: row.index === palette.selectedIndex.value }"
							role="option"
							:aria-selected="row.index === palette.selectedIndex.value"
							type="button"
							@click="(e: MouseEvent) => palette.execute(row.item, { switchOnly: e.shiftKey })"
							@mouseenter="palette.selectedIndex.value = row.index"
						>
							<!-- A host: the empty pane's row, grouped as the rail groups it (#625). -->
							<HostPickRow
								v-if="row.host"
								:host="row.host"
								:status="hostRows.status(row.host.id)"
								:address="hostRows.address(row.host)"
								:count="hostRows.count(row.host.id)"
								:action="statusAction(hostRows.status(row.host.id))"
								:hint="row.index === palette.selectedIndex.value ? HOST_KEYS_HINT : null"
							/>
							<template v-else>
								<span class="palette-item-icon" aria-hidden="true">
									<img v-if="row.item.iconUrl" :src="row.item.iconUrl" class="palette-icon-img" />
									<template v-else>{{ row.item.icon }}</template>
								</span>
								<span class="palette-item-text">
									<span class="palette-item-label">{{ row.item.label }}</span>
									<span v-if="row.item.description" class="palette-item-desc">{{ row.item.description }}</span>
								</span>
								<span class="palette-item-badge" :data-type="row.item.type">
									{{ typeBadge(row.item.type) }}
								</span>
								<span v-if="row.item.shortcut" class="palette-item-shortcut">
									{{ row.item.shortcut }}
								</span>
							</template>
						</button>
					</template>
				</div>

				<!-- Empty state -->
				<div v-else class="palette-empty">No results for "{{ localQuery }}"</div>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import type { Host } from "@lasterm/shared";
import { ref, watch, nextTick, computed } from "vue";
import { statusAction } from "../composables/hostPicker.js";
import {
	type PaletteItemType,
	type PaletteRow,
	paletteRows,
	useCommandPalette,
} from "../composables/useCommandPalette.js";
import { useHostRows } from "../composables/useHostRows.js";
import HostPickRow from "./HostPickRow.vue";

const palette = useCommandPalette();
const hostRows = useHostRows();

/** What a host row's keys do (#625), named on the row that has them. */
const HOST_KEYS_HINT = "Enter: new terminal · Shift+Enter: switch";

const inputRef = ref<HTMLInputElement | null>(null);
const localQuery = ref("");

// Auto-focus input whenever the palette opens
watch(
	() => palette.isOpen.value,
	async (open) => {
		if (open) {
			localQuery.value = "";
			await nextTick();
			inputRef.value?.focus();
		}
	},
);

// ── Grouping ──────────────────────────────────────────────────────────────────

type DisplayRow =
	| Extract<PaletteRow, { kind: "heading" }>
	| (Extract<PaletteRow, { kind: "item" }> & { host: Host | null });

/**
 * The list as shown, in the order ↑ and ↓ walk: recent items first under
 * "Recent" (SC-21), then each type under its heading, the hosts under their
 * rail headings as well (#625).
 */
const displayRows = computed((): DisplayRow[] =>
	paletteRows(palette.results.value, palette.recentResults.value.length).map((row) =>
		row.kind === "heading"
			? row
			: {
					...row,
					host:
						row.item.type === "host" ? (hostRows.host(row.item.payload as string) ?? null) : null,
				},
	),
);

function typeBadge(type: PaletteItemType): string {
	switch (type) {
		case "host":
			return "Host";
		case "channel":
			return "Channel";
		case "action":
			return "Action";
		case "profile":
			return "Profile";
	}
}
</script>

<style scoped>
/* ── Overlay ──────────────────────────────────────────────────────────────── */
.palette-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay);
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding-top: 80px;
	z-index: 1000;
}

/* ── Card ─────────────────────────────────────────────────────────────────── */
.palette-card {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 8px;
	box-shadow: var(--nt-shadow);
	width: 560px;
	max-width: calc(100vw - 32px);
	overflow: hidden;
	display: flex;
	flex-direction: column;
}

/* ── Search row ───────────────────────────────────────────────────────────── */
.palette-search {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 16px;
	border-bottom: 1px solid var(--nt-border);
}

.palette-search-icon {
	font-size: 16px;
	flex-shrink: 0;
	opacity: 0.6;
}

.palette-input {
	flex: 1;
	background: transparent;
	border: none;
	outline: none;
	color: var(--nt-fg);
	font-size: 15px;
	font-family: inherit;
	caret-color: var(--nt-accent);
}

.palette-input::placeholder {
	color: var(--nt-tab-hover);
}

/* ── Results list ─────────────────────────────────────────────────────────── */
.palette-results {
	max-height: 360px;
	overflow-y: auto;
	padding: 4px 0;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-border) transparent;
}

.palette-results::-webkit-scrollbar {
	width: 6px;
}

.palette-results::-webkit-scrollbar-track {
	background: transparent;
}

.palette-results::-webkit-scrollbar-thumb {
	background: var(--nt-border);
	border-radius: 3px;
}

/* ── Group label ──────────────────────────────────────────────────────────── */
.palette-group-label {
	padding: 6px 16px 2px;
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: var(--nt-text-secondary);
	user-select: none;
}

/* A host's rail heading, under "Hosts" (#625). */
.palette-group-label--sub {
	padding: 4px 16px 2px 24px;
	font-size: 9px;
	font-weight: 600;
	letter-spacing: 0.06em;
	color: var(--nt-text-muted);
}

/* ── Result item ──────────────────────────────────────────────────────────── */
.palette-item {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	padding: 7px 16px;
	background: transparent;
	border: none;
	cursor: pointer;
	text-align: left;
	color: var(--nt-fg);
	font-size: 13px;
	font-family: inherit;
	transition: background 0.08s;
	/* A host badge's dot is ringed with what is behind it. */
	--host-badge-ring: var(--nt-bg);
}

.palette-item:hover,
.palette-item.selected {
	background: var(--nt-border);
	--host-badge-ring: var(--nt-border);
}

.palette-item-icon {
	font-size: 14px;
	flex-shrink: 0;
	width: 20px;
	height: 20px;
	text-align: center;
	display: flex;
	align-items: center;
	justify-content: center;
}

.palette-icon-img {
	width: 18px;
	height: 18px;
	border-radius: 4px;
	object-fit: cover;
}

.palette-item-text {
	flex: 1;
	min-width: 0;
	display: flex;
	flex-direction: column;
}

.palette-item-label {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.palette-item-desc {
	font-size: 11px;
	color: var(--nt-text-secondary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

/* ── Type badge ───────────────────────────────────────────────────────────── */
.palette-item-badge {
	font-size: 10px;
	font-weight: 600;
	padding: 2px 6px;
	border-radius: 4px;
	letter-spacing: 0.04em;
	flex-shrink: 0;
}

.palette-item-badge[data-type="host"] {
	background: rgba(var(--nt-accent-rgb), 0.12);
	color: var(--nt-accent);
	border: 1px solid rgba(var(--nt-accent-rgb), 0.25);
}

.palette-item-badge[data-type="channel"] {
	background: rgba(var(--nt-green-rgb), 0.12);
	color: var(--nt-green);
	border: 1px solid rgba(var(--nt-green-rgb), 0.25);
}

.palette-item-badge[data-type="action"] {
	background: rgba(var(--nt-accent-rgb), 0.12);
	color: var(--nt-magenta);
	border: 1px solid rgba(var(--nt-accent-rgb), 0.25);
}

.palette-item-badge[data-type="profile"] {
	background: rgba(var(--nt-yellow-rgb, 200, 150, 0), 0.12);
	color: var(--nt-yellow, #c89600);
	border: 1px solid rgba(var(--nt-yellow-rgb, 200, 150, 0), 0.25);
}

/* ── Shortcut hint ────────────────────────────────────────────────────────── */
.palette-item-shortcut {
	font-size: 11px;
	color: var(--nt-text-secondary);
	font-family: ui-monospace, monospace;
	flex-shrink: 0;
}

/* ── Empty state ──────────────────────────────────────────────────────────── */
.palette-empty {
	padding: 24px 16px;
	text-align: center;
	color: var(--nt-tab-hover);
	font-size: 13px;
	font-style: italic;
}
</style>
