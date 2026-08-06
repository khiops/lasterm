<template>
	<div class="terminal-pane" :style="borderStyle" @contextmenu.prevent="showContextMenu">
		<!-- Pane header — always rendered so fitAddon.fit() calculates correct rows -->
		<div
			class="pane-header"
			draggable="true"
			@dragstart="onDragStart"
			@dragend="onDragEnd"
		>
			<span class="pane-title">{{ paneTitle }}</span>
			<WriteLockIndicator :channel-id="effectiveChannelId" :is-dead="isDead" class="pane-lock" />
		</div>

		<!-- Environment banner (UX-07) -->
		<EnvironmentBanner
			v-if="bannerText"
			:text="bannerText"
			:bg-color="visualProfile.banner.bgColor"
			:text-color="visualProfile.banner.textColor"
		/>

		<div v-if="error" class="terminal-error">
			<span>{{ error }}</span>
		</div>
		<div v-else-if="!ready" class="terminal-loading">
			<span>Connecting…</span>
		</div>
		<div ref="terminalContainer" class="terminal-container" />

		<!-- Background tint overlay (UX-07) -->
		<div v-if="tintStyle" class="tint-overlay" :style="tintStyle" />

		<!-- Exit overlay for all dead channels -->
		<div v-if="isDead" class="exit-overlay">
			<div class="exit-message">{{ exitMessage }}</div>
			<div class="exit-actions">
				<button class="exit-btn" @click="onRestart">Restart</button>
				<button v-if="isDirectProcess" class="exit-btn" @click="onConfigure">Configure</button>
				<button class="exit-btn exit-btn--danger" @click="onClosePaneFromOverlay">Close</button>
			</div>
		</div>

		<!-- Reconnecting overlay — shown when WS drops after terminal was initialized -->
		<div v-if="ready && !sessionStore.connected" class="reconnecting-overlay">
			<span class="reconnecting-text">Reconnecting<span class="reconnecting-dots" /></span>
		</div>

		<!-- Unread lines bar -->
		<UnreadLinesBar
			:line-count="unreadBarCount"
			:show="showUnreadBar"
			@mark-read="markRead"
			@jump-to-bottom="jumpToBottom"
		/>

		<!-- Search overlay -->
		<SearchOverlay
			:is-open="search.isOpen.value"
			:match-count="effectiveMatchCount"
			:current-match="effectiveCurrentMatch"
			:regex-error="search.regexError.value"
			:query="search.query.value"
			:options="search.options.value"
			:position="searchPosition"
			:show-scope-toggle="props.hasMultiplePanes"
			:scope="searchScope"
			:match-pane="matchPaneName"
			:history="searchHistory.history.value"
			@search="onSearchEmit"
			@find-next="onFindNext"
			@find-previous="onFindPrevious"
			@close="onSearchClose"
			@update:options="onSearchOptionsUpdate"
			@update:scope="onScopeUpdate"
			@select-history="onSelectHistory"
			@add-to-history="onAddToHistory"
		/>

		<!-- Context menu -->
		<div
			v-if="contextMenuVisible"
			class="context-menu"
			:style="{ top: `${contextMenuY}px`, left: `${contextMenuX}px` }"
			@mouseleave="contextMenuVisible = false"
		>
			<button class="context-menu__item" @click="onSplitRight">Split Right</button>
			<button class="context-menu__item" @click="onSplitDown">Split Down</button>
			<hr class="context-menu__divider" />
			<button class="context-menu__item" @click="onDetachPane">Detach</button>
			<button class="context-menu__item context-menu__item--danger" @click="onClosePane">
				Close Pane
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { DEFAULT_CHANNEL_NAME } from '@lasterm/shared';
import { computed, inject, onMounted, onUnmounted, ref, toRef, watch } from 'vue';
import { useActivityTracker } from '../composables/useActivityTracker.js';
import { playBellSound } from '../composables/useBellSound.js';
import type { SearchScope } from '../composables/useMultiPaneSearch.js';
import { MULTI_PANE_SEARCH_KEY } from '../composables/useMultiPaneSearch.js';
import { useResolvedProfile } from '../composables/useResolvedProfile.js';
import { useScrollBehavior } from '../composables/useScrollBehavior.js';
import type { SearchHistoryEntry } from '../composables/useSearchHistory.js';
import { useSearchHistory } from '../composables/useSearchHistory.js';
import { useSearchShortcuts } from '../composables/useSearchShortcuts.js';
import { useTabTitle } from '../composables/useTabTitle.js';
import { useTerminal } from '../composables/useTerminal.js';
import { useVisualProfile } from '../composables/useVisualProfile.js';
import { useChannelsStore } from '../stores/channels.js';
import { useConfigStore } from '../stores/config.js';
import { useHostsStore } from '../stores/hosts.js';
import { useNotificationStore } from '../stores/notifications.js';
import { useSessionStore } from '../stores/session.js';
import { useWriteLockStore } from '../stores/writelock.js';
import EnvironmentBanner from './EnvironmentBanner.vue';
import SearchOverlay from './SearchOverlay.vue';
import UnreadLinesBar from './UnreadLinesBar.vue';
import WriteLockIndicator from './WriteLockIndicator.vue';

