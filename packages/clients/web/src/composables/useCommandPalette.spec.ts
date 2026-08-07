import type { Host, LaunchProfile } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useProfilesStore } from "../stores/profiles.js";
import { fuzzyMatch, useCommandPalette } from "./useCommandPalette.js";

vi.hoisted(() => {
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storage.set(key, value);
		},
		removeItem: (key: string) => {
			storage.delete(key);
		},
		clear: () => {
			storage.clear();
		},
		get length() {
			return storage.size;
		},
		key: (index: number) => [...storage.keys()][index] ?? null,
	});
});

/**
 * Mock useLayout — useCommandPalette depends on it but we only need stub values.
 * The module-level mock must come before importing the composable via vitest hoisting.
 */
vi.mock("./useLayout.js", () => ({
	useLayout: () => ({
		activeTab: { value: null },
		tabs: { value: [] },
		closeTab: vi.fn(),
		splitPane: vi.fn(),
	}),
}));

/**
 * Mock useSessionStore to avoid WS dependency in unit tests.
 */
vi.mock("../stores/session.js", () => ({
	useSessionStore: () => ({
		wsClient: { send: vi.fn(), on: vi.fn().mockReturnValue(vi.fn()) },
	}),
}));

/**
 * Mock useRecentPaletteItems — avoids localStorage side-effects in tests.
 * Shared spies so the test file and the composable see the same functions.
 */
const mockPushRecent = vi.fn();
const mockClearRecent = vi.fn();

vi.mock("./useRecentPaletteItems.js", async () => {
	const { ref } = await import("vue");
	const recentIds = ref<string[]>([]);
	return {
		useRecentPaletteItems: () => ({
			recentIds,
			pushRecent: mockPushRecent,
			clearRecent: mockClearRecent,
		}),
	};
});

function makeProfile(id: string, name: string, shell = "/bin/bash"): LaunchProfile {
	return {
		id,
		name,
		shell,
		mode: "shell",
		elevated: false,
		supportedOs: "any",
		iconType: "auto",
		sortOrder: 0,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
	};
}

function makeHost(id: string, label: string): Host {
	return {
		id,
		label,
		type: "ssh",
		sshHost: "example.com",
		sshPort: 22,
		iconType: "auto",
		trustRemoteHints: "apply",
		sortOrder: 0,
		keepAliveSeconds: 0,
		historyRetentionDays: 30,
		os: null,
		arch: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
	};
}

