<template>
	<div
		ref="tabBarEl"
		class="tab-bar"
		role="tablist"
		aria-label="Open terminals"
		data-focus-zone="tabs"
		@focusout="onTabsFocusOut"
		@wheel.prevent="onWheel"
		@dragover.prevent="onTabBarDragOver"
		@dragleave="onTabBarDragLeave"
		@drop="onTabBarDrop"
	>
		<button
			v-for="{ tab, index: idx } in visibleTabs"
			:key="tab.id"
			role="tab"
			:aria-selected="idx === activeTabIndex"
			:draggable="editingTabIndex !== idx"
			:class="['tab', { 'tab--active': idx === activeTabIndex, 'tab--drop-before': dropInsertIndex === idx, 'tab--drop-after': dropInsertIndex === idx + 1 && idx === lastVisibleIndex, 'tab--dragging': dragTabIndex === idx, 'tab--host-edge': hostMarkerStyle === 'edge' && hostMarkers.has(tab.id) }]"
			:style="hostMarkers.get(tab.id) ? { '--tab-host-color': hostMarkers.get(tab.id)?.color } : undefined"
			:title="tabTooltip(tab.id)"
			:tabindex="tab.id === rovingTabId ? 0 : -1"
			:data-tab-id="tab.id"
			data-zone-item
			@click="emit('select-tab', idx)"
			@focus="keyboardTabId = tab.id"
			@keydown="onTabKeydown($event, tab.id, idx)"
			@mousedown.middle.prevent="emit('close-tab', idx)"
			@contextmenu.prevent="onTabContextMenu(idx, $event)"
			@dragstart="onTabDragStart(idx, $event)"
			@dragend="onTabDragEnd"
		>
			<span v-if="isWelcomeTab(tab.id)" class="tab__welcome-star" title="Welcome Tab">&#x2605;</span>
			<span
				v-if="hostMarkerStyle === 'dot' && hostMarkers.has(tab.id)"
				class="tab__host-dot"
				:aria-label="`On ${hostMarkers.get(tab.id)?.label}`"
			></span>
			<span
				v-else-if="hostMarkerStyle === 'initials' && hostMarkers.has(tab.id)"
				class="tab__host-initials"
				:aria-label="`On ${hostMarkers.get(tab.id)?.label}`"
			>{{ hostMarkers.get(tab.id)?.initials }}</span>
			<input
				v-if="editingTabIndex === idx"
				ref="editInput"
				v-model="editValue"
				class="tab-rename-input"
				@keydown.enter="commitRename"
				@keydown.escape="cancelRename"
				@blur="commitRename"
				@click.stop
			/>
			<span v-else class="tab__label" @dblclick="startRename(idx)">{{ getTabLabel(tab.id) }}</span>
			<span
				v-if="notificationStore.activityDots.get(getActiveChannelId(tab.id) ?? '') && idx !== activeTabIndex"
				class="tab__activity-dot"
				aria-label="New activity"
			></span>
			<span
				v-if="(notificationStore.bellCounts.get(getActiveChannelId(tab.id) ?? '') ?? 0) > 0"
				class="tab__bell-badge"
			>{{ notificationStore.bellCounts.get(getActiveChannelId(tab.id) ?? '') }}</span>
			<span
				v-show="showCloseButton"
				class="tab__close"
				role="button"
				:aria-label="`Close ${getTabLabel(tab.id)}`"
				title="Close tab"
				@click.stop="emit('close-tab', idx)"
			>×</span>
		</button>

		<!-- Split "+" button: left part spawns, right chevron opens profile dropdown -->
		<div class="tab-bar__add-group">
			<button
				class="tab-bar__add tab-bar__add--main"
				aria-label="Open new terminal"
				:title="NEW_TAB_TOOLTIP"
				@click="emit('add-tab')"
			>+</button>
			<button
				ref="chevronBtnEl"
				class="tab-bar__add tab-bar__add--chevron"
				aria-label="Launch from profile"
				title="Launch from profile"
				aria-haspopup="menu"
				:aria-expanded="profileDropdownVisible"
				@click.stop="toggleProfileDropdown"
			>▾</button>
		</div>

		<ProfileDropdown
			:visible="profileDropdownVisible"
			:anchor-el="chevronBtnEl"
			:host-id="activeHostId"
			@close="profileDropdownVisible = false"
		/>

		<TabContextMenu
			:visible="ctxMenu.visible"
			:x="ctxMenu.x"
			:y="ctxMenu.y"
			:tab="ctxMenu.tabIndex >= 0 ? tabs[ctxMenu.tabIndex] ?? null : null"
			:active-channel-id="ctxMenu.tabIndex >= 0 && tabs[ctxMenu.tabIndex] ? getActiveChannelId(tabs[ctxMenu.tabIndex]!.id) : null"
			:tab-index="ctxMenu.tabIndex"
			:tab-count="tabs.length"
			:is-welcome="ctxMenu.tabIndex >= 0 && tabs[ctxMenu.tabIndex] ? isWelcomeTab(tabs[ctxMenu.tabIndex]!.id) : false"
			:is-custom-title="isCtxTabCustomTitle"
			@close="ctxMenu.visible = false"
			@rename="onCtxRename"
			@reset-title="onCtxResetTitle"
			@close-tab="(idx) => emit('close-tab', idx)"
			@close-others="(idx) => emit('close-others', idx)"
			@close-to-right="(idx) => emit('close-to-right', idx)"
			@close-all="emit('close-all')"
			@split-right="(id) => emit('split', id, 'vertical')"
			@split-down="(id) => emit('split', id, 'horizontal')"
			@set-welcome="(id) => emit('set-welcome', id)"
			@configure-command="(id) => emit('configure-command', id)"
		/>
	</div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, nextTick } from "vue";