// ---------------------------------------------------------------------------
// Props + emits
// ---------------------------------------------------------------------------

const props = withDefaults(
	defineProps<{
		/**
		 * If provided, this pane manages an already-spawned channel (e.g. when
		 * routed from a tab or split). If null/undefined, the pane spawns its
		 * own channel on mount (legacy single-pane behaviour).
		 */
		channelId?: string | null;
		/** Stable pane identifier from the layout tree (for DnD targeting). */
		paneId?: string | null;
		/** Host ID for this pane — used for visual profile resolution (UX-07). */
		hostId?: string | null;
		/** Whether the current tab has multiple panes (SC-12). */
		hasMultiplePanes?: boolean;
	}>(),
	{ channelId: null, paneId: null, hostId: null, hasMultiplePanes: false },
);

const emit = defineEmits<{
	(e: 'split-right', channelId: string): void;
	(e: 'split-down', channelId: string): void;
	(e: 'detach-pane', channelId: string): void;
	(e: 'close-pane', channelId: string): void;
	(e: 'channel-spawned', tempId: string, realId: string): void;
	(e: 'configure-command', channelId: string): void;
	(e: 'search-all-panes', query: string): void;
	(e: 'find-next-all', currentChannelId: string): void;
	(e: 'find-previous-all', currentChannelId: string): void;
}>();

// ---------------------------------------------------------------------------
// Stores + terminal composable
// ---------------------------------------------------------------------------

const sessionStore = useSessionStore();
const channelsStore = useChannelsStore();
const writeLockStore = useWriteLockStore();
const configStore = useConfigStore();
const notificationStore = useNotificationStore();
const terminalContainer = ref<HTMLElement | null>(null);
const ready = ref(false);
const error = ref<string | null>(null);

const hostsStore = useHostsStore();

// Resolve per-host theme override (SC-03) from host.profileJson
const hostThemeName = (() => {
	if (!props.hostId) return undefined;
	const host = hostsStore.hosts.find((h) => h.id === props.hostId);
	if (!host?.profileJson) return undefined;
	try {
		const parsed = JSON.parse(host.profileJson) as { theme?: string };
		return parsed.theme;
	} catch {
		return undefined;
	}
})();

const { profile: resolvedProfile } = useResolvedProfile(
	computed(() => props.hostId ?? undefined),
	computed(() => props.channelId ?? undefined),
);

const {
	init,
	attachChannel,
	reattachChannel,
	applyProfile,
	suppressNextResize,
	dispose,
	canWrite,
	currentDynamicTitle,
	search,
	terminal,
} = useTerminal(terminalContainer, sessionStore.wsClient, resolvedProfile.value, hostThemeName);

