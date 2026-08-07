import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "./useLogs.js";

// ---------------------------------------------------------------------------
// Stubs — must be registered before any module import resolves the stores
// ---------------------------------------------------------------------------

const localStorageMap = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => localStorageMap.get(key) ?? null,
	setItem: (key: string, value: string) => localStorageMap.set(key, value),
	removeItem: (key: string) => localStorageMap.delete(key),
	clear: () => localStorageMap.clear(),
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Deferred imports so that stubs are in place before the modules are evaluated
const { useLogs } = await import("./useLogs.js");
const { useAuthStore } = await import("../stores/auth.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return { lvl: "info", msg: "test message", ...overrides };
}

function stubFetch(response: {
	ok: boolean;
	entries?: LogEntry[];
	total?: number;
	status?: number;
	statusText?: string;
}): void {
	if (response.ok) {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					entries: response.entries ?? [],
					total: response.total ?? 0,
				}),
		});
	} else {
		mockFetch.mockResolvedValueOnce({
			ok: false,
			status: response.status ?? 500,
			statusText: response.statusText ?? "Internal Server Error",
		});
	}
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

beforeEach(() => {
	localStorageMap.clear();
	// Seed auth token so useLogs doesn't short-circuit with "Not authenticated"
	localStorageMap.set("lasterm_token", "test-token");
	setActivePinia(createPinia());
	mockFetch.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useLogs — initial state", () => {
	it("returns empty entries, zero total, not loading, no error on creation", () => {
		const { entries, total, loading, error } = useLogs({});

		expect(entries.value).toStrictEqual([]);
		expect(total.value).toBe(0);
		expect(loading.value).toBe(false);
		expect(error.value).toBeNull();
	});
});

describe("useLogs — hub logs (no channelId)", () => {
	it("fetches hub logs from /api/logs/hub", async () => {
		const logEntry = makeEntry({ lvl: "info", msg: "hub started", ts: "2026-01-01T00:00:00Z" });
		stubFetch({ ok: true, entries: [logEntry], total: 1 });

		const { entries, total, loading, error, fetch } = useLogs({});

		await fetch();

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/logs/hub");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");

		expect(loading.value).toBe(false);
		expect(error.value).toBeNull();
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]?.msg).toBe("hub started");
		expect(total.value).toBe(1);
	});

	it("passes level filter as query param", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({});
		await fetch({ level: "error" });

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("level=error");
	});

	it("passes search filter as query param", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({});
		await fetch({ search: "crash" });

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("search=crash");
	});

	it("passes limit query param (default 100)", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({});
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("limit=100");
	});

	it("respects custom limit option", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({ limit: 25 });
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("limit=25");
	});

	it("sets offset=0 on initial fetch (not loadMore)", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({});
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("offset=0");
	});

	it("replaces entries (not appends) on subsequent fetch calls", async () => {
		const first = [makeEntry({ msg: "first" })];
		const second = [makeEntry({ msg: "second" }), makeEntry({ msg: "third" })];

		stubFetch({ ok: true, entries: first, total: 1 });
		const { entries, fetch } = useLogs({});
		await fetch();
		expect(entries.value).toHaveLength(1);

		stubFetch({ ok: true, entries: second, total: 2 });
		await fetch();
		expect(entries.value).toHaveLength(2);
		expect(entries.value[0]?.msg).toBe("second");
	});
});

describe("useLogs — channel logs (with channelId)", () => {
	it("fetches channel logs from /api/logs/channels/:id", async () => {
		stubFetch({ ok: true, entries: [makeEntry({ msg: "SPAWN_OK" })], total: 1 });

		const { fetch } = useLogs({ channelId: "ch-abc" });
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("/api/logs/channels/ch-abc");
	});

	it("URL-encodes channelId", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({ channelId: "ch abc/special" });
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("/api/logs/channels/ch%20abc%2Fspecial");
	});
});

describe("useLogs — loading state", () => {
	it("sets loading=true during fetch and restores to false on success", async () => {
		let resolveJson!: (v: unknown) => void;
		const jsonPromise = new Promise((res) => {
			resolveJson = res;
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => jsonPromise,
		});

		const { loading, fetch } = useLogs({});
		const fetchPromise = fetch();

		// In-flight: loading must be true
		expect(loading.value).toBe(true);

		resolveJson({ entries: [], total: 0 });
		await fetchPromise;

		expect(loading.value).toBe(false);
	});

	it("restores loading=false even when fetch resolves with !ok", async () => {
		stubFetch({ ok: false, status: 503, statusText: "Service Unavailable" });

		const { loading, fetch } = useLogs({});
		await fetch();

		expect(loading.value).toBe(false);
	});
});

