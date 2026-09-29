import type { Host } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelsStore } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { type HostVisibleProfile, useProfilesStore } from "../stores/profiles.js";
import { type AppActionId, shortcutLabel } from "../utils/app-shortcuts.js";
import {
	arrangeForDisplay,
	fuzzyMatch,
	type PaletteItem,
	paletteRows,
	useCommandPalette,
} from "./useCommandPalette.js";

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

function makeProfile(id: string, name: string, shell = "/bin/bash"): HostVisibleProfile {
	return {
		id,
		name,
		shell,
		effectiveSort: 0,
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

		it("names a terminal as its tab does, not by its id", () => {
			const channelsStore = useChannelsStore();
			channelsStore.channels = [
				{
					id: "01m2wzzfrxpkm8h79wmdfkeszm",
					sessionId: "s1",
					shell: "pwsh.exe",
					cols: 80,
					rows: 24,
					status: "live",
					// No rename: the hub-resolved name comes from the shell's title.
					displayTitle: "pwsh in project",
					createdAt: "2025-01-01T00:00:00Z",
					updatedAt: "2025-01-01T00:00:00Z",
				},
			];

			const palette = useCommandPalette();
			palette.search("#");

			const labels = palette.results.value.filter((r) => r.type === "channel").map((r) => r.label);
			expect(labels).toEqual(["pwsh in project"]);
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

		// Ctrl+, opens Settings (#637): the row names it, from the table.
		it("Settings shows the chord that opens it", () => {
			const palette = useCommandPalette();
			palette.search(">settings");
			const item = palette.results.value.find((r) => r.id === "action:settings");
			expect(item?.shortcut).toBe(shortcutLabel("settings.open"));
			expect(item?.shortcut).toBe("Ctrl+,");
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

	// The palette listed Ctrl+T, Ctrl+W, Ctrl+\ and Ctrl+- that nothing handled (#631).
	describe("the actions a shortcut runs", () => {
		const ROWS: [string, AppActionId][] = [
			["action:new-channel", "tab.new"],
			["action:close-pane", "pane.close"],
			["action:split-right", "pane.splitRight"],
			["action:split-down", "pane.splitDown"],
		];

		it("show the chord the window runs them on, read from the table", () => {
			const palette = useCommandPalette();
			palette.search(">");
			for (const [row, id] of ROWS) {
				const item = palette.results.value.find((r) => r.id === row);
				expect(item?.shortcut).toBe(shortcutLabel(id));
			}
			expect(palette.results.value.find((r) => r.id === "action:new-channel")?.shortcut).toBe(
				"Ctrl+Shift+T",
			);
			// Windows Terminal's Ctrl+Shift+W closes a pane (#637).
			const closePane = palette.results.value.find((r) => r.id === "action:close-pane");
			expect([closePane?.label, closePane?.shortcut]).toEqual(["Close Pane", "Ctrl+Shift+W"]);
		});

		// The keyboard shortcuts overlay (#639): App.vue opens it (App.spec.ts), as Ctrl+/ does.
		it("offer Keyboard Shortcuts, with its chord, run by the window", () => {
			const palette = useCommandPalette();
			const handler = vi.fn();
			palette.onExternalAction.value = handler;
			palette.search(">keyboard");
			const item = palette.results.value.find((r) => r.id === "action:keyboard-shortcuts");
			expect([item?.label, item?.shortcut]).toEqual(["Keyboard Shortcuts", "Ctrl+/"]);
			expect(item?.shortcut).toBe(shortcutLabel("help.shortcuts"));
			if (item === undefined) throw new Error("Keyboard Shortcuts is not offered");
			palette.execute(item);
			expect(handler).toHaveBeenCalledExactlyOnceWith("action:keyboard-shortcuts");
			expect(palette.isOpen.value).toBe(false);
		});

		// Its chord went to Close Pane; the row still closes the tab, and shows no chord.
		it("keep Close Tab, without a chord", () => {
			const palette = useCommandPalette();
			const handler = vi.fn();
			palette.onExternalAction.value = handler;
			palette.search(">close tab");
			const item = palette.results.value.find((r) => r.id === "action:close-tab");
			expect(item?.label).toBe("Close Tab");
			expect(item?.shortcut).toBeUndefined();
			if (item === undefined) throw new Error("Close Tab is not offered");
			palette.execute(item);
			expect(handler).toHaveBeenCalledExactlyOnceWith("action:close-tab");
		});

		// App.vue runs them as the tab bar does, and as their chords do (App.spec.ts).
		it("are run by the window, as their chords are", () => {
			const palette = useCommandPalette();
			const handler = vi.fn();
			palette.onExternalAction.value = handler;
			palette.search(">");
			for (const [row] of ROWS) {
				const item = palette.results.value.find((r) => r.id === row);
				if (item === undefined) throw new Error(`${row} is not offered`);
				palette.execute(item);
				expect(handler).toHaveBeenLastCalledWith(row);
			}
			expect(handler).toHaveBeenCalledTimes(ROWS.length);
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
			profilesStore.hostProfiles = [makeProfile("p1", "Python REPL")];

			const palette = useCommandPalette();
			palette.search("python");

			const profileResults = palette.results.value.filter((r) => r.type === "profile");
			expect(profileResults).toHaveLength(1);
			expect(profileResults[0]?.label).toBe("Python REPL");
		});

		it("profile item has shell as description", () => {
			const profilesStore = useProfilesStore();
			profilesStore.hostProfiles = [makeProfile("p1", "Fish Shell", "/usr/bin/fish")];

			const palette = useCommandPalette();
			palette.search("~");

			const item = palette.results.value.find((r) => r.type === "profile");
			expect(item?.description).toBe("/usr/bin/fish");
		});

		it("~ prefix filters to profiles only", () => {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [makeHost("h1", "Production")];

			const profilesStore = useProfilesStore();
			profilesStore.hostProfiles = [makeProfile("p1", "Python REPL")];

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
			profilesStore.hostProfiles = [
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
			profilesStore.hostProfiles = [makeProfile("p1", "Bash"), makeProfile("p2", "Zsh")];

			const palette = useCommandPalette();
			palette.search("~");

			expect(palette.results.value).toHaveLength(2);
			expect(palette.results.value.every((r) => r.type === "profile")).toBe(true);
		});

		it("offers the profiles of the active host, read when it opens", async () => {
			const profilesStore = useProfilesStore();
			// A profile the host cannot run, such as a Linux shell on Windows, is
			// not in its menu, so the palette must not offer it either.
			profilesStore.profiles = [makeProfile("p1", "Bash"), makeProfile("p2", "Zsh")];
			const load = vi.spyOn(profilesStore, "loadHostProfiles").mockImplementation(async () => {
				profilesStore.hostProfiles = [makeProfile("p2", "Zsh")];
			});

			const palette = useCommandPalette();
			palette.open();
			await load.mock.results[0]?.value;
			palette.search("~");

			expect(load).toHaveBeenCalled();
			expect(palette.results.value.map((r) => r.label)).toEqual(["Zsh"]);
		});

		it("execute() on profile item calls spawnFromProfile", () => {
			const profilesStore = useProfilesStore();
			const spawnSpy = vi.spyOn(profilesStore, "spawnFromProfile");
			// Also set up active host so spawnFromProfile doesn't bail early
			const channelsStore = useChannelsStore();
			channelsStore.activeHostId = "h1";

			profilesStore.hostProfiles = [makeProfile("p1", "Python REPL")];

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
			profilesStore.hostProfiles = [
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
			profilesStore.hostProfiles = [makeProfile("p1", "Bash")];

			const palette = useCommandPalette();
			palette.search("~");

			const item = palette.results.value.find((r) => r.type === "profile");
			expect(item?.icon).toBe("▶");
		});
	});

	// The palette lists hosts as the empty pane does (#625): the rail's order
	// and headings; Enter opens a terminal on one, Shift+Enter switches to it.
	describe("host rows (#625)", () => {
		function railHosts(): void {
			const hostsStore = useHostsStore();
			hostsStore.hosts = [
				{ ...makeHost("local", "local"), type: "local" },
				makeHost("beta", "Beta"),
				{ ...makeHost("alpha", "Alpha"), hostGroupId: "g2" },
				{ ...makeHost("gamma", "Gamma"), hostGroupId: "g1" },
			];
			hostsStore.hostGroups = [
				{ id: "g1", name: "Home", sortOrder: 0, createdAt: "", updatedAt: "" },
				{ id: "g2", name: "Prod", sortOrder: 1, createdAt: "", updatedAt: "" },
			];
		}

		afterEach(() => {
			useCommandPalette().onOpenHost.value = null;
		});

		it("lists the hosts in the rail's order, under the rail's headings", () => {
			railHosts();
			const palette = useCommandPalette();
			palette.search("@");

			expect(palette.results.value.map((r) => r.payload)).toEqual([
				"local",
				"gamma",
				"alpha",
				"beta",
			]);
			const rows = paletteRows(palette.results.value, 0);
			expect(rows.filter((r) => r.kind === "heading").map((r) => r.label)).toEqual([
				"Hosts",
				"Local",
				"Home",
				"Prod",
				"Ungrouped",
			]);
			// Each result's row index is its place in `results`: ↑ and ↓ follow what is shown.
			const indices = rows.flatMap((r) => (r.kind === "item" ? [r.index] : []));
			expect(indices).toEqual([0, 1, 2, 3]);
		});

		it("opens a new terminal on a host with Enter", () => {
			railHosts();
			const hostsStore = useHostsStore();
			hostsStore.selectHost("local");
			const openOnHost = vi.fn();
			const palette = useCommandPalette();
			palette.onOpenHost.value = openOnHost;
			palette.open();
			palette.search("@gamma");
			palette.executeSelected();

			expect(openOnHost).toHaveBeenCalledWith("gamma");
			expect(hostsStore.selectedHostId).toBe("local");
			expect(palette.isOpen.value).toBe(false);
		});

		it("only switches to the host with Shift+Enter", () => {
			railHosts();
			const hostsStore = useHostsStore();
			hostsStore.selectHost("local");
			const openOnHost = vi.fn();
			const palette = useCommandPalette();
			palette.onOpenHost.value = openOnHost;
			palette.search("@gamma");
			palette.executeSelected({ switchOnly: true });

			expect(hostsStore.selectedHostId).toBe("gamma");
			expect(openOnHost).not.toHaveBeenCalled();
		});

		it("keeps each type together, so that the order shown is the order walked", () => {
			const item = (type: PaletteItem["type"], id: string): PaletteItem => ({
				id: `${type}:${id}`,
				label: id,
				type,
				icon: "",
				payload: id,
			});
			const arranged = arrangeForDisplay(
				[item("host", "b"), item("channel", "x"), item("host", "a"), item("action", "y")],
				new Map([
					["a", 0],
					["b", 1],
				]),
			);
			expect(arranged.map((i) => i.id)).toEqual(["host:a", "host:b", "channel:x", "action:y"]);
		});

		it("heads the recent items apart, without the rail's headings", () => {
			const recent: PaletteItem = {
				id: "host:alpha",
				label: "Alpha",
				type: "host",
				icon: "",
				payload: "alpha",
				section: "Prod",
			};
			const other: PaletteItem = {
				...recent,
				id: "host:beta",
				payload: "beta",
				section: "Ungrouped",
			};
			const rows = paletteRows([recent, other], 1);
			expect(rows.map((r) => (r.kind === "heading" ? `# ${r.label}` : r.key))).toEqual([
				"# Recent",
				"host:alpha",
				"# Hosts",
				"# Ungrouped",
				"host:beta",
			]);
		});
	});
});
