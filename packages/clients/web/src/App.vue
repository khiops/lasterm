<template>
	<div class="app-root" :class="{ 'app-root--transparent': windowUsesTransparentBackground }">
		<TitleBar />
		<!-- Write-request dialog — rendered globally, outside layout, via Teleport -->
		<WriteRequestDialog />

		<!-- Auth-prompt dialog — SSH password / passphrase, rendered via Teleport -->
		<AuthPromptDialog />

		<!-- Host key warning dialog — SSH host key mismatch (TOFU), rendered via Teleport -->
		<HostKeyWarning />

		<!-- Agent binary verify dialog — remote agent SHA256 TOFU, rendered via Teleport -->
		<AgentBinaryVerify />

		<!-- Agent deploy failed dialog — AGENT_NOT_AVAILABLE error with retry, rendered via Teleport -->
		<AgentDeployFailed />

		<!-- Global in-app toast notifications (SSH errors, spawn failures, etc.) -->
		<ToastContainer />

		<!-- Command Palette — Teleport to body, triggered by Ctrl+P / Cmd+P -->
		<CommandPalette />

		<!-- Settings panel — rendered globally, outside layout, via Teleport -->
		<SettingsPanel
			:visible="showSettings"
			:desktop-version="desktopVersion"
			@close="showSettings = false"
		/>

		<CloseModal
			:visible="closeModalVisible"
			:busy="false"
			@select="onCloseModalSelect"
			@cancel="onCloseModalCancel"
		/>

		<!-- Configure Command dialog — opened from tab context menu or exit overlay -->
		<ConfigureCommandDialog
			:visible="showConfigureDialog"
			:channel-id="configureChannelId"
			@close="showConfigureDialog = false"
			@applied="showConfigureDialog = false"
		/>

		<!-- Confirm dialog — used for Close All / Close Others confirmations -->
		<ConfirmDialog
			:visible="confirmDialog.visible"
			:title="confirmDialog.title"
			:message="confirmDialog.message"
			confirm-label="Close"
			:show-remember="true"
			@confirm="onConfirmAction"
			@cancel="confirmDialog.visible = false"
		/>

		<!-- Add/Edit Host modal — opened from rail "+" or host context menu -->
		<HostModal
			v-if="showHostModal"
			:visible="true"
			:edit-host="editingHost"
			@close="showHostModal = false; editingHost = null"
			@saved="onHostSaved"
			@batch-import="showHostModal = false; showBatchImport = true"
		/>

		<!-- Context menus — host badge and group header right-click -->
		<HostContextMenu
			:visible="hostContextMenu !== null"
			:host-id="hostContextMenu?.hostId ?? ''"
			:x="hostContextMenu?.x ?? 0"
			:y="hostContextMenu?.y ?? 0"
			@close="hostContextMenu = null"
			@edit="onEditHost"
			@delete="onDeleteHost"
			@connect="onConnectHost"
			@disconnect="onDisconnectHost"
			@new-group="onNewGroupForHost"
		/>

		<GroupContextMenu
			:visible="groupContextMenu !== null"
			:group-id="groupContextMenu?.groupId ?? ''"
			:group-name="groupContextMenu?.groupName ?? ''"
			:x="groupContextMenu?.x ?? 0"
			:y="groupContextMenu?.y ?? 0"
			@close="groupContextMenu = null"
			@rename="onRenameGroup"
			@delete-group="onDeleteGroup"
		/>

		<!-- Rail background context menu -->
		<RailContextMenu
			:visible="railContextMenu !== null"
			:x="railContextMenu?.x ?? 0"
			:y="railContextMenu?.y ?? 0"
			@close="railContextMenu = null"
			@add-host="showHostModal = true"
			@add-group="onAddGroupFromRail"
		/>

		<!-- Rename group dialog -->
		<GroupActionDialog
			v-if="renameGroupId !== null"
			:visible="true"
			title="Rename Group"
			:message="`Rename group '${renameGroupCurrentName}'.`"
			confirm-label="Rename"
			input-label="NEW NAME"
			:input-value="renameGroupCurrentName"
			input-placeholder="Group name"
			@close="renameGroupId = null"
			@confirm="onRenameGroupConfirmed"
		/>

		<!-- Delete group confirmation -->
		<GroupActionDialog
			v-if="deleteGroupId !== null"
			:visible="true"
			title="Delete Group"
			:message="`Delete group '${deleteGroupCurrentName}'? Hosts will move to Ungrouped.`"
			confirm-label="Delete"
			:confirm-danger="true"
			@close="deleteGroupId = null"
			@confirm="onDeleteGroupConfirmed"
		/>

		<!-- Create host-group dialog (triggered from rail context menu) -->
		<GroupActionDialog
			:visible="createGroupDialogVisible"
			title="Create Group"
			message="Create a new host group."
			confirm-label="Create"
			input-label="GROUP NAME"
			input-placeholder="Enter group name"
			@close="createGroupDialogVisible = false"
			@confirm="onCreateGroupConfirmed"
		/>

		<!-- Sidebar background context menu -->
		<SidebarContextMenu
			:visible="sidebarContextMenu !== null"
			:x="sidebarContextMenu?.x ?? 0"
			:y="sidebarContextMenu?.y ?? 0"
			@close="sidebarContextMenu = null"
			@add-group="onAddChannelGroupFromSidebar"
		/>

		<!-- Create channel-group dialog -->
		<GroupActionDialog
			:visible="createChannelGroupDialogVisible"
			title="Create Group"
			message="Create a new channel group."
			confirm-label="Create"
			input-label="GROUP NAME"
			input-placeholder="Enter group name"
			@close="createChannelGroupDialogVisible = false"
			@confirm="onCreateChannelGroupConfirmed"
		/>

		<!-- Delete host confirmation modal -->
		<DeleteHostModal
			:visible="deleteHostId !== null"
			:host-id="deleteHostId ?? ''"
			@close="deleteHostId = null"
			@deleted="deleteHostId = null; void hostsStore.fetchHosts()"
		/>

		<!-- Batch import from SSH config -->
		<BatchImportModal
			v-model:show="showBatchImport"
			@imported="void hostsStore.fetchHosts()"
		/>

		<!-- Pairing code generator dialog -->
		<Teleport to="body">
			<div v-if="showPairingGenerator" class="pairing-gen-overlay" @click.self="showPairingGenerator = false">
				<div class="pairing-gen-card">
					<div class="pairing-gen-header">
						<h3 class="pairing-gen-title">Pair Another Device</h3>
						<button class="pairing-gen-close" @click="showPairingGenerator = false" aria-label="Close">&times;</button>
					</div>
					<p class="pairing-gen-desc">
						Generate a one-time code to authenticate another browser or device.
						Your current session will not be affected.
					</p>
					<PairingCodeGenerator />
				</div>
			</div>
		</Teleport>

		<!-- Pairing overlay — shown when no token yet, or AUTH_FAIL -->
		<PairingScreen
			v-if="needsPairing"
			@authenticated="onAuthenticated"
		/>

		<!-- Loading screen — shown while config/theme loads after auth -->
		<div v-else-if="!appReady" class="app-loading">
			<div class="app-loading-spinner" />
		</div>

		<template v-else>
			<!-- Window-wide wallpaper — one layer behind every app region -->
			<TransitionGroup
				name="window-wallpaper-fade"
				tag="div"
				class="window-wallpaper"
				aria-hidden="true"
			>
				<div
					v-if="windowWallpaperStyle"
					:key="`bg:${windowWallpaperLayerKey}`"
					class="window-wallpaper__bg"
					:style="windowWallpaperStyle"
				/>
				<div
					v-if="windowWallpaperDimStyle"
					:key="`dim:${windowWallpaperLayerKey}`"
					class="window-wallpaper__dim"
					:style="windowWallpaperDimStyle"
				/>
			</TransitionGroup>

			<!-- Main layout — only shown when authenticated and WS ready -->
			<div class="app-layout" :style="layoutStyle">
			<HostRail
				class="host-rail"
				@toggle-settings="showSettings = !showSettings"
				@toggle-palette="commandPalette.toggle()"
				@add-host="showHostModal = true"
				@rail-context-menu="onRailContextMenu"
				@host-context-menu="onHostContextMenu"
				@group-context-menu="onGroupContextMenu"
			/>
			<!-- Resize handle after host rail -->
			<div
				class="resize-handle"
				:style="{ left: railResize.width.value + 'px' }"
				@mousedown="railResize.onMouseDown"
				@dblclick="railResize.reset"
			/>
			<ChannelSidebar
				v-show="!sidebarResize.collapsed.value"
				class="channel-sidebar"
				@select-channel="onSelectChannel"
				@open-new-tab="onSidebarOpenNewTab"
				@open-current-tab="onSidebarOpenCurrentTab"
				@configure-command="onConfigureCommand"
				@set-welcome="onSetWelcome"
				@sidebar-context-menu="onSidebarContextMenu"
				@add-channel-group="onAddChannelGroupFromSidebar"
				@purge-dead="onPurgeDead"
				@delete-channel="onDeleteChannel"
				@new-channel="onAddTab"
			/>
			<!-- Resize handle after channel sidebar -->
			<div
				class="resize-handle"
				:style="{ left: (railResize.width.value + (sidebarResize.collapsed.value ? 0 : sidebarResize.width.value)) + 'px' }"
				@mousedown="sidebarResize.onMouseDown"
				@dblclick="sidebarResize.reset"
			/>

			<!-- Terminal main: tab bar + recursive pane layout -->
			<div class="terminal-main">
				<TabBar
					:tabs="layout.tabs.value"
					:active-tab-index="layout.activeTabIndex.value"
					:get-tab-label="layout.getTabLabel"
					:get-active-channel-id="layout.getActiveChannelId"
					@select-tab="layout.setActiveTab"
					@close-tab="layout.closeTab"
					@close-others="onCloseOthers"
					@close-to-right="layout.closeToRight"
					@close-all="onCloseAll"
					@add-tab="onAddTab"
					@rename-tab="onRenameTab"
					@split="onSplit"
					@set-welcome="onSetWelcome"
					@move-to-new-tab="onMoveToNewTab"
					@reorder-tab="layout.reorderTab"
					@configure-command="onConfigureCommand"
				/>
				<div class="pane-area">
					<div
						v-for="(tab, idx) in layout.tabs.value"
						:key="tab.id"
						v-show="idx === layout.activeTabIndex.value"
						class="pane-tab-container"
					>
						<PaneLayout
							v-if="layout.layouts.value[tab.id]"
							:node="layout.layouts.value[tab.id]!"
							:host-id="channelsStore.activeHostId"
							:tab-id="tab.id"
							:has-multiple-panes="tabHasMultiplePanes(tab.id)"
							@split="onSplit"
							@close-pane="onClosePane"
							@detach-pane="onDetachPane"
							@update-ratio="layout.updateRatio"
							@channel-spawned="onChannelSpawned"
							@fill-vacant="onFillVacant"
							@new-terminal-vacant="onNewTerminalVacant"
							@rearrange-vacant="onRearrangeVacant"
							@drop-pane="onDropPane"
							@focus-pane="onFocusPane"
							@configure-command="onConfigureCommand"
							@search-all-panes="onSearchAllPanes"
							@find-next-all="onFindNextAll"
							@find-previous-all="onFindPreviousAll"
						/>
					</div>
					<div v-if="layout.tabs.value.length === 0" class="pane-empty">
						Select a channel or click + to open a terminal.
					</div>
				</div>
			</div>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import type { Host } from '@termora/shared';