describe("useLogs — error paths", () => {
	it("sets error when response is not ok", async () => {
		stubFetch({ ok: false, status: 404, statusText: "Not Found" });

		const { error, fetch } = useLogs({});
		await fetch();

		expect(error.value).toBe("Request failed: 404 Not Found");
	});

	it("sets error when fetch throws a network error", async () => {
		mockFetch.mockRejectedValueOnce(new Error("Network failure"));

		const { error, fetch } = useLogs({});
		await fetch();

		expect(error.value).toBe("Network failure");
	});

	it("sets error to generic message for non-Error thrown values", async () => {
		mockFetch.mockRejectedValueOnce("oops");

		const { error, fetch } = useLogs({});
		await fetch();

		expect(error.value).toBe("Unknown error");
	});

	it("clears previous error on a new successful fetch", async () => {
		// First call: failure
		stubFetch({ ok: false, status: 500, statusText: "Server Error" });
		const { error, fetch } = useLogs({});
		await fetch();
		expect(error.value).not.toBeNull();

		// Second call: success
		stubFetch({ ok: true, entries: [], total: 0 });
		await fetch();
		expect(error.value).toBeNull();
	});

	it("returns early without fetching when not authenticated", async () => {
		localStorageMap.clear(); // remove token → auth store sees null

		// Re-init Pinia so auth store reads from the now-empty localStorage
		setActivePinia(createPinia());

		const { error, fetch } = useLogs({});
		await fetch();

		expect(mockFetch).not.toHaveBeenCalled();
		expect(error.value).toBe("Not authenticated");
	});
});

describe("useLogs — empty result", () => {
	it("sets entries to empty array and total to 0 when API returns no entries", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { entries, total, fetch } = useLogs({});
		await fetch();

		expect(entries.value).toStrictEqual([]);
		expect(total.value).toBe(0);
	});
});

