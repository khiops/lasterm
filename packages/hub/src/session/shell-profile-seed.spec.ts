import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseManager } from "../storage/db.js";
import { openTestDatabases } from "../storage/db.js";
import { MetaDAL } from "../storage/meta.js";
import { seedShellProfiles } from "./shell-profile-seed.js";

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
});
