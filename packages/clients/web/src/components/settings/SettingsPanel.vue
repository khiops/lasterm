<template>
	<Teleport to="body">
		<Transition name="settings-fade">
			<div
				v-if="visible"
				class="settings-overlay"
				@mousedown.self="$emit('close')"
			>
				<Transition name="settings-slide">
					<div
						v-if="visible"
						ref="panelEl"
						class="settings-panel"
						role="dialog"
						aria-label="Settings"
						aria-modal="true"
						tabindex="-1"
						@keydown="onPanelKeydown"
					>
						<div class="settings-header">
							<h2 class="settings-title">Settings</h2>
							<button
								ref="closeEl"
								class="settings-close"
								type="button"
								aria-label="Close settings panel"
								@click="$emit('close')"
							>
								&#10005;
							</button>
						</div>

						<ScopeTabBar
							v-model="settingsStore.activeScope"
							v-bind="{
								...(hostName !== undefined && { hostName }),
								...(channelName !== undefined && { channelName }),
							}"
							:show-host="showHost"
							:show-channel="showChannel"
						/>

						<div class="settings-body">
							<CategoryNav
								v-model="settingsStore.activeCategory"
								:scope="settingsStore.activeScope"
								:show-desktop="runsInTauri"
								@enter-detail="focusDetail"
							/>
							<!-- Focusable itself, for a category with no control: → still goes in. -->
							<div ref="contentEl" class="settings-content" tabindex="-1">
								<div v-if="settingsStore.loading" class="settings-loading">
									Loading settings...
								</div>
								<template v-else>
									<AppearanceCategory
										v-if="settingsStore.activeCategory === 'appearance'"
										:scope="settingsStore.activeScope"
									/>
									<WallpaperCategory
										v-else-if="settingsStore.activeCategory === 'wallpaper'"
										:scope="settingsStore.activeScope"
									/>
									<ProfilesSettings
										v-else-if="settingsStore.activeCategory === 'profiles'"
									/>
									<EnvironmentCategory
										v-else-if="settingsStore.activeCategory === 'environment'"
										:scope="settingsStore.activeScope"
									/>
									<ElevationCategory
										v-else-if="settingsStore.activeCategory === 'elevation'"
										:scope="settingsStore.activeScope"
									/>
									<AgentManagerCategory
										v-else-if="settingsStore.activeCategory === 'agents'"
										:desktop-version="desktopVersion"
									/>
									<DesktopCategory
										v-else-if="settingsStore.activeCategory === 'desktop'"
									/>
									<ConfirmationsCategory
										v-else-if="settingsStore.activeCategory === 'confirmations'"
									/>
									<SchemaCategory
										v-else-if="settingsStore.activeCategory !== 'keybindings'"
										:category="settingsStore.activeCategory"
										:scope="settingsStore.activeScope"
										v-bind="hostName !== undefined ? { hostName } : {}"
									/>
									<KeybindingsCategory v-else />
								</template>
							</div>
						</div>

						<!-- About footer -->
						<div class="settings-footer">
							<button
								class="settings-about-btn"
								type="button"
								@click="showAbout = true"
							>
								About Lasterm
							</button>
						</div>
					</div>
				</Transition>
			</div>
		</Transition>
	</Teleport>

	<AboutModal :show="showAbout" @close="showAbout = false" />
</template>

<script setup lang="ts">
import { DEFAULT_CHANNEL_NAME } from '@lasterm/shared';
import { computed, nextTick, ref, watch } from 'vue';
import { useChannelsStore } from '../../stores/channels.js';
import { windowShortcutOf } from '../../utils/app-shortcuts.js';
import { nextInCycle } from '../../utils/focus-zones.js';
import { useHostsStore } from '../../stores/hosts.js';
import { type Scope, useSettingsStore } from '../../stores/settings.js';
import { useToastStore } from '../../stores/toast.js';
import AboutModal from '../AboutModal.vue';
import CategoryNav from './CategoryNav.vue';
import AgentManagerCategory from './categories/AgentManagerCategory.vue';
import AppearanceCategory from './categories/AppearanceCategory.vue';
import DesktopCategory from './categories/DesktopCategory.vue';
import ConfirmationsCategory from './categories/ConfirmationsCategory.vue';
import ElevationCategory from './categories/ElevationCategory.vue';
import EnvironmentCategory from './categories/EnvironmentCategory.vue';
import KeybindingsCategory from './categories/KeybindingsCategory.vue';
import SchemaCategory from './categories/SchemaCategory.vue';
import WallpaperCategory from './categories/WallpaperCategory.vue';
import ProfilesSettings from './ProfilesSettings.vue';
import ScopeTabBar from './ScopeTabBar.vue';
import { isTauriRuntime } from '../../utils/hub-url.js';

const props = defineProps<{
	visible: boolean;
	desktopVersion?: string | undefined;
}>();

