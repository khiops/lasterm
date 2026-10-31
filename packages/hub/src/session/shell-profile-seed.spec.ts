import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { restoreAgentDefaultProfile, seedShellProfiles } from "./shell-profile-seed.js";

const CMD = "C:\\WINDOWS\\system32\\cmd.exe";
const POWERSHELL = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PWSH = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
// What a Windows agent reports: the same shells, spelled its own way
const AGENT_SHELLS = [CMD, POWERSHELL.toLowerCase(), PWSH];

describe("seedShellProfiles", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;
	let hostId: string;

	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
		hostId = dal.createHost({ type: "local", label: "local" }).id;
	});

	afterEach(() => {
		dbs.close();
		vi.restoreAllMocks();
	});

	/** The profiles the hub's own discovery names on Windows. */
	function discoveredWindowsProfiles() {
		for (const [i, [name, shell]] of [
			["Windows PowerShell", POWERSHELL],
			["Command Prompt", CMD],
		].entries()) {
			dal.createLaunchProfile({
				name: name as string,
				shell: shell as string,
				mode: "shell",
				elevated: false,
				supportedOs: "windows",
				iconType: "auto",
				sortOrder: i,
			});
		}
	}

	/** What the menu lists for the host: name, and whether it is the default. */
	function menu(os = "windows") {
		return dal
			.listHostProfiles(hostId, os)
			.map((p) => (p.overrideType === "default" ? `${p.name} (default)` : p.name));
	}

	it("lists each Windows shell once, under the profile that already launches it", async () => {
		discoveredWindowsProfiles();

		await seedShellProfiles(hostId, AGENT_SHELLS, CMD, null, dal);

		expect(menu()).toEqual(["Command Prompt (default)", "Windows PowerShell", "pwsh.exe"]);
		expect(dal.getLaunchProfileByName("pwsh.exe")?.supportedOs).toBe("windows");
	});

	it("repairs the path-named duplicates an earlier seeding left", async () => {
		discoveredWindowsProfiles();
		// What the seeding did when it read a file name only after a `/`
		for (const shell of AGENT_SHELLS) {
			const stale = dal.createLaunchProfile({
				name: shell,
				shell,
				mode: "shell",
				elevated: false,
				supportedOs: "linux",
				iconType: "auto",
				sortOrder: 0,
			});
			dal.upsertHostProfileOverride(hostId, stale.id, shell === CMD ? "default" : "pin");
		}
		const stalePwsh = dal.getLaunchProfileByName(PWSH);

		await seedShellProfiles(hostId, AGENT_SHELLS, CMD, null, dal);

		// The renamed profile keeps its place in the menu: only which entries remain matters here
		expect(menu().sort()).toEqual(
			["Command Prompt (default)", "Windows PowerShell", "pwsh.exe"].sort(),
		);
		// The one shell no other profile launches keeps its profile, renamed
		expect(dal.getLaunchProfileByName("pwsh.exe")?.id).toBe(stalePwsh?.id);
		expect(dal.listLaunchProfiles()).toHaveLength(3);
	});

	it("keeps a path-named profile the user edited", async () => {
		discoveredWindowsProfiles();
		const edited = dal.createLaunchProfile({
			name: CMD,
			shell: CMD,
			cwd: "D:\\work",
			mode: "shell",
			elevated: false,
			supportedOs: "windows",
			iconType: "auto",
			sortOrder: 5,
		});

		await seedShellProfiles(hostId, [CMD], CMD, null, dal);

		expect(dal.getLaunchProfile(edited.id)?.name).toBe(CMD);
	});

	it("leaves a profile the user hid hidden", async () => {
		discoveredWindowsProfiles();
		const cmd = dal.getLaunchProfileByName("Command Prompt");
		dal.upsertHostProfileOverride(hostId, cmd?.id ?? "", "hide");

		await seedShellProfiles(hostId, [CMD, POWERSHELL], POWERSHELL, null, dal);

		expect(menu()).toEqual(["Windows PowerShell (default)"]);
	});

	it("names a Unix shell by its file name, and pins it on the host", async () => {
		await seedShellProfiles(hostId, ["/bin/bash", "/usr/bin/fish"], "/bin/bash", "linux", dal);

		expect(menu("linux")).toEqual(["bash (default)", "fish"]);
		expect(
			dal.getHostLaunchProfileOverride(hostId, dal.getLaunchProfileByName("fish")?.id ?? ""),
		).toMatchObject({ overrideType: "pin" });
	});

	// Every connection seeds again: each HELLO with shells calls it (#800).
	describe("the host's default profile", () => {
		const UNIX_SHELLS = ["/bin/bash", "/usr/bin/fish", "/usr/bin/zsh"];
		const connect = (agentDefault: string) =>
			seedShellProfiles(hostId, UNIX_SHELLS, agentDefault, "linux", dal);
		const id = (name: string) => dal.getLaunchProfileByName(name)?.id ?? "";
		const defaults = () => menu("linux").filter((entry) => entry.endsWith("(default)"));
		/** What Settings > Profiles > "Set as Default" stores, through the hosts' profile routes. */
		const setAsDefault = (name: string) =>
			dal.upsertHostProfileOverride(hostId, id(name), "default");

		it("is the agent's on a host that has none", async () => {
			await connect("/bin/bash");

			expect(defaults()).toEqual(["bash (default)"]);
			expect(dal.getHostDefaultOverride(hostId)).toMatchObject({
				profileId: id("bash"),
				setByUser: false,
			});
		});

		it("stays the one the user set when the host connects again", async () => {
			await connect("/bin/bash");
			setAsDefault("fish");

			await connect("/bin/bash");

			expect(defaults()).toEqual(["fish (default)"]);
			expect(menu("linux")).toEqual(["fish (default)", "bash", "zsh"]);
		});

		it("stays the one the user set when the agent's default changes", async () => {
			await connect("/bin/bash");
			// The user chose the agent's own default: it is theirs all the same
			setAsDefault("bash");

			await connect("/usr/bin/zsh");

			expect(defaults()).toEqual(["bash (default)"]);
		});

		it("follows the agent's default while the user has set none", async () => {
			await connect("/bin/bash");

			await connect("/usr/bin/zsh");

			expect(defaults()).toEqual(["zsh (default)"]);
		});

		it("is the agent's again once the profile the user set is deleted", async () => {
			await connect("/bin/bash");
			setAsDefault("fish");
			dal.deleteLaunchProfile(id("fish"));

			await connect("/bin/bash");

			expect(defaults()).toEqual(["bash (default)"]);
		});

		it("is the agent's again once the user clears theirs", async () => {
			await connect("/bin/bash");
			setAsDefault("fish");
			dal.deleteHostProfileOverride(hostId, id("fish"));

			await connect("/bin/bash");

			expect(defaults()).toEqual(["bash (default)"]);
		});

		it("is never a profile the user hid", async () => {
			await connect("/bin/bash");
			dal.upsertHostProfileOverride(hostId, id("bash"), "hide");

			await connect("/bin/bash");

			expect(menu("linux")).toEqual(["fish", "zsh"]);
			expect(dal.getHostDefaultOverride(hostId)).toBeUndefined();
		});

		// Edit Host's "Automatic" (#802): the user's default goes, and the
		// agent's applies to the next terminal, not after the next connection.
		describe("given back at once when the user's goes (restoreAgentDefaultProfile)", () => {
			/** A host as its last connection left it: its agent reported bash. */
			async function connected(): Promise<void> {
				dal.updateHostDiscoveredShells(hostId, UNIX_SHELLS, "/bin/bash");
				await connect("/bin/bash");
			}

			it("is the agent's once the user clears theirs", async () => {
				await connected();
				setAsDefault("fish");
				dal.deleteHostProfileOverride(hostId, id("fish"));

				restoreAgentDefaultProfile(hostId, dal);

				expect(defaults()).toEqual(["bash (default)"]);
				expect(dal.getHostDefaultOverride(hostId)?.setByUser).toBe(false);
			});

			it("is the agent's once the profile the user set is deleted", async () => {
				await connected();
				setAsDefault("fish");
				dal.deleteLaunchProfile(id("fish"));

				restoreAgentDefaultProfile(hostId, dal);

				expect(defaults()).toEqual(["bash (default)"]);
			});

			it("leaves a default the host has, the user's or the hub's", async () => {
				await connected();
				setAsDefault("fish");

				restoreAgentDefaultProfile(hostId, dal);

				expect(dal.getHostDefaultOverride(hostId)).toMatchObject({
					profileId: id("fish"),
					setByUser: true,
				});
			});

			// One the user deleted comes back with the next connection, as it did.
			it("brings back no profile the user deleted, and marks none", async () => {
				await connected();
				dal.deleteLaunchProfile(id("bash"));

				restoreAgentDefaultProfile(hostId, dal);

				expect(dal.getLaunchProfileByName("bash")).toBeUndefined();
				expect(dal.getHostDefaultOverride(hostId)).toBeUndefined();
			});

			it("marks none on a host whose agent never reported its default, nor a profile it hid", async () => {
				restoreAgentDefaultProfile(hostId, dal);
				expect(dal.getHostDefaultOverride(hostId)).toBeUndefined();

				await connected();
				dal.upsertHostProfileOverride(hostId, id("bash"), "hide");
				restoreAgentDefaultProfile(hostId, dal);
				expect(dal.getHostDefaultOverride(hostId)).toBeUndefined();
			});
		});
	});
});