describe("useCommandPalette", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
	});

	describe("open / close / toggle", () => {
		it("starts closed", () => {
			const palette = useCommandPalette();
			expect(palette.isOpen.value).toBe(false);
		});

		it("open() sets isOpen to true and resets query", () => {
			const palette = useCommandPalette();
			palette.search("stale");
			palette.open();
			expect(palette.isOpen.value).toBe(true);
			expect(palette.query.value).toBe("");
			expect(palette.selectedIndex.value).toBe(0);
		});

		it("close() sets isOpen to false and resets query", () => {
			const palette = useCommandPalette();
			palette.open();
			palette.search("something");
			palette.close();
			expect(palette.isOpen.value).toBe(false);
			expect(palette.query.value).toBe("");
		});

		it("toggle() flips isOpen state", () => {
			const palette = useCommandPalette();
			palette.toggle();
			expect(palette.isOpen.value).toBe(true);
			palette.toggle();
			expect(palette.isOpen.value).toBe(false);
		});
	});

	describe("search / results filtering", () => {
		it("returns all items when query is empty", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [makeHost("h1", "Production"), makeHost("h2", "Staging")];

			const palette = useCommandPalette();
			// Empty query — should include hosts + builtin actions
			const results = palette.results.value;
			const hostResults = results.filter((r) => r.type === "host");
			const actionResults = results.filter((r) => r.type === "action");
			expect(hostResults).toHaveLength(2);
			expect(actionResults.length).toBeGreaterThanOrEqual(4); // New Channel, Split Right, Split Down, Close Tab, ...
		});

		it("filters hosts by label (case-insensitive)", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [
				makeHost("h1", "Production"),
				makeHost("h2", "Staging"),
				makeHost("h3", "Dev Proxy"),
			];

			const palette = useCommandPalette();
			palette.search("prod");

			const hostResults = palette.results.value.filter((r) => r.type === "host");
			expect(hostResults).toHaveLength(1);
			expect(hostResults[0]?.label).toBe("Production");
		});

		it("filters channels by title (case-insensitive)", () => {
			const channelsStore = useChannelsStore();
			channelsStore.channels = [
				{
					id: "c1",
					sessionId: "s1",
					shell: "/bin/bash",
					cols: 80,
					rows: 24,
					status: "live",
					title: "Build Runner",
					createdAt: "2025-01-01T00:00:00Z",
					updatedAt: "2025-01-01T00:00:00Z",
				},
				{
					id: "c2",
					sessionId: "s1",
					shell: "/bin/bash",
					cols: 80,
					rows: 24,
					status: "live",
					title: "Log Tail",
					createdAt: "2025-01-01T00:00:00Z",
					updatedAt: "2025-01-01T00:00:00Z",
				},
			];

			const palette = useCommandPalette();
			palette.search("build");

			const channelResults = palette.results.value.filter((r) => r.type === "channel");
			expect(channelResults).toHaveLength(1);
			expect(channelResults[0]?.label).toBe("Build Runner");
		});

		it("filters builtin actions by label", () => {
			const palette = useCommandPalette();
			palette.search("split");

			const actionResults = palette.results.value.filter((r) => r.type === "action");
			expect(actionResults).toHaveLength(2); // Split Right + Split Down
		});

		it("returns empty results when no items match", () => {
			const palette = useCommandPalette();
			palette.search("zzz-no-match-zzz");
			expect(palette.results.value).toHaveLength(0);
		});

		it("trims and lowercases the query before matching", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [makeHost("h1", "Production")];

			const palette = useCommandPalette();
			palette.search("  PRODUCTION  ");

			const hostResults = palette.results.value.filter((r) => r.type === "host");
			expect(hostResults).toHaveLength(1);
		});
	});

	describe("navigation", () => {
		it("search() resets selectedIndex to 0", () => {
			const palette = useCommandPalette();
			palette.open();
			// Move selection down then search to verify reset
			palette.moveDown();
			palette.search("new");
			expect(palette.selectedIndex.value).toBe(0);
		});

		it("moveDown wraps around to the beginning", () => {
			const palette = useCommandPalette();
			palette.search("split"); // 2 results: Split Right + Split Down
			const count = palette.results.value.length;
			expect(count).toBe(2);

			palette.moveDown(); // index 1
			palette.moveDown(); // wraps to 0
			expect(palette.selectedIndex.value).toBe(0);
		});

		it("moveUp wraps around to the end", () => {
			const palette = useCommandPalette();
			palette.search("split"); // 2 results
			const count = palette.results.value.length;
			expect(count).toBe(2);

			// selectedIndex starts at 0, moveUp wraps to last
			palette.moveUp();
			expect(palette.selectedIndex.value).toBe(count - 1);
		});

		it("moveDown is a no-op when results are empty", () => {
			const palette = useCommandPalette();
			palette.search("zzz-no-match-zzz");
			palette.moveDown();
			expect(palette.selectedIndex.value).toBe(0);
		});

		it("moveUp is a no-op when results are empty", () => {
			const palette = useCommandPalette();
			palette.search("zzz-no-match-zzz");
			palette.moveUp();
			expect(palette.selectedIndex.value).toBe(0);
		});
	});

	describe("execute", () => {
		it("execute() closes the palette", () => {
			const palette = useCommandPalette();
			palette.open();
			palette.execute({
				id: "host:h1",
				label: "Test",
				type: "host",
				icon: "X",
				payload: "h1",
			});
			expect(palette.isOpen.value).toBe(false);
		});

		it("executeSelected() is a no-op when results are empty", () => {
			const palette = useCommandPalette();
			palette.search("zzz-no-match-zzz");
			// Should not throw
			palette.executeSelected();
			expect(palette.isOpen.value).toBe(false);
		});
	});

	describe("fuzzy matching (SC-15, INV-04, INV-08)", () => {
		it("prefix match ranks higher than substring", () => {
			// "prod" prefix-matches "prod-db", substring-matches "my-production"
			expect(fuzzyMatch("prod", "prod-db")).toBeGreaterThan(
				fuzzyMatch("prod", "my-production-server"),
			);
		});

		it("exact match has highest score", () => {
			expect(fuzzyMatch("test", "test")).toBeGreaterThan(fuzzyMatch("test", "testing"));
		});

		it("exact match score is highest tier", () => {
			expect(fuzzyMatch("test", "test")).toBeGreaterThan(fuzzyMatch("test", "test-runner"));
		});

		it("returns 0 for non-matching query", () => {
			expect(fuzzyMatch("prod", "dev-proxy")).toBe(0);
		});

		it("returns 0 for empty query", () => {
			expect(fuzzyMatch("", "anything")).toBe(0);
		});

		it("SC-19b: word boundary bonus — pds matches production-database-server", () => {
			expect(fuzzyMatch("pds", "production-database-server")).toBeGreaterThan(0);
		});

		it("SC-19b: word boundary match scores higher than mid-word match", () => {
			// "pds" starting at word boundaries beats "pds" found mid-word
			const boundaryScore = fuzzyMatch("pds", "production-database-server");
			const midWordScore = fuzzyMatch("pds", "xproductionxdatabasexserver");
			expect(boundaryScore).toBeGreaterThan(midWordScore);
		});

		it("scores are deterministic (INV-04)", () => {
			const score1 = fuzzyMatch("prod", "production-db");
			const score2 = fuzzyMatch("prod", "production-db");
			expect(score1).toBe(score2);
		});

		it("case-insensitive matching", () => {
			expect(fuzzyMatch("PROD", "production")).toBeGreaterThan(0);
			expect(fuzzyMatch("prod", "PRODUCTION")).toBeGreaterThan(0);
		});
	});

	describe("prefix filters (SC-16, SC-17, SC-18, INV-06)", () => {
		it("@ prefix shows only hosts", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [makeHost("h1", "Production")];

			const palette = useCommandPalette();
			palette.search("@prod");
			const types = new Set(palette.results.value.map((r) => r.type));
			expect(types.has("host")).toBe(true);
			expect(types.has("action")).toBe(false);
			expect(types.has("channel")).toBe(false);
		});

		it("> prefix shows only actions", () => {
			const palette = useCommandPalette();
			palette.search(">split");
			const types = new Set(palette.results.value.map((r) => r.type));
			expect(types.has("action")).toBe(true);
			expect(types.has("host")).toBe(false);
			expect(types.has("channel")).toBe(false);
		});

		it("# prefix shows only channels", () => {
			const channelsStore = useChannelsStore();
			channelsStore.channels = [
				{
					id: "c1",
					sessionId: "s1",
					shell: "/bin/bash",
					cols: 80,
					rows: 24,
					status: "live",
					title: "Build Runner",
					createdAt: "2025-01-01T00:00:00Z",
					updatedAt: "2025-01-01T00:00:00Z",
				},
			];

			const palette = useCommandPalette();
			palette.search("#build");
			const types = new Set(palette.results.value.map((r) => r.type));
			expect(types.has("channel")).toBe(true);
			expect(types.has("host")).toBe(false);
			expect(types.has("action")).toBe(false);
		});

		it("SC-16b: @ prefix with empty query shows all hosts", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [makeHost("h1", "Alpha"), makeHost("h2", "Beta")];

			const palette = useCommandPalette();
			palette.search("@");
			expect(palette.results.value.length).toBe(2);
			expect(palette.results.value.every((r) => r.type === "host")).toBe(true);
		});

		it("SC-16b: > prefix with empty query shows all actions", () => {
			const palette = useCommandPalette();
			palette.search(">");
			expect(palette.results.value.length).toBeGreaterThanOrEqual(4);
			expect(palette.results.value.every((r) => r.type === "action")).toBe(true);
		});
	});

	describe("host search includes sshHost (SC-19)", () => {
		it("finds host by IP address in sshHost", () => {
			const hostsStore = useHostsStore();
			const h = makeHost("h1", "production");
			h.sshHost = "10.0.0.5";
			hostsStore.hosts = [h];

			const palette = useCommandPalette();
			palette.search("10.0.0");
			const hostResults = palette.results.value.filter((r) => r.type === "host");
			expect(hostResults).toHaveLength(1);
			expect(hostResults[0]?.label).toBe("production");
		});

		it("finds host by hostname in sshHost", () => {
			const hostsStore = useHostsStore();
			const h = makeHost("h1", "my-server");
			h.sshHost = "web.example.com";
			hostsStore.hosts = [h];

			const palette = useCommandPalette();
			palette.search("web.example");
			const hostResults = palette.results.value.filter((r) => r.type === "host");
			expect(hostResults).toHaveLength(1);
		});
	});

	describe("rich descriptions (SC-20)", () => {
		it("SSH host item has user@host description", () => {
			const hostsStore = useHostsStore();
			const h = makeHost("h1", "web");
			h.sshUser = "deploy";
			h.sshHost = "web.io";
			h.sshPort = 22;
			hostsStore.hosts = [h];

			const palette = useCommandPalette();
			palette.search("@web");
			const item = palette.results.value.find((r) => r.type === "host");
			expect(item?.description).toBe("deploy@web.io");
		});

		it("SSH host with non-standard port includes port in description", () => {
			const hostsStore = useHostsStore();
			const h = makeHost("h1", "web");
			h.sshUser = "admin";
			h.sshHost = "prod.example.com";
			h.sshPort = 2222;
			hostsStore.hosts = [h];

			const palette = useCommandPalette();
			palette.search("@");
			const item = palette.results.value.find((r) => r.type === "host");
			expect(item?.description).toBe("admin@prod.example.com:2222");
		});
	});

	describe("new actions (SC-22, SC-23)", () => {
		it("Add Host action exists", () => {
			const palette = useCommandPalette();
			palette.search(">add");
			expect(palette.results.value.some((r) => r.id === "action:add-host")).toBe(true);
		});

		it("Settings action exists", () => {
			const palette = useCommandPalette();
			palette.search(">settings");
			expect(palette.results.value.some((r) => r.id === "action:settings")).toBe(true);
		});

		it("Import SSH Config action exists", () => {
			const palette = useCommandPalette();
			palette.search(">import");
			expect(palette.results.value.some((r) => r.id === "action:ssh-import")).toBe(true);
		});

		it("Toggle Sidebar action exists", () => {
			const palette = useCommandPalette();
			palette.search(">sidebar");
			expect(palette.results.value.some((r) => r.id === "action:toggle-sidebar")).toBe(true);
		});

		it("unknown action invokes onExternalAction callback", () => {
			const palette = useCommandPalette();
			const handler = vi.fn();
			palette.onExternalAction.value = handler;
			palette.execute({ id: "action:add-host", label: "Add Host", type: "action", icon: "➕" });
			expect(handler).toHaveBeenCalledWith("action:add-host");
		});
	});

	describe("recent items integration (SC-21, SC-24)", () => {
		it("recentResults is empty when query is non-empty", () => {
			const palette = useCommandPalette();
			palette.search("split");
			expect(palette.recentResults.value).toEqual([]);
		});

		it("recentResults is empty when prefix filter is active", () => {
			const palette = useCommandPalette();
			palette.search("@");
			expect(palette.recentResults.value).toEqual([]);
		});

		it("execute() calls pushRecent with item id", () => {
			mockPushRecent.mockClear();
			const palette = useCommandPalette();
			palette.execute({
				id: "host:h1",
				label: "Test",
				type: "host",
				icon: "🖥",
				payload: "h1",
			});
			expect(mockPushRecent).toHaveBeenCalledWith("host:h1");
		});
	});

	describe("profile items (SC-28)", () => {
		it("profile items appear in general search results", () => {
			const profilesStore = useProfilesStore();
			profilesStore.profiles = [makeProfile("p1", "Python REPL")];

			const palette = useCommandPalette();
			palette.search("python");

			const profileResults = palette.results.value.filter((r) => r.type === "profile");
			expect(profileResults).toHaveLength(1);
			expect(profileResults[0]?.label).toBe("Python REPL");
		});

		it("profile item has shell as description", () => {
			const profilesStore = useProfilesStore();
			profilesStore.profiles = [makeProfile("p1", "Fish Shell", "/usr/bin/fish")];

			const palette = useCommandPalette();
			palette.search("~");

			const item = palette.results.value.find((r) => r.type === "profile");
			expect(item?.description).toBe("/usr/bin/fish");
		});

		it("~ prefix filters to profiles only", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [makeHost("h1", "Production")];

			const profilesStore = useProfilesStore();
			profilesStore.profiles = [makeProfile("p1", "Python REPL")];

			const palette = useCommandPalette();
			palette.search("~");

			const types = new Set(palette.results.value.map((r) => r.type));
			expect(types.has("profile")).toBe(true);
			expect(types.has("host")).toBe(false);
			expect(types.has("action")).toBe(false);
			expect(types.has("channel")).toBe(false);
		});

		it("~ prefix with search query fuzzy-matches profile names", () => {
			const profilesStore = useProfilesStore();
			profilesStore.profiles = [
				makeProfile("p1", "Python REPL"),
				makeProfile("p2", "Node REPL"),
				makeProfile("p3", "PyPy"),
			];

			const palette = useCommandPalette();
			palette.search("~py");

			const profileResults = palette.results.value.filter((r) => r.type === "profile");
			// Should match "Python REPL" and "PyPy", not "Node REPL"
			expect(profileResults.some((r) => r.label === "Python REPL")).toBe(true);
			expect(profileResults.some((r) => r.label === "PyPy")).toBe(true);
			expect(profileResults.some((r) => r.label === "Node REPL")).toBe(false);
		});

		it("~ prefix with empty query shows all profiles", () => {
			const profilesStore = useProfilesStore();
			profilesStore.profiles = [makeProfile("p1", "Bash"), makeProfile("p2", "Zsh")];

			const palette = useCommandPalette();
			palette.search("~");

			expect(palette.results.value).toHaveLength(2);
			expect(palette.results.value.every((r) => r.type === "profile")).toBe(true);
		});

		it("execute() on profile item calls spawnFromProfile", () => {
			const profilesStore = useProfilesStore();
			const spawnSpy = vi.spyOn(profilesStore, "spawnFromProfile");
			// Also set up active host so spawnFromProfile doesn't bail early
			const channelsStore = useChannelsStore();
			channelsStore.activeHostId = "h1";

			profilesStore.profiles = [makeProfile("p1", "Python REPL")];

			const palette = useCommandPalette();
			palette.execute({
				id: "profile:p1",
				label: "Python REPL",
				type: "profile",
				icon: "▶",
				payload: "p1",
			});

			expect(spawnSpy).toHaveBeenCalledWith("p1");
		});

		it("profile item uses emoji icon when iconType is emoji", () => {
			const profilesStore = useProfilesStore();
			profilesStore.profiles = [
				{
					...makeProfile("p1", "Python REPL"),
					iconType: "emoji",
					iconValue: "🐍",
				},
			];

			const palette = useCommandPalette();
			palette.search("~");

			const item = palette.results.value.find((r) => r.type === "profile");
			expect(item?.icon).toBe("🐍");
		});

		it("profile item uses default icon when iconType is not emoji", () => {
			const profilesStore = useProfilesStore();
			profilesStore.profiles = [makeProfile("p1", "Bash")];

			const palette = useCommandPalette();
			palette.search("~");

			const item = palette.results.value.find((r) => r.type === "profile");
			expect(item?.icon).toBe("▶");
		});
	});
});