import { generateId } from '@termora/shared';
import { computed, onMounted, onUnmounted, provide, ref, toRef, watch } from 'vue';
import AgentBinaryVerify from './components/AgentBinaryVerify.vue';
import AgentDeployFailed from './components/AgentDeployFailed.vue';
import AuthPromptDialog from './components/AuthPromptDialog.vue';
import BatchImportModal from './components/BatchImportModal.vue';
import ChannelSidebar from './components/ChannelSidebar.vue';
import CloseModal from './components/CloseModal.vue';
import CommandPalette from './components/CommandPalette.vue';
import ConfigureCommandDialog from './components/ConfigureCommandDialog.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import DeleteHostModal from './components/DeleteHostModal.vue';
import GroupActionDialog from './components/GroupActionDialog.vue';
import GroupContextMenu from './components/GroupContextMenu.vue';
import HostContextMenu from './components/HostContextMenu.vue';
import HostKeyWarning from './components/HostKeyWarning.vue';
import HostModal from './components/HostModal.vue';
import HostRail from './components/HostRail.vue';
import PairingCodeGenerator from './components/PairingCodeGenerator.vue';
import PairingScreen from './components/PairingScreen.vue';
import PaneLayout from './components/PaneLayout.vue';
import RailContextMenu from './components/RailContextMenu.vue';
import SidebarContextMenu from './components/SidebarContextMenu.vue';
import SettingsPanel from './components/settings/SettingsPanel.vue';
import TabBar from './components/TabBar.vue';
import TitleBar from './components/TitleBar.vue';
import ToastContainer from './components/ToastContainer.vue';
import WriteRequestDialog from './components/WriteRequestDialog.vue';
import {
	shouldUseTransparentBackground,
	useActiveWallpaper,
} from './composables/useActiveWallpaper.js';
import { useAutoSwitch } from './composables/useAutoSwitch.js';
import { useCommandPalette } from './composables/useCommandPalette.js';
import type { DropZone } from './composables/useLayout.js';
import {
	collectTerminalChannelIds,
	countPanes,
	purgeDeadTabs,
	purgeOrphanedTabs,
	useLayout,
} from './composables/useLayout.js';
import { MULTI_PANE_SEARCH_KEY, useMultiPaneSearch } from './composables/useMultiPaneSearch.js';
import { useResizable } from './composables/useResizable.js';
import { useTabTitle } from './composables/useTabTitle.js';
import {
	isTauriRuntime,
	usePlatformInfo,
	useWindowEffects,
} from './composables/useWindowEffects.js';
import { useWindowTitle } from './composables/useWindowTitle.js';
import { useAuthStore } from './stores/auth.js';
import { useChannelsStore } from './stores/channels.js';
import { useConfigStore } from './stores/config.js';
import { useHostsStore } from './stores/hosts.js';
import { useProfilesStore } from './stores/profiles.js';
import { useSessionStore } from './stores/session.js';
import { useThemeStore } from './stores/theme.js';
import { useToastStore } from './stores/toast.js';
import { useWriteLockStore } from './stores/writelock.js';
import { loadDesktopVersion } from './utils/desktop-version.js';
import { hubBaseUrl, initAssetToken, initHubPort } from './utils/hub-url.js';