const emit = defineEmits<{
	close: [];
}>();

const settingsStore = useSettingsStore();
const hostsStore = useHostsStore();
const channelsStore = useChannelsStore();
const toastStore = useToastStore();

const showAbout = ref(false);
const runsInTauri = isTauriRuntime();

// ─── Derived context ──────────────────────────────────────────────────

const showHost = computed(() => hostsStore.selectedHostId !== null);
const showChannel = computed(() => channelsStore.selectedChannelId !== null);

const hostName = computed(() => {
	if (!hostsStore.selectedHostId) return undefined;
	const host = hostsStore.hosts.find((h) => h.id === hostsStore.selectedHostId);
	return host?.label ?? undefined;
});

const channelName = computed(() => {
	if (!channelsStore.selectedChannelId) return undefined;
	const ch = channelsStore.channels.find((c) => c.id === channelsStore.selectedChannelId);
	return ch?.displayTitle ?? DEFAULT_CHANNEL_NAME;
});

// ─── Load cascade when panel opens ────────────────────────────────────

watch(
	() => props.visible,
	(isVisible) => {
		if (isVisible) {
			void settingsStore.loadCascade(
				hostsStore.selectedHostId ?? undefined,
				channelsStore.selectedChannelId ?? undefined,
			);
		}
	},
);

// ─── The keyboard (#637) ──────────────────────────────────────────────
//
// On open the keyboard lands on the current category of the menu, and on close it goes back to
// where it was. ↑ and ↓ move along the menu (CategoryNav), → or Enter go into the detail, and
// Esc or Shift+Tab from the detail's first control come back. Esc elsewhere closes. F6 moves
// between the menu, the detail and the close button, and Tab stays inside: the panel is modal.

const panelEl = ref<HTMLElement | null>(null);
const contentEl = ref<HTMLElement | null>(null);
const closeEl = ref<HTMLElement | null>(null);

/** The panel's own zones, in the order F6 visits them. */
const SETTINGS_ZONES = ['menu', 'detail', 'close'] as const;
type SettingsZone = (typeof SETTINGS_ZONES)[number];

/** Elements that can take Tab, unless their tabindex keeps them out (a roving item's). */
const TABBABLE =
	'button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]';

/** Where the keyboard was before the panel opened, to go back to on close. */
let returnFocusTo: HTMLElement | null = null;

watch(
	() => props.visible,
	(isVisible) => {
		if (isVisible) {
			const active = document.activeElement;
			returnFocusTo = active instanceof HTMLElement && active !== document.body ? active : null;
			void nextTick(focusMenu);
			return;
		}
		const back = returnFocusTo;
		returnFocusTo = null;
		if (back?.isConnected === true) back.focus();
	},
);

function tabbablesIn(root: HTMLElement | null): HTMLElement[] {
	if (root === null) return [];
	return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
		(el) => el.tabIndex >= 0 && el.closest('[hidden], [inert]') === null,
	);
}

/** The current category's item in the menu: the one that takes Tab there. */
function menuItem(): HTMLElement | null {
	return panelEl.value?.querySelector<HTMLElement>('.category-nav [tabindex="0"]') ?? null;
}

/** The detail's first control, or the detail itself when it has none. */
function detailEntry(): HTMLElement | null {
	return tabbablesIn(contentEl.value)[0] ?? contentEl.value;
}

function focusMenu(): void {
	menuItem()?.focus();
}

function focusDetail(): void {
	void nextTick(() => detailEntry()?.focus());
}

function zoneOf(target: HTMLElement): SettingsZone | null {
	if (target.closest('.category-nav') !== null) return 'menu';
	if (contentEl.value?.contains(target) === true) return 'detail';
	if (target === closeEl.value) return 'close';
	return null;
}

function zoneEntry(zone: SettingsZone): HTMLElement | null {
	if (zone === 'menu') return menuItem();
	if (zone === 'detail') return detailEntry();
	return closeEl.value;
}

function onPanelKeydown(event: KeyboardEvent): void {
	const target = event.target as HTMLElement;
	// F6, Shift+F6 and their Ctrl chords, from the shortcut table: the window leaves them to this
	// dialog (it takes the keys that move the keyboard, and runs none behind a modal), and they
	// move between its own zones.
	const shortcut = windowShortcutOf(event);
	if (shortcut === 'zone.next' || shortcut === 'zone.previous') {
		event.preventDefault();
		const next = nextInCycle(
			SETTINGS_ZONES,
			zoneOf(target),
			shortcut === 'zone.next' ? 1 : -1,
			(zone) => zoneEntry(zone) !== null,
		);
		if (next !== null) zoneEntry(next)?.focus();
		return;
	}
	// A control that used the key itself — an open dropdown's Esc — keeps it.
	if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
	if (event.key === 'Escape' && !event.shiftKey) {
		event.preventDefault();
		// From the detail, back to its category in the menu; anywhere else, the panel closes.
		if (zoneOf(target) === 'detail') focusMenu();
		else emit('close');
		return;
	}
	if (event.key !== 'Tab') return;
	if (event.shiftKey && zoneOf(target) === 'detail' && target === detailEntry()) {
		event.preventDefault();
		focusMenu();
		return;
	}
	// The panel is modal: Tab goes round inside it.
	const tabbables = tabbablesIn(panelEl.value);
	const first = tabbables[0];
	const last = tabbables[tabbables.length - 1];
	if (first === undefined || last === undefined) return;
	if (!event.shiftKey && target === last) {
		event.preventDefault();
		first.focus();
	} else if (event.shiftKey && target === first) {
		event.preventDefault();
		last.focus();
	}
}

