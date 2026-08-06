<template>
	<Teleport to="body">
		<Transition name="settings-fade">
			<div
				v-if="visible"
				class="settings-overlay"
				@mousedown.self="$emit('close')"
				@keydown.escape="$emit('close')"
			>
				<Transition name="settings-slide">
					<div
						v-if="visible"
						class="settings-panel"
						role="dialog"
						aria-label="Settings"
						aria-modal="true"
						tabindex="-1"
					>
						<div class="settings-header">
							<h2 class="settings-title">Settings</h2>
							<button
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
							/>
							<div class="settings-content">
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
import { computed, ref, watch } from 'vue';
import { useChannelsStore } from '../../stores/channels.js';
import { useHostsStore } from '../../stores/hosts.js';
import { type Scope, useSettingsStore } from '../../stores/settings.js';
import { useToastStore } from '../../stores/toast.js';
import AboutModal from '../AboutModal.vue';
import CategoryNav from './CategoryNav.vue';
import AgentManagerCategory from './categories/AgentManagerCategory.vue';
import AppearanceCategory from './categories/AppearanceCategory.vue';
import DesktopCategory from './categories/DesktopCategory.vue';
import ElevationCategory from './categories/ElevationCategory.vue';
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

defineEmits<{
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