const authStore = useAuthStore();
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const toastStore = useToastStore();

// ─── Resizable panels ────────────────────────────────────────────────────────

function saveLayoutWidth(key: string, value: number): void {
	if (authStore.token === null) return;
	void fetch(`${hubBaseUrl()}/api/config/ui`, {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${authStore.token}`,
		},
		body: JSON.stringify({ layout: { [key]: value } }),
	}).then(() => configStore.loadUiConfig());
}

const railResize = useResizable({
	initialWidth: 48,
	minWidth: 48,
	maxWidth: 120,
	onResizeEnd: (width) => saveLayoutWidth('hostRailWidth', width),
});

const sidebarResize = useResizable({
	initialWidth: 200,
	minWidth: 140,
	maxWidth: 400,
	collapseThreshold: 80,
	onResizeEnd: (width) => saveLayoutWidth('sidebarWidth', width),
});

// Apply persisted layout widths once the config loads (after auth).
watch(
	() => configStore.uiConfig.layout,
	(layout) => {
		if (!layout) return;
		if (layout.hostRailWidth > 0) {
			railResize.width.value = layout.hostRailWidth;
		}
		const sw = layout.sidebarWidth;
		if (sw === 0) {
			sidebarResize.collapsed.value = true;
			sidebarResize.width.value = 0;
		} else if (sw > 0) {
			sidebarResize.collapsed.value = false;
			sidebarResize.width.value = sw;
		}
	},
	{ once: true },
);

const layoutStyle = computed(() => ({
	'--rail-w': `${railResize.width.value}px`,
	'--sidebar-w': `${sidebarResize.collapsed.value ? 0 : sidebarResize.width.value}px`,
}));
const hostsStore = useHostsStore();
const channelsStore = useChannelsStore();
const themeStore = useThemeStore();
const writeLockStore = useWriteLockStore();
const autoSwitch = useAutoSwitch();
const layout = useLayout();
const {
	wallpaperStyle: windowWallpaperStyle,
	dimStyle: windowWallpaperDimStyle,
	backgroundMode: windowBackgroundMode,
	displayedEffectState: windowDisplayedEffectState,
} = useActiveWallpaper({
	activeTab: layout.activeTab,
	getActiveChannelId: layout.getActiveChannelId,
	channelHostMap: toRef(channelsStore, 'channelHostMap'),
});
const windowPlatformInfo = usePlatformInfo();
useWindowEffects({
	displayedEffectState: windowDisplayedEffectState,
	platformInfo: windowPlatformInfo,
});
const windowUsesTransparentBackground = computed(() =>
	shouldUseTransparentBackground(windowBackgroundMode.value, isTauriRuntime()),
);
const windowWallpaperLayerKey = computed(() => {
	const style = windowWallpaperStyle.value;
	if (!style) return 'none';
	return [
		style.backgroundImage ?? '',
		style.filter ?? '',
		windowWallpaperDimStyle.value?.background ?? '',
	]
		.map(String)
		.join('|');
});
const multiPaneSearch = useMultiPaneSearch();
provide(MULTI_PANE_SEARCH_KEY, multiPaneSearch);
const commandPalette = useCommandPalette();
const profilesStore = useProfilesStore();
const showSettings = ref(false);
const desktopVersion = ref<string | undefined>(undefined);
const closeModalVisible = ref(false);
const desktopCloseAttempt = ref<number | null>(null);
const showConfigureDialog = ref(false);
const configureChannelId = ref<string | null>(null);
const showHostModal = ref(false);
const editingHost = ref<Host | null>(null);
const deleteHostId = ref<string | null>(null);
const showBatchImport = ref(false);

const showPairingGenerator = ref(false);
let desktopCloseUnlisten: (() => void) | null = null;
let desktopCloseExpiryUnlisten: (() => void) | null = null;

watch(
	() => authStore.clientId,
	(clientId) => {
		void syncShutdownCallerClientId(clientId);
	},
	{ immediate: true },
);

// Sync auto-switch composable with server appearance config (SC-14)
// This ensures OS dark/light preference is respected at boot, not just when Settings is open.
// IMPORTANT: Set theme names BEFORE enabled — the enabled watcher is flush:sync
// and calls start() immediately, which reads darkThemeName/lightThemeName.
watch(
	() => themeStore.appearance,
	(cfg) => {
		autoSwitch.darkThemeName.value = cfg.autoSwitch.darkTheme;
		autoSwitch.lightThemeName.value = cfg.autoSwitch.lightTheme;
		autoSwitch.enabled.value = cfg.autoSwitch.enabled;
	},
	{ immediate: true },
);

// Wire up palette external actions (add-host, settings, ssh-import, toggle-sidebar, pairing-code)
commandPalette.onExternalAction.value = (actionId: string) => {
	switch (actionId) {
		case 'action:add-host':
			editingHost.value = null;
			showHostModal.value = true;
			break;
		case 'action:settings':
			showSettings.value = true;
			break;
		case 'action:ssh-import':
			showBatchImport.value = true;
			break;
		case 'action:toggle-sidebar':
			sidebarResize.collapsed.value = !sidebarResize.collapsed.value;
			break;
		case 'action:pairing-code':
			showPairingGenerator.value = true;
			break;
		default:
			console.warn('[CommandPalette] unhandled external action:', actionId);
	}
};
const hostContextMenu = ref<{
	hostId: string;
	x: number;
	y: number;
} | null>(null);
const groupContextMenu = ref<{
	groupId: string;
	groupName: string;
	x: number;
	y: number;
} | null>(null);
const railContextMenu = ref<{ x: number; y: number } | null>(null);
// Create host-group dialog
const createGroupDialogVisible = ref(false);
// ID of the group being renamed/deleted
const renameGroupId = ref<string | null>(null);
const renameGroupCurrentName = ref<string>('');
const deleteGroupId = ref<string | null>(null);
const deleteGroupCurrentName = ref<string>('');
// Channel-group create dialog + sidebar context menu
const sidebarContextMenu = ref<{ x: number; y: number } | null>(null);
const createChannelGroupDialogVisible = ref(false);

// ─── Per-channel theme cascade ───────────────────────────────────────────────

/**
 * When the active channel changes, fetch the resolved cascade for that
 * host+channel and apply the correct theme. Falls back to global theme
 * when no channel is selected.
 */
/**
 * Resolve and apply the cascade theme for a given channel.
 * Extracted so it can be called from both the watcher and onMounted.
 */
async function applyCascadeTheme(channelId: string): Promise<void> {
	if (themeStore.availableThemes.length === 0) return;
	const hostId = channelsStore.channelHostMap.get(channelId) ?? null;
	if (authStore.token === null) return;
	try {
		const params = new URLSearchParams();
		if (hostId) params.set('host_id', hostId);
		params.set('channel_id', channelId);
		const res = await fetch(`${hubBaseUrl()}/api/config/cascade?${params.toString()}`, {
			headers: { Authorization: `Bearer ${authStore.token}` },
		});
		if (!res.ok) return;
		const data = (await res.json()) as {
			terminal: {
				resolved: { theme?: string };
				host?: { theme?: string } | null;
				channel?: { theme?: string } | null;
			};
		};
		// Only apply scope override if there's an explicit host or channel theme
		const hasChannelOverride = data.terminal.channel?.theme != null;
		const hasHostOverride = data.terminal.host?.theme != null;
		if (!hasChannelOverride && !hasHostOverride) {
			// No explicit scope override — use global appearance theme
			themeStore.setScopeOverride(null);
			if (themeStore.currentTheme !== null) {
				themeStore.applyTheme(themeStore.currentTheme);
			}
			return;
		}
		const themeName = data.terminal.resolved.theme;
		if (!themeName) return;
		const theme = themeStore.availableThemes.find((t) => t.name === themeName);
		if (theme) {
			themeStore.setScopeOverride(theme);
			themeStore.applyTheme(theme);
		}
	} catch {
		// Non-critical — leave current theme applied
	}
}

watch(
	() => channelsStore.selectedChannelId,
	async (channelId) => {
		if (channelId === null) {
			// No channel selected — reapply global theme
			themeStore.setScopeOverride(null);
			if (themeStore.currentTheme !== null) {
				themeStore.applyTheme(themeStore.currentTheme);
			}
			return;
		}
		await applyCascadeTheme(channelId);
	},
);

// ─── Window title ────────────────────────────────────────────────────────────

const windowTitleEnabled = computed(() => configStore.uiConfig.title?.windowTitle !== false);

const windowTitleFormat = computed(
	() => configStore.uiConfig.title?.windowFormat ?? 'termora - {prefix}{host} - {title}',
);

const activeChannelId = computed(() => {
	const tab = layout.activeTab.value;
	if (tab === null) return null;
	return layout.getActiveChannelId(tab.id);
});
/** Resolved title of the active tab's channel (no prefix, no truncation). */
const { resolvedTitle: _resolvedTitle } = useTabTitle(activeChannelId, toRef(channelsStore, 'channels'));
const activeTitle = computed(() => (activeChannelId.value === null ? '' : _resolvedTitle.value));

/** Label of the host that owns the active tab's channel. */
const activeHost = computed(() => {
	const hostId = hostsStore.selectedHostId;
	if (hostId === null) return '';
	const host = hostsStore.hosts.find((h) => h.id === hostId);
	return host?.label ?? '';
});

/** Per-host prefix from config (global default from [title] section). */
const activePrefix = computed(() => {
	return configStore.uiConfig.title?.prefix ?? '';
});

useWindowTitle({
	enabled: windowTitleEnabled,
	format: windowTitleFormat,
	activeTitle,
	activeHost,
	activePrefix,
});

// ─── Confirm dialog state ────────────────────────────────────────────────────

const confirmDialog = ref({
	visible: false,
	title: '',
	message: '',
	action: null as (() => void) | null,
	actionKey: '' as string,
});

/**
 * Check if a confirmation should be skipped based on localStorage preferences.
 */
function shouldSkipConfirm(action: string): boolean {
	if (localStorage.getItem(`termora:skip${action}`) === 'true') return true;
	const hostId = channelsStore.activeHostId;
	if (hostId) {
		if (localStorage.getItem(`termora:skip${action}:${hostId}`) === 'true') return true;
	}
	return false;
}

/**
 * Handle confirm dialog result, including "Remember" persistence.
 */
function onConfirmAction(remember: { host: boolean; global: boolean }): void {
	const action = confirmDialog.value.action;
	const actionKey = confirmDialog.value.actionKey;

	if (remember.global) {
		localStorage.setItem(`termora:skip${actionKey}`, 'true');
	}
	if (remember.host && channelsStore.activeHostId) {
		localStorage.setItem(`termora:skip${actionKey}:${channelsStore.activeHostId}`, 'true');
	}

	action?.();
	confirmDialog.value.visible = false;
}

/**
 * Show pairing screen when:
 * - No token stored in localStorage, OR
 * - The hub responded AUTH_FAIL (token revoked / rotated on server)
 * - Post-auth config is still loading (prevents flash of default theme)
 */
const appReady = ref(false);
const postAuthLoading = ref(false);
const needsPairing = computed(() => authStore.token === null || sessionStore.authFailed || postAuthLoading.value);

/** Helper: open a tab backed by a pending spawn (TerminalPane handles the actual SPAWN). */
function openPendingTab(hostId: string): void {
	const tempId = generateId();
	channelsStore.registerPendingSpawn(tempId, hostId);
	layout.openTab(tempId);
}

/**
 * On mount: if we have a token, connect the WebSocket and fetch hosts.
 */
onMounted(async () => {
	// Ctrl+K / Cmd+K must be captured before Chrome's omnibox intercepts it (SC-14)
	window.addEventListener('keydown', onGlobalKeydown, { capture: true });
	try {
		const { listen } = await import('@tauri-apps/api/event');
		desktopCloseUnlisten = await listen<{ attemptId: number }>(
			'desktop-close-requested',
			async (event) => {
				try {
					const { invoke } = await import('@tauri-apps/api/core');
					await invoke('acknowledge_desktop_close', { attemptId: event.payload.attemptId });
					desktopCloseAttempt.value = event.payload.attemptId;
					closeModalVisible.value = true;
				} catch (error) {
					console.warn('[desktop] failed to acknowledge close presentation:', error);
				}
			},
		);
		desktopCloseExpiryUnlisten = await listen<{ attemptId: number }>('desktop-close-expired', (event) => {
			if (desktopCloseAttempt.value === event.payload.attemptId) {
				desktopCloseAttempt.value = null;
				closeModalVisible.value = false;
			}
		});
	} catch (error) {
		console.warn('[desktop] failed to register close presentations:', error);
	}

	// In Tauri desktop, resolve the hub port BEFORE any API calls so that
	// hubBaseUrl() / hubWsUrl() use the correct port (zero_conf may pick != 4100).
	try {
		await initHubPort();
	} catch {
		// Not in Tauri context — ignore
	}

	desktopVersion.value = await loadDesktopVersion();

	// In Tauri desktop, fetch the hub auth token via invoke BEFORE the
	// token check — connect() is gated by token !== null, so the invoke
	// inside _doConnect() was never reached on first launch.
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		const tauriToken = await invoke<string | null>('get_hub_auth_token');
		if (tauriToken) {
			authStore.setToken(tauriToken);
		}
	} catch {
		// Not in Tauri context — ignore
	}

	if (authStore.token !== null) {
		try {
			await sessionStore.connect();
			await initAssetToken(authStore.token);
			await configStore.loadFonts();
			// Load resolved profile + UI behaviour config now that auth is established
			await configStore.loadProfile();
			await configStore.loadUiConfig();
			await themeStore.loadThemes();
			await themeStore.loadAppearance();
			// Auto-switch watcher fires here (immediate: true) — if enabled,
			// it applies the OS-preferred theme. Otherwise fall back to saved theme.
			if (!themeStore.appearance.autoSwitch.enabled) {
				const savedThemeName = themeStore.appearance.theme;
				const savedTheme = themeStore.availableThemes.find((t) => t.name === savedThemeName);
				if (savedTheme) {
					themeStore.currentTheme = savedTheme;
					themeStore.applyTheme(savedTheme);
				}
			}
			themeStore.applyOpacity(themeStore.appearance.opacity);
			themeStore.applyScrollbar(themeStore.appearance.scrollbar);
			await hostsStore.fetchHosts();
			await profilesStore.fetchProfiles();
			// Apply channel/host theme override if an active channel exists
			if (channelsStore.selectedChannelId) {
				await applyCascadeTheme(channelsStore.selectedChannelId);
			}
		} catch (err) {
			console.error('[App] startup connect failed:', err);
		}
	}
	appReady.value = true;
});

onUnmounted(() => {
	window.removeEventListener('keydown', onGlobalKeydown, { capture: true });
	desktopCloseUnlisten?.();
	desktopCloseExpiryUnlisten?.();
});

async function onCloseModalSelect(decision: { action: 'quit' | 'tray'; remember: boolean }): Promise<void> {
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('answer_desktop_close', {
			attemptId: desktopCloseAttempt.value,
			action: decision.action,
			remember: decision.remember,
		});
		closeModalVisible.value = false;
		desktopCloseAttempt.value = null;
	} catch (error) {
		console.error('[desktop] failed to answer close choice:', error);
		const message = error instanceof Error ? error.message : String(error);
		toastStore.show('error', `Close choice failed: ${message}`, 10_000);
	}
}

function onCloseModalCancel(): void {
	const attemptId = desktopCloseAttempt.value;
	closeModalVisible.value = false;
	desktopCloseAttempt.value = null;
	if (attemptId === null) return;
	void import('@tauri-apps/api/core').then(({ invoke }) =>
		invoke('cancel_desktop_close', { attemptId }),
	);
}

async function syncShutdownCallerClientId(clientId: string | null): Promise<void> {
	if (!isTauriRuntime()) return;
	try {
		const { invoke } = await import('@tauri-apps/api/core');
		await invoke('set_shutdown_caller_client_id', { clientId });
	} catch {
		// Older desktop shells do not have this command; the server guard still applies.
	}
}



/**
 * When the selected host changes, fetch the channel list for that host.
 * This is the primary trigger for populating the ChannelSidebar.
 * On first run (no existing channels), auto-spawn a local terminal.
 */
watch(
	() => hostsStore.selectedHostId,
	async (hostId) => {
		if (hostId === null) return;
		await channelsStore.fetchChannels(hostId);
		// Clear stale write-lock entries for dead channels
		const deadIds = new Set(channelsStore.channels.filter((c) => c.status === 'dead').map((c) => c.id));
		writeLockStore.pruneDeadLocks(deadIds);
		// Always purge tabs for channels that no longer exist on this host
		purgeOrphanedTabs(
			channelsStore.channels,
			layout.tabs.value,
			layout.closeTab,
			hostId,
			channelsStore.channelHostMap,
			layout.layouts.value,
		);
		if (configStore.uiConfig.onChannelDead === 'close') {
			purgeDeadTabs(channelsStore.channels, layout.tabs.value, layout.closeTab, layout.layouts.value);
		}
		// Auto-open welcome tab if one exists and is alive
		const welcomeCh = channelsStore.channels.find((c) => c.isWelcome && c.status !== 'dead');
		if (welcomeCh) {
			layout.openTab(welcomeCh.id);
		}

		// Auto-spawn only for local hosts with no live channels and no tabs open.
		// SSH hosts require an explicit connection — auto-spawn would timeout.
		const host = hostsStore.hosts.find((h) => h.id === hostId);
		const hasAliveChannels = channelsStore.channels.some((c) => c.status !== 'dead');
		if (host?.type === 'local' && !hasAliveChannels && layout.tabs.value.length === 0) {
			openPendingTab(hostId);
		}
	},
	{ immediate: true },
);

/**
 * When a channel is selected programmatically (e.g. after removeChannel
 * fallback or fetchChannels auto-select), open its tab.
 */
watch(
	() => channelsStore.selectedChannelId,
	(channelId) => {
		if (channelId === null) return;
		layout.openTab(channelId);
	},
);

/**
 * Sidebar click handler. Always opens a tab — even when re-clicking the
 * same channel (the watcher above only fires on value *changes*).
 */
function onSelectChannel(channelId: string): void {
	layout.openTab(channelId);
	channelsStore.selectChannel(channelId);
}

/**
 * Reverse sync: when the active tab changes (e.g. user clicks a tab),
 * update the sidebar selection to match.
 */
watch(
	() => layout.activeTab.value,
	(tab) => {
		if (tab !== null) {
			const activeChId = layout.getActiveChannelId(tab.id);
			if (activeChId !== null && activeChId !== channelsStore.selectedChannelId) {
				channelsStore.selectChannel(activeChId);
			}
		}
	},
	{ immediate: true },
);

/**
 * React to channels transitioning to "dead" or being removed.
 * - "close" mode: immediately close the tab when a channel dies.
 * - "readonly" mode: keep the tab (Closed badge, read-only content).
 * - Explicit removal (DELETE): always close the tab regardless of mode.
 */
watch(
	() => channelsStore.channels.map((c) => ({ id: c.id, status: c.status })),
	(current, previous) => {
		if (!previous) return;

		// Close tabs for channels that died (only in "close" mode).
		// In the new model, only close a tab if ALL its terminal panes are dead.
		if (configStore.uiConfig.onChannelDead === 'close') {
			for (const ch of current) {
				if (ch.status !== 'dead') continue;
				const prev = previous.find((p) => p.id === ch.id);
				if (prev && prev.status !== 'dead') {
					// Find which tab contains this channel
					const tabId = layout.findTabForChannel(ch.id);
					if (tabId === null) continue;
					// Only close if ALL terminal panes in the tab are dead
					const root = layout.layouts.value[tabId];
					if (root !== null && root !== undefined) {
						const deadIds = new Set(current.filter((c) => c.status === 'dead').map((c) => c.id));
						const termIds = collectTerminalChannelIds(root);
						if (termIds.length > 0 && termIds.every((id) => deadIds.has(id))) {
							const idx = layout.tabs.value.findIndex((t) => t.id === tabId);
							if (idx !== -1) layout.closeTab(idx);
						}
					}
				}
			}
		}

		// Always close tabs for channels removed from the list (explicit DELETE).
		// Only close a tab if the deleted channel was the ONLY terminal in the tab.
		const currentIds = new Set(current.map((c) => c.id));
		for (const prev of previous) {
			if (!currentIds.has(prev.id)) {
				const tabId = layout.findTabForChannel(prev.id);
				if (tabId === null) continue;
				const root = layout.layouts.value[tabId];
				if (root !== null && root !== undefined) {
					const termIds = collectTerminalChannelIds(root);
					// Only auto-close tab if this was the only channel in it
					if (termIds.length === 1 && termIds[0] === prev.id) {
						const idx = layout.tabs.value.findIndex((t) => t.id === tabId);
						if (idx !== -1) layout.closeTab(idx);
					}
				}
			}
		}
	},
	{ deep: true },
);

/**
 * Returns true when a terminal PTY element has keyboard focus.
 * xterm.js routes input through a hidden textarea inside the .xterm container.
 * We guard Ctrl+Shift+1..9 shortcuts so they pass through to the PTY when focused (INV-13).
 */
function isPtyFocused(): boolean {
	const el = document.activeElement;
	if (el === null) return false;
	return el.closest('.xterm') !== null;
}

/**
 * Global keydown handler attached to the app root.
 * Intercepts Ctrl+K (Windows/Linux) and Cmd+K (macOS) to toggle the palette (SC-14).
 * Intercepts Ctrl+Shift+1..9 to spawn profile N (INV-13: only when PTY is NOT focused).
 */
function onGlobalKeydown(event: KeyboardEvent): void {
	const isK = event.key === 'k' || event.key === 'K';
	const modifier = event.ctrlKey || event.metaKey;
	if (isK && modifier) {
		event.preventDefault();
		commandPalette.toggle();
		return;
	}

	// Ctrl+Shift+1..9 — spawn profile N (INV-13: skip when PTY has focus)
	if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey) {
		const digit = parseInt(event.key, 10);
		if (digit >= 1 && digit <= 9 && !isPtyFocused()) {
			const profile = profilesStore.profiles[digit - 1];
			if (profile !== undefined) {
				event.preventDefault();
				profilesStore.spawnFromProfile(profile.id);
			}
			return;
		}
	}

	if (event.key === 'Escape' && showSettings.value) {
		showSettings.value = false;
	}
}

/**
 * Handle host modal save — refresh the host list and close the modal.
 */
function onHostSaved(_host: Host): void {
	showHostModal.value = false;
	editingHost.value = null;
	void hostsStore.fetchHosts();
}

/**
 * Handle right-click on a host badge in the rail.
 * Stores position + hostId for the context menu component.
 */
function onHostContextMenu(payload: { hostId: string; event: MouseEvent }): void {
	hostContextMenu.value = {
		hostId: payload.hostId,
		x: payload.event.clientX,
		y: payload.event.clientY,
	};
}

/**
 * Handle right-click on a group header in the rail.
 */
function onGroupContextMenu(payload: { groupId: string; groupName: string; event: MouseEvent }): void {
	groupContextMenu.value = {
		groupId: payload.groupId,
		groupName: payload.groupName,
		x: payload.event.clientX,
		y: payload.event.clientY,
	};
}

function onRailContextMenu(payload: { x: number; y: number }): void {
	railContextMenu.value = { x: payload.x, y: payload.y };
}

function onAddGroupFromRail(): void {
	railContextMenu.value = null;
	createGroupDialogVisible.value = true;
}

async function onCreateGroupConfirmed(name?: string): Promise<void> {
	createGroupDialogVisible.value = false;
	if (!name?.trim()) return;
	await hostsStore.createHostGroup(name.trim());
	await hostsStore.fetchHosts();
}

// ─── Context menu action handlers ─────────────────────────────────────────

function onEditHost(hostId: string): void {
	const host = hostsStore.hosts.find((h) => h.id === hostId) ?? null;
	editingHost.value = host;
	showHostModal.value = true;
}

function onDeleteHost(hostId: string): void {
	deleteHostId.value = hostId;
}

function onConnectHost(hostId: string): void {
	hostsStore.selectHost(hostId);
}

function onDisconnectHost(_hostId: string): void {
	// TODO: implement disconnect via session store
}

function onNewGroupForHost(hostId: string): void {
	// Open the host modal in edit mode so the user can set a new group
	onEditHost(hostId);
}

function onRenameGroup(groupId: string): void {
	const group = hostsStore.hostGroups.find((g) => g.id === groupId) ?? null;
	if (!group) return;
	renameGroupId.value = groupId;
	renameGroupCurrentName.value = group.name;
}

function onRenameGroupConfirmed(newName?: string): void {
	const id = renameGroupId.value;
	renameGroupId.value = null;
	if (!id || !newName?.trim()) return;
	void hostsStore.renameHostGroup(id, newName.trim());
}

function onDeleteGroup(groupId: string): void {
	const group = hostsStore.hostGroups.find((g) => g.id === groupId) ?? null;
	if (!group) return;
	deleteGroupId.value = groupId;
	deleteGroupCurrentName.value = group.name;
}

function onDeleteGroupConfirmed(): void {
	const id = deleteGroupId.value;
	deleteGroupId.value = null;
	if (!id) return;
	void hostsStore.deleteHostGroup(id).then(() => hostsStore.fetchHosts());
}

// ─── Channel-group handlers ─────────────────────────────────────

function onSidebarContextMenu(event: MouseEvent): void {
	sidebarContextMenu.value = { x: event.clientX, y: event.clientY };
}

function onAddChannelGroupFromSidebar(): void {
	sidebarContextMenu.value = null;
	createChannelGroupDialogVisible.value = true;
}

async function onPurgeDead(): Promise<void> {
	// Close tabs whose ALL terminal panes are dead before purging
	const deadIds = new Set(channelsStore.channels.filter((c) => c.status === 'dead').map((c) => c.id));
	// Iterate tabs in reverse so indices stay stable as we close
	for (let i = layout.tabs.value.length - 1; i >= 0; i--) {
		const tab = layout.tabs.value[i];
		if (!tab) continue;
		const root = layout.layouts.value[tab.id];
		if (root !== null && root !== undefined) {
			const termIds = collectTerminalChannelIds(root);
			if (termIds.length > 0 && termIds.every((id) => deadIds.has(id))) {
				layout.closeTab(i);
			}
		}
	}
	await channelsStore.purgeDeadChannels();
}

async function onDeleteChannel(channelId: string): Promise<void> {
	// Close the tab if this channel is its only terminal pane
	const tabId = layout.findTabForChannel(channelId);
	if (tabId !== null) {
		const root = layout.layouts.value[tabId];
		if (root !== null && root !== undefined) {
			const termIds = collectTerminalChannelIds(root);
			if (termIds.length === 1 && termIds[0] === channelId) {
				const idx = layout.tabs.value.findIndex((t) => t.id === tabId);
				if (idx !== -1) layout.closeTab(idx);
			}
		}
	}
	await channelsStore.deleteChannel(channelId);
}

async function onCreateChannelGroupConfirmed(name?: string): Promise<void> {
	createChannelGroupDialogVisible.value = false;
	if (!name?.trim()) return;
	await channelsStore.addGroup(name.trim());
}

/**
 * Called by PairingScreen when it has obtained a new token and
 * successfully completed WS AUTH. We just clear authFailed —
 * the session store will already be authenticated.
 */
async function onAuthenticated(): Promise<void> {
	postAuthLoading.value = true;
	try {
		await initAssetToken(authStore.token);
		await configStore.loadFonts();
		await configStore.loadProfile();
		await configStore.loadUiConfig();
		await themeStore.loadThemes();
		await themeStore.loadAppearance();
		// Auto-switch watcher fires here — if enabled, OS preference wins.
		if (!themeStore.appearance.autoSwitch.enabled) {
			const savedThemeName = themeStore.appearance.theme;
			const savedTheme = themeStore.availableThemes.find((t) => t.name === savedThemeName);
			if (savedTheme) {
				themeStore.currentTheme = savedTheme;
				themeStore.applyTheme(savedTheme);
			}
		}
		themeStore.applyOpacity(themeStore.appearance.opacity);
		themeStore.applyScrollbar(themeStore.appearance.scrollbar);
		await hostsStore.fetchHosts();
	} catch (err) {
		console.error('[App] post-pairing init failed:', err);
	} finally {
		postAuthLoading.value = false;
		appReady.value = true;
	}
}

/**
 * "+" button in the tab bar: open a pending tab whose TerminalPane
 * will handle the actual SPAWN with correct terminal dimensions.
 */
function onAddTab(): void {
	const hostId = channelsStore.activeHostId;
	if (hostId === null) return;
	openPendingTab(hostId);
}

/**
 * Rename a tab (and its channel) via inline edit in the tab bar.
 */
function onRenameTab(channelId: string, title: string): void {
	channelsStore.renameChannel(channelId, title);
}

/**
 * Close all tabs, but protect the welcome tab (if any).
 * Shows confirmation dialog if configured (default: true).
 */
function onCloseAll(): void {
	const welcomeId = channelsStore.welcomeChannel?.id;
	const welcomeTabId = welcomeId ? layout.findTabForChannel(welcomeId) : null;
	const closingCount = welcomeTabId
		? layout.tabs.value.filter((t) => t.id !== welcomeTabId).length
		: layout.tabs.value.length;

	if (
		closingCount > 0 &&
		configStore.uiConfig.tabs?.confirmCloseAll !== false &&
		!shouldSkipConfirm('ConfirmCloseAll')
	) {
		confirmDialog.value = {
			visible: true,
			title: `Close ${closingCount} terminal${closingCount > 1 ? 's' : ''}?`,
			message: 'Terminals will be detached but continue running.',
			action: () => layout.closeAll(welcomeId),
			actionKey: 'ConfirmCloseAll',
		};
	} else {
		layout.closeAll(welcomeId);
	}
}

/**
 * Close all tabs except the one at the given index.
 * Shows confirmation dialog if configured (default: true).
 */
function onCloseOthers(keepIndex: number): void {
	const closingCount = layout.tabs.value.length - 1;

	if (
		closingCount > 0 &&
		configStore.uiConfig.tabs?.confirmCloseOthers !== false &&
		!shouldSkipConfirm('ConfirmCloseOthers')
	) {
		confirmDialog.value = {
			visible: true,
			title: `Close ${closingCount} other terminal${closingCount > 1 ? 's' : ''}?`,
			message: 'Terminals will be detached but continue running.',
			action: () => layout.closeOthers(keepIndex),
			actionKey: 'ConfirmCloseOthers',
		};
	} else {
		layout.closeOthers(keepIndex);
	}
}

/**
 * Toggle a channel as the welcome tab for its host.
 * If the channel is already the welcome tab, unset it; otherwise set it.
 */
async function onSetWelcome(channelId: string): Promise<void> {
	const hostId = channelsStore.activeHostId;
	if (hostId === null) return;

	const channel = channelsStore.channels.find((c) => c.id === channelId);
	if (channel?.isWelcome) {
		await channelsStore.clearWelcomeChannel(hostId);
	} else {
		await channelsStore.setWelcomeChannel(hostId, channelId);
	}
}

/**
 * Split a pane. The second pane opens as a vacant slot — the user picks
 * or spawns a channel via the VacantPane picker.
 */
function onSplit(existingChannelId: string, direction: 'horizontal' | 'vertical'): void {
	layout.splitPane(existingChannelId, direction);
}

/**
 * Called by PaneLayout when a TerminalPane completes a deferred spawn.
 * Patches the layout tree to replace the temp ID with the real channel ID,
 * then selects the new channel in the sidebar.
 */
function onChannelSpawned(tempId: string, realId: string): void {
	layout.replaceChannelId(tempId, realId);
	channelsStore.selectChannel(realId);
	// Refresh channel list so the new channel (after respawn) appears in the sidebar.
	if (channelsStore.activeHostId) {
		void channelsStore.fetchChannels(channelsStore.activeHostId);
	}
}

/**
 * Close a single pane: collapse the split and give space to the sibling.
 * If the pane is the root (no split parent), it becomes a vacant slot (INV-04).
 * INV-03: closing never kills the terminal — channel keeps running.
 */
function onClosePane(channelId: string): void {
	layout.closePane(channelId);
}

/**
 * Detach a pane: replace it with a vacant slot without collapsing the split.
 * The channel/PTY keeps running. INV-03: detach never kills the terminal.
 */
function onDetachPane(channelId: string): void {
	layout.detachPane(channelId);
}

/**
 * Fill a vacant slot with an existing channel.
 */
function onFillVacant(vacantId: string, channelId: string): void {
	layout.fillVacant(vacantId, channelId);
}

/**
 * Spawn a new terminal in a vacant slot.
 */
function onNewTerminalVacant(vacantId: string): void {
	const hostId = channelsStore.activeHostId;
	if (hostId === null) return;

	const tempId = generateId();
	channelsStore.registerPendingSpawn(tempId, hostId);
	layout.fillVacant(vacantId, tempId);
}

/**
 * Remove a vacant pane slot and give its space to the sibling.
 */
function onRearrangeVacant(vacantId: string): void {
	layout.rearrangeVacant(vacantId);
}

/**
 * Handle cross-tab pane DnD: move sourceChannelId into the target tab.
 * Validates max-4-panes (for non-center drops) before delegating to layout.
 */
function onDropPane(sourceChannelId: string, targetPaneId: string, targetTabId: string, zone: DropZone): void {
	// For non-center zone, check max panes in target tab
	if (zone !== 'center') {
		const targetRoot = layout.layouts.value[targetTabId];
		if (targetRoot && countPanes(targetRoot) >= 4) return;
	}
	layout.movePaneTo(sourceChannelId, targetPaneId, targetTabId, zone);
}

/**
 * Open the Configure Command dialog for a channel.
 */
function onConfigureCommand(channelId: string): void {
	configureChannelId.value = channelId;
	showConfigureDialog.value = true;
}

/**
 * Handle tab-bar drop: move a pane out to its own new tab.
 */
function onMoveToNewTab(sourceChannelId: string, insertAtIndex: number): void {
	layout.moveToNewTab(sourceChannelId, insertAtIndex);
}

/**
 * Sidebar context menu: open a channel in a new tab.
 */
function onSidebarOpenNewTab(channelId: string): void {
	layout.openTab(channelId);
	channelsStore.selectChannel(channelId);
}

/**
 * Sidebar context menu: open a channel in the current (active) tab,
 * replacing whatever is there.
 */
function onSidebarOpenCurrentTab(channelId: string): void {
	const activeTab = layout.activeTab.value;
	if (activeTab === null) {
		// No active tab — just open a new one
		layout.openTab(channelId);
		channelsStore.selectChannel(channelId);
		return;
	}
	// Replace the active pane's channel in the active tab
	const activeChId = layout.getActiveChannelId(activeTab.id);
	if (activeChId !== null) {
		layout.replaceChannelId(activeChId, channelId);
		channelsStore.selectChannel(channelId);
	} else {
		layout.openTab(channelId);
		channelsStore.selectChannel(channelId);
	}
}

// ---------------------------------------------------------------------------
// Multi-pane search (SC-11, SC-12)
// ---------------------------------------------------------------------------

/**
 * Check if a tab has multiple panes (SC-12: scope toggle visibility).
 */
function tabHasMultiplePanes(tabId: string): boolean {
	const root = layout.layouts.value[tabId];
	if (root === null || root === undefined) return false;
	return countPanes(root) > 1;
}

/**
 * Broadcast search query to all panes in the active tab.
 */
function onSearchAllPanes(query: string): void {
	multiPaneSearch.searchAll(query, layout.layout.value);
}

/**
 * Navigate to next match across all panes (SC-11).
 */
function onFindNextAll(currentChannelId: string): void {
	multiPaneSearch.findNextAll(currentChannelId, layout.layout.value);
}

/**
 * Navigate to previous match across all panes.
 */
function onFindPreviousAll(currentChannelId: string): void {
	multiPaneSearch.findPreviousAll(currentChannelId, layout.layout.value);
}

/**
 * Handle focus-pane events from PaneLayout (bubbled up from TerminalPane).
 * Updates the activePaneId for the tab so getActiveChannelId() works correctly.
 */
function onFocusPane(tabId: string, paneId: string): void {
	layout.setActivePaneId(tabId, paneId);
}

// Set up the focus-pane callback for cross-pane search navigation (SC-11).
// When multi-pane search needs to focus a different pane, we could implement
// pane focusing here. For MVP, the match indicator shows which pane has the
// match — actual terminal focus would require a ref registry.
// TODO: Implement pane focus for SC-11 (requires TerminalPane ref registry)
</script>

<style>
/* Global reset — applied to document root */
*,
*::before,
*::after {
	box-sizing: border-box;
}

html,
body,
#app {
	margin: 0;
	padding: 0;
	height: 100%;
	overflow: hidden;
	font-family: system-ui, -apple-system, sans-serif;
	font-size: 13px;
	background: transparent;
}

.app-root {
	height: 100%;
	display: flex;
	flex-direction: column;
	position: relative;
	overflow: hidden;
	background: var(--nt-bg);
	isolation: isolate;
}

.app-root--transparent {
	background: transparent;
}

.window-wallpaper {
	position: absolute;
	inset: 0;
	z-index: 0;
	overflow: hidden;
	pointer-events: none;
}

.window-wallpaper__bg,
.window-wallpaper__dim {
	position: absolute;
	inset: 0;
	pointer-events: none;
}

.window-wallpaper__bg {
	z-index: 0;
}

.window-wallpaper__dim {
	z-index: 1;
}

.window-wallpaper-fade-enter-active,
.window-wallpaper-fade-leave-active {
	transition: opacity 160ms ease;
}

.window-wallpaper-fade-enter-from,
.window-wallpaper-fade-leave-to {
	opacity: 0;
}

.app-layout {
	display: grid;
	grid-template-columns: var(--rail-w, 48px) var(--sidebar-w, 200px) 1fr;
	flex: 1;
	min-height: 0;
	background: transparent;
	color: var(--nt-fg);
	position: relative;
	z-index: 1;
}

.resize-handle {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 6px;
	margin-left: -3px;
	cursor: col-resize;
	z-index: 20;
	transition: background 0.15s;
}

.resize-handle:hover,
.resize-handle:active {
	background: rgba(var(--nt-accent-rgb), 0.3);
}

.host-rail {
	background: rgba(var(--nt-host-rail-rgb), var(--nt-host-rail-alpha));
}

.channel-sidebar {
	background: rgba(var(--nt-sidebar-rgb), var(--nt-sidebar-alpha));
	border-right: 1px solid var(--nt-border);
}

.terminal-main {
	overflow: hidden;
	display: flex;
	flex-direction: column;
}

.pane-area {
	flex: 1;
	overflow: hidden;
	display: flex;
	flex-direction: column;
	position: relative;
}

.pane-tab-container {
	display: flex;
	flex-direction: column;
	width: 100%;
	height: 100%;
	position: absolute;
	inset: 0;
}

.pane-empty {
	flex: 1;
	display: flex;
	align-items: center;
	justify-content: center;
	color: var(--nt-tab-hover);
	font-size: 13px;
	font-style: italic;
}

body.termora-dragging * {
	cursor: grabbing !important;
}

/* Pairing code generator dialog */
.pairing-gen-overlay {
	position: fixed;
	inset: 0;
	background: rgba(0, 0, 0, 0.5);
	backdrop-filter: blur(4px);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 2000;
}

.pairing-gen-card {
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
	border-radius: 12px;
	padding: 24px 28px;
	width: 360px;
	max-width: calc(100vw - 32px);
	box-shadow: var(--nt-shadow);
}

.pairing-gen-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 8px;
}

.pairing-gen-title {
	margin: 0;
	font-size: 16px;
	font-weight: 600;
	color: var(--nt-fg);
}

.pairing-gen-close {
	background: none;
	border: none;
	color: var(--nt-text-secondary);
	font-size: 20px;
	cursor: pointer;
	padding: 0 4px;
	line-height: 1;
}

.pairing-gen-close:hover {
	color: var(--nt-fg);
}

.pairing-gen-desc {
	margin: 0 0 4px;
	font-size: 12px;
	color: var(--nt-text-secondary);
	line-height: 1.5;
}

.app-loading {
	position: fixed;
	inset: 0;
	background: var(--nt-bg);
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 999;
	flex: 1;
}

.app-loading-spinner {
	width: 28px;
	height: 28px;
	border: 3px solid var(--nt-border);
	border-top-color: var(--nt-accent);
	border-radius: 50%;
	animation: app-spin 0.7s linear infinite;
}

@keyframes app-spin {
	to {
		transform: rotate(360deg);
	}
}
</style>