import type { Host } from "@lasterm/shared";
import type { Tab } from "../composables/useLayout.js";
import { getColorFromLabel, getInitials } from "../composables/useHostIcon.js";
import { useRename } from "../composables/useRename.js";
import { useChannelsStore } from "../stores/channels.js";
import { useConfigStore } from "../stores/config.js";
import { useHostsStore } from "../stores/hosts.js";
import { useNotificationStore } from "../stores/notifications.js";
import { shortcutLabel, TAB_NUMBERS } from "../utils/app-shortcuts.js";
import { listMove } from "../utils/focus-zones.js";
import { tabToSwitchTo } from "../utils/tab-switch.js";
import ProfileDropdown from "./ProfileDropdown.vue";
import TabContextMenu from "./TabContextMenu.vue";

const channelsStore = useChannelsStore();
const configStore = useConfigStore();
const hostsStore = useHostsStore();
const notificationStore = useNotificationStore();

// Profile dropdown state
const profileDropdownVisible = ref(false);
const chevronBtnEl = ref<HTMLElement | null>(null);
const activeHostId = computed(() => channelsStore.activeHostId);

function toggleProfileDropdown(): void {
	profileDropdownVisible.value = !profileDropdownVisible.value;
}

const showCloseButton = computed(() => configStore.uiConfig.tabs?.closeButton !== false);

const props = defineProps<{
	tabs: Tab[];
	activeTabIndex: number;
	/** Resolve the display label for a tab by its tab.id. */
	getTabLabel: (tabId: string) => string;
	/** Get the channelId of the active pane for a tab by its tab.id. */
	getActiveChannelId: (tabId: string) => string | null;
	/**
	 * The tabs to show, by id, or null to show them all. Resolved by the layout
	 * so that closing "the others" and this bar agree on what is on screen.
	 */
	visibleTabIds?: ReadonlySet<string> | null;
}>();

