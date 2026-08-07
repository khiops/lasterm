import type { ScrollMode } from "@lasterm/shared";
import { type ComputedRef, computed, ref, watch } from "vue";
import { useNotificationStore } from "../stores/notifications.js";

/**
 * Manages unread lines bar visibility and scroll behavior on tab switch.
 *
 * Modes:
 * - "auto": show bar if lines < threshold, scroll to bottom if >= threshold
 * - "alwaysBottom": always scroll to bottom, never show bar
 * - "alwaysResume": always resume position, show bar if new lines
 */
export function useScrollBehavior(opts: {
	channelId: ComputedRef<string | null>;
	isActiveTab: ComputedRef<boolean>;
	scrollMode?: ScrollMode;
	autoThreshold?: number;
	scrollToBottom?: () => void;
}) {
	const mode = opts.scrollMode ?? "auto";
	const threshold = opts.autoThreshold ?? 100;
	const notificationStore = useNotificationStore();

	const showBar = ref(false);
	const barLineCount = ref(0);

	const unreadCount = computed(() => {
		const chId = opts.channelId.value;
		if (!chId) return 0;
		return notificationStore.unreadLines.get(chId) ?? 0;
	});

	// When tab becomes active, decide what to show
	watch(opts.isActiveTab, (active) => {
		if (!active) {
			showBar.value = false;
			return;
		}

		const chId = opts.channelId.value;
		if (!chId) return;

		// Always clear bell + activity on tab focus (unread lines handled below per mode)
		notificationStore.clearBellAndActivity(chId);

		const lines = notificationStore.unreadLines.get(chId) ?? 0;

		if (mode === "alwaysBottom") {
			// Always scroll to bottom, no bar
			opts.scrollToBottom?.();
			notificationStore.clearChannel(chId);
			showBar.value = false;
		} else if (mode === "alwaysResume") {
			// Always resume position, show bar if new lines
			if (lines > 0) {
				barLineCount.value = lines;
				showBar.value = true;
			} else {
				showBar.value = false;
			}
		} else {
			// "auto" mode
			if (lines >= threshold) {
				// Too many lines — scroll to bottom, but briefly flash the bar
				// so the user knows lines were skipped (SC-22)
				barLineCount.value = lines;
				showBar.value = true;
				opts.scrollToBottom?.();
				notificationStore.clearChannel(chId);
				setTimeout(() => {
					showBar.value = false;
				}, 1500);
			} else if (lines > 0) {
				// Manageable amount — resume position, show bar
				barLineCount.value = lines;
				showBar.value = true;
			} else {
				showBar.value = false;
			}
		}
	});

	// Update bar line count when unread changes (while active)
	watch(unreadCount, (count) => {
		if (opts.isActiveTab.value) return; // Don't show bar while active
		barLineCount.value = count;
	});

	function markRead(): void {
		const chId = opts.channelId.value;
		if (chId) {
			notificationStore.clearChannel(chId);
		}
		showBar.value = false;
	}

	function jumpToBottom(): void {
		const chId = opts.channelId.value;
		if (chId) {
			notificationStore.clearChannel(chId);
		}
		showBar.value = false;
		opts.scrollToBottom?.();
	}

	function onNaturalScrollToBottom(): void {
		// Ignore scroll events from hidden panes (v-show). xterm.js auto-scrolls
		// when writing data even when the terminal is display:none, which would
		// immediately clear unread lines set by the activity tracker.
		if (!opts.isActiveTab.value) return;

		const chId = opts.channelId.value;
		if (chId) {
			// Only clear unread lines (scroll-related). Bell/activity have their
			// own lifecycle — cleared on tab focus or auto-dismiss, not on scroll.
			notificationStore.clearUnreadLines(chId);
		}
		showBar.value = false;
	}

	return {
		showBar,
		barLineCount,
		markRead,
		jumpToBottom,
		onNaturalScrollToBottom,
	};
}