describe("useLogs — loadMore (pagination)", () => {
	it("appends entries and keeps total when loadMore is called", async () => {
		const page1 = [makeEntry({ msg: "entry-1" }), makeEntry({ msg: "entry-2" })];
		const page2 = [makeEntry({ msg: "entry-3" })];

		stubFetch({ ok: true, entries: page1, total: 3 });
		const { entries, total, fetch, loadMore } = useLogs({ limit: 2 });
		await fetch();

		expect(entries.value).toHaveLength(2);
		expect(total.value).toBe(3);

		stubFetch({ ok: true, entries: page2, total: 3 });
		await loadMore();

		expect(entries.value).toHaveLength(3);
		expect(entries.value[2]?.msg).toBe("entry-3");
		expect(total.value).toBe(3);
	});

	it("sends offset equal to current entries length on loadMore", async () => {
		const page1 = [makeEntry({ msg: "a" }), makeEntry({ msg: "b" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { fetch, loadMore } = useLogs({ limit: 2 });
		await fetch();

		stubFetch({ ok: true, entries: [makeEntry({ msg: "c" })], total: 5 });
		await loadMore();

		const [url] = mockFetch.mock.calls[1] as [string];
		expect(url).toContain("offset=2");
	});

	it("loadMore is a no-op when all entries are already loaded", async () => {
		stubFetch({ ok: true, entries: [makeEntry(), makeEntry()], total: 2 });
		const { fetch, loadMore } = useLogs({});
		await fetch();

		await loadMore();

		// Only 1 fetch call (the initial fetch), no second call for loadMore
		expect(mockFetch).toHaveBeenCalledOnce();
	});

	it("loadMore is a no-op when already loading", async () => {
		// Set up: entries < total so loadMore would normally fire
		const page1 = [makeEntry({ msg: "a" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { loading, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();

		// Simulate in-flight state
		loading.value = true;
		await loadMore();

		// Still only 1 call (the initial fetch)
		expect(mockFetch).toHaveBeenCalledOnce();

		// Clean up
		loading.value = false;
	});

	it("sets error='Not authenticated' when loadMore called without a token (B4)", async () => {
		// Load some entries first
		stubFetch({ ok: true, entries: [makeEntry()], total: 5 });
		const { fetch, loadMore, error } = useLogs({ limit: 1 });
		await fetch();

		// Remove token mid-session
		localStorageMap.clear();
		setActivePinia(createPinia());

		await loadMore();

		// Only 1 fetch call (the initial one); loadMore set auth error
		expect(mockFetch).toHaveBeenCalledOnce();
		expect(error.value).toBe("Not authenticated");
	});

	it("preserves filters from last fetch() when loadMore is called", async () => {
		const page1 = [makeEntry({ msg: "e1" })];
		stubFetch({ ok: true, entries: page1, total: 3 });
		const { fetch, loadMore } = useLogs({ limit: 1 });
		await fetch({ level: "warn", search: "timeout" });

		stubFetch({ ok: true, entries: [makeEntry({ msg: "e2" })], total: 3 });
		await loadMore();

		const [url] = mockFetch.mock.calls[1] as [string];
		expect(url).toContain("level=warn");
		expect(url).toContain("search=timeout");
		expect(url).toContain("offset=1");
	});

	it("sets error on loadMore when response is not ok", async () => {
		stubFetch({ ok: true, entries: [makeEntry()], total: 5 });
		const { error, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();

		stubFetch({ ok: false, status: 502, statusText: "Bad Gateway" });
		await loadMore();

		expect(error.value).toBe("Request failed: 502 Bad Gateway");
	});
});

// ─── B1: fetch() race — out-of-order responses ───────────────────────────────

describe("useLogs — fetch() race guard (B1)", () => {
	it("only the latest fetch response commits — older stale response is discarded", async () => {
		// Two fetches: first resolves AFTER second. Only second's data should be committed.
		let resolveFirst!: (v: unknown) => void;
		const firstJsonPromise = new Promise((res) => {
			resolveFirst = res;
		});

		// First fetch: slow — json() never resolves until we call resolveFirst
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => firstJsonPromise,
		});
		// Second fetch: immediate
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					entries: [makeEntry({ msg: "second" })],
					total: 1,
				}),
		});

		const { entries, total, loading, fetch } = useLogs({});

		// Start first fetch (slow) — do NOT await yet
		const firstFetch = fetch({ level: "error" });

		// Immediately start second fetch — it should supersede the first
		const secondFetch = fetch({ level: "warn" });
		await secondFetch;

		// Now resolve the first (stale) fetch's json — it should be discarded
		resolveFirst({ entries: [makeEntry({ msg: "stale" })], total: 99 });
		await firstFetch;

		// Only second's data is visible
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]?.msg).toBe("second");
		expect(total.value).toBe(1);
		// loading must be false — second fetch completed
		expect(loading.value).toBe(false);
	});
});

// ─── B2: loadMore() stale-append guard ───────────────────────────────────────

describe("useLogs — loadMore() stale-append guard (B2)", () => {
	it("loadMore stale append is dropped when a newer fetch() supersedes it", async () => {
		// page1: initial fetch
		const page1 = [makeEntry({ msg: "p1-entry" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { entries, total, loading, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();
		expect(entries.value).toHaveLength(1);

		// Arrange: loadMore whose json() resolves AFTER a subsequent fetch() completes
		let resolveMoreJson!: (v: unknown) => void;
		const moreJsonPromise = new Promise((res) => {
			resolveMoreJson = res;
		});
		// loadMore fetch — slow json()
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => moreJsonPromise,
		});

		// loadMore check: loading=false, entries<total → will proceed
		const loadMorePromise = loadMore();

		// Before loadMore resolves, start a new fetch() — this bumps the generation
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					entries: [makeEntry({ msg: "fresh-fetch" })],
					total: 1,
				}),
		});
		await fetch();

		// Now resolve the stale loadMore json — it should be discarded
		resolveMoreJson({ entries: [makeEntry({ msg: "stale-append" })], total: 5 });
		await loadMorePromise;

		// Only fresh-fetch data is visible; stale append was not committed
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]?.msg).toBe("fresh-fetch");
		expect(total.value).toBe(1);
		expect(loading.value).toBe(false);
	});
});

// ─── Logout-mid-fetch guard ───────────────────────────────────────────────────