const emit = defineEmits<{
	(e: "select-tab", index: number): void;
	(e: "close-tab", index: number): void;
	(e: "close-others", index: number): void;
	(e: "close-to-right", index: number): void;
	(e: "close-all"): void;
	(e: "add-tab"): void;
	(e: "rename-tab", channelId: string, title: string): void;
	(e: "split", channelId: string, direction: "horizontal" | "vertical"): void;
	(e: "set-welcome", channelId: string): void;
	(e: "move-to-new-tab", sourceChannelId: string, insertAtIndex: number): void;
	(e: "reorder-tab", fromIndex: number, toIndex: number): void;
	(e: "configure-command", channelId: string): void;
}>();

// ─── Which host a tab is on ─────────────────────────────────────────────────
//
// Tabs are global and terminals belong to hosts, so the bar can hold terminals
// from several machines at once — and after a restart, often does. The marker
// only appears when it says something: while every tab is on the host being
// looked at, it is noise, and the bar stays as it was.

const hostMarkerStyle = computed(() => configStore.uiConfig.tabs?.hostMarker ?? "dot");

function hostOfTab(tabId: string): Host | null {
	const channelId = props.getActiveChannelId(tabId);
	if (channelId === null) return null;
	const hostId = channelsStore.channelHostMap.get(channelId);
	if (hostId === undefined) return null;
	return hostsStore.hosts.find((h) => h.id === hostId) ?? null;
}

// ─── Which tabs the bar shows ───────────────────────────────────────────────
//
// Global by default: one window, one row of terminals, wherever they run. Per
// host, the bar shows only the terminals on the host in view; the others stay
// open and come back with their host. A tab whose host is not known yet stays
// in view either way — hiding what cannot be classified is how tabs disappear
// for no reason anyone can see.

const visibleTabs = computed(() => {
	const all = props.tabs.map((tab, index) => ({ tab, index }));
	const inView = props.visibleTabIds;
	if (inView === null || inView === undefined) return all;
	return all.filter(({ tab }) => inView.has(tab.id));
});

/** The global index of the last tab on screen, for the drop marker. */
const lastVisibleIndex = computed(() => {
	const visible = visibleTabs.value;
	return visible.length === 0 ? -1 : (visible[visible.length - 1]?.index ?? -1);
});

/**
 * Whether the bar marks hosts at all.
 *
 * Only when a tab on screen is on some other host than the one in view. With
 * the bar showing one host, that never happens, and the marker would say the
 * same thing on every tab.
 */
const marksHosts = computed(() => {
	if (hostMarkerStyle.value === "none") return false;
	const active = channelsStore.activeHostId;
	return visibleTabs.value.some(({ tab }) => {
		const hostId = hostOfTab(tab.id)?.id;
		return hostId !== undefined && hostId !== active;
	});
});

/** The marker each tab carries, by tab id — resolved once per render. */
const hostMarkers = computed(() => {
	const markers = new Map<string, { color: string; initials: string; label: string }>();
	if (!marksHosts.value) return markers;
	for (const { tab } of visibleTabs.value) {
		const host = hostOfTab(tab.id);
		if (host === null) continue;
		markers.set(tab.id, {
			color: host.color || getColorFromLabel(host.label),
			initials: getInitials(host.label),
			label: host.label,
		});
	}
	return markers;
});

// -------------------------------------------------------------------------
// Tooltips: the shortcuts, from the table the window runs them from (#637)
// -------------------------------------------------------------------------
//
// The tab's × keeps no chord: `pane.close`'s closes the focused pane, not the tab, and the
// palette's Close Tab has none.

const NEW_TAB_TOOLTIP = `New terminal (${shortcutLabel("tab.new")})`;
const SWITCH_TOOLTIP = `${shortcutLabel("tab.next")} / ${shortcutLabel("tab.previous")}: next / previous tab`;

/**
 * The `tab.goToN` chord that reaches each tab, by tab id: the lowest N that lands on it, as the
 * window works it out. Tabs 1 to 8 of the bar have theirs, and the last one the ninth's when it
 * is further along; the others have none.
 */