// ─── Auto-fallback scope when context changes ─────────────────────────

watch(
	() => showHost.value,
	(hasHost) => {
		if (!hasHost && settingsStore.activeScope === 'host') {
			settingsStore.activeScope = 'global';
		}
	},
);

watch(
	() => showChannel.value,
	(hasChannel) => {
		if (!hasChannel && settingsStore.activeScope === 'channel') {
			settingsStore.activeScope = 'global';
		}
	},
);

// ─── Toast when no overrides at the active scope (auto-fallback) ───────

/**
 * Returns true if the terminal section has zero explicit overrides at
 * the given scope (i.e. every value will fall back to a higher scope).
 */
function hasNoScopeOverrides(scope: Scope): boolean {
	if (scope === 'global') return false;
	if (!settingsStore.cascade) return false;
	const layer = scope === 'host' ? settingsStore.cascade.terminal.host : settingsStore.cascade.terminal.channel;
	if (!layer) return true;
	// If every own key is null/undefined the scope has no overrides
	return Object.values(layer as Record<string, unknown>).every((v) => v === null || v === undefined);
}

watch(
	() => settingsStore.activeScope,
	(scope) => {
		if (scope === 'global') return;
		if (!settingsStore.cascade) return;
		if (hasNoScopeOverrides(scope)) {
			const scopeName = scope === 'host' ? (hostName.value ?? 'host') : 'channel';
			toastStore.show('info', `No overrides at ${scopeName} level — showing inherited values`, 3000);
		}
	},
);
</script>

<style scoped>
.settings-overlay {
	position: fixed;
	inset: 0;
	background: var(--nt-overlay);
	display: flex;
	justify-content: flex-end;
	z-index: 900;
}

.settings-panel {
	width: 680px;
	max-width: calc(100vw - 64px);
	height: 100%;
	background: var(--nt-bg);
	border-left: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

.settings-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	border-bottom: 1px solid var(--nt-border);
	flex-shrink: 0;
}

.settings-title {
	margin: 0;
	font-size: 15px;
	font-weight: 700;
	color: var(--nt-fg);
}

.settings-close {
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 16px;
	cursor: pointer;
	padding: 4px;
	line-height: 1;
	border-radius: 4px;
}

.settings-close:hover {
	color: var(--nt-fg);
	background: var(--nt-hover);
}

/* The keyboard's place, on every control of the panel and of its categories (#637): a ring in
   the theme's accent. A mouse click shows none. */
.settings-panel :deep(:focus-visible) {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

/* The panel and the detail take the keyboard only to hand it on: inside, the ring. */
.settings-panel:focus-visible,
.settings-content:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: -2px;
}

.settings-body {
	flex: 1;
	display: flex;
	overflow: hidden;
}

.settings-content {
	flex: 1;
	overflow-y: auto;
	padding: 20px;
	scrollbar-width: thin;
	scrollbar-color: var(--nt-scrollbar-thumb) var(--nt-scrollbar-track);
}

.settings-loading {
	display: flex;
	align-items: center;
	justify-content: center;
	height: 100%;
	color: var(--nt-text-secondary);
	font-size: 13px;
}

.settings-footer {
	flex-shrink: 0;
	padding: 10px 16px;
	border-top: 1px solid var(--nt-border);
	display: flex;
	justify-content: center;
}

.settings-about-btn {
	background: transparent;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 12px;
	cursor: pointer;
	padding: 4px 8px;
	border-radius: 4px;
	transition: color 0.15s ease, background 0.15s ease;
}

.settings-about-btn:hover {
	color: var(--nt-fg);
	background: var(--nt-hover);
}

/* ── Transitions ──────────────────────────────────────────────────────── */

.settings-fade-enter-active,
.settings-fade-leave-active {
	transition: opacity 0.2s ease;
}

.settings-fade-enter-from,
.settings-fade-leave-to {
	opacity: 0;
}

.settings-slide-enter-active,
.settings-slide-leave-active {
	transition: transform 0.3s ease;
}

.settings-slide-enter-from,
.settings-slide-leave-to {
	transform: translateX(100%);
}
</style>
