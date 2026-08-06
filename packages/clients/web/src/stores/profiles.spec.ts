import type { LaunchProfile } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProfilesStore } from "./profiles.js";

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

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
	return {
		id: "profile-1",
		name: "Zsh",
		shell: "/bin/zsh",
		args: [],
		mode: "shell",
		elevated: false,
		supportedOs: "any",
		iconType: "emoji",
		iconValue: "🐚",
		sortOrder: 0,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeJsonResponse(data: unknown, ok = true): Response {
	return {
		ok,
		status: ok ? 200 : 500,
		json: () => Promise.resolve(data),
	} as unknown as Response;
}

// ---------------------------------------------------------------------------
// Mock WsClient — minimal send-capture
// ---------------------------------------------------------------------------

type SentMessage = Record<string, unknown>;

class MockWsClient {
	sent: SentMessage[] = [];
	send(msg: SentMessage): void {
		this.sent.push(msg);
	}
	on(): () => void {
		return () => {};
	}
	get isConnected(): boolean {
		return true;
	}
	close(): void {}
	onDisconnect(): () => void {
		return () => {};
	}
	onReconnect(): () => void {
		return () => {};
	}
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
	localStorageMap.clear();
	mockFetch.mockReset();
	setActivePinia(createPinia());
	// Seed auth token (TOKEN_KEY = "lasterm_token")
	localStorageMap.set("lasterm_token", "test-token");
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fetchProfiles
// ---------------------------------------------------------------------------

describe("useProfilesStore — fetchProfiles", () => {
	it("populates profiles from API response", async () => {
		const p1 = makeProfile({ id: "p1", name: "Zsh" });
		const p2 = makeProfile({ id: "p2", name: "Fish" });
		mockFetch.mockResolvedValueOnce(makeJsonResponse([p1, p2]));

		const store = useProfilesStore();
		await store.fetchProfiles();

		expect(store.profiles).toHaveLength(2);
		expect(store.profiles[0]?.id).toBe("p1");
		expect(store.profiles[1]?.id).toBe("p2");
	});

	it("sends Bearer token in Authorization header", async () => {
		mockFetch.mockResolvedValueOnce(makeJsonResponse([]));

		const store = useProfilesStore();
		await store.fetchProfiles();

		expect(mockFetch).toHaveBeenCalledWith("/api/launch-profiles", {
			headers: { Authorization: "Bearer test-token" },
		});
	});

	it("sets loading to false after successful fetch", async () => {
		mockFetch.mockResolvedValueOnce(makeJsonResponse([]));
		const store = useProfilesStore();
		await store.fetchProfiles();
		expect(store.loading).toBe(false);
	});

	it("sets loading to false even if fetch throws", async () => {
		mockFetch.mockResolvedValueOnce(makeJsonResponse(null, false));
		const store = useProfilesStore();
		await expect(store.fetchProfiles()).rejects.toThrow();
		expect(store.loading).toBe(false);
	});

	it("does nothing when not authenticated", async () => {
		localStorageMap.delete("lasterm_token");
		const store = useProfilesStore();
		await store.fetchProfiles();
		expect(mockFetch).not.toHaveBeenCalled();
		expect(store.profiles).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// fetchHostProfiles
// ---------------------------------------------------------------------------

describe("useProfilesStore — fetchHostProfiles", () => {
	it("fetches profiles filtered for a specific host", async () => {
		const p = makeProfile({ id: "p1" });
		mockFetch.mockResolvedValueOnce(makeJsonResponse([p]));

		const store = useProfilesStore();
		const result = await store.fetchHostProfiles("host-1");

		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe("p1");
		expect(mockFetch).toHaveBeenCalledWith("/api/hosts/host-1/profiles", expect.any(Object));
	});

	it("returns [] when not authenticated", async () => {
		localStorageMap.delete("lasterm_token");
		const store = useProfilesStore();
		const result = await store.fetchHostProfiles("host-1");
		expect(result).toEqual([]);
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// spawnFromProfile — SC-12
// ---------------------------------------------------------------------------

describe("useProfilesStore — spawnFromProfile", () => {
	it("sends SPAWN with launchProfileId when host is active", async () => {
		// Set up channels store with an active host
		const { useChannelsStore } = await import("./channels.js");
		const { useSessionStore } = await import("./session.js");
		const channelsStore = useChannelsStore();
		channelsStore.activeHostId = "host-1";

		// Patch the wsClient on the session store
		const sessionStore = useSessionStore();
		const mockWsClient = new MockWsClient();
		// @ts-expect-error — replace markRaw wsClient for test
		sessionStore.wsClient = mockWsClient;

		const store = useProfilesStore();
		store.spawnFromProfile("profile-abc");

		expect(mockWsClient.sent).toHaveLength(1);
		expect(mockWsClient.sent[0]).toMatchObject({
			type: "SPAWN",
			hostId: "host-1",
			launchProfileId: "profile-abc",
		});
	});

	it("does nothing when no active host", async () => {
		const { useChannelsStore } = await import("./channels.js");
		const { useSessionStore } = await import("./session.js");
		const channelsStore = useChannelsStore();
		channelsStore.activeHostId = null;

		const sessionStore = useSessionStore();
		const mockWsClient = new MockWsClient();
		// @ts-expect-error — replace markRaw wsClient for test
		sessionStore.wsClient = mockWsClient;

		const store = useProfilesStore();
		store.spawnFromProfile("profile-abc");

		expect(mockWsClient.sent).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// spawnQuickCommand — SC-27, SC-29
// ---------------------------------------------------------------------------

describe("useProfilesStore — spawnQuickCommand", () => {
	async function setupWithActiveHost() {
		const { useChannelsStore } = await import("./channels.js");
		const { useSessionStore } = await import("./session.js");
		const channelsStore = useChannelsStore();
		channelsStore.activeHostId = "host-1";

		const sessionStore = useSessionStore();
		const mockWsClient = new MockWsClient();
		// @ts-expect-error — replace markRaw wsClient for test
		sessionStore.wsClient = mockWsClient;

		return { channelsStore, sessionStore, mockWsClient };
	}

	it("parses single command into shell with directProcess=true (SC-27)", async () => {
		const { mockWsClient } = await setupWithActiveHost();
		const store = useProfilesStore();
		store.spawnQuickCommand("htop");

		expect(mockWsClient.sent).toHaveLength(1);
		expect(mockWsClient.sent[0]).toMatchObject({
			type: "SPAWN",
			hostId: "host-1",
			shell: "htop",
			directProcess: true,
		});
		expect((mockWsClient.sent[0] as Record<string, unknown>).args).toBeUndefined();
	});

	it("parses command with args into shell + args with directProcess=true", async () => {
		const { mockWsClient } = await setupWithActiveHost();
		const store = useProfilesStore();
		store.spawnQuickCommand("python3 -m http.server 8080");

		expect(mockWsClient.sent[0]).toMatchObject({
			type: "SPAWN",
			hostId: "host-1",
			shell: "python3",
			args: ["-m", "http.server", "8080"],
			directProcess: true,
		});
	});

	it("trims whitespace before parsing", async () => {
		const { mockWsClient } = await setupWithActiveHost();
		const store = useProfilesStore();
		store.spawnQuickCommand("  node server.js  ");

		expect(mockWsClient.sent[0]).toMatchObject({
			shell: "node",
			args: ["server.js"],
		});
	});

	it("is a no-op for empty input (SC-29)", async () => {
		const { mockWsClient } = await setupWithActiveHost();
		const store = useProfilesStore();
		store.spawnQuickCommand("");

		expect(mockWsClient.sent).toHaveLength(0);
	});

	it("is a no-op for whitespace-only input (SC-29)", async () => {
		const { mockWsClient } = await setupWithActiveHost();
		const store = useProfilesStore();
		store.spawnQuickCommand("   ");

		expect(mockWsClient.sent).toHaveLength(0);
	});

	it("does nothing when no active host", async () => {
		const { useChannelsStore } = await import("./channels.js");
		const { useSessionStore } = await import("./session.js");
		const channelsStore = useChannelsStore();
		channelsStore.activeHostId = null;
		const sessionStore = useSessionStore();
		const mockWsClient = new MockWsClient();
		// @ts-expect-error — replace markRaw wsClient for test
		sessionStore.wsClient = mockWsClient;

		const store = useProfilesStore();
		store.spawnQuickCommand("htop");

		expect(mockWsClient.sent).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// createProfile
// ---------------------------------------------------------------------------

describe("useProfilesStore — createProfile", () => {
	it("appends newly created profile to profiles list", async () => {
		const created = makeProfile({ id: "new-p" });
		mockFetch.mockResolvedValueOnce(makeJsonResponse(created));

		const store = useProfilesStore();
		const result = await store.createProfile({ name: "New" });

		expect(result.id).toBe("new-p");
		expect(store.profiles).toContainEqual(created);
	});
});

// ---------------------------------------------------------------------------
// deleteProfile
// ---------------------------------------------------------------------------

describe("useProfilesStore — deleteProfile", () => {
	it("removes deleted profile from profiles list", async () => {
		const p = makeProfile({ id: "del-p" });
		// Seed store
		const store = useProfilesStore();
		store.profiles.push(p);

		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(null),
		} as unknown as Response);
		await store.deleteProfile("del-p");

		expect(store.profiles.find((x) => x.id === "del-p")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// F-003: HTTP method correctness
// ---------------------------------------------------------------------------

describe("useProfilesStore — HTTP method correctness (F-003)", () => {
	it("updateProfile uses PUT (not PATCH)", async () => {
		const updated = makeProfile({ id: "p1", name: "Updated" });
		mockFetch.mockResolvedValueOnce(makeJsonResponse(updated));

		const store = useProfilesStore();
		await store.updateProfile("p1", { name: "Updated" });

		const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(options.method).toBe("PUT");
		expect(mockFetch).toHaveBeenCalledWith(
			"/api/launch-profiles/p1",
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("reorderProfiles uses PUT /api/launch-profiles/order", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve(null),
		} as unknown as Response);

		const store = useProfilesStore();
		await store.reorderProfiles(["p1", "p2"]);

		const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/launch-profiles/order");
		expect(options.method).toBe("PUT");
	});
});

// ---------------------------------------------------------------------------
// F-009: toCamelCase applied to API responses
// ---------------------------------------------------------------------------

describe("useProfilesStore — toCamelCase conversion (F-009)", () => {
	it("fetchProfiles converts snake_case API response to camelCase", async () => {
		// Simulate snake_case response from hub API
		const snakeResponse = [
			{
				id: "p1",
				name: "Zsh",
				shell: "/bin/zsh",
				args: [],
				mode: "shell",
				elevated: false,
				supported_os: "linux",
				icon_type: "emoji",
				icon_value: "🐚",
				sort_order: 0,
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T00:00:00Z",
			},
		];
		mockFetch.mockResolvedValueOnce(makeJsonResponse(snakeResponse));

		const store = useProfilesStore();
		await store.fetchProfiles();

		expect(store.profiles).toHaveLength(1);
		// camelCase fields must be present
		expect(store.profiles[0]?.supportedOs).toBe("linux");
		expect(store.profiles[0]?.iconType).toBe("emoji");
		expect(store.profiles[0]?.iconValue).toBe("🐚");
		expect(store.profiles[0]?.sortOrder).toBe(0);
		expect(store.profiles[0]?.createdAt).toBe("2026-01-01T00:00:00Z");
	});

	it("createProfile converts snake_case API response to camelCase", async () => {
		const snakeResponse = {
			id: "new-p",
			name: "Fish",
			shell: "/usr/bin/fish",
			args: [],
			mode: "shell",
			elevated: false,
			supported_os: "any",
			icon_type: "auto",
			icon_value: "",
			sort_order: 1,
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		};
		mockFetch.mockResolvedValueOnce(makeJsonResponse(snakeResponse));

		const store = useProfilesStore();
		const result = await store.createProfile({ name: "Fish" });

		expect(result.id).toBe("new-p");
		expect(result.supportedOs).toBe("any");
		expect(result.iconType).toBe("auto");
		expect(result.sortOrder).toBe(1);
	});
});