// ---------------------------------------------------------------------------
// Search config from config store
// ---------------------------------------------------------------------------

const searchConfig = computed(() => configStore.uiConfig.search ?? {});
const searchPosition = computed<'top-right' | 'bottom-right' | 'bottom-bar'>(
	() => searchConfig.value.position ?? 'top-right',
);
const highlightOnClose = computed<'clear' | 'fade' | 'persist'>(() => searchConfig.value.highlightOnClose ?? 'clear');
const searchHistorySize = computed(() => searchConfig.value.historySize ?? 20);
const searchHistory = useSearchHistory(searchHistorySize);

/**
 * The channel this pane is currently showing. When channelId prop is set,
 * we use that; otherwise we fall back to the channel we spawned internally.
 */
const internalChannelId = ref<string | null>(null);

const effectiveChannelId = computed<string | null>(() => props.channelId ?? internalChannelId.value);

// ---------------------------------------------------------------------------
// Notification: activity tracking + unread lines bar
// ---------------------------------------------------------------------------

const isActiveTab = computed(() => {
	const chId = effectiveChannelId.value;
	return chId !== null && channelsStore.selectedChannelId === chId;
});

useActivityTracker({
	channelId: effectiveChannelId,
	isActiveTab,
	wsClient: sessionStore.wsClient,
});

const notificationConfig = computed(() => configStore.uiConfig.notifications ?? {});
const scrollMode = computed(() => notificationConfig.value.scroll?.mode ?? 'auto');
const autoThreshold = computed(() => notificationConfig.value.scroll?.autoThreshold ?? 100);

const {
	showBar: showUnreadBar,
	barLineCount: unreadBarCount,
	markRead,
	jumpToBottom,
	onNaturalScrollToBottom,
} = useScrollBehavior({
	channelId: effectiveChannelId,
	isActiveTab,
	scrollMode: scrollMode.value,
	autoThreshold: autoThreshold.value,
	scrollToBottom: () => {
		terminal.value?.scrollToBottom();
	},
});

const { tabTitle: paneTitle } = useTabTitle(effectiveChannelId, toRef(channelsStore, 'channels'), currentDynamicTitle);

// ---------------------------------------------------------------------------
// Visual profile (UX-07)
// ---------------------------------------------------------------------------

const paneHost = computed(() => {
	if (!props.hostId) return undefined;
	return hostsStore.hosts.find((h) => h.id === props.hostId);
});

const { profile: visualProfile, bannerText, borderStyle, tintStyle } = useVisualProfile(paneHost);

// ---------------------------------------------------------------------------
// Write-lock awareness
// ---------------------------------------------------------------------------

const isWriter = computed(() => {
	const chId = effectiveChannelId.value;
	return chId ? writeLockStore.isWriter(chId) : false;
});

watch(
	isWriter,
	(writerNow) => {
		canWrite.value = writerNow;
	},
	{ immediate: true },
);

// ---------------------------------------------------------------------------
// Dead-channel awareness
// ---------------------------------------------------------------------------

const isDead = computed(() => {
	const chId = effectiveChannelId.value;
	if (!chId) return false;
	const channel = channelsStore.channels.find((c) => c.id === chId);
	return channel?.status === 'dead';
});

const isDirectProcess = computed(() => {
	const chId = effectiveChannelId.value;
	if (!chId) return false;
	const channel = channelsStore.channels.find((c) => c.id === chId);
	return channel?.directProcess === true;
});

const exitMessage = computed(() => {
	const chId = effectiveChannelId.value;
	if (!chId) return 'Exited';
	const channel = channelsStore.channels.find((c) => c.id === chId);
	const label = channel?.directProcess ? 'Process' : 'Shell';
	const code = channel?.exitCode;
	if (code !== undefined && code !== null) {
		return `${label} exited (code ${code})`;
	}
	return `${label} exited`;
});

