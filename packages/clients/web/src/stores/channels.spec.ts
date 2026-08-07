import type { ChannelCreatedMessage } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelsStore } from "./channels.js";
import { useConfigStore } from "./config.js";
import { useSessionStore } from "./session.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const localStorageMap = new Map<string, string>();
vi.stubGlobal("localStorage", {
	getItem: (key: string) => localStorageMap.get(key) ?? null,
	setItem: (key: string, value: string) => localStorageMap.set(key, value),
	removeItem: (key: string) => localStorageMap.delete(key),
	clear: () => localStorageMap.clear(),
});

// fetch is called by fetchGroups — stub it to return a controllable response
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const COLLAPSED_KEY = "lasterm:collapsed-groups";

function makeGroupRow(id: string, name = "Group"): Record<string, unknown> {
	return {
		id,
		host_id: "host-1",
		name,
		sort_order: 0,
		created_at: "2026-01-01T00:00:00Z",
	};
}

function stubGroups(rows: Record<string, unknown>[]): void {
	mockFetch.mockImplementation((url: string) => {
		const body = url.includes("/api/groups") ? rows : [];
		return Promise.resolve({
			ok: true,
			json: () => Promise.resolve(body),
		});
	});
}

/** Parse the collapsed map stored in localStorage, or return null if absent. */
function readCollapsedMap(): Record<string, boolean> | null {
	const raw = localStorage.getItem(COLLAPSED_KEY);
	if (raw === null) return null;
	return JSON.parse(raw) as Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
	localStorageMap.clear();
	mockFetch.mockReset();
	setActivePinia(createPinia());
	// Seed auth token so fetchGroups doesn't early-return (TOKEN_KEY = "lasterm_token")
	localStorageMap.set("lasterm_token", "test-token");
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// toggleGroupCollapsed — persists to localStorage
// ---------------------------------------------------------------------------

describe("useChannelsStore — toggleGroupCollapsed", () => {
	it("persists collapsed=true for a group on first toggle", async () => {
		stubGroups([makeGroupRow("g1")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		store.toggleGroupCollapsed("g1");

		const map = readCollapsedMap();
		expect(map).not.toBeNull();
		expect(map?.g1).toBe(true);
	});

	it("persists collapsed=false on second toggle (expand)", async () => {
		stubGroups([makeGroupRow("g1")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		store.toggleGroupCollapsed("g1"); // collapse
		store.toggleGroupCollapsed("g1"); // expand

		const map = readCollapsedMap();
		expect(map?.g1).toBe(false);
	});

	it("restores collapsed state when fetchGroups is called", async () => {
		// Pre-seed localStorage with a collapsed group
		localStorageMap.set(COLLAPSED_KEY, JSON.stringify({ g1: true }));

		stubGroups([makeGroupRow("g1"), makeGroupRow("g2")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		const g1 = store.groups.find((g) => g.id === "g1");
		const g2 = store.groups.find((g) => g.id === "g2");
		expect(g1?.collapsed).toBe(true);
		expect(g2?.collapsed).toBe(false);
	});

	it("does not affect __general__ entry when toggling a real group", async () => {
		localStorageMap.set(COLLAPSED_KEY, JSON.stringify({ __general__: true }));
		stubGroups([makeGroupRow("g1")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		store.toggleGroupCollapsed("g1");

		const map = readCollapsedMap();
		// __general__ must survive the group toggle unchanged
		expect(map?.__general__).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// toggleGeneralCollapsed — persists to localStorage under __general__
// ---------------------------------------------------------------------------

describe("useChannelsStore — toggleGeneralCollapsed", () => {
	it("starts false by default", () => {
		const store = useChannelsStore();
		expect(store.generalCollapsed).toBe(false);
	});

	it("toggles generalCollapsed to true on first call", () => {
		const store = useChannelsStore();
		store.toggleGeneralCollapsed();
		expect(store.generalCollapsed).toBe(true);
	});

	it("toggles back to false on second call", () => {
		const store = useChannelsStore();
		store.toggleGeneralCollapsed();
		store.toggleGeneralCollapsed();
		expect(store.generalCollapsed).toBe(false);
	});

	it("writes __general__=true to localStorage on collapse", () => {
		const store = useChannelsStore();
		store.toggleGeneralCollapsed();

		const map = readCollapsedMap();
		expect(map).not.toBeNull();
		expect(map?.__general__).toBe(true);
	});

	it("writes __general__=false to localStorage on expand", () => {
		const store = useChannelsStore();
		store.toggleGeneralCollapsed(); // collapse
		store.toggleGeneralCollapsed(); // expand

		const map = readCollapsedMap();
		expect(map?.__general__).toBe(false);
	});

	it("does not overwrite other group entries in localStorage", () => {
		localStorageMap.set(COLLAPSED_KEY, JSON.stringify({ g1: true, g2: false }));
		const store = useChannelsStore();
		store.toggleGeneralCollapsed();

		const map = readCollapsedMap();
		expect(map?.g1).toBe(true);
		expect(map?.g2).toBe(false);
		expect(map?.__general__).toBe(true);
	});

	it("restores generalCollapsed=true from localStorage after fetchGroups", async () => {
		localStorageMap.set(COLLAPSED_KEY, JSON.stringify({ __general__: true }));
		stubGroups([]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");
		expect(store.generalCollapsed).toBe(true);
	});

	it("restores generalCollapsed=false when __general__ is absent from localStorage", async () => {
		localStorageMap.set(COLLAPSED_KEY, JSON.stringify({ g1: true }));
		stubGroups([]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");
		expect(store.generalCollapsed).toBe(false);
	});

	it("handles corrupt localStorage gracefully — defaults to false", async () => {
		localStorageMap.set(COLLAPSED_KEY, "not-valid-json{{{");
		stubGroups([]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");
		expect(store.generalCollapsed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// fetchChannels — stale state cleared on startup (STATE_SYNC race fix)
// ---------------------------------------------------------------------------

describe("useChannelsStore — fetchChannels clears stale state", () => {
	function makeChannelRow(
		id: string,
		status: "live" | "dead" | "connecting" = "live",
	): Record<string, unknown> {
		return {
			id,
			session_id: "sess-1",
			shell: "/bin/bash",
			cols: 80,
			rows: 24,
			status,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		};
	}

	function stubChannelsAndGroups(
		channels: Record<string, unknown>[],
		groups: Record<string, unknown>[] = [],
	): void {
		mockFetch.mockImplementation((url: string) => {
			const body = url.includes("/api/groups") ? groups : channels;
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		});
	}

	it("clears channels when switching hosts so STATE_SYNC buffers", async () => {
		// Simulate existing state for host-1
		stubChannelsAndGroups([makeChannelRow("ch-1")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");
		expect(store.channels).toHaveLength(1);

		// Switch to host-2 — channels must be cleared at the start
		let capturedChannelsLength: number | null = null;
		stubChannelsAndGroups([makeChannelRow("ch-2")]);
		const origFetch = mockFetch.getMockImplementation();
		mockFetch.mockImplementation(async (url: string) => {
			capturedChannelsLength = store.channels.length;
			return origFetch?.(url);
		});

		await store.fetchChannels("host-2");

		// channels must have been [] when the REST call started (host changed)
		expect(capturedChannelsLength).toBe(0);
		expect(store.channels).toHaveLength(1);
	});

	it("keeps existing channels when refreshing same host", async () => {
		stubChannelsAndGroups([makeChannelRow("ch-1")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");
		expect(store.channels).toHaveLength(1);

		// Refresh same host — channels must NOT be cleared (tabs stay open)
		let capturedChannelsLength: number | null = null;
		const origFetch = mockFetch.getMockImplementation();
		mockFetch.mockImplementation(async (url: string) => {
			capturedChannelsLength = store.channels.length;
			return origFetch?.(url);
		});

		await store.fetchChannels("host-1");

		expect(capturedChannelsLength).toBe(1);
		expect(store.channels).toHaveLength(1);
	});

	it("applies STATE_SYNC status when it arrives before fetchChannels completes", async () => {
		// Controlled promise to pause the REST response mid-flight
		let resolveChannels!: (v: unknown) => void;
		const channelsPromise = new Promise((r) => {
			resolveChannels = r;
		});

		mockFetch.mockImplementation((url: string) => {
			if (url.includes("/api/groups")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			// Channels response is held until we release it
			return channelsPromise.then(() => ({
				ok: true,
				json: () => Promise.resolve([makeChannelRow("ch-1", "live")]),
			}));
		});

		const store = useChannelsStore();
		const fetchPromise = store.fetchChannels("host-1");

		// STATE_SYNC arrives while channels.value is still [] (REST not yet complete)
		// hub says ch-1 is "dead"
		store.applyStateSync([{ channelId: "ch-1", sessionId: "sess-1", status: "dead" }]);

		// Release the REST response
		resolveChannels(undefined);
		await fetchPromise;

		// STATE_SYNC's "dead" status must win over REST's "live" status
		expect(store.channels).toHaveLength(1);
		expect(store.channels[0]?.status).toBe("dead");
	});

	it("marks channels absent from STATE_SYNC as dead via lastSyncIds", async () => {
		let resolveChannels!: (v: unknown) => void;
		const channelsPromise = new Promise((r) => {
			resolveChannels = r;
		});

		mockFetch.mockImplementation((url: string) => {
			if (url.includes("/api/groups")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
			}
			return channelsPromise.then(() => ({
				ok: true,
				json: () =>
					Promise.resolve([makeChannelRow("ch-1", "live"), makeChannelRow("ch-2", "live")]),
			}));
		});

		const store = useChannelsStore();
		const fetchPromise = store.fetchChannels("host-1");

		// STATE_SYNC only knows about ch-1 — ch-2 has been lost by the hub
		store.applyStateSync([{ channelId: "ch-1", sessionId: "sess-1", status: "live" }]);

		resolveChannels(undefined);
		await fetchPromise;

		expect(store.channels).toHaveLength(2);
		const ch1 = store.channels.find((c) => c.id === "ch-1");
		const ch2 = store.channels.find((c) => c.id === "ch-2");
		expect(ch1?.status).toBe("live");
		// ch-2 is absent from STATE_SYNC → must be marked dead
		expect(ch2?.status).toBe("dead");
	});

	it("applies STATE_SYNC status when it arrives after fetchChannels completes", async () => {
		stubChannelsAndGroups([makeChannelRow("ch-1", "live")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		// STATE_SYNC arrives after fetchChannels — channels.value is populated
		// so applyStateSync applies directly
		store.applyStateSync([{ channelId: "ch-1", sessionId: "sess-1", status: "dead" }]);

		expect(store.channels[0]?.status).toBe("dead");
	});

	it("does not carry stale channels into a new host fetch", async () => {
		stubChannelsAndGroups([makeChannelRow("ch-old", "live")]);
		const store = useChannelsStore();
		await store.fetchChannels("host-1");
		expect(store.channels.map((c) => c.id)).toContain("ch-old");

		// Switch to a different host — ch-old must not appear
		stubChannelsAndGroups([makeChannelRow("ch-new", "live")]);
		await store.fetchChannels("host-2");

		expect(store.channels.map((c) => c.id)).not.toContain("ch-old");
		expect(store.channels.map((c) => c.id)).toContain("ch-new");
	});
});

// ---------------------------------------------------------------------------
// spawnChannel — autoGroup behaviour
// ---------------------------------------------------------------------------

describe("useChannelsStore — spawnChannel autoGroup", () => {
	function makeGroupRowWithOrder(
		id: string,
		name: string,
		sortOrder: number,
	): Record<string, unknown> {
		return {
			id,
			host_id: "host-1",
			name,
			sort_order: sortOrder,
			created_at: "2026-01-01T00:00:00Z",
		};
	}

	function setupWsClient(sentMessages: unknown[]): {
		on: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	} {
		const listeners = new Map<string, ((msg: unknown) => void)[]>();
		const on = vi.fn((type: string, cb: (msg: unknown) => void) => {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type)?.push(cb);
			return () => {
				const arr = listeners.get(type) ?? [];
				const idx = arr.indexOf(cb);
				if (idx !== -1) arr.splice(idx, 1);
			};
		});
		const send = vi.fn((msg: unknown) => {
			sentMessages.push(msg);
			// Immediately fire SPAWN_OK so the promise resolves
			const cbs = listeners.get("SPAWN_OK") ?? [];
			for (const cb of cbs) cb({ type: "SPAWN_OK", channelId: "ch-new" });
		});
		return { on, send };
	}

	beforeEach(() => {
		localStorageMap.set("lasterm_token", "test-token");
	});

	it("sends SPAWN without groupId when autoGroup is none", async () => {
		mockFetch.mockImplementation((url: string) => {
			const body = url.includes("/api/groups") ? [makeGroupRowWithOrder("g1", "Alpha", 0)] : [];
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		});

		const sentMessages: unknown[] = [];
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		const sessionStore = useSessionStore();
		const { on, send } = setupWsClient(sentMessages);
		// @ts-expect-error — overwrite reactive wsClient for test
		sessionStore.wsClient = { on, send };

		// configStore defaults autoGroup to undefined (falsy) — no assignment
		await store.spawnChannel("host-1");

		expect(send).toHaveBeenCalledOnce();
		const msg = sentMessages[0] as Record<string, unknown>;
		expect(msg.type).toBe("SPAWN");
		expect(msg.groupId).toBeUndefined();
	});

	it("sends SPAWN with first group's id when autoGroup is first", async () => {
		mockFetch.mockImplementation((url: string) => {
			const body = url.includes("/api/groups")
				? [makeGroupRowWithOrder("g2", "Beta", 10), makeGroupRowWithOrder("g1", "Alpha", 0)]
				: [];
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		});

		const sentMessages: unknown[] = [];
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		const sessionStore = useSessionStore();
		const { on, send } = setupWsClient(sentMessages);
		// @ts-expect-error — overwrite reactive wsClient for test
		sessionStore.wsClient = { on, send };

		const configStore = useConfigStore();
		configStore.uiConfig = { ...configStore.uiConfig, channels: { autoGroup: "first" } };

		await store.spawnChannel("host-1");

		expect(send).toHaveBeenCalledOnce();
		const msg = sentMessages[0] as Record<string, unknown>;
		expect(msg.type).toBe("SPAWN");
		// g1 has sortOrder 0 — it's first
		expect(msg.groupId).toBe("g1");
	});

	it("sends SPAWN without groupId when autoGroup is first but no groups exist", async () => {
		mockFetch.mockImplementation((url: string) => {
			const body = url.includes("/api/groups") ? [] : [];
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		});

		const sentMessages: unknown[] = [];
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		const sessionStore = useSessionStore();
		const { on, send } = setupWsClient(sentMessages);
		// @ts-expect-error — overwrite reactive wsClient for test
		sessionStore.wsClient = { on, send };

		const configStore = useConfigStore();
		configStore.uiConfig = { ...configStore.uiConfig, channels: { autoGroup: "first" } };

		await store.spawnChannel("host-1");

		expect(send).toHaveBeenCalledOnce();
		const msg = sentMessages[0] as Record<string, unknown>;
		expect(msg.type).toBe("SPAWN");
		expect(msg.groupId).toBeUndefined();
	});
});

describe("useChannelsStore — spawnChannel agent sync handling", () => {
	function setupManualWsClient(sentMessages: unknown[]): {
		emit: (type: string, msg: unknown) => void;
		on: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	} {
		const listeners = new Map<string, ((msg: unknown) => void)[]>();
		const on = vi.fn((type: string, cb: (msg: unknown) => void) => {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type)?.push(cb);
			return () => {
				const arr = listeners.get(type) ?? [];
				const idx = arr.indexOf(cb);
				if (idx !== -1) arr.splice(idx, 1);
			};
		});
		const send = vi.fn((msg: unknown) => {
			sentMessages.push(msg);
		});
		const emit = (type: string, msg: unknown) => {
			for (const cb of listeners.get(type) ?? []) {
				cb(msg);
			}
		};
		return { emit, on, send };
	}

	beforeEach(() => {
		localStorageMap.set("lasterm_token", "test-token");
		mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
	});

	it("does not reject a pending spawn when AGENT_SYNCED arrives before SPAWN_OK", async () => {
		const sentMessages: unknown[] = [];
		const store = useChannelsStore();
		const sessionStore = useSessionStore();
		const { emit, on, send } = setupManualWsClient(sentMessages);
		// @ts-expect-error — overwrite reactive wsClient for test
		sessionStore.wsClient = { on, send };

		const spawn = store.spawnChannel("host-1");

		emit("AGENT_SYNCED", {
			type: "AGENT_SYNCED",
			hostId: "host-1",
			hostname: "prod-box",
			message: "Agent on prod-box updated to the current version",
		});
		emit("SPAWN_OK", { type: "SPAWN_OK", channelId: "ch-new" });

		await expect(spawn).resolves.toBe("ch-new");
		expect(send).toHaveBeenCalledOnce();
	});

	it("ignores legacy AGENT_UPDATED error frames while waiting for SPAWN_OK", async () => {
		const sentMessages: unknown[] = [];
		const store = useChannelsStore();
		const sessionStore = useSessionStore();
		const { emit, on, send } = setupManualWsClient(sentMessages);
		// @ts-expect-error — overwrite reactive wsClient for test
		sessionStore.wsClient = { on, send };

		const spawn = store.spawnChannel("host-1");

		emit("ERROR", {
			type: "ERROR",
			code: "AGENT_UPDATED",
			message: "Legacy agent update notice",
		});
		emit("SPAWN_OK", { type: "SPAWN_OK", channelId: "ch-new" });

		await expect(spawn).resolves.toBe("ch-new");
		expect(send).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// handleChannelCreated — multi-client sync (CHANNEL_CREATED WS message)
// ---------------------------------------------------------------------------

function makeCreatedMsg(overrides?: Partial<ChannelCreatedMessage>): ChannelCreatedMessage {
	return {
		type: "CHANNEL_CREATED",
		hostId: "host-1",
		channelId: "ch-new",
		sessionId: "sess-1",
		shell: "/bin/bash",
		cols: 80,
		rows: 24,
		status: "live",
		displayTitle: "Terminal",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function stubEmpty(): void {
	mockFetch.mockImplementation(() =>
		Promise.resolve({ ok: true, json: () => Promise.resolve([]) }),
	);
}

describe("useChannelsStore — handleChannelCreated", () => {
	it("adds the new channel to the list when the host matches", async () => {
		stubEmpty();
		const store = useChannelsStore();
		// Load host-1 (channels will be empty — REST returns [])
		await store.fetchChannels("host-1");
		expect(store.channels).toHaveLength(0);

		store.handleChannelCreated(makeCreatedMsg());

		expect(store.channels).toHaveLength(1);
		expect(store.channels[0]?.id).toBe("ch-new");
		expect(store.channels[0]?.status).toBe("live");
	});

	it("channel becomes visible with status live — no pendingStatuses gap", async () => {
		// This proves the grey-icon race is gone: the channel enters the list
		// already-live so updateChannelStatus never needs to buffer it.
		// Also asserts pendingStatuses is purged after handleChannelCreated so a
		// stale buffered entry cannot resurrect a later dead channel (M1 guard).
		stubEmpty();
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		// Simulate CHANNEL_STATE("live") arriving before the channel was loaded —
		// this buffers an entry in pendingStatuses.
		store.updateChannelStatus("ch-new", "live");

		// Now the channel materialises via CHANNEL_CREATED.
		store.handleChannelCreated(makeCreatedMsg());

		const ch = store.channels.find((c) => c.id === "ch-new");
		expect(ch).toBeDefined();
		expect(ch?.status).toBe("live");

		// The channel then dies on the server.  fetchChannels (same host, so
		// hostChanged===false → pendingStatuses NOT cleared automatically) returns
		// it as "dead".  The stale "live" buffer must NOT overwrite server-truth.
		mockFetch.mockImplementation((url: string) => {
			const body = url.includes("/api/groups")
				? []
				: [
						{
							id: "ch-new",
							session_id: "sess-1",
							shell: "/bin/bash",
							cols: 80,
							rows: 24,
							status: "dead",
							created_at: "2026-01-01T00:00:00Z",
							updated_at: "2026-01-01T00:00:00Z",
						},
					];
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		});
		await store.fetchChannels("host-1");

		const chAfter = store.channels.find((c) => c.id === "ch-new");
		expect(chAfter?.status).toBe("dead");
	});

	it("is host-scoped: ignores CHANNEL_CREATED for a host the client is not viewing", async () => {
		stubEmpty();
		const store = useChannelsStore();
		// Client is viewing host-1
		await store.fetchChannels("host-1");

		// Message is for host-2 — must be ignored
		store.handleChannelCreated(makeCreatedMsg({ hostId: "host-2" }));

		expect(store.channels).toHaveLength(0);
	});

	it("deduplicates: no-op if the channel is already present (spawning client race)", async () => {
		mockFetch.mockImplementation((url: string) => {
			const body = url.includes("/api/groups")
				? []
				: [
						{
							id: "ch-new",
							session_id: "sess-1",
							shell: "/bin/bash",
							cols: 80,
							rows: 24,
							status: "live",
							created_at: "2026-01-01T00:00:00Z",
							updated_at: "2026-01-01T00:00:00Z",
						},
					];
			return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
		});

		const store = useChannelsStore();
		// fetchChannels already populated ch-new (spawning client path)
		await store.fetchChannels("host-1");
		expect(store.channels).toHaveLength(1);

		// CHANNEL_CREATED arrives (broadcast catches up) — must NOT duplicate
		store.handleChannelCreated(makeCreatedMsg());

		expect(store.channels).toHaveLength(1);
	});

	it("tracks channelId → hostId in channelHostMap", async () => {
		stubEmpty();
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		store.handleChannelCreated(makeCreatedMsg());

		expect(store.channelHostMap.get("ch-new")).toBe("host-1");
	});

	it("forwards optional fields (args, cwd) when present", async () => {
		stubEmpty();
		const store = useChannelsStore();
		await store.fetchChannels("host-1");

		store.handleChannelCreated(
			makeCreatedMsg({ args: ["-l"], cwd: "/home/user", channelId: "ch-args" }),
		);

		const ch = store.channels.find((c) => c.id === "ch-args");
		expect(ch?.args).toEqual(["-l"]);
		expect(ch?.cwd).toBe("/home/user");
	});
});

// ---------------------------------------------------------------------------
// M1 full race: CHANNEL_STATE buffered → CHANNEL_CREATED → dead → fetchChannels
// ---------------------------------------------------------------------------

describe("useChannelsStore — M1: stale pendingStatuses cannot resurrect a dead channel", () => {
	function makeChannelRow(
		id: string,
		status: "live" | "dead" | "connecting" = "live",
	): Record<string, unknown> {
		return {
			id,
			session_id: "sess-1",
			shell: "/bin/bash",
			cols: 80,
			rows: 24,
			status,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		};
	}

	it(
		"CHANNEL_STATE(live) buffered before CHANNEL_CREATED — after channel dies, " +
			"same-host fetchChannels returns dead — channel must stay dead (purge mutation catch)",
		async () => {
			// Step 1: channels empty, CHANNEL_STATE("live") arrives → buffered in pendingStatuses.
			mockFetch.mockImplementation((url: string) => {
				const body = url.includes("/api/groups") ? [] : [];
				return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			});
			const store = useChannelsStore();
			await store.fetchChannels("host-1");
			// Buffer a "live" status before the channel exists.
			store.updateChannelStatus("ch-m1", "live");

			// Step 2: CHANNEL_CREATED arrives — channel materialises.
			store.handleChannelCreated(makeCreatedMsg({ channelId: "ch-m1", status: "live" }));
			expect(store.channels.find((c) => c.id === "ch-m1")?.status).toBe("live");

			// Step 3: server reports channel as dead.
			// Same host (host-1) → hostChanged===false → pendingStatuses NOT cleared automatically.
			// The handleChannelCreated purge MUST have removed the "live" entry so that
			// fetchChannels now surfaces server-truth ("dead") without overwrite.
			mockFetch.mockImplementation((url: string) => {
				const body = url.includes("/api/groups") ? [] : [makeChannelRow("ch-m1", "dead")];
				return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
			});
			await store.fetchChannels("host-1");

			const ch = store.channels.find((c) => c.id === "ch-m1");
			expect(ch?.status).toBe("dead");
			// Verify by running a second same-host fetch (still returns dead) — if
			// the buffered entry had survived the purge, it would flip status to "live".
			await store.fetchChannels("host-1");
			expect(store.channels.find((c) => c.id === "ch-m1")?.status).toBe("dead");
		},
	);
});

// ---------------------------------------------------------------------------
// F1: stale group-fetch race — generation guard must cover groups.value
// ---------------------------------------------------------------------------

describe("useChannelsStore — F1: stale fetchChannels must not overwrite newer generation groups", () => {
	function _stubControlledFetch(opts: {
		groupsForFirst: Record<string, unknown>[];
		groupsForSecond: Record<string, unknown>[];
	}): {
		resolveFirstChannels: () => void;
		resolveSecondChannels: () => void;
	} {
		let resolveFirstChannels!: () => void;
		let resolveSecondChannels!: () => void;
		let callCount = 0;

		const firstChannelsDone = new Promise<void>((r) => {
			resolveFirstChannels = r;
		});
		const secondChannelsDone = new Promise<void>((r) => {
			resolveSecondChannels = r;
		});

		mockFetch.mockImplementation(async (url: string) => {
			const isGroups = (url as string).includes("/api/groups");
			if (isGroups) {
				// First call returns first groups, second call returns second groups.
				callCount++;
				const groups = callCount === 1 ? opts.groupsForFirst : opts.groupsForSecond;
				return { ok: true, json: () => Promise.resolve(groups) };
			}
			// Channels: first fetch is held, second resolves immediately.
			if (callCount <= 1) {
				// First channels fetch — held until released
				await firstChannelsDone;
			} else {
				await secondChannelsDone;
			}
			return { ok: true, json: () => Promise.resolve([]) };
		});

		return { resolveFirstChannels, resolveSecondChannels };
	}

	it("stale (older-generation) fetch resolving last must NOT overwrite newer generation groups", async () => {
		// Arrange two fetch invocations:
		//   - fetch-1 (gen=1): slow, carries "OldGroup" groups
		//   - fetch-2 (gen=2): fast, carries "NewGroup" groups; resolves first
		//
		// Mutation caught: committing groups.value inside _fetchGroupsRaw (before
		// the generation guard) would let fetch-1's stale groups clobber fetch-2's.

		let resolveFirst!: () => void;
		let resolveSecond!: () => void;

		const firstChannelsDone = new Promise<void>((r) => {
			resolveFirst = r;
		});
		const secondChannelsDone = new Promise<void>((r) => {
			resolveSecond = r;
		});

		const groupsForGen1 = [makeGroupRow("g-stale", "OldGroup")];
		const groupsForGen2 = [makeGroupRow("g-fresh", "NewGroup")];

		// Track which generation the groups fetch belongs to via call order.
		let groupsFetchCount = 0;
		let channelsFetchCount = 0;

		mockFetch.mockImplementation(async (url: string) => {
			const isGroups = (url as string).includes("/api/groups");
			if (isGroups) {
				groupsFetchCount++;
				const thisGen = groupsFetchCount;
				const groups = thisGen === 1 ? groupsForGen1 : groupsForGen2;
				return { ok: true, json: () => Promise.resolve(groups) };
			}
			// Channels fetches: gen-1 is HELD, gen-2 resolves immediately then gen-1 resolves late.
			channelsFetchCount++;
			const thisCall = channelsFetchCount;
			if (thisCall === 1) {
				// gen-1 channels — hold until told to release
				await firstChannelsDone;
			} else {
				// gen-2 channels — resolve immediately then release gen-1 after
				await secondChannelsDone;
			}
			return { ok: true, json: () => Promise.resolve([]) };
		});

		const store = useChannelsStore();

		// Start fetch-1 (gen=1) — it will hang waiting for channels.
		const fetch1Promise = store.fetchChannels("host-1");

		// Start fetch-2 (gen=2) immediately — groups resolve fast, channels resolve fast.
		// fetch-2 must win and set groups to NewGroup.
		const fetch2Promise = store.fetchChannels("host-1");

		// Let gen-2 complete first.
		resolveSecond();
		await fetch2Promise;

		// At this point the store should reflect gen-2 groups.
		expect(store.groups.map((g) => g.id)).toContain("g-fresh");
		expect(store.groups.map((g) => g.id)).not.toContain("g-stale");

		// Now release gen-1's channel fetch — it resolves LATE with OldGroup groups.
		// The generation guard MUST discard it; groups.value must remain "NewGroup".
		resolveFirst();
		await fetch1Promise;

		expect(store.groups.map((g) => g.id)).not.toContain("g-stale");
		expect(store.groups.map((g) => g.id)).toContain("g-fresh");
	});
});

// ---------------------------------------------------------------------------
// M2 race: CHANNEL_CREATED during in-flight fetchChannels
// ---------------------------------------------------------------------------

describe("useChannelsStore — M2: WS-added channel preserved when fetchChannels resolves", () => {
	it(
		"channel added by handleChannelCreated while fetchChannels is in-flight — " +
			"resolve with data lacking that channel — WS-added channel must still be present " +
			"(mutation catch: blindly setting channels.value=data on resolve)",
		async () => {
			// Controlled promise to pause the REST response mid-flight.
			let resolveChannels!: (v: unknown) => void;
			const channelsPromise = new Promise((r) => {
				resolveChannels = r;
			});

			mockFetch.mockImplementation((url: string) => {
				if (url.includes("/api/groups")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				// Channels response is held — snapshot was taken BEFORE ch-ws existed.
				return channelsPromise.then(() => ({
					ok: true,
					json: () => Promise.resolve([]),
				}));
			});

			const store = useChannelsStore();
			const fetchPromise = store.fetchChannels("host-1");

			// CHANNEL_CREATED arrives while the REST request is still in-flight.
			store.handleChannelCreated(makeCreatedMsg({ channelId: "ch-ws", status: "live" }));

			// Verify it was added to channels immediately.
			expect(store.channels.find((c) => c.id === "ch-ws")).toBeDefined();

			// Now resolve the fetch with a server snapshot that LACKS ch-ws
			// (it was created AFTER the REST snapshot was taken).
			resolveChannels(undefined);
			await fetchPromise;

			// ch-ws must still be present — the WS event is the authority for
			// channels created after the REST snapshot.
			expect(store.channels.find((c) => c.id === "ch-ws")).toBeDefined();
			expect(store.channels.find((c) => c.id === "ch-ws")?.status).toBe("live");
		},
	);
});

// ---------------------------------------------------------------------------
// G1 holistic-guard: post-JSON race — stale fetch resolving after json() parse
// ---------------------------------------------------------------------------

describe("useChannelsStore — G1: stale fetch resolving after channelsRes.json() must not commit", () => {
	it(
		"post-JSON race: gen-N json() resolves after gen-N+1 committed " +
			"— channels.value must reflect gen-N+1, NOT gen-N " +
			"(mutation caught: committing channels.value before the single post-await guard)",
		async () => {
			// Controlled teardown: gen-1 (host-A) is held until after gen-2 (host-B) commits.
			// After gen-2 commits, gen-1's json() resolves — the guard must discard it.
			let resolveHostAJson!: () => void;
			const hostAJsonReady = new Promise<void>((r) => {
				resolveHostAJson = r;
			});

			function makeRow(id: string): Record<string, unknown> {
				return {
					id,
					session_id: "sess-1",
					shell: "/bin/bash",
					cols: 80,
					rows: 24,
					status: "live",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				};
			}

			// Track which channels call this is (1=host-A fetch, 2=host-B fetch).
			let channelsFetchCount = 0;

			mockFetch.mockImplementation((url: string) => {
				if ((url as string).includes("/api/groups")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				channelsFetchCount++;
				const call = channelsFetchCount;
				if (call === 1) {
					// host-A fetch: Response resolves immediately but json() is held.
					return Promise.resolve({
						ok: true,
						json: () => hostAJsonReady.then(() => [makeRow("ch-host-a")]),
					});
				}
				// host-B fetch: resolves fully immediately.
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve([makeRow("ch-host-b")]),
				});
			});

			const store = useChannelsStore();

			// Start gen-1 (host-A) — its json() is held.
			const fetchA = store.fetchChannels("host-a");

			// Start gen-2 (host-B) — it will fully resolve (new host, channels cleared).
			await store.fetchChannels("host-b");

			// Gen-2 has committed — channels.value must be host-B's list.
			expect(store.channels.map((c) => c.id)).toContain("ch-host-b");
			expect(store.channels.map((c) => c.id)).not.toContain("ch-host-a");

			// Now unblock gen-1's json() — the single post-await guard must discard it.
			resolveHostAJson();
			await fetchA;

			// channels.value must still reflect gen-2 (host-B), NOT overwritten by gen-1.
			expect(store.channels.map((c) => c.id)).toContain("ch-host-b");
			expect(store.channels.map((c) => c.id)).not.toContain("ch-host-a");
		},
	);
});

// ---------------------------------------------------------------------------
// G2 holistic-guard: error-clobber race — stale failed fetch must not clear
//                    a newer generation's (null) error state
// ---------------------------------------------------------------------------

describe("useChannelsStore — G2: stale failed fetch must not clobber newer generation error=null", () => {
	it(
		"error clobber: gen-N+1 succeeds (error stays null); gen-N fails afterward " +
			"— error.value must remain null " +
			"(mutation caught: assigning error.value in catch without generation guard)",
		async () => {
			// gen-1 starts first; its json() is held so it resolves AFTER gen-2.
			// gen-2 starts second; it fails immediately (network error).
			// gen-3 starts third; it succeeds and clears error.
			// Then gen-1's failure resolves — the guarded catch must NOT re-set error.

			// Simpler scenario that directly tests the catch guard:
			// gen-1: response ok but json() is held → will fail with a thrown error later
			// gen-2: succeeds fully → error.value = null

			let _resolveGen1Json!: (v: unknown) => void;
			let rejectGen1Json!: (reason: unknown) => void;
			const gen1JsonPromise = new Promise<unknown>((res, rej) => {
				_resolveGen1Json = res;
				rejectGen1Json = rej;
			});

			function makeRow(id: string): Record<string, unknown> {
				return {
					id,
					session_id: "sess-1",
					shell: "/bin/bash",
					cols: 80,
					rows: 24,
					status: "live",
					created_at: "2026-01-01T00:00:00Z",
					updated_at: "2026-01-01T00:00:00Z",
				};
			}

			let channelsFetchCount = 0;
			mockFetch.mockImplementation((url: string) => {
				if ((url as string).includes("/api/groups")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				channelsFetchCount++;
				const call = channelsFetchCount;
				if (call === 1) {
					// gen-1 Response is fine but json() is controlled (will be rejected).
					return Promise.resolve({
						ok: true,
						json: () => gen1JsonPromise,
					});
				}
				// gen-2+: immediately succeeds with a channel.
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve([makeRow("ch-gen2")]),
				});
			});

			const store = useChannelsStore();

			// Start gen-1 — its json() is held.
			const fetchGen1 = store.fetchChannels("host-1");

			// Start gen-2 (same host) — it fully succeeds.
			await store.fetchChannels("host-1");

			// Gen-2 succeeded → error must be null.
			expect(store.error).toBeNull();
			expect(store.channels.map((c) => c.id)).toContain("ch-gen2");

			// Now make gen-1's json() throw — it's a stale fetch.
			// The guarded catch must NOT assign error.value for the stale generation.
			rejectGen1Json(new Error("stale-network-failure"));
			await fetchGen1;

			// error.value must still be null — gen-2 succeeded, gen-1's failure is stale.
			expect(store.error).toBeNull();
		},
	);
});

// ---------------------------------------------------------------------------
// G3 holistic-guard: loading lifecycle — stale fetch must not flip loading
// ---------------------------------------------------------------------------

describe("useChannelsStore — G3: stale fetch finally must not flip loading for current generation", () => {
	it(
		"loading lifecycle: stale gen-N finishing after gen-N+1 must not set loading=false " +
			"for the current generation if it is still in-flight " +
			"(mutation caught: unconditional loading.value=false in finally)",
		async () => {
			// gen-1: slow json() — resolves after gen-2 is in-flight.
			// gen-2: slow json() too — we observe loading stays true while gen-2 is pending.

			let resolveGen1Json!: () => void;
			let resolveGen2Json!: () => void;

			const gen1JsonReady = new Promise<void>((r) => {
				resolveGen1Json = r;
			});
			const gen2JsonReady = new Promise<void>((r) => {
				resolveGen2Json = r;
			});

			let channelsFetchCount = 0;
			mockFetch.mockImplementation((url: string) => {
				if ((url as string).includes("/api/groups")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
				}
				channelsFetchCount++;
				const call = channelsFetchCount;
				if (call === 1) {
					return Promise.resolve({ ok: true, json: () => gen1JsonReady.then(() => []) });
				}
				return Promise.resolve({ ok: true, json: () => gen2JsonReady.then(() => []) });
			});

			const store = useChannelsStore();

			// Start gen-1 — it will be superseded.
			const fetchGen1 = store.fetchChannels("host-1");
			expect(store.loading).toBe(true);

			// Start gen-2 — supersedes gen-1.
			const fetchGen2 = store.fetchChannels("host-1");
			expect(store.loading).toBe(true);

			// Release gen-1 first — its finally must NOT flip loading=false because
			// gen-2 is still in-flight and gen-2 is the current generation.
			resolveGen1Json();
			await fetchGen1;

			// gen-2 is still pending — loading must still be true.
			expect(store.loading).toBe(true);

			// Now finish gen-2 — loading can become false.
			resolveGen2Json();
			await fetchGen2;

			expect(store.loading).toBe(false);
		},
	);
});