const tabChords = computed(() => {
	const chords = new Map<string, string>();
	const ids = props.tabs.map((tab) => tab.id);
	for (const n of TAB_NUMBERS) {
		const index = tabToSwitchTo({ goTo: n }, ids, props.activeTabIndex, props.visibleTabIds ?? null);
		const id = index === null ? undefined : ids[index];
		if (id !== undefined && !chords.has(id)) chords.set(id, shortcutLabel(`tab.goTo${n}`));
	}
	return chords;
});

/** A tab's tooltip: its name, its host when the bar marks hosts, its chord, and the tab keys. */
function tabTooltip(tabId: string): string {
	const host = hostMarkers.value.get(tabId);
	const label = props.getTabLabel(tabId);
	const name = host ? `${label} — on ${host.label}` : label;
	const chord = tabChords.value.get(tabId);
	return [chord === undefined ? name : `${name} — ${chord}`, SWITCH_TOOLTIP].join("\n");
}

// -------------------------------------------------------------------------
// Keyboard (#637)
// -------------------------------------------------------------------------
//
// One tab takes Tab: ← and → move along the bar, Home and End to its ends, Enter or Space
// activates the tab as a click does, and Delete closes it as its × does.

/** The tab the keyboard is on while it is in the bar, by id; null once it leaves. */
const keyboardTabId = ref<string | null>(null);

/** The one tab that takes Tab: the keyboard's, else the active one, else the first shown. */
const rovingTabId = computed(() => {
	const ids = visibleTabs.value.map(({ tab }) => tab.id);
	for (const id of [keyboardTabId.value, props.tabs[props.activeTabIndex]?.id ?? null]) {
		if (id !== null && ids.includes(id)) return id;
	}
	return ids[0] ?? null;
});

function focusTab(tabId: string | null): void {
	if (tabId === null) return;
	const tabs = tabBarEl.value?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [];
	[...tabs].find((el) => el.dataset.tabId === tabId)?.focus();
}

function onTabKeydown(event: KeyboardEvent, tabId: string, idx: number): void {
	// A tab being renamed keeps its keys, and a chord is the window's.
	if (event.target !== event.currentTarget || event.defaultPrevented) return;
	if (event.ctrlKey || event.altKey || event.metaKey) return;
	const ids = visibleTabs.value.map(({ tab }) => tab.id);
	const at = ids.indexOf(tabId);
	if (event.key === "Enter" || event.key === " ") {
		// In place of the button's own click, which would come on top.
		event.preventDefault();
		emit("select-tab", idx);
		return;
	}
	if (event.key === "Delete") {
		event.preventDefault();
		// The keyboard stays in the bar, on the tab that takes the closed one's place.
		const neighbour = ids[at + 1] ?? ids[at - 1] ?? null;
		keyboardTabId.value = neighbour;
		emit("close-tab", idx);
		void nextTick(() => focusTab(neighbour));
		return;
	}
	const next = listMove(ids.length, at, event.key, "horizontal");
	if (next === null) return;
	event.preventDefault();
	const target = ids[next] ?? null;
	keyboardTabId.value = target;
	focusTab(target);
}

/** Leaving the bar, Tab comes back to the active tab. */
function onTabsFocusOut(event: FocusEvent): void {
	const into = event.relatedTarget as Node | null;
	if (into !== null && tabBarEl.value?.contains(into)) return;
	keyboardTabId.value = null;
}

// -------------------------------------------------------------------------
// Horizontal scroll
// -------------------------------------------------------------------------

const tabBarEl = ref<HTMLElement | null>(null);

function onWheel(e: WheelEvent): void {
	if (tabBarEl.value) {
		tabBarEl.value.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
	}
}