watch(isDead, (dead) => {
	if (dead) canWrite.value = false;
});

// ---------------------------------------------------------------------------
// Lifecycle: init terminal + attach/reattach channel
// ---------------------------------------------------------------------------

onMounted(async () => {
	try {
		await sessionStore.connect();

		const { cols, rows } = init();

		if (props.channelId !== null && props.channelId !== undefined) {
			// Check if this is a pending spawn (temp ID created by App.vue)
			const hostId = channelsStore.consumePendingSpawn(props.channelId);

			if (hostId !== null) {
				// Fresh spawn — PTY is created with actual terminal dimensions
				// so no RESIZE is needed → no SIGWINCH → no duplicate prompt
				const realId = await channelsStore.spawnChannel(hostId, {
					cols,
					rows,
					select: false,
				});
				internalChannelId.value = realId;
				// PTY was spawned at exact terminal dims — suppress the RESIZE
				// that attachChannel would otherwise send (prevents SIGWINCH)
				suppressNextResize();
				attachChannel(realId);
				emit('channel-spawned', props.channelId, realId);
			} else {
				// Dead channels must not send ATTACH — the hub rejects with
				// CHANNEL_DEAD and the error state would obscure the dead
				// overlay. Mark ready so the overlay renders immediately.
				if (isDead.value) {
					ready.value = true;
					return;
				}
				// Existing channel — reattach (fetch snapshot + tail).
				// Write-lock state is set by the WRITE_LOCK WS message handler
				// (fired by WriteLockManager.attach on the hub side), not from
				// the ATTACH_OK payload — avoids a microtask race where
				// setInitialHolder would overwrite a more recent WRITE_LOCK.
				await reattachChannel(props.channelId);
			}
			ready.value = true;
			applyProfile(resolvedProfile.value);
			// Register xterm.js BEL handler — fires on \x07 from PTY output
			terminal.value?.onBell(() => {
				const chId = props.channelId;
				// Increment bell badge (agent BELL WS message not reliable for all shells)
				if (chId != null && resolvedProfile.value.bellBadge !== false) {
					notificationStore.incrementBellCount(chId);
					// Auto-clear badge after 1s if this is the active channel
					if (chId === channelsStore.selectedChannelId) {
						setTimeout(() => {
							if (props.channelId === channelsStore.selectedChannelId) {
								notificationStore.clearBellAndActivity(props.channelId!);
							}
						}, 1000);
					}
				}
				const p = resolvedProfile.value;
				const sound = p.bellSound;
				// Backward compat: boolean true → "system", false/undefined → "mute"
				const resolved = typeof sound === 'boolean' ? (sound ? 'system' : 'mute') : (sound ?? 'mute');
				if (resolved === 'mute') return;
				playBellSound({
					sound: resolved,
					...(p.bellCustomFile && { customSoundFile: p.bellCustomFile }),
				});
			});
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// CHANNEL_DEAD from hub means the channel died between page load and ATTACH.
		// Treat as dead channel (show overlay) rather than an error state.
		if (msg.includes('is dead') || msg.includes('CHANNEL_DEAD')) {
			ready.value = true;
			return;
		}
		// AGENT_NOT_AVAILABLE is handled by the AgentDeployFailed modal — the
		// inline pane error would be redundant and confusing alongside the modal.
		if (msg.startsWith('AGENT_NOT_AVAILABLE:')) {
			return;
		}
		error.value = msg;
		console.error('[TerminalPane] Initialization failed:', err);
	}
});

// Re-attach when the channelId prop changes (e.g. pane reuse after tab switch).
// Skip when the new ID matches internalChannelId (happens after pending spawn
// resolution — replaceChannelId updates the prop from tempId to realId but
// the channel is already attached).
watch(
	() => props.channelId,
	async (newId) => {
		if (newId !== null && newId !== undefined && ready.value) {
			if (newId === internalChannelId.value) return;
			try {
				error.value = null;
				await reattachChannel(newId);
			} catch (err) {
				error.value = err instanceof Error ? err.message : String(err);
			}
		}
	},
);

// Re-attach terminal channels after hub reconnect (session persistence).
// When the hub restarts, WS auto-reconnects and session store increments
// reconnectCount. Each pane then re-attaches its channel to restore the
// snapshot from spool.db + connect to the new PTY output stream.
watch(
	() => sessionStore.reconnectCount,
	async () => {
		if (effectiveChannelId.value && ready.value) {
			try {
				error.value = null;
				await reattachChannel(effectiveChannelId.value);
			} catch (err) {
				error.value = err instanceof Error ? err.message : String(err);
			}
		}
	},
);

// Re-apply profile when the per-terminal resolved profile updates.
// useResolvedProfile fetches /api/config/resolved?host_id=X&channel_id=Y and
// re-fetches on relevant ProfileChangeEvents so each terminal reacts to its own overrides.
watch(
	resolvedProfile,
	(p) => {
		applyProfile(p);
	},
	{ deep: true },
);

onUnmounted(() => {
	dispose();
});

// ---------------------------------------------------------------------------
// Exit overlay actions (direct process)
// ---------------------------------------------------------------------------

async function onRestart(): Promise<void> {
	const chId = effectiveChannelId.value;
	if (chId === null) return;

	// SSH hosts: restart goes through WS SPAWN flow (supports async prompts
	// for passphrase/TOFU/deploy). REST restart can't handle interactive auth.
	if (paneHost.value?.type === 'ssh' && props.hostId) {
		const term = terminal.value;
		await channelsStore.spawnChannel(props.hostId, {
			...(term !== null ? { cols: term.cols, rows: term.rows } : {}),
		});
		// Remove the dead channel entirely and close its pane
		await channelsStore.deleteChannel(chId);
		emit('close-pane', chId);
		return;
	}

	const ok = await channelsStore.restartChannel(chId);
	if (ok) {
		const result = await reattachChannel(chId, { preserveContent: true });
		if (result.writeLockHolder) {
			writeLockStore.handleWriteLock(chId, result.writeLockHolder);
		}
		// Restore write permission — isDead watcher set canWrite=false
		// when the channel died. If isWriter never changed (write-lock
		// persists across restart for same channel ID), the isWriter
		// watcher won't re-fire, so we must restore explicitly.
		canWrite.value = isWriter.value;
	}
}

function onConfigure(): void {
	const chId = effectiveChannelId.value;
	if (chId !== null) {
		emit('configure-command', chId);
	}
}

function onClosePaneFromOverlay(): void {
	const chId = effectiveChannelId.value;
	if (chId !== null) {
		emit('close-pane', chId);
	}
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

const contextMenuVisible = ref(false);
const contextMenuX = ref(0);
const contextMenuY = ref(0);

function showContextMenu(event: MouseEvent): void {
	contextMenuX.value = event.offsetX;
	contextMenuY.value = event.offsetY;
	contextMenuVisible.value = true;
}

function onSplitRight(): void {
	contextMenuVisible.value = false;
	const chId = effectiveChannelId.value;
	if (chId !== null) emit('split-right', chId);
}

function onSplitDown(): void {
	contextMenuVisible.value = false;
	const chId = effectiveChannelId.value;
	if (chId !== null) emit('split-down', chId);
}

function onDetachPane(): void {
	contextMenuVisible.value = false;
	const chId = effectiveChannelId.value;
	if (chId !== null) emit('detach-pane', chId);
}

function onClosePane(): void {
	contextMenuVisible.value = false;
	const chId = effectiveChannelId.value;
	if (chId !== null) emit('close-pane', chId);
}

// Dismiss context menu on any outside click
function onDocumentClick(): void {
	contextMenuVisible.value = false;
}

onMounted(() => document.addEventListener('click', onDocumentClick));
onUnmounted(() => document.removeEventListener('click', onDocumentClick));

// ---------------------------------------------------------------------------
// Multi-pane search registry (SC-11, SC-12)
// ---------------------------------------------------------------------------

const multiPaneSearch = inject(MULTI_PANE_SEARCH_KEY, null);
const searchScope = computed<SearchScope>(() => multiPaneSearch?.scope.value ?? 'pane');

/** Pane name shown in cross-pane match indicator. */
const matchPaneName = computed<string | null>(() => {
	if (!multiPaneSearch) return null;
	if (searchScope.value !== 'all') return null;
	const matchChId = multiPaneSearch.matchPaneChannelId.value;
	if (matchChId === null || matchChId === effectiveChannelId.value) return null;
	const ch = channelsStore.channels.find((c) => c.id === matchChId);
	return ch?.displayTitle ?? DEFAULT_CHANNEL_NAME;
});

/** Effective match count: aggregated when scope=all, local when scope=pane. */
const effectiveMatchCount = computed(() => {
	if (searchScope.value === 'all' && multiPaneSearch) {
		return multiPaneSearch.totalMatchCount.value;
	}
	return search.matchCount.value;
});

/** Effective current match: aggregated when scope=all, local when scope=pane. */
const effectiveCurrentMatch = computed(() => {
	if (searchScope.value === 'all' && multiPaneSearch) {
		return multiPaneSearch.totalCurrentMatch.value;
	}
	return search.currentMatch.value;
});

// Register this pane's search handle with the multi-pane registry
onMounted(() => {
	if (multiPaneSearch) {
		const chId = effectiveChannelId.value;
		if (chId) {
			multiPaneSearch.register({
				channelId: chId,
				search: search.search,
				findNext: search.findNext,
				findPrevious: search.findPrevious,
				clear: search.clear,
				matchCount: search.matchCount,
				currentMatch: search.currentMatch,
			});
		}
	}
});

// Update registration when channelId changes (after pending spawn resolves)
watch(effectiveChannelId, (newId, oldId) => {
	if (!multiPaneSearch) return;
	if (oldId) multiPaneSearch.unregister(oldId);
	if (newId) {
		multiPaneSearch.register({
			channelId: newId,
			search: search.search,
			findNext: search.findNext,
			findPrevious: search.findPrevious,
			clear: search.clear,
			matchCount: search.matchCount,
			currentMatch: search.currentMatch,
		});
	}
});

onUnmounted(() => {
	if (multiPaneSearch) {
		const chId = effectiveChannelId.value;
		if (chId) multiPaneSearch.unregister(chId);
	}
});

// ---------------------------------------------------------------------------
// Search overlay
// ---------------------------------------------------------------------------

function onSearchClose(): void {
	const mode = highlightOnClose.value;

	if (mode === 'persist') {
		// Close overlay but keep decorations visible
		search.isOpen.value = false;
	} else if (mode === 'fade') {
		// Close overlay, then fade decorations after 300ms
		search.isOpen.value = false;
		setTimeout(() => {
			search.clear();
		}, 300);
	} else {
		// "clear" (default): close and clear immediately
		search.close();
	}

	if (multiPaneSearch && searchScope.value === 'all') {
		multiPaneSearch.clearAll();
		multiPaneSearch.setScope('pane');
	}
	// Refocus the terminal so keyboard input resumes
	terminal.value?.focus();
}

function onSearchOptionsUpdate(opts: import('../composables/useTerminalSearch.js').SearchOptions): void {
	search.options.value = opts;
	// Re-trigger search with new options
	if (search.query.value) {
		search.search(search.query.value);
		// If scope=all, re-search on all panes
		if (searchScope.value === 'all' && multiPaneSearch) {
			emit('search-all-panes', search.query.value);
		}
	}
}

function onScopeUpdate(newScope: SearchScope): void {
	if (!multiPaneSearch) return;
	multiPaneSearch.setScope(newScope);
	if (newScope === 'all' && search.query.value) {
		// Broadcast current query to all panes
		emit('search-all-panes', search.query.value);
	}
}

function onSearchEmit(query: string): void {
	search.search(query);
	if (searchScope.value === 'all' && multiPaneSearch) {
		emit('search-all-panes', query);
	}
}

function onFindNext(): void {
	if (searchScope.value === 'all' && multiPaneSearch && effectiveChannelId.value) {
		emit('find-next-all', effectiveChannelId.value);
	} else {
		search.findNext();
	}
}

function onFindPrevious(): void {
	if (searchScope.value === 'all' && multiPaneSearch && effectiveChannelId.value) {
		emit('find-previous-all', effectiveChannelId.value);
	} else {
		search.findPrevious();
	}
}

function onSelectHistory(entry: SearchHistoryEntry): void {
	// Set regex state from history entry
	search.options.value = { ...search.options.value, regex: entry.regex };
	// Trigger search with the stored query
	search.search(entry.query);
	if (searchScope.value === 'all' && multiPaneSearch) {
		emit('search-all-panes', entry.query);
	}
}

function onAddToHistory(query: string, regex: boolean): void {
	searchHistory.add(query, regex);
}

function toggleSearchOption(key: keyof import('../composables/useTerminalSearch.js').SearchOptions): void {
	onSearchOptionsUpdate({
		...search.options.value,
		[key]: !search.options.value[key],
	});
}

useSearchShortcuts(search.isOpen, {
	onToggleCase: () => toggleSearchOption('caseSensitive'),
	onToggleRegex: () => toggleSearchOption('regex'),
	onToggleWholeWord: () => toggleSearchOption('wholeWord'),
});

// Wire natural scroll-to-bottom detection (EFF-07 / F-007).
// When the viewport reaches the bottom of the scrollback buffer,
// clear unread badges and hide the unread lines bar.
watch(terminal, (term) => {
	if (!term) return;
	term.onScroll(() => {
		const buf = term.buffer.active;
		// Viewport is at bottom when baseY equals the scrollback position
		// (i.e., no lines are hidden below the viewport)
		if (buf.baseY === buf.viewportY) {
			onNaturalScrollToBottom();
		}
	});
});

// Intercept Ctrl+Shift+F before xterm.js captures it.
// attachCustomKeyEventHandler runs for every key event; returning false
// prevents xterm from processing it (so the browser/our handler can act).
watch(terminal, (term) => {
	if (!term) return;
	term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
		if (ev.ctrlKey && ev.shiftKey && ev.key === 'F') {
			if (ev.type === 'keydown') {
				search.open();
			}
			return false; // prevent xterm from processing
		}
		// When search overlay is open, let Escape propagate to the overlay
		if (ev.key === 'Escape' && search.isOpen.value) {
			return false;
		}
		// When search is open, intercept Alt+C/R/W so they reach
		// useSearchShortcuts instead of being sent to the PTY
		if (ev.altKey && search.isOpen.value) {
			const k = ev.key.toLowerCase();
			if (k === 'c' || k === 'r' || k === 'w') {
				return false;
			}
		}
		// Ctrl+V / Ctrl+Shift+V → let browser handle paste from clipboard
		if (ev.ctrlKey && ev.key === 'v') {
			return false;
		}
		// Ctrl+C with selection → copy to clipboard (not SIGINT)
		if (ev.ctrlKey && ev.key === 'c' && term.hasSelection()) {
			return false;
		}
		return true;
	});
});