describe("useLogs — stale-auth guard: logout while fetch() in flight", () => {
	it("does not commit entries or total when auth is cleared before response resolves", async () => {
		// Mutation: removing the `|| authStore.token === null` check from the post-await
		// guard causes entries/total to be committed even after logout.
		let resolveJson!: (v: unknown) => void;
		const jsonPromise = new Promise((res) => {
			resolveJson = res;
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => jsonPromise,
		});

		const { entries, total, fetch } = useLogs({});
		const authStore = useAuthStore();

		// Start fetch — deferred; will not resolve until we call resolveJson
		const fetchPromise = fetch();

		// Logout while in flight
		authStore.clearToken();

		// Now resolve the response — the guard must drop it
		resolveJson({ entries: [makeEntry({ msg: "should-not-commit" })], total: 99 });
		await fetchPromise;

		// Stale data must NOT have been committed
		expect(entries.value).toStrictEqual([]);
		expect(total.value).toBe(0);
	});
});

describe("useLogs — stale-auth guard: logout while loadMore() in flight", () => {
	it("does not append entries when auth is cleared before loadMore response resolves", async () => {
		// Seed initial page
		const page1 = [makeEntry({ msg: "page1" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { entries, total, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();
		expect(entries.value).toHaveLength(1);

		// Arrange deferred loadMore response
		let resolveMoreJson!: (v: unknown) => void;
		const moreJsonPromise = new Promise((res) => {
			resolveMoreJson = res;
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => moreJsonPromise,
		});

		const authStore = useAuthStore();
		const loadMorePromise = loadMore();

		// Logout while loadMore is in flight
		authStore.clearToken();

		// Resolve the response — guard must drop the append
		resolveMoreJson({ entries: [makeEntry({ msg: "should-not-append" })], total: 5 });
		await loadMorePromise;

		// Entries must remain at page1 only — stale append was not committed.
		// total stays at 5 (from the initial fetch); the stale loadMore response did NOT
		// overwrite it (guard fired before the commit path).
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]?.msg).toBe("page1");
		expect(total.value).toBe(5); // unchanged from initial fetch — stale response dropped
	});
});

// ─── Logout-mid-fetch: error paths ───────────────────────────────────────────

describe("useLogs — stale-auth guard: logout while fetch() in flight (error path)", () => {
	it("does not commit error when auth is cleared and response is not-ok", async () => {
		// Mutation: removing `|| authStore.token === null` from the catch/not-ok guard
		// causes error.value to be set post-logout.
		let resolveRes!: (v: unknown) => void;
		const resPromise = new Promise((res) => {
			resolveRes = res;
		});
		mockFetch.mockReturnValueOnce(resPromise);

		const { error, fetch } = useLogs({});
		const authStore = useAuthStore();

		const fetchPromise = fetch();

		// Logout while the fetch is in flight
		authStore.clearToken();

		// Resolve with a not-ok response — guard must prevent error.value from being set
		resolveRes({ ok: false, status: 503, statusText: "Service Unavailable" });
		await fetchPromise;

		// error.value must remain null — stale error must not commit after logout
		expect(error.value).toBeNull();
	});

	it("does not commit error when auth is cleared and fetch() rejects (network error)", async () => {
		// Mutation: removing `|| authStore.token === null` from the catch block
		// causes error.value to be set post-logout.
		let rejectRes!: (reason: unknown) => void;
		const resPromise = new Promise<never>((_, rej) => {
			rejectRes = rej;
		});
		mockFetch.mockReturnValueOnce(resPromise);

		const { error, fetch } = useLogs({});
		const authStore = useAuthStore();

		const fetchPromise = fetch();

		// Logout while the fetch is in flight
		authStore.clearToken();

		// Reject the fetch — catch guard must prevent error.value from being set
		rejectRes(new Error("Network failure"));
		await fetchPromise;

		expect(error.value).toBeNull();
	});
});

describe("useLogs — stale-auth guard: logout while loadMore() in flight (error path)", () => {
	it("does not commit error when auth is cleared and loadMore response is not-ok", async () => {
		// Seed initial page so loadMore has something to do
		const page1 = [makeEntry({ msg: "p1" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { error, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();

		let resolveRes!: (v: unknown) => void;
		const resPromise = new Promise((res) => {
			resolveRes = res;
		});
		mockFetch.mockReturnValueOnce(resPromise);

		const authStore = useAuthStore();
		const loadMorePromise = loadMore();

		// Logout while loadMore is in flight
		authStore.clearToken();

		// Resolve with not-ok — guard must prevent error.value from being set
		resolveRes({ ok: false, status: 503, statusText: "Service Unavailable" });
		await loadMorePromise;

		expect(error.value).toBeNull();
	});

	it("does not commit error when auth is cleared and loadMore() rejects (network error)", async () => {
		// Mutation: removing `|| authStore.token === null` from loadMore catch block
		const page1 = [makeEntry({ msg: "p1" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { error, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();

		let rejectRes!: (reason: unknown) => void;
		const resPromise = new Promise<never>((_, rej) => {
			rejectRes = rej;
		});
		mockFetch.mockReturnValueOnce(resPromise);

		const authStore = useAuthStore();
		const loadMorePromise = loadMore();

		// Logout while loadMore is in flight
		authStore.clearToken();

		rejectRes(new Error("Network failure"));
		await loadMorePromise;

		expect(error.value).toBeNull();
	});
});

// ─── Token-replacement guard (rotation without logout) ───────────────────────

describe("useLogs — stale-auth guard: token replaced (rotated) while fetch() in flight", () => {
	it("does not commit entries when token rotates to a new value before response resolves", async () => {
		// Mutation: keeping `authStore.token === null` instead of `authStore.token !== tok`
		// would let this response commit, because the token is non-null after rotation.
		let resolveJson!: (v: unknown) => void;
		const jsonPromise = new Promise((res) => {
			resolveJson = res;
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => jsonPromise,
		});

		const { entries, total, fetch } = useLogs({});
		const authStore = useAuthStore();

		// Start fetch under token "test-token" — deferred
		const fetchPromise = fetch();

		// Rotate to a new token (re-auth / background refresh) — NOT logout
		authStore.setToken("new-rotated-token");

		// Resolve with a success response — guard must drop it (old token ≠ new token)
		resolveJson({ entries: [makeEntry({ msg: "should-not-commit" })], total: 99 });
		await fetchPromise;

		// Stale data must NOT have been committed
		expect(entries.value).toStrictEqual([]);
		expect(total.value).toBe(0);
	});
});

describe("useLogs — stale-auth guard: token replaced (rotated) while loadMore() in flight", () => {
	it("does not append entries when token rotates before loadMore response resolves", async () => {
		// Mutation: keeping `authStore.token === null` instead of `authStore.token !== tok`
		// would let this append commit, because the token is non-null after rotation.
		const page1 = [makeEntry({ msg: "page1" })];
		stubFetch({ ok: true, entries: page1, total: 5 });
		const { entries, total, fetch, loadMore } = useLogs({ limit: 1 });
		await fetch();
		expect(entries.value).toHaveLength(1);

		// Arrange deferred loadMore response
		let resolveMoreJson!: (v: unknown) => void;
		const moreJsonPromise = new Promise((res) => {
			resolveMoreJson = res;
		});
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => moreJsonPromise,
		});

		const authStore = useAuthStore();
		const loadMorePromise = loadMore();

		// Rotate the token while loadMore is in flight — NOT logout
		authStore.setToken("new-rotated-token");

		// Resolve the response — guard must drop the stale append
		resolveMoreJson({ entries: [makeEntry({ msg: "should-not-append" })], total: 5 });
		await loadMorePromise;

		// Entries must remain at page1 only — stale append dropped
		expect(entries.value).toHaveLength(1);
		expect(entries.value[0]?.msg).toBe("page1");
		expect(total.value).toBe(5);
	});
});

// ─── B3: limit clamp ─────────────────────────────────────────────────────────

describe("useLogs — limit clamp (B3)", () => {
	it("clamps limit below 1 to 1", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({ limit: 0 });
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("limit=1");
	});

	it("clamps limit above 1000 to 1000", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({ limit: 9999 });
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("limit=1000");
	});

	it("truncates fractional limit (3.9 → 3)", async () => {
		stubFetch({ ok: true, entries: [], total: 0 });

		const { fetch } = useLogs({ limit: 3.9 });
		await fetch();

		const [url] = mockFetch.mock.calls[0] as [string];
		expect(url).toContain("limit=3");
	});
});
