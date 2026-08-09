import { type Ref, ref } from "vue";
import { useAuthStore } from "../stores/auth.js";
import { hubFetch } from "../utils/hub-fetch.js";
import { hubBaseUrl } from "../utils/hub-url.js";

export interface LogEntry {
	t?: number; // channel log: offset in ms
	ts?: string; // hub log: ISO 8601 timestamp
	src?: "hub" | "agent";
	lvl: string;
	msg: string;
	[key: string]: unknown;
}

interface FetchParams {
	level?: string;
	search?: string;
	offset?: number;
}

export interface UseLogsOptions {
	/** If set, fetch channel logs. If absent/undefined, fetch hub logs. */
	channelId?: string;
	/** Page size — default 100. B3: clamped to 1..1000. */
	limit?: number;
}

export interface UseLogsReturn {
	entries: Ref<LogEntry[]>;
	total: Ref<number>;
	loading: Ref<boolean>;
	error: Ref<string | null>;
	fetch: (params?: FetchParams) => Promise<void>;
	loadMore: () => Promise<void>;
}

export function useLogs(options: UseLogsOptions): UseLogsReturn {
	const { channelId } = options;
	// B3: clamp limit to a sane integer range (1..1000)
	const rawLimit = options.limit ?? 100;
	const limit = Math.max(1, Math.min(1000, Math.trunc(rawLimit)));

	const entries: Ref<LogEntry[]> = ref([]);
	const total: Ref<number> = ref(0);
	const loading: Ref<boolean> = ref(false);
	const error: Ref<string | null> = ref(null);

	/** Last params used for fetch — stored so loadMore can append. */
	let _lastParams: FetchParams = {};

	/**
	 * Monotonically increasing request generation counter.
	 * B1/B2: only the response belonging to the latest generation is committed.
	 */
	let _generation = 0;

	function buildUrl(params: FetchParams & { offset?: number }): string {
		const base = hubBaseUrl();
		const path =
			channelId !== undefined
				? `${base}/api/logs/channels/${encodeURIComponent(channelId)}`
				: `${base}/api/logs/hub`;

		const qs = new URLSearchParams();
		if (params.level) qs.set("level", params.level);
		if (params.search) qs.set("search", params.search);
		qs.set("limit", String(limit));
		if (params.offset !== undefined) qs.set("offset", String(params.offset));

		const query = qs.toString();
		return query ? `${path}?${query}` : path;
	}

	async function refresh(params: FetchParams = {}): Promise<void> {
		const authStore = useAuthStore();
		if (authStore.token === null) {
			error.value = "Not authenticated";
			return;
		}
		// Snapshot the token so we detect both logout (null) and replacement (different value)
		const tok = authStore.token;

		// B1: claim a new generation before going async — any older in-flight
		// response will see its generation is stale and skip committing.
		const gen = ++_generation;

		_lastParams = params;
		loading.value = true;
		error.value = null;

		try {
			const url = buildUrl({ ...params, offset: 0 });
			const res = await hubFetch(url, {
				headers: { Authorization: `Bearer ${tok}` },
			});

			// B1: stale response guard — a newer refresh superseded this one, or auth changed
			if (gen !== _generation || authStore.token !== tok) return;

			if (!res.ok) {
				error.value = `Request failed: ${res.status} ${res.statusText}`;
				return;
			}

			const data = (await res.json()) as { entries: LogEntry[]; total: number };

			// B1: re-check after the async json() parse
			if (gen !== _generation || authStore.token !== tok) return;

			entries.value = data.entries;
			total.value = data.total;
		} catch (err) {
			if (gen !== _generation || authStore.token !== tok) return;
			error.value = err instanceof Error ? err.message : "Unknown error";
		} finally {
			// Only clear loading if we are still the active generation
			if (gen === _generation) {
				loading.value = false;
			}
		}
	}

	async function loadMore(): Promise<void> {
		const authStore = useAuthStore();
		if (authStore.token === null) {
			// B4: match refresh's unauthenticated behavior — set error before returning
			error.value = "Not authenticated";
			return;
		}
		// Snapshot the token so we detect both logout (null) and replacement (different value)
		const tok = authStore.token;

		if (loading.value) return;
		if (entries.value.length >= total.value) return;

		// B2: snapshot the generation at the start of loadMore; if refresh fires
		// concurrently and bumps _generation, we discard the stale append.
		const gen = _generation;

		loading.value = true;
		error.value = null;

		try {
			const url = buildUrl({ ..._lastParams, offset: entries.value.length });
			const res = await hubFetch(url, {
				headers: { Authorization: `Bearer ${tok}` },
			});

			// B2: stale append guard — also drop if auth changed mid-flight
			if (gen !== _generation || authStore.token !== tok) return;

			if (!res.ok) {
				error.value = `Request failed: ${res.status} ${res.statusText}`;
				return;
			}

			const data = (await res.json()) as { entries: LogEntry[]; total: number };

			// B2: re-check after async json() parse
			if (gen !== _generation || authStore.token !== tok) return;

			entries.value = [...entries.value, ...data.entries];
			total.value = data.total;
		} catch (err) {
			if (gen !== _generation || authStore.token !== tok) return;
			error.value = err instanceof Error ? err.message : "Unknown error";
		} finally {
			if (gen === _generation) {
				loading.value = false;
			}
		}
	}

	return { entries, total, loading, error, fetch: refresh, loadMore };
}