/** Scroll the active tab into view whenever it changes. */
watch(
	() => props.activeTabIndex,
	async () => {
		await nextTick();
		const el = tabBarEl.value;
		if (!el) return;
		const onScreen = visibleTabs.value.findIndex((e) => e.index === props.activeTabIndex);
		if (onScreen === -1) return;
		const tab = el.children[onScreen] as HTMLElement | undefined;
		tab?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
	},
);

// -------------------------------------------------------------------------
// Inline rename
// -------------------------------------------------------------------------

const editingTabIndex = ref<number | null>(null);

const { editValue, editInput, isEditing, startRename: startRenameRaw, commitRename, cancelRename } = useRename({
	onCommit: (newValue) => {
		if (editingTabIndex.value === null) return;
		const tab = props.tabs[editingTabIndex.value];
		if (tab !== undefined) {
			// Rename operates on the active pane's channel
			const channelId = props.getActiveChannelId(tab.id);
			if (channelId !== null) {
				emit("rename-tab", channelId, newValue);
			}
		}
	},
});

watch(isEditing, (editing) => {
	if (!editing) editingTabIndex.value = null;
});

function startRename(idx: number): void {
	const tab = props.tabs[idx];
	if (tab === undefined) return;
	editingTabIndex.value = idx;
	startRenameRaw(props.getTabLabel(tab.id));
}

// -------------------------------------------------------------------------
// Welcome tab check (checks active pane's channel)
// -------------------------------------------------------------------------

function isWelcomeTab(tabId: string): boolean {
	const channelId = props.getActiveChannelId(tabId);
	return channelId !== null && channelsStore.welcomeChannel?.id === channelId;
}

// -------------------------------------------------------------------------
// Context menu
// -------------------------------------------------------------------------

const ctxMenu = reactive({ visible: false, x: 0, y: 0, tabIndex: -1 });

function onTabContextMenu(idx: number, event: MouseEvent): void {
	ctxMenu.x = event.clientX;
	ctxMenu.y = event.clientY;
	ctxMenu.tabIndex = idx;
	ctxMenu.visible = true;
}

function onCtxRename(channelId: string): void {
	// Find the tab whose active channel matches
	const idx = props.tabs.findIndex((t) => props.getActiveChannelId(t.id) === channelId);
	if (idx !== -1) startRename(idx);
}

/** Whether the context-menu'd tab has a user-set custom title. */
const isCtxTabCustomTitle = computed(() => {
	const tab = ctxMenu.tabIndex >= 0 ? props.tabs[ctxMenu.tabIndex] : undefined;
	if (!tab) return false;
	const channelId = props.getActiveChannelId(tab.id);
	if (channelId === null) return false;
	const ch = channelsStore.channels.find((c) => c.id === channelId);
	return ch?.title != null && ch.title !== "";
});

function onCtxResetTitle(channelId: string): void {
	channelsStore.clearTitle(channelId);
}

// -------------------------------------------------------------------------
// Tab bar drop (move pane to new tab between existing tabs)
// -------------------------------------------------------------------------

const dropInsertIndex = ref<number | null>(null);

/**
 * Determine the insertion index for a tab-bar drop based on mouse position.
 * Returns the index at which a new tab would be inserted.
 */
function getDropInsertIndex(event: DragEvent): number {
	const el = tabBarEl.value;
	const pastTheEnd = lastVisibleIndex.value === -1 ? props.tabs.length : lastVisibleIndex.value + 1;
	if (!el) return pastTheEnd;

	// Iterate over tab buttons to find the insertion point. A button's position
	// on screen is not its position in the list when the bar shows one host's
	// tabs, so the answer is the index that tab has in the full list.
	const buttons = Array.from(el.querySelectorAll<HTMLElement>("[role=tab]"));
	for (let i = 0; i < buttons.length; i++) {
		const btn = buttons[i];
		if (!btn) continue;
		const rect = btn.getBoundingClientRect();
		const midX = rect.left + rect.width / 2;
		if (event.clientX < midX) return visibleTabs.value[i]?.index ?? pastTheEnd;
	}
	return pastTheEnd;
}

