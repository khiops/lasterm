import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigResolver, UiConfig } from "../config.js";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import { MetaDAL } from "./meta.js";
import { migrateLegacyShellDefaults } from "./migrate-launch-profiles.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal ConfigResolver stub that returns the given channels.defaultShell.
 */
function makeConfigResolver(defaultShell?: string): ConfigResolver {
	const channels = { defaultShell, defaultGroupName: "General", autoGroup: "none" as const };
	return {
		uiConfig: { channels } as unknown as UiConfig,
	} as unknown as ConfigResolver;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("migrateLegacyShellDefaults", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	// ─── SC-24: Migrate per-host default_shell ─────────────────────────────

	describe("SC-24: per-host default_shell", () => {
		it("creates a profile named after the shell basename and sets it as host default", () => {
			const host = dal.createHost({
				type: "ssh",
				label: "server-1",
				defaultShell: "/bin/zsh",
			});

			const result = migrateLegacyShellDefaults(dal);

			expect(result.profilesCreated).toBe(1);
			expect(result.hostsLinked).toBe(1);

			const profiles = dal.listLaunchProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0]?.name).toBe("zsh");
			expect(profiles[0]?.shell).toBe("/bin/zsh");

			// The profile must be registered as default for the host
			const hostProfiles = dal.listHostProfiles(host.id, "linux");
			expect(hostProfiles).toHaveLength(1);
			expect(hostProfiles[0]?.shell).toBe("/bin/zsh");
			expect(hostProfiles[0]?.overrideType).toBe("default");
		});

		it("reads shell from profile_json.defaultShell when default_shell column is absent", () => {
			const host = dal.createHost({
				type: "ssh",
				label: "server-1",
				profileJson: JSON.stringify({ defaultShell: "/bin/zsh" }),
			});

			const result = migrateLegacyShellDefaults(dal);

			expect(result.profilesCreated).toBe(1);
			expect(result.hostsLinked).toBe(1);

			const profiles = dal.listLaunchProfiles();
			expect(profiles[0]?.shell).toBe("/bin/zsh");

			const hostProfiles = dal.listHostProfiles(host.id, "linux");
			expect(hostProfiles[0]?.overrideType).toBe("default");
		});

		it("reads shell from profile_json.shell when defaultShell is absent", () => {
			dal.createHost({
				type: "ssh",
				label: "server-1",
				profileJson: JSON.stringify({ shell: "/bin/fish" }),
			});

			const result = migrateLegacyShellDefaults(dal);

			expect(result.profilesCreated).toBe(1);
			const profiles = dal.listLaunchProfiles();
			expect(profiles[0]?.shell).toBe("/bin/fish");
		});
	});

	// ─── SC-25: Migrate config.toml defaultShell ───────────────────────────

	describe("SC-25: global config.toml defaultShell", () => {
		it("creates a profile from config.toml without any host override", () => {
			// No hosts with defaultShell
			dal.createHost({ type: "local", label: "local" });

			const resolver = makeConfigResolver("/bin/fish");
			const result = migrateLegacyShellDefaults(dal, resolver);

			expect(result.profilesCreated).toBe(1);
			expect(result.hostsLinked).toBe(0);

			const profiles = dal.listLaunchProfiles();
			expect(profiles).toHaveLength(1);
			expect(profiles[0]?.name).toBe("fish");
			expect(profiles[0]?.shell).toBe("/bin/fish");
		});

		it("does not create a host override for the global profile", () => {
			const host = dal.createHost({ type: "local", label: "local" });

			const resolver = makeConfigResolver("/bin/fish");
			migrateLegacyShellDefaults(dal, resolver);

			// No override should be registered for the host
			// listHostProfiles with supportedOs="any" returns all profiles visible to host
			// Since there's no hide/pin/default override, the profile should appear
			// but WITHOUT an overrideType value
			const hostProfiles = dal.listHostProfiles(host.id, "linux");
			// The fish profile is globally visible (supported_os=any, no hide override)
			expect(hostProfiles.length).toBe(1);
			expect(hostProfiles[0]?.shell).toBe("/bin/fish");
			// No host-specific override type — it's just globally visible
			expect(hostProfiles[0]?.overrideType).toBeUndefined();
		});
	});

	// ─── SC-26: Per-host wins default slot over global ─────────────────────

	describe("SC-26: per-host wins default slot over global", () => {
		it("sets per-host shell as host default; global shell exists as profile only", () => {
			const host = dal.createHost({
				type: "ssh",
				label: "server-1",
				defaultShell: "/bin/zsh",
			});

			const resolver = makeConfigResolver("/bin/bash");
			const result = migrateLegacyShellDefaults(dal, resolver);

			expect(result.profilesCreated).toBe(2);
			expect(result.hostsLinked).toBe(1);

			const profiles = dal.listLaunchProfiles();
			expect(profiles).toHaveLength(2);

			const shells = profiles.map((p) => p.shell).sort();
			expect(shells).toEqual(["/bin/bash", "/bin/zsh"]);

			// "zsh" must be default on server-1
			const hostProfiles = dal.listHostProfiles(host.id, "linux");
			const zshEntry = hostProfiles.find((p) => p.shell === "/bin/zsh");
			expect(zshEntry).toBeDefined();
			expect(zshEntry?.overrideType).toBe("default");

			// "bash" must NOT have a default override on server-1 (just globally visible)
			const bashEntry = hostProfiles.find((p) => p.shell === "/bin/bash");
			expect(bashEntry).toBeDefined();
			expect(bashEntry?.overrideType).toBeUndefined();
		});
	});

	// ─── Idempotency ───────────────────────────────────────────────────────

	describe("idempotency", () => {
		it("returns zero counts on second run when profiles already exist", () => {
			dal.createHost({ type: "ssh", label: "server-1", defaultShell: "/bin/zsh" });

			const first = migrateLegacyShellDefaults(dal);
			expect(first.profilesCreated).toBe(1);

			const second = migrateLegacyShellDefaults(dal);
			expect(second.profilesCreated).toBe(0);
			expect(second.hostsLinked).toBe(0);

			// No duplicate profiles should exist
			expect(dal.listLaunchProfiles()).toHaveLength(1);
		});

		it("skips migration when profiles already exist even with new hosts present", () => {
			// Pre-create a profile as if migration already ran
			dal.createLaunchProfile({
				name: "existing",
				shell: "/bin/bash",
				mode: "shell",
				elevated: false,
				supportedOs: "any",
				iconType: "auto",
				sortOrder: 0,
			});

			dal.createHost({ type: "ssh", label: "server-1", defaultShell: "/bin/zsh" });

			const result = migrateLegacyShellDefaults(dal);
			expect(result.profilesCreated).toBe(0);
			expect(result.hostsLinked).toBe(0);

			// Still only the pre-existing profile
			expect(dal.listLaunchProfiles()).toHaveLength(1);
		});
	});

	// ─── Name deduplication ────────────────────────────────────────────────

	describe("name deduplication", () => {
		it("first profile gets basename, second with same basename gets full path", () => {
			// Two hosts with different paths that share the same basename "zsh"
			dal.createHost({
				type: "ssh",
				label: "server-1",
				defaultShell: "/bin/zsh",
			});
			dal.createHost({
				type: "ssh",
				label: "server-2",
				defaultShell: "/usr/local/bin/zsh",
			});

			const result = migrateLegacyShellDefaults(dal);

			expect(result.profilesCreated).toBe(2);

			const profiles = dal.listLaunchProfiles();
			expect(profiles).toHaveLength(2);

			const names = profiles.map((p) => p.name).sort();
			// First gets "zsh", second gets full path
			expect(names).toContain("zsh");
			expect(names).toContain("/usr/local/bin/zsh");
		});

		it("global config shell with same path as host shell reuses existing profile", () => {
			dal.createHost({ type: "ssh", label: "server-1", defaultShell: "/bin/zsh" });

			// Global config also points to zsh (same path)
			const resolver = makeConfigResolver("/bin/zsh");
			const result = migrateLegacyShellDefaults(dal, resolver);

			// Only one profile — same shell path is not duplicated
			expect(result.profilesCreated).toBe(1);
			expect(dal.listLaunchProfiles()).toHaveLength(1);
		});
	});

	// ─── Edge cases ────────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles hosts with no default shell — no profiles created for them", () => {
			dal.createHost({ type: "local", label: "local" });
			dal.createHost({ type: "ssh", label: "server-1" });

			const result = migrateLegacyShellDefaults(dal);

			expect(result.profilesCreated).toBe(0);
			expect(result.hostsLinked).toBe(0);
		});

		it("works without a configResolver — skips global source", () => {
			dal.createHost({ type: "ssh", label: "server-1", defaultShell: "/bin/bash" });

			const result = migrateLegacyShellDefaults(dal, undefined);

			expect(result.profilesCreated).toBe(1);
			expect(result.hostsLinked).toBe(1);
		});

		it("ignores configResolver with no defaultShell set", () => {
			dal.createHost({ type: "ssh", label: "server-1", defaultShell: "/bin/bash" });

			const resolver = makeConfigResolver(undefined);
			const result = migrateLegacyShellDefaults(dal, resolver);

			// Only the per-host profile, no extra from global
			expect(result.profilesCreated).toBe(1);
		});

		it("handles malformed profile_json gracefully", () => {
			dal.createHost({
				type: "ssh",
				label: "server-1",
				profileJson: "not-valid-json",
			});

			const result = migrateLegacyShellDefaults(dal);

			expect(result.profilesCreated).toBe(0);
			expect(result.hostsLinked).toBe(0);
		});
	});
});