// ---------------------------------------------------------------------------
// Drag-and-drop (cross-tab pane DnD)
// ---------------------------------------------------------------------------

function onDragStart(event: DragEvent): void {
	if (!event.dataTransfer) return;
	const chId = effectiveChannelId.value;
	if (chId === null) return;

	event.dataTransfer.effectAllowed = 'move';

	const hostId = channelsStore.activeHostId ?? null;

	event.dataTransfer.setData(
		'text/x-lasterm-pane',
		JSON.stringify({
			channelId: chId,
			paneId: props.paneId,
			hostId,
		}),
	);

	document.body.classList.add('lasterm-dragging');
}

function onDragEnd(): void {
	document.body.classList.remove('lasterm-dragging');
}
</script>

<style scoped>
.terminal-pane {
	position: relative;
	width: 100%;
	height: 100%;
	overflow: hidden;
	display: flex;
	flex-direction: column;
}

.pane-header {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 4px 10px;
	background: var(--nt-tab-bar);
	border-bottom: 1px solid var(--nt-border);
	flex-shrink: 0;
	min-height: 28px;
	cursor: grab;
}

.pane-header:active {
	cursor: grabbing;
}

.pane-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--nt-text-secondary);
	text-transform: uppercase;
	letter-spacing: 0.06em;
	flex: 1;
}

