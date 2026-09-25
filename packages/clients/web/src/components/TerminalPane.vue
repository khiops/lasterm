<template>
	<div ref="paneRoot" class="terminal-pane" :style="borderStyle" @contextmenu.prevent="showContextMenu">
		<!-- Pane header — always rendered so fitAddon.fit() calculates correct rows -->
		<div
			class="pane-header"
			draggable="true"
			@dragstart="onDragStart"
			@dragend="onDragEnd"
		>
			<span class="pane-title">{{ paneTitle }}</span>
			<WriteLockIndicator :channel-id="effectiveChannelId" :is-dead="isDead || hasEnded || isGone" class="pane-lock" />
		</div>

		<!-- Environment banner (UX-07) -->
		<EnvironmentBanner
			v-if="bannerText"
			:text="bannerText"
			:bg-color="visualProfile.banner.bgColor"
			:text-color="visualProfile.banner.textColor"
		/>

		<div v-if="error" class="terminal-error">
			<div class="terminal-error__box">
				<span>{{ error }}</span>
				<div class="terminal-error__actions">
					<button class="exit-btn" @click="onRetry">Retry</button>
					<button class="exit-btn" @click="onClosePaneFromOverlay">Close</button>
				</div>
			</div>
		</div>
		<div v-else-if="!ready" class="terminal-loading">
			<span>Connecting…</span>
		</div>
		<div ref="terminalContainer" class="terminal-container" />

		<!-- Background tint overlay (UX-07) -->
		<div v-if="tintStyle" class="tint-overlay" :style="tintStyle" />

		<!-- Exit overlay for all dead channels, and for one the hub has never heard of.
		     The card carries its own opaque ground, so what is behind it — the
		     terminal's content, a wallpaper — never decides whether it reads. -->
		<div v-if="cover === 'exited' || cover === 'gone'" class="exit-overlay">
			<div
				ref="exitCard"
				class="exit-card"
				role="group"
				tabindex="-1"
				:aria-labelledby="`${exitId}-message`"
			>
				<p :id="`${exitId}-message`" class="exit-message">
					{{ cover === 'gone' ? goneMessage : exitMessage }}
				</p>
				<p v-if="heldBack !== null && !isGone" class="exit-reason">{{ heldBackText }}</p>
				<p v-if="restartFailure && !isGone" class="exit-reason">
					Could not restart it: {{ restartFailure }}
				</p>
				<div class="exit-actions">
					<button
						v-if="!isGone"
						class="exit-btn exit-btn--primary"
						:disabled="restarting"
						@click="onOverlayAction('restart')"
					>
						{{ restarting ? 'Restarting…' : 'Restart' }}
					</button>
					<button
						v-if="isDirectProcess && !isGone"
						class="exit-btn"
						@click="onConfigure"
					>Configure</button>
					<button
						v-if="isGone"
						class="exit-btn"
						@click="onClosePaneFromOverlay"
					>Close</button>
					<button v-else class="exit-btn" @click="onOverlayAction('close')">Close</button>
				</div>
				<div v-if="!isGone" class="exit-options">
					<label class="exit-option" :for="`${exitId}-keep`">
						<input :id="`${exitId}-keep`" v-model="keepChoice" type="checkbox" />
						Keep in the sidebar
					</label>
					<label class="exit-option" :for="`${exitId}-always`">
						<input :id="`${exitId}-always`" v-model="alwaysChoice" type="checkbox" />
						Always do this
					</label>
				</div>
			</div>
		</div>

		<!-- Not connected: what is shown is remembered, not live -->
		<div v-if="cover === 'not-connected'" class="detached-banner">
			<span class="detached-text">Not connected. This is what this terminal last showed; typing here goes nowhere.</span>
			<button class="detached-btn" @click="onReconnect">Reconnect</button>
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
import { computed, inject, nextTick, onMounted, onUnmounted, ref, toRef, useId, watch } from 'vue';
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
import {
	createEndWatch,
	type EndSeen,
	endedPrefs,
	type HeldBack,
	heldBackMessage,
	type OverlayAction,
	overlayChoice,
	reactToEnd,
} from '../utils/exit-action.js';
import { type AttachFacts, factsFromAttachOk, factsFromRefusal, paneCover } from '../utils/pane-cover.js';
import { altArrowSequence, IS_MAC } from '../utils/terminal-keys.js';
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
	/** `ended` when closing a terminal known to have ended: whether to keep it listed. */
	(e: 'close-pane', channelId: string, ended?: { keep: boolean }): void;
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