function onTabBarDragOver(event: DragEvent): void {
	if (!event.dataTransfer) return;
	const types = event.dataTransfer.types;
	if (!types.includes("text/x-lasterm-pane") && !types.includes("text/x-lasterm-tab")) return;
	event.dataTransfer.dropEffect = "move";
	dropInsertIndex.value = getDropInsertIndex(event);
}

function onTabBarDragLeave(event: DragEvent): void {
	const el = event.currentTarget as HTMLElement;
	const related = event.relatedTarget as Node | null;
	if (related && el.contains(related)) return;
	dropInsertIndex.value = null;
}

function onTabBarDrop(event: DragEvent): void {
	dropInsertIndex.value = null;

	if (!event.dataTransfer) return;

	// Tab reorder drop takes priority
	const tabData = event.dataTransfer.getData("text/x-lasterm-tab");
	if (tabData !== "") {
		event.stopPropagation();
		const fromIndex = Number.parseInt(tabData, 10);
		if (Number.isNaN(fromIndex)) return;
		const toIndex = getDropInsertIndex(event);
		// When dragging right, the removal shifts indices left by 1
		const adjustedTo = toIndex > fromIndex ? toIndex - 1 : toIndex;
		emit("reorder-tab", fromIndex, adjustedTo);
		return;
	}

	// Pane-to-new-tab drop (existing behavior)
	const raw = event.dataTransfer.getData("text/x-lasterm-pane");
	if (!raw) return;

	let data: { channelId: string; paneId: string; hostId: string | null };
	try {
		data = JSON.parse(raw) as typeof data;
	} catch {
		return;
	}

	// Prevent drops from propagating to PaneLayout drop zones
	event.stopPropagation();

	const insertIdx = getDropInsertIndex(event);
	emit("move-to-new-tab", data.channelId, insertIdx);
}

// -------------------------------------------------------------------------
// Tab DnD reorder
// -------------------------------------------------------------------------

const dragTabIndex = ref<number | null>(null);

function onTabDragStart(idx: number, event: DragEvent): void {
	// Don't drag while renaming
	if (editingTabIndex.value === idx) return;
	if (!event.dataTransfer) return;
	dragTabIndex.value = idx;
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData("text/x-lasterm-tab", String(idx));
}

function onTabDragEnd(): void {
	dragTabIndex.value = null;
	dropInsertIndex.value = null;
}
</script>

<style scoped>
.tab-bar {
	display: flex;
	align-items: stretch;
	background: rgba(var(--nt-tab-bar-rgb), var(--nt-tab-bar-alpha));
	border-bottom: 1px solid var(--nt-border);
	overflow-x: auto;
	overflow-y: hidden;
	flex-shrink: 0;
	min-height: 32px;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-border) transparent;
}

.tab-bar::-webkit-scrollbar {
	height: 3px;
}

.tab-bar::-webkit-scrollbar-track {
	background: transparent;
}

.tab-bar::-webkit-scrollbar-thumb {
	background: var(--nt-border);
	border-radius: 2px;
}

.tab {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 0 10px 0 12px;
	min-width: 80px;
	max-width: 180px;
	background: var(--nt-host-rail);
	border: none;
	border-right: 1px solid var(--nt-border);
	color: var(--nt-text-secondary);
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
	white-space: nowrap;
	overflow: hidden;
	transition: background 0.1s, color 0.1s;
	position: relative;
	flex-shrink: 0;
}

.tab:hover {
	background: var(--nt-bg);
	color: var(--nt-sidebar-text);
}

.tab--active {
	background: var(--nt-border);
	color: var(--nt-fg);
	border-bottom: 2px solid var(--nt-accent);
}

.tab--active:hover {
	background: var(--nt-border);
}