.pane-lock {
	flex-shrink: 0;
}

.terminal-container {
	flex: 1;
	overflow: hidden;
	background: rgba(var(--nt-bg-rgb), var(--nt-terminal-alpha));
	position: relative;
	z-index: 2;
}

.tint-overlay {
	position: absolute;
	inset: 0;
	pointer-events: none;
	z-index: 3;
	will-change: opacity;
}

.terminal-loading,
.terminal-error {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: 13px;
	color: var(--nt-text-secondary);
	pointer-events: none;
	z-index: 1;
}

.terminal-error {
	color: var(--nt-badge);
}

/* Context menu */
.context-menu {
	position: absolute;
	background: var(--nt-bg);
	border: 1px solid var(--nt-tab-hover);
	border-radius: 6px;
	padding: 4px 0;
	min-width: 140px;
	z-index: 100;
	box-shadow: var(--nt-shadow);
}

.context-menu__item {
	display: block;
	width: 100%;
	padding: 6px 12px;
	background: none;
	border: none;
	color: var(--nt-fg);
	font-size: 12px;
	font-family: inherit;
	text-align: left;
	cursor: pointer;
	transition: background 0.1s;
}

.context-menu__item:hover {
	background: var(--nt-border);
}

.context-menu__item--danger {
	color: var(--nt-badge);
}