/**
 * The host this pane speaks to is the one its terminal runs on, not the one the
 * rail has selected. Tabs are global, so a pane whose terminal is on another
 * host stays on screen while you look elsewhere — and every pane was handed the
 * selected host, which gave it that host's profile and had Restart try to bring
 * the terminal back on a machine it had never run on.
 *
 * A pane still owing its spawn has no channel yet: there the selected host is
 * exactly right, since a new terminal opens on the host in view.
 */
const paneHostId = computed<string | undefined>(() => {
	const channelId = props.channelId;
	if (channelId !== null && channelId !== undefined) {
		const known = channelsStore.channelHostMap.get(channelId);
		if (known !== undefined) return known;
	}
	return props.hostId ?? undefined;
});
const writeLockStore = useWriteLockStore();
const configStore = useConfigStore();
const notificationStore = useNotificationStore();
const terminalContainer = ref<HTMLElement | null>(null);
const ready = ref(false);
const error = ref<string | null>(null);
/** Host of a spawn this pane owes, kept until the channel exists. */
const pendingHostId = ref<string | null>(null);
/** The BEL handler is registered on the terminal, so once is enough. */
let bellBound = false;
/** A reconnect landed while this pane was still opening: what it sent went out
 * on a socket that is gone, so the failure to come is not the channel's fault. */
let reconnectedWhileOpening = false;

const hostsStore = useHostsStore();

// Resolve per-host theme override (SC-03) from host.profileJson
const hostThemeName = (() => {
	const paneHost = paneHostId.value;
	if (!paneHost) return undefined;
	const host = hostsStore.hosts.find((h) => h.id === paneHost);
	if (!host?.profileJson) return undefined;
	try {
		const parsed = JSON.parse(host.profileJson) as { theme?: string };
		return parsed.theme;
	} catch {
		return undefined;
	}
})();

const { profile: resolvedProfile } = useResolvedProfile(
	computed(() => paneHostId.value),
	computed(() => props.channelId ?? undefined),
);

