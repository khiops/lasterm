import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseManager } from "./db.js";
import { openTestDatabases } from "./db.js";
import { MetaDAL } from "./meta.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProfile(overrides: Partial<Parameters<MetaDAL["createLaunchProfile"]>[0]> = {}) {
	return {
		name: "My Shell",
		shell: "/bin/bash",
		mode: "shell" as const,
		elevated: false,
		supportedOs: "any" as const,
		iconType: "auto" as const,
		sortOrder: 0,
		...overrides,
	};
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("MetaDAL — Launch Profiles", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;
	let localHostId: string;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
		const host = dal.createHost({ type: "local", label: "local" });
		localHostId = host.id;
	});

	afterEach(() => {
		dbs.close();
	});

	// ─── SC-01: Create profile with all fields ─────────────────────────────

	describe("createLaunchProfile — all fields (SC-01)", () => {
		it("creates a profile and returns it with ULID and timestamps", () => {
			const profile = dal.createLaunchProfile({
				name: "Full Profile",
				shell: "/bin/zsh",
				args: ["-l", "-i"],
				cwd: "/home/user",
				env: { FOO: "bar", MY_SECRET: "hunter2" },
				mode: "shell",
				elevated: false,
				supportedOs: "linux",
				iconType: "emoji",
				iconValue: "",
				color: "#ff6600",
				profileOverrides: { fontSize: 14 },
				sortOrder: 5,
			});

			expect(profile.id).toHaveLength(26);
			expect(profile.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
			expect(profile.name).toBe("Full Profile");
			expect(profile.shell).toBe("/bin/zsh");
			expect(profile.args).toEqual(["-l", "-i"]);
			expect(profile.cwd).toBe("/home/user");
			expect(profile.env).toEqual({ FOO: "bar", MY_SECRET: "hunter2" });
			expect(profile.mode).toBe("shell");
			expect(profile.elevated).toBe(false);
			expect(profile.supportedOs).toBe("linux");
			expect(profile.iconType).toBe("emoji");
			expect(profile.iconValue).toBe("");
			expect(profile.color).toBe("#ff6600");
			expect(profile.profileOverrides).toEqual({ fontSize: 14 });
			expect(profile.sortOrder).toBe(5);
			expect(profile.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(profile.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});
	});

	// ─── SC-02: Create minimal profile ────────────────────────────────────

	describe("createLaunchProfile — minimal (SC-02)", () => {
		it("creates a minimal profile with name and shell only", () => {
			const profile = dal.createLaunchProfile(makeProfile());

			expect(profile.name).toBe("My Shell");
			expect(profile.shell).toBe("/bin/bash");
			expect(profile.mode).toBe("shell");
			expect(profile.elevated).toBe(false);
			expect(profile.supportedOs).toBe("any");
			expect(profile.iconType).toBe("auto");
			expect(profile.args).toBeUndefined();
			expect(profile.cwd).toBeUndefined();
			expect(profile.env).toBeUndefined();
			expect(profile.color).toBeUndefined();
		});
	});

	// ─── SC-03: Duplicate name rejected ───────────────────────────────────

	describe("createLaunchProfile — duplicate name (SC-03)", () => {
		it("throws on duplicate name", () => {
			dal.createLaunchProfile(makeProfile({ name: "Duplicate" }));
			expect(() => dal.createLaunchProfile(makeProfile({ name: "Duplicate" }))).toThrow();
		});
	});

	// ─── SC-33: Case-insensitive name uniqueness ──────────────────────────

	describe("createLaunchProfile — case-insensitive uniqueness (SC-33)", () => {
		it("throws on same name with different case", () => {
			dal.createLaunchProfile(makeProfile({ name: "MyProfile" }));
			expect(() => dal.createLaunchProfile(makeProfile({ name: "myprofile" }))).toThrow();
			expect(() => dal.createLaunchProfile(makeProfile({ name: "MYPROFILE" }))).toThrow();
		});
	});

	// ─── getLaunchProfile ─────────────────────────────────────────────────

	describe("getLaunchProfile", () => {
		it("returns profile by ID", () => {
			const created = dal.createLaunchProfile(makeProfile());
			const found = dal.getLaunchProfile(created.id);
			expect(found).toBeDefined();
			expect(found?.id).toBe(created.id);
		});

		it("returns undefined for unknown ID", () => {
			expect(dal.getLaunchProfile("non-existent")).toBeUndefined();
		});
	});

	// ─── listLaunchProfiles ───────────────────────────────────────────────

	describe("listLaunchProfiles", () => {
		it("returns empty array when none exist", () => {
			expect(dal.listLaunchProfiles()).toEqual([]);
		});

		it("returns profiles sorted by sort_order then name", () => {
			dal.createLaunchProfile(makeProfile({ name: "Zsh", sortOrder: 2 }));
			dal.createLaunchProfile(makeProfile({ name: "Bash", sortOrder: 1 }));
			dal.createLaunchProfile(makeProfile({ name: "Fish", sortOrder: 1 }));

			const profiles = dal.listLaunchProfiles();
			expect(profiles).toHaveLength(3);
			// sort_order 1 first, then alphabetical within same sort_order
			expect(profiles[0]?.name).toBe("Bash");
			expect(profiles[1]?.name).toBe("Fish");
			expect(profiles[2]?.name).toBe("Zsh");
		});
	});

	// ─── updateLaunchProfile ──────────────────────────────────────────────

	describe("updateLaunchProfile", () => {
		it("updates name and shell", () => {
			const created = dal.createLaunchProfile(makeProfile());
			const updated = dal.updateLaunchProfile(created.id, { name: "Updated", shell: "/bin/zsh" });
			expect(updated?.name).toBe("Updated");
			expect(updated?.shell).toBe("/bin/zsh");
		});

		it("updates updatedAt timestamp", () => {
			const created = dal.createLaunchProfile(makeProfile());
			const before = created.updatedAt;
			const updated = dal.updateLaunchProfile(created.id, { name: "Changed" });
			// updatedAt should be >= createdAt
			expect((updated?.updatedAt ?? "") >= before).toBe(true);
		});

		it("returns undefined for unknown ID", () => {
			expect(dal.updateLaunchProfile("non-existent", { name: "X" })).toBeUndefined();
		});

		it("updates elevated field (boolean ↔ integer)", () => {
			const created = dal.createLaunchProfile(makeProfile({ elevated: false }));
			const updated = dal.updateLaunchProfile(created.id, { elevated: true });
			expect(updated?.elevated).toBe(true);
			const restored = dal.updateLaunchProfile(created.id, { elevated: false });
			expect(restored?.elevated).toBe(false);
		});
	});

	// ─── deleteLaunchProfile ──────────────────────────────────────────────

	describe("deleteLaunchProfile", () => {
		it("deletes profile and returns true", () => {
			const created = dal.createLaunchProfile(makeProfile());
			expect(dal.deleteLaunchProfile(created.id)).toBe(true);
			expect(dal.getLaunchProfile(created.id)).toBeUndefined();
		});

		it("returns false for unknown ID", () => {
			expect(dal.deleteLaunchProfile("non-existent")).toBe(false);
		});
	});

	// ─── SC-05: Delete profile → channel gets NULL launch_profile_id ──────

	describe("deleteLaunchProfile — cascades to channels (SC-05)", () => {
		it("sets channels.launch_profile_id to NULL on profile delete", () => {
			const profile = dal.createLaunchProfile(makeProfile());

			// Create a session and channel referencing the profile
			const session = (() => {
				dal.createSession({ id: "sess-01", hostId: localHostId, status: "active" });
				return dal.getSession("sess-01");
			})();
			expect(session).toBeDefined();

			dal.createChannel({
				id: "chan-01",
				sessionId: "sess-01",
				status: "live",
			});

			// Manually set launch_profile_id via raw SQL (DAL doesn't set it during create)
			dbs.meta
				.prepare("UPDATE channels SET launch_profile_id = ? WHERE id = ?")
				.run(profile.id, "chan-01");

			// Verify it's set
			const before = dal.getChannel("chan-01");
			expect(before?.launchProfileId).toBe(profile.id);

			// Delete the profile
			dal.deleteLaunchProfile(profile.id);

			// Channel's launch_profile_id should be NULL (ON DELETE SET NULL)
			const after = dal.getChannel("chan-01");
			expect(after?.launchProfileId).toBeUndefined();
		});
	});

	// ─── reorderLaunchProfiles ────────────────────────────────────────────

	describe("reorderLaunchProfiles", () => {
		it("reorders profiles by updating sort_order", () => {
			const a = dal.createLaunchProfile(makeProfile({ name: "A", sortOrder: 0 }));
			const b = dal.createLaunchProfile(makeProfile({ name: "B", sortOrder: 1 }));
			const c = dal.createLaunchProfile(makeProfile({ name: "C", sortOrder: 2 }));

			// Reorder: C, A, B
			dal.reorderLaunchProfiles([c.id, a.id, b.id]);

			const profiles = dal.listLaunchProfiles();
			expect(profiles[0]?.name).toBe("C"); // sort_order 0
			expect(profiles[1]?.name).toBe("A"); // sort_order 1
			expect(profiles[2]?.name).toBe("B"); // sort_order 2
		});
	});

	// ─── SC-32: Reorder with missing/invalid IDs ──────────────────────────

	describe("reorderLaunchProfiles — missing/invalid IDs (SC-32)", () => {
		it("ignores unknown IDs without throwing", () => {
			const a = dal.createLaunchProfile(makeProfile({ name: "A", sortOrder: 10 }));
			// Pass a mix of valid and invalid IDs
			expect(() =>
				dal.reorderLaunchProfiles(["non-existent-id", a.id, "another-bad-id"]),
			).not.toThrow();
			// Valid profile gets its sort_order updated (index 1 = sort_order 1)
			const updated = dal.getLaunchProfile(a.id);
			expect(updated?.sortOrder).toBe(1);
		});
	});

	// ─── SC-06/07: OS-aware visibility ────────────────────────────────────

	describe("listHostProfiles — OS filtering (SC-06, SC-07, SC-10)", () => {
		it("shows 'any' profiles on any OS (SC-10)", () => {
			dal.createLaunchProfile(makeProfile({ name: "Universal", supportedOs: "any" }));
			const result = dal.listHostProfiles(localHostId, "linux");
			expect(result.map((p) => p.name)).toContain("Universal");
		});

		it("shows linux profile on linux host (SC-06)", () => {
			dal.createLaunchProfile(makeProfile({ name: "Linux Only", supportedOs: "linux" }));
			const result = dal.listHostProfiles(localHostId, "linux");
			expect(result.map((p) => p.name)).toContain("Linux Only");
		});

		it("hides linux profile on darwin host (SC-07)", () => {
			dal.createLaunchProfile(makeProfile({ name: "Linux Only", supportedOs: "linux" }));
			const result = dal.listHostProfiles(localHostId, "darwin");
			expect(result.map((p) => p.name)).not.toContain("Linux Only");
		});

		it("shows darwin profile on darwin host", () => {
			dal.createLaunchProfile(makeProfile({ name: "Mac Only", supportedOs: "darwin" }));
			const result = dal.listHostProfiles(localHostId, "darwin");
			expect(result.map((p) => p.name)).toContain("Mac Only");
		});

		it("includes effectiveSort in result", () => {
			dal.createLaunchProfile(makeProfile({ name: "P1", sortOrder: 5 }));
			const result = dal.listHostProfiles(localHostId, "any");
			expect(result[0]?.effectiveSort).toBeDefined();
		});
	});

	// ─── SC-08: Pin override shows profile on non-matching OS ─────────────

	describe("listHostProfiles — pin override (SC-08)", () => {
		it("pin override shows a non-matching OS profile", () => {
			const profile = dal.createLaunchProfile(
				makeProfile({ name: "Windows Only", supportedOs: "windows" }),
			);
			// Without pin, should not show on linux
			const before = dal.listHostProfiles(localHostId, "linux");
			expect(before.map((p) => p.name)).not.toContain("Windows Only");

			// Add pin override
			dal.upsertHostProfileOverride(localHostId, profile.id, "pin");

			const after = dal.listHostProfiles(localHostId, "linux");
			expect(after.map((p) => p.name)).toContain("Windows Only");
			expect(after.find((p) => p.name === "Windows Only")?.overrideType).toBe("pin");
		});
	});

	// ─── SC-09: Hide override hides profile on matching OS ────────────────

	describe("listHostProfiles — hide override (SC-09)", () => {
		it("hide override removes a matching OS profile from results", () => {
			const profile = dal.createLaunchProfile(
				makeProfile({ name: "Linux Shell", supportedOs: "linux" }),
			);
			// Before hide: visible on linux
			const before = dal.listHostProfiles(localHostId, "linux");
			expect(before.map((p) => p.name)).toContain("Linux Shell");

			// Add hide override
			dal.upsertHostProfileOverride(localHostId, profile.id, "hide");

			const after = dal.listHostProfiles(localHostId, "linux");
			expect(after.map((p) => p.name)).not.toContain("Linux Shell");
		});
	});

	// ─── SC-11: One default per host enforced ─────────────────────────────

	describe("upsertHostProfileOverride — one default per host (SC-11)", () => {
		it("replacing default: removes old default, sets new one", () => {
			const p1 = dal.createLaunchProfile(makeProfile({ name: "Profile1" }));
			const p2 = dal.createLaunchProfile(makeProfile({ name: "Profile2" }));

			dal.upsertHostProfileOverride(localHostId, p1.id, "default");
			dal.upsertHostProfileOverride(localHostId, p2.id, "default");

			// p1 should no longer be default
			const o1 = dal.getHostLaunchProfileOverride(localHostId, p1.id);
			expect(o1).toBeUndefined(); // it was deleted when p2 was set as default

			// p2 should be default
			const o2 = dal.getHostLaunchProfileOverride(localHostId, p2.id);
			expect(o2?.overrideType).toBe("default");
		});

		it("allows other override types on same host alongside default", () => {
			const p1 = dal.createLaunchProfile(makeProfile({ name: "Default" }));
			const p2 = dal.createLaunchProfile(makeProfile({ name: "Pinned" }));

			dal.upsertHostProfileOverride(localHostId, p1.id, "default");
			dal.upsertHostProfileOverride(localHostId, p2.id, "pin");

			// Both overrides should exist
			expect(dal.getHostLaunchProfileOverride(localHostId, p1.id)?.overrideType).toBe("default");
			expect(dal.getHostLaunchProfileOverride(localHostId, p2.id)?.overrideType).toBe("pin");
		});
	});

	// ─── deleteHostProfileOverride ────────────────────────────────────────

	describe("deleteHostProfileOverride", () => {
		it("removes an override and returns true", () => {
			const p = dal.createLaunchProfile(makeProfile());
			dal.upsertHostProfileOverride(localHostId, p.id, "pin");
			expect(dal.deleteHostProfileOverride(localHostId, p.id)).toBe(true);
			expect(dal.getHostLaunchProfileOverride(localHostId, p.id)).toBeUndefined();
		});

		it("returns false when override does not exist", () => {
			const p = dal.createLaunchProfile(makeProfile());
			expect(dal.deleteHostProfileOverride(localHostId, p.id)).toBe(false);
		});
	});

	// ─── updateHostDiscoveredShells ───────────────────────────────────────

	describe("updateHostDiscoveredShells", () => {
		it("stores discovered shells on the host", () => {
			dal.updateHostDiscoveredShells(localHostId, ["/bin/bash", "/bin/zsh", "/usr/bin/fish"]);
			const host = dal.getHost(localHostId);
			expect(host?.discoveredShells).toEqual(["/bin/bash", "/bin/zsh", "/usr/bin/fish"]);
			expect(host?.discoveredShellsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it("updates defaultShell when provided", () => {
			dal.updateHostDiscoveredShells(localHostId, ["/bin/bash"], "/bin/bash");
			const host = dal.getHost(localHostId);
			expect(host?.defaultShell).toBe("/bin/bash");
		});

		it("does not update defaultShell when not provided", () => {
			// Set a default_shell first
			dal.updateHost(localHostId, { defaultShell: "/bin/zsh" });
			// Update discovered shells without defaultShell
			dal.updateHostDiscoveredShells(localHostId, ["/bin/bash"]);
			const host = dal.getHost(localHostId);
			// defaultShell should remain /bin/zsh
			expect(host?.defaultShell).toBe("/bin/zsh");
		});
	});

	// ─── default override appears first in listHostProfiles ───────────────

	describe("listHostProfiles — default appears first", () => {
		it("default override profile is first in results", () => {
			const _p1 = dal.createLaunchProfile(makeProfile({ name: "A Profile", sortOrder: 0 }));
			const p2 = dal.createLaunchProfile(makeProfile({ name: "B Default", sortOrder: 1 }));

			dal.upsertHostProfileOverride(localHostId, p2.id, "default");

			const profiles = dal.listHostProfiles(localHostId, "any");
			expect(profiles[0]?.name).toBe("B Default");
			expect(profiles[0]?.overrideType).toBe("default");
			expect(profiles[1]?.name).toBe("A Profile");
		});
	});
});
