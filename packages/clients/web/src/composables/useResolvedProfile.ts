import { DEFAULT_PROFILE, type TerminalProfile } from "@lasterm/shared";
import { onMounted, onUnmounted, type Ref, ref, watch } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { useConfigStore } from "../stores/config.js";
import { hubBaseUrl, hubPortReady } from "../utils/hub-url.js";

export interface ResolvedProfileContext {
	hostId: string | null;
	channelId: string | null;
}

/**
 * Per-terminal profile resolution via the cascade API.
 *
 * Fetches /api/config/cascade?host_id=X&channel_id=Y on mount and
 * extracts terminal.resolved, then re-fetches whenever a relevant
 * profile-change event fires (global, host-scoped matching hostId,
 * or channel-scoped matching channelId).
 *
 * Falls back to DEFAULT_PROFILE while the first fetch is in-flight or
 * if the request fails.
 */
export function useResolvedProfile(
	hostId: Ref<string | undefined | null>,
	channelId: Ref<string | undefined | null>,
): {
	profile: Ref<TerminalProfile>;
	resolvedFor: Ref<ResolvedProfileContext | null>;
	reload: () => Promise<void>;
} {
	const configStore = useConfigStore();
	const authStore = useAuthStore();
	const profile = ref<TerminalProfile>({ ...DEFAULT_PROFILE });
	const resolvedFor = ref<ResolvedProfileContext | null>(null);
	let requestSeq = 0;
	let resolvedToken: string | null = null;

	function currentContext(): ResolvedProfileContext {
		return {
			hostId: hostId.value ?? null,
			channelId: channelId.value ?? null,
		};
	}

	function currentToken(): string | null {
		return authStore.token?.trim() || null;
	}

	function contextsEqual(a: ResolvedProfileContext | null, b: ResolvedProfileContext): boolean {
		return a?.hostId === b.hostId && a.channelId === b.channelId;
	}

	function resetProfile(): void {
		profile.value = { ...DEFAULT_PROFILE };
		resolvedFor.value = null;
		resolvedToken = null;
	}

	async function reload(): Promise<void> {
		const requestId = ++requestSeq;
		const token = currentToken();
		if (!token) {
			resetProfile();
			return;
		}

		const requestContext = currentContext();
		const shouldReset =
			resolvedToken !== token || !contextsEqual(resolvedFor.value, requestContext);
		if (shouldReset) resetProfile();

		if (!hubPortReady.value) return;

		try {
			const params = new URLSearchParams();
			if (requestContext.hostId) params.set("host_id", requestContext.hostId);
			if (requestContext.channelId) params.set("channel_id", requestContext.channelId);
			const qs = params.toString();
			const resp = await fetch(`${hubBaseUrl()}/api/config/cascade${qs ? `?${qs}` : ""}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (resp.ok) {
				const cascade = (await resp.json()) as { terminal: { resolved: TerminalProfile } };
				if (
					requestId === requestSeq &&
					currentToken() === token &&
					contextsEqual(currentContext(), requestContext)
				) {
					profile.value = cascade.terminal.resolved;
					resolvedFor.value = requestContext;
					resolvedToken = token;
				}
			}
		} catch (err) {
			console.warn("[useResolvedProfile] failed to load:", err);
		}
	}

	let unsubscribe: (() => void) | null = null;

	onMounted(() => {
		void reload();
		unsubscribe = configStore.onProfileChange((event) => {
			if (event.scope === "global") {
				// Global change affects all terminals
				void reload();
			} else if (event.scope === "host" && event.hostId === hostId.value) {
				// Host change affects terminals on this host
				void reload();
			} else if (event.scope === "channel" && event.channelId === channelId.value) {
				// Channel change affects only this terminal
				void reload();
			}
		});
	});

	const stopContextWatch = watch([hostId, channelId], () => {
		void reload();
	});

	const stopAuthWatch = watch(
		() => authStore.token,
		() => {
			void reload();
		},
	);

	const stopHubReadyWatch = watch(
		() => hubPortReady.value,
		(ready) => {
			if (ready) void reload();
		},
	);

	onUnmounted(() => {
		unsubscribe?.();
		stopContextWatch();
		stopAuthWatch();
		stopHubReadyWatch();
	});

	return { profile, resolvedFor, reload };
}
