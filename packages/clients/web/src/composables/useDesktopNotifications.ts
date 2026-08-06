import { onUnmounted } from "vue";

interface GroupEntry {
	count: number;
	channelId: string;
	channelTitle: string;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Show a desktop notification without requiring Vue component context.
 * Intended for use from Pinia stores or plain modules.
 * Only shows when document is hidden and permission is granted.
 */
export function showSimpleNotification(title: string, body: string, channelId: string): void {
	if (typeof Notification === "undefined") return;
	if (Notification.permission !== "granted") return;
	if (!document.hidden) return;

	try {
		const notification = new Notification(title, {
			body,
			tag: `lasterm-${channelId}`,
			silent: true,
		});

		notification.onclick = () => {
			window.focus();
			notification.close();
		};
	} catch {
		// Notification API may throw in some environments
	}
}

/**
 * Desktop notification management for terminal alerts.
 *
 * Features:
 * - Permission request wrapper
 * - Grouping: accumulates alerts within a window, shows "N alerts in <channel>"
 * - Click-to-focus: focuses window and activates the channel tab
 * - Only shows when document is hidden (tab not visible)
 */
export function useDesktopNotifications(opts?: {
	groupingWindowMs?: number;
	onActivateChannel?: (channelId: string) => void;
}) {
	const groupingWindowMs = opts?.groupingWindowMs ?? 5000;
	const pendingGroups = new Map<string, GroupEntry>();

	function requestPermission(): void {
		if (typeof Notification === "undefined") return;
		if (Notification.permission === "default") {
			void Notification.requestPermission();
		}
	}

	function showNotification(
		title: string,
		body: string,
		channelId: string,
		channelTitle?: string,
		tag?: string,
	): void {
		if (typeof Notification === "undefined") return;
		if (Notification.permission !== "granted") return;

		// Only show when document is hidden (user is not looking at this tab)
		if (!document.hidden) return;

		const effectiveTag = tag ?? `lasterm-bell-${channelId}`;
		const groupKey = effectiveTag;

		const existing = pendingGroups.get(groupKey);
		if (existing) {
			// Accumulate within grouping window
			existing.count++;
			// Update will happen when the timer fires
			return;
		}

		// Start a new grouping window
		const label = channelTitle ?? "terminal";
		const entry: GroupEntry = {
			count: 1,
			channelId,
			channelTitle: label,
			timer: setTimeout(() => {
				// Timer fired — show the grouped notification
				pendingGroups.delete(groupKey);
				_showNative(
					entry.count > 1 ? `${title} (${entry.count} alerts)` : title,
					entry.count > 1 ? `${entry.count} alerts in ${entry.channelTitle}` : body,
					channelId,
					effectiveTag,
				);
			}, groupingWindowMs),
		};
		pendingGroups.set(groupKey, entry);

		// Show the first notification immediately
		_showNative(title, body, channelId, effectiveTag);
	}

	function _showNative(title: string, body: string, channelId: string, tag: string): void {
		try {
			const notification = new Notification(title, {
				body,
				tag,
				silent: true, // Sound is handled separately by useBellSound
			});

			notification.onclick = () => {
				window.focus();
				opts?.onActivateChannel?.(channelId);
				notification.close();
			};
		} catch {
			// Notification API may throw in some environments (e.g. service workers)
		}
	}

	function dispose(): void {
		for (const entry of pendingGroups.values()) {
			clearTimeout(entry.timer);
		}
		pendingGroups.clear();
	}

	onUnmounted(dispose);

	return {
		requestPermission,
		showNotification,
		dispose,
	};
}