.context-menu__divider {
	border: none;
	border-top: 1px solid var(--nt-border);
	margin: 4px 0;
}

/* Exit overlay for direct process */
.exit-overlay {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 16px;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(2px);
	z-index: 10;
}

.exit-message {
	color: var(--nt-text-secondary);
	font-size: 14px;
	font-weight: 500;
}

.exit-actions {
	display: flex;
	gap: 8px;
}

.exit-btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	background: var(--nt-tab-hover);
	color: var(--nt-fg);
	border: none;
	border-radius: 4px;
	cursor: pointer;
	transition: background 0.12s, opacity 0.12s;
}

.exit-btn:hover {
	opacity: 0.85;
	background: var(--nt-border);
}

.exit-btn--danger {
	color: var(--nt-badge);
}

/* Reconnecting overlay */
.reconnecting-overlay {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	background: rgba(0, 0, 0, 0.55);
	backdrop-filter: blur(2px);
	z-index: 10;
	pointer-events: none;
}

.reconnecting-text {
	color: var(--nt-fg);
	font-size: 14px;
	font-weight: 500;
}

.reconnecting-dots::after {
	content: "";
	animation: dots 1.4s steps(4, end) infinite;
}

@keyframes dots {
	0% {
		content: "";
	}
	25% {
		content: ".";
	}
	50% {
		content: "..";
	}
	75% {
		content: "...";
	}
}
</style>