/* The keyboard's tab (#637): a ring in the theme's accent, inside the tab. */
.tab:focus {
	outline: none;
}

.tab:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.tab--dragging {
	opacity: 0.5;
}

.tab--drop-before::before {
	content: "";
	position: absolute;
	left: -1px;
	top: 4px;
	bottom: 4px;
	width: 2px;
	background: var(--nt-accent, #6495ed);
	z-index: 10;
}

.tab--drop-after::after {
	content: "";
	position: absolute;
	right: -1px;
	top: 4px;
	bottom: 4px;
	width: 2px;
	background: var(--nt-accent, #6495ed);
	z-index: 10;
}

.tab__welcome-star {
	flex-shrink: 0;
	font-size: 10px;
	color: var(--nt-accent);
	line-height: 1;
}

.tab__label {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	text-align: left;
}

/* The host marker. It sits before the label so a glance down the bar reads a
   column of hosts, and it takes the host's own colour — the same one the host
   rail uses, so the two agree. */
.tab__host-dot {
	flex-shrink: 0;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--tab-host-color, var(--nt-accent));
}

.tab__host-initials {
	flex-shrink: 0;
	padding: 0 4px;
	border-radius: 3px;
	font-size: 9px;
	font-weight: 600;
	line-height: 14px;
	letter-spacing: 0.02em;
	color: var(--nt-bright-white, #fff);
	background: var(--tab-host-color, var(--nt-accent));
}

/* The host's colour costs no width at all: the tab keeps its size and takes
   the colour along its top edge. The top, because the bottom is where the
   active tab draws its own accent — two lines sharing one edge is two signals
   nobody can tell apart. */
.tab--host-edge {
	box-shadow: inset 0 2px 0 0 var(--tab-host-color, var(--nt-accent));
}

.tab__activity-dot {
	flex-shrink: 0;
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--nt-blue, #3b82f6);
}

.tab__bell-badge {
	flex-shrink: 0;
	min-width: 16px;
	height: 16px;
	padding: 0 4px;
	border-radius: 8px;
	background: var(--nt-badge);
	color: var(--nt-bright-white, #fff);
	font-size: 10px;
	font-weight: 700;
	line-height: 16px;
	text-align: center;
}

.tab__close {
	flex-shrink: 0;
	/* The glyph is 16px; the target around it is not. A close that misses lands
	   on the tab, which selects it instead — the gesture appears to do nothing,
	   and is tried again. The negative margin keeps the tab the size it was. */
	width: 24px;
	height: 24px;
	margin: -4px -4px -4px 0;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 3px;
	font-size: 14px;
	line-height: 1;
	opacity: 0;
	color: var(--nt-text-secondary);
	transition: opacity 0.1s, background 0.1s, color 0.1s;
}

.tab:hover .tab__close,
.tab--active .tab__close {
	opacity: 1;
}

.tab__close:hover {
	background: var(--nt-tab-hover);
	color: var(--nt-badge);
}

.tab-rename-input {
	flex: 1;
	background: transparent;
	border: none;
	border-bottom: 1px solid var(--nt-tab-hover);
	color: inherit;
	font: inherit;
	outline: none;
	width: 100%;
	padding: 0;
	min-width: 0;
}

.tab-bar__add-group {
	display: flex;
	flex-shrink: 0;
	align-self: stretch;
}

.tab-bar__add {
	background: transparent;
	border: none;
	color: var(--nt-tab-hover);
	line-height: 1;
	cursor: pointer;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: color 0.1s, background 0.1s;
	align-self: stretch;
}

.tab-bar__add--main {
	width: 32px;
	font-size: 18px;
}

.tab-bar__add--chevron {
	width: 16px;
	font-size: 11px;
	border-left: 1px solid var(--nt-border);
	padding: 0 2px;
}

.tab-bar__add:hover {
	color: var(--nt-accent);
	background: var(--nt-bg);
}
</style>