const {
	init,
	awaitFont,
	attachChannel,
	reattachChannel,
	applyProfile,
	suppressNextResize,
	syncChannelSize,
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

const { tabTitle: paneTitle } = useTabTitle(
	effectiveChannelId,
	toRef(channelsStore, 'channels'),
	currentDynamicTitle,
	{ index: toRef(channelsStore, 'channelIndex') },
);

// ---------------------------------------------------------------------------
// Visual profile (UX-07)
// ---------------------------------------------------------------------------

const paneHost = computed(() => {
	const hostId = paneHostId.value;
	if (!hostId) return undefined;
	return hostsStore.hosts.find((h) => h.id === hostId);
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

// Whatever host is in view: the list only carries that host's channels, and
// a pane over another host's terminal must hear it end too (#556).
const isDead = computed(() => channelsStore.statusOf(effectiveChannelId.value) === 'dead');

const isDirectProcess = computed(() => {
	const chId = effectiveChannelId.value;
	if (!chId) return false;
	const channel = channelsStore.channels.find((c) => c.id === chId);
	// A terminal on a host not in view is in the index only.
	if (channel === undefined) return channelsStore.channelIndex.get(chId)?.directProcess === true;
	return channel.directProcess === true;
});

/**
 * A terminal this hub has no record of — deleted from another window, or left
 * over from a hub that is gone.
 *
 * It is shown here rather than announced: the pane is where this terminal is
 * looked at, and a red banner carrying its id says nothing to the person
 * reading it.
 */
const isGone = ref(false);

/** A Reconnect or a Restart is already asking for this terminal. */
let reattaching = false;

/**
 * The last attach reached the terminal itself, and nothing since says it ended.
 *
 * Only such a pane has nothing to gain from attaching again when the hub says
 * its terminal is live. Every other one does: one on its banner, one over a
 * terminal that has ended and was brought back from elsewhere, one that never
 * attached because it knew its terminal had ended.
 */
let attachedLive = false;

// ---------------------------------------------------------------------------
// When the terminal ends (#574)
// ---------------------------------------------------------------------------

/** "When a terminal ends" and "Keep ended terminals in the sidebar", from Settings. */
const prefs = computed(() => endedPrefs(configStore.uiConfig.panes));

/**
 * Whether an end was seen as it happened, or found afterwards: only the first
 * is acted on. See `reactToEnd`.
 */
const endWatch = createEndWatch(() => performance.now());

// What the pane hears after its socket went is not live, whatever it says.
// Synchronous, so that no report arriving on the next socket is read first.
watch(
	() => sessionStore.connected,
	(connected) => {
		if (!connected) endWatch.lost();
	},
	{ flush: 'sync' },
);

/** Why the setting's restart did not happen, shown on the overlay. */
const heldBack = ref<HeldBack | null>(null);
const heldBackText = computed(() => (heldBack.value === null ? '' : heldBackMessage(heldBack.value)));
// A reason is about one terminal: a pane handed another one drops it.
watch(effectiveChannelId, () => {
	heldBack.value = null;
});

/** Do what the setting says about an end, or show the overlay and why. */
function onTerminalEnded(end: EndSeen): void {
	const reaction = reactToEnd(prefs.value, {
		...end,
		directProcess: isDirectProcess.value,
		writer: isWriter.value,
	});
	if (reaction.kind === 'overlay') {
		// An end found later keeps the reason the one seen gave, which is still true.
		if (reaction.heldBack !== undefined) heldBack.value = reaction.heldBack;
		else if (end.seen === 'live') heldBack.value = null;
		return;
	}
	heldBack.value = null;
	if (reaction.kind === 'restart') void onRestart();
	else closeEnded(reaction.keep);
}

type AttachResult = Awaited<ReturnType<typeof reattachChannel>>;

/** Take what the hub answered to an attach about `chId`, and only that. */
function takeAnswer(chId: string, facts: AttachFacts): void {
	hasEnded.value = facts.ended;
	isGone.value = facts.gone;
	isDetached.value = facts.detached;
	attachedLive = !facts.ended && !facts.gone && !facts.detached;
	if (attachedLive) {
		endWatch.attached(chId);
		heldBack.value = null;
	} else if (facts.ended) {
		// Refused because it has ended: found, not seen happening.
		onTerminalEnded(endWatch.ended(chId));
	} else {
		endWatch.lost();
	}
}

/**
 * Attach to the terminal, and let the hub's answer decide what covers it.
 *
 * Every attach goes through here: the pane opening, Reconnect, Restart, a new
 * channel id, the socket coming back. Each used to read the answer its own
 * way, and the one after the socket came back did not read it at all, so the
 * pane kept or dropped its banner whatever the hub said (#559).
 *
 * Resolves with the ATTACH_OK, or null when the hub answered that the terminal
 * has ended or that it has no record of it. Anything else is thrown: it says
 * nothing about the terminal.
 */
async function attachAndCover(
	chId: string,
	opts?: { preserveContent?: boolean },
): Promise<AttachResult | null> {
	let result: AttachResult;
	try {
		result = await reattachChannel(chId, opts);
	} catch (err) {
		// Reaching the host and not finding the terminal there is an answer, not
		// a failure to connect: dropping it left the pane saying "Not connected"
		// over a terminal that had ended (#556).
		const facts = factsFromRefusal((err as { code?: string } | null)?.code);
		if (facts === null) throw err;
		takeAnswer(chId, facts);
		return null;
	}
	takeAnswer(chId, factsFromAttachOk(result.cached));
	return result;
}

/**
 * Ask again for the terminal itself.
 *
 * The hub tries the host when a pane attaches, so attaching again is the whole
 * gesture: it either comes back with something live, answers from memory again
 * and the banner stays, or reaches the host and finds the terminal gone.
 */
async function onReconnect(): Promise<void> {
	const chId = effectiveChannelId.value;
	if (chId === null || reattaching) return;
	reattaching = true;
	try {
		await attachAndCover(chId, { preserveContent: true });
	} catch {
		// Still unreachable. The banner is already saying so.
	} finally {
		reattaching = false;
	}
}

/**
 * The hub answered this pane from what it remembers, with nothing attached to
 * the terminal itself.
 *
 * It happens when the host cannot be reached: a remote whose daemon is holding
 * the terminal, but whose connection could not be reopened. What is on screen
 * is the last thing the terminal showed, and what is typed into it goes
 * nowhere — so the pane has to say so rather than look ordinary.
 */
const isDetached = ref(false);

/**
 * The hub said this terminal has ended, whatever the channel list holds.
 *
 * `isDead` reads the list of the host in view, or what the hub has reported
 * since the page loaded, and the list is the current session's: a tab left
 * over from before a restart names a terminal the hub still knows, the list no
 * longer carries, and nothing has reported on. Trusting only those left such a
 * pane blank and inert — no message, no button, nothing to do.
 */
// The lock indicator reads this too: a terminal on another host that has
// ended is in no list, and may have had no report, so `isDead` can stay false
// there, and the pane offered "No lock" over a shell that no longer exists
// while the overlay said it had exited.
const hasEnded = ref(false);
const goneMessage = 'This terminal no longer exists.';

/**
 * A terminal brought back — from this pane or from the sidebar — is not the
 * one that ended. What the attach learnt when the page loaded stops being
 * true, and left standing it kept "Shell exited" over a live shell with its
 * prompt showing beneath.
 */
watch(
	() => channelsStore.statusOf(effectiveChannelId.value),
	(status) => {
		if (status === 'live' || status === 'born') {
			hasEnded.value = false;
			heldBack.value = null;
		}
	},
);

/** A restart is under way: over SSH it can take seconds, and a button that
 * does nothing visible for that long gets pressed again. */
const restarting = ref(false);

/**
 * The hub says this terminal is live while the pane is not attached to it.
 *
 * On its banner, the host was reached after the attach had stopped waiting
 * for it: a Reconnect slower than the attach left the pane saying "Not
 * connected" over a terminal it could now reach (#556). Over the exit
 * overlay, or never attached because it knew its terminal had ended, the
 * terminal was brought back from the sidebar or from another window, and the
 * pane went blank over it with nothing attached (#559). Either way it asks
 * again, as Reconnect would. A restart from this pane attaches by itself.
 */
watch(
	() => channelsStore.reportOf(effectiveChannelId.value),
	(report, previous) => {
		const chId = effectiveChannelId.value;
		if (report?.status === 'dead') {
			attachedLive = false;
			// The hub saying it ended: live if this pane was watching it run on
			// this socket, found otherwise (#574). A report repeating it is not news.
			if (chId !== null && previous?.status !== 'dead') onTerminalEnded(endWatch.ended(chId));
		}
		if (report?.status !== 'live' || attachedLive || !ready.value || restarting.value) return;
		// Brought back from elsewhere while this pane was over it ended: a start
		// seen, which the attach below counts from.
		if (chId !== null && previous?.status === 'dead') endWatch.starting(chId);
		void onReconnect();
	},
);

/** What the pane lays over its terminal, if anything. */
const cover = computed(() =>
	paneCover({
		status: channelsStore.statusOf(effectiveChannelId.value),
		ended: hasEnded.value,
		gone: isGone.value,
		detached: isDetached.value,
	}),
);

/** Why the last attempt to bring this terminal back failed, if it did. */
const restartFailure = computed(() => {
	const chId = effectiveChannelId.value;
	return chId === null ? undefined : channelsStore.restartFailures.get(chId);
});

const exitMessage = computed(() => {
	const chId = effectiveChannelId.value;
	if (!chId) return 'Exited';
	const channel = channelsStore.channels.find((c) => c.id === chId);
	const label = isDirectProcess.value ? 'Process' : 'Shell';
	const code = channel?.exitCode ?? channelsStore.reportOf(chId)?.exitCode;
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

/**
 * Spawn or attach the pane's channel, and report what stopped it.
 *
 * Called on mount and again by a retry: the terminal itself is created once, by
 * init(), so this takes the size it already has. A spawn that never completed
 * keeps its host in `pendingHostId`, so the retry spawns rather than attaching a
 * channel that was never created.
 */
async function openChannel(cols: number, rows: number): Promise<void> {
	try {
		await sessionStore.connect();

		if (props.channelId !== null && props.channelId !== undefined) {
			const hostId = pendingHostId.value;

			if (hostId !== null) {
				// Fresh spawn — PTY is created with actual terminal dimensions
				// so no RESIZE is needed → no SIGWINCH → no duplicate prompt
				const realId = await channelsStore.spawnChannel(hostId, {
					cols,
					rows,
					select: false,
				});
				pendingHostId.value = null;
				internalChannelId.value = realId;
				// PTY was spawned at these dims — suppress the RESIZE that
				// attachChannel would otherwise send (prevents SIGWINCH)
				suppressNextResize(cols, rows);
				attachChannel(realId);
				attachedLive = true;
				// Watched from its very start.
				endWatch.starting(realId);
				endWatch.attached(realId);
				// And now that there is a channel to tell: a font arriving while
				// it was being created refits the terminal, and that fit had
				// nobody to send its size to.
				syncChannelSize();
				emit('channel-spawned', props.channelId, realId);
			} else {
				// A terminal already known to have ended is not asked for: the
				// hub would answer CHANNEL_DEAD, which is what the overlay says.
				// Mark ready so the overlay renders immediately.
				if (isDead.value) {
					ready.value = true;
					return;
				}
				// Existing channel — reattach (fetch snapshot + tail).
				// Write-lock state is set by the WRITE_LOCK WS message handler
				// (fired by WriteLockManager.attach on the hub side), not from
				// the ATTACH_OK payload — avoids a microtask race where
				// setInitialHolder would overwrite a more recent WRITE_LOCK.
				// A terminal that has ended, whichever host it is on, is
				// answered as ended: the pane shows the exit overlay with
				// Restart, and nothing restarts it on its own (#559).
				await attachAndCover(props.channelId);
			}
			ready.value = true;
			applyProfile(resolvedProfile.value);
			// Register xterm.js BEL handler — fires on \x07 from PTY output
			if (bellBound) return;
			bellBound = true;
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
		const code = (err as { code?: string } | null)?.code;
		// The channel died between page load and ATTACH: the pane shows it dead,
		// which is a state, not an error.
		if (code === 'CHANNEL_DEAD' || msg.includes('is dead') || msg.includes('CHANNEL_DEAD')) {
			hasEnded.value = true;
			ready.value = true;
			return;
		}
		// The hub has no record of it — deleted from another window, or left over
		// from a hub that is gone. The same shape of news, shown the same way.
		if (code === 'CHANNEL_NOT_FOUND') {
			isGone.value = true;
			ready.value = true;
			return;
		}
		// AGENT_NOT_AVAILABLE is explained by the AgentDeployFailed modal, so the
		// pane does not repeat why. It still has to stop saying "Connecting…":
		// returning here left a pane waiting for ever on something that had
		// already failed, with nothing on it to click and no keystroke accepted.
		if (msg.startsWith('AGENT_NOT_AVAILABLE:')) {
			error.value = 'This host could not be reached.';
			return;
		}
		error.value = msg;
		console.error('[TerminalPane] Initialization failed:', err);
		// An attach lost with its socket is worth sending again by itself. A
		// spawn is not: the hub may have created the channel and only the answer
		// was lost, and a second one would leave a terminal nobody asked for.
		if (reconnectedWhileOpening && pendingHostId.value === null) {
			reconnectedWhileOpening = false;
			await onRetry();
		}
	}
}

onMounted(async () => {
	// The spawn App.vue registered for this tab, kept so a retry can spawn it.
	pendingHostId.value =
		props.channelId !== null && props.channelId !== undefined
			? channelsStore.consumePendingSpawn(props.channelId)
			: null;
	// Measure with the font the terminal will use: against a fallback the fit
	// counts columns the window does not have, and the PTY is spawned that wide.
	await awaitFont();
	const { cols, rows } = init();
	await openChannel(cols, rows);
});

/** Try again after a failure — the button the error offers. */
async function onRetry(): Promise<void> {
	error.value = null;
	const term = terminal.value;
	await openChannel(term?.cols ?? 80, term?.rows ?? 24);
}

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
				await attachAndCover(newId);
			} catch (err) {
				error.value = err instanceof Error ? err.message : String(err);
			}
		}
	},
);

// Re-attach terminal channels after hub reconnect (session persistence).
// When the hub restarts, WS auto-reconnects and session store increments
// reconnectCount. Each pane then re-attaches its channel to restore the
// snapshot from spool.db + connect to the new PTY output stream. What the
// hub answers now decides the cover, whatever the pane showed before: the
// terminal may have ended, come back, or become unreachable meanwhile (#559).
watch(
	() => sessionStore.reconnectCount,
	async () => {
		// A pane that failed to open never became ready: the connection coming
		// back is its chance to try again, which is what left it stuck before.
		if (!ready.value) {
			if (error.value !== null) await onRetry();
			// Still opening: the attempt in flight speaks to a socket that is
			// gone, so let it fail and try again then.
			else reconnectedWhileOpening = true;
			return;
		}
		if (effectiveChannelId.value) {
			try {
				error.value = null;
				await attachAndCover(effectiveChannelId.value);
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

	// Every host takes the same road now: restarting a dead terminal is a spawn
	// under its own id, over the WS — which is what the SSH branch here existed
	// for, since that path carries the prompts a passphrase or a host key need.
	// It used to open a stranger and delete the terminal being restarted, which
	// is the opposite of what the button says.
	if (restarting.value) return;
	restarting.value = true;
	// The attach that follows counts from this start: an end within seconds of
	// it is one the setting does not restart again (#574).
	endWatch.starting(chId);
	heldBack.value = null;
	let ok: boolean;
	try {
		ok = await channelsStore.restartChannel(chId, paneHostId.value);
	} finally {
		restarting.value = false;
	}
	if (!ok) endWatch.lost();
	if (ok) {
		// This pane may be over a terminal no list shows — one on another
		// host — where the status watcher may not have heard it come back yet.
		hasEnded.value = false;
		reattaching = true;
		let result: AttachResult | null;
		try {
			result = await attachAndCover(chId, { preserveContent: true });
		} finally {
			reattaching = false;
		}
		// Ended again at once, or gone: the answer is already what covers it.
		if (result === null) return;
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

/** Close the pane of a terminal that has ended, deleting it unless it is kept. */
function closeEnded(keep: boolean): void {
	const chId = effectiveChannelId.value;
	if (chId !== null) emit('close-pane', chId, { keep });
}

/** The overlay's options: "Keep in the sidebar" and "Always do this". */
const exitId = useId();
const keepChoice = ref(false);
const alwaysChoice = ref(false);
const paneRoot = ref<HTMLElement | null>(null);
const exitCard = ref<HTMLElement | null>(null);

/**
 * Restart or Close, clicked on the overlay: done at once, with the options
 * beside it, and remembered as the setting when "Always do this" says so.
 */
function onOverlayAction(action: OverlayAction): void {
	const { act, remember } = overlayChoice(action, {
		keep: keepChoice.value,
		always: alwaysChoice.value,
	});
	if (remember !== null) void configStore.saveUiSettings('panes', remember);
	if (act.kind === 'restart') void onRestart();
	else closeEnded(act.keep);
}

/**
 * Give the overlay the keyboard, when the keyboard was on this pane.
 *
 * The terminal takes Tab for itself, so from there the overlay's buttons
 * could only be reached with a mouse. Focus held anywhere else — another pane,
 * a dialog, Settings — is left where it is.
 *
 * The card takes it, not Restart: the keys typed as the shell ended — the
 * Enter after `exit`, one pressed twice — would otherwise restart it. Tab
 * reaches the buttons from there.
 */
function focusOverlay(): void {
	const active = document.activeElement;
	const idle = active === null || active === document.body;
	if ((idle && isActiveTab.value) || (active !== null && paneRoot.value?.contains(active) === true)) {
		exitCard.value?.focus();
	}
}

// Each time the overlay comes up its options start from the setting.
watch(
	() => cover.value === 'exited' || cover.value === 'gone',
	(shown) => {
		if (!shown) return;
		keepChoice.value = prefs.value.keepEnded;
		alwaysChoice.value = false;
		void nextTick(focusOverlay);
	},
	{ immediate: true },
);

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

// The terminal that becomes the selected one takes the keyboard: a new
// terminal, or a tab switched to, left it on the page body, so the first keys
// went nowhere until a click.
watch(
	[isActiveTab, terminal],
	([active, term]) => {
		// Over a terminal that has ended, the keyboard goes to the overlay's card.
		if (active && term) void nextTick(() => (exitCard.value ?? term).focus());
	},
	{ immediate: true },
);

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
		// Alt+arrow → word motion, as xterm 5 did before leaving it to embedders
		const altArrow = altArrowSequence(ev, IS_MAC);
		if (altArrow !== null) {
			if (ev.type === 'keydown') {
				term.input(altArrow);
			}
			return false;
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
	/* The one layer carrying the terminal's opacity, for the whole pane.
	   xterm paints the same colour at the same opacity on its own element,
	   which multiplied the two — 69 % asked for, 90 % on screen — and that
	   element stops on a whole row, leaving a strip along the bottom with no
	   tint at all. Its background is taken back in base.css so this one is
	   alone, and the pane is of one piece. */
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
	/* Above .terminal-container (2) and .tint-overlay (3): below them, the
	   terminal's own background hid every message a pane had to give. */
	z-index: 4;
}

/* The pane keeps whatever the terminal already showed, so the message needs a
   ground of its own to be read over it. */
.terminal-loading span,
.terminal-error__box {
	padding: 6px 12px;
	border-radius: 6px;
	background: var(--nt-bg);
	border: 1px solid var(--nt-border);
}

.terminal-error {
	color: var(--nt-badge);
}

.terminal-error__box {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 10px;
	padding: 14px 18px;
	text-align: center;
	/* The overlay lets clicks through to the terminal; its buttons must not. */
	pointer-events: auto;
}

.terminal-error__actions {
	display: flex;
	gap: 8px;
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

/* Exit overlay: a neutral scrim over whatever the pane shows, and on it a card
   of the theme's own opaque ground. The card's text and its ground are a pair
   the theme guarantees (`--nt-text-strong` is made to read at 4.5:1 on
   `--nt-bg`), so what lies behind — the terminal's content, a wallpaper, a
   translucent terminal — never decides whether it reads. Every colour a rule
   below gives its text is checked against its ground, in every bundled theme,
   by TerminalPane.spec.ts. */
.exit-overlay {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 16px;
	background: var(--nt-overlay);
	backdrop-filter: blur(2px);
	z-index: 10;
}

.exit-card {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 12px;
	max-width: min(36rem, 100%);
	padding: 16px 20px;
	border-radius: 8px;
	background: rgb(var(--nt-bg-rgb));
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	box-shadow: var(--nt-shadow);
	text-align: center;
}

/* The card holds the keyboard only so that nothing on it acts on a stray key. */
.exit-card:focus {
	outline: none;
}

.exit-message {
	margin: 0;
	font-size: 14px;
	font-weight: 600;
}

.exit-reason {
	margin: 0;
	font-size: 12px;
	line-height: 1.4;
	overflow-wrap: anywhere;
}

.exit-actions {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 8px;
}

/* The same buttons as before, in colours that read on the card: outlined on
   its ground, and Restart filled with the accent as the action to take. */
.exit-btn {
	padding: 6px 14px;
	font-size: 12px;
	font-family: inherit;
	font-weight: 500;
	background: transparent;
	color: var(--nt-text-strong);
	border: 1px solid var(--nt-border);
	border-radius: 4px;
	cursor: pointer;
	transition: border-color 0.12s;
}

.exit-btn--primary {
	background: var(--nt-accent);
	color: var(--nt-accent-fg);
	border-color: var(--nt-accent);
}

/* Hover marks the edge and leaves the colours alone: a tinted ground would
   take the text below the contrast it was chosen for. */
.exit-btn:hover:not(:disabled) {
	border-color: var(--nt-text-strong);
}

.exit-btn:focus-visible,
.exit-option input:focus-visible {
	outline: 2px solid var(--nt-accent);
	outline-offset: 2px;
}

.exit-btn:disabled {
	opacity: 0.6;
	cursor: default;
}

.exit-options {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 6px 16px;
}

.exit-option {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 12px;
	cursor: pointer;
}

.exit-option input {
	margin: 0;
	accent-color: var(--nt-accent);
	cursor: pointer;
}

/* Reconnecting overlay */
.detached-banner {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	z-index: 6;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 6px 10px;
	background: var(--nt-badge-warning, #f9e2af);
	color: #000;
	font-size: 12px;
}

.detached-text {
	flex: 1;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.detached-btn {
	flex-shrink: 0;
	padding: 2px 10px;
	border: 1px solid rgba(0, 0, 0, 0.35);
	border-radius: 3px;
	background: transparent;
	color: inherit;
	font: inherit;
	cursor: pointer;
}

.detached-btn:hover {
	background: rgba(0, 0, 0, 0.1);
}

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
