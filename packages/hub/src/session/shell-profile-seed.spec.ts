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

	// A profile is the hub's, not a host's: one seeded from another machine,
	// the Store PowerShell of the hub's own, bears the file name of a shell a
	// Windows Server reports at another path. Reusing it by that name started
	// a path the server does not have, and it became the server's default
	// (#816).
	describe("a shell whose file name a profile launching another path bears (#816)", () => {
		const STORE_PWSH =
			"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe";
		const SERVER_PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const SERVER_CMD = "C:\\Windows\\system32\\cmd.exe";
		const SERVER_SHELLS = [SERVER_PWSH, SERVER_CMD];
		const QUALIFIED = "pwsh.exe (C:\\Program Files\\PowerShell\\7)";
		let serverId: string;

		/** The hub's own "pwsh.exe", seeded from its machine before the server was added. */
		function storePwsh() {
			return dal.createLaunchProfile({
				name: "pwsh.exe",
				shell: STORE_PWSH,
				mode: "shell",
				elevated: false,
				supportedOs: "windows",
				iconType: "auto",
				sortOrder: 1,
			});
		}

		/** The 0.15.2 agent's HELLO: PowerShell 7 its default (#806). */
		const connect = () => seedShellProfiles(serverId, SERVER_SHELLS, SERVER_PWSH, "windows", dal);
		const defaultOf = () => {
			const marked = dal.getHostDefaultOverride(serverId);
			const profile = marked && dal.getLaunchProfile(marked.profileId);
			return profile && { name: profile.name, shell: profile.shell, setByUser: marked.setByUser };
		};

		beforeEach(() => {
			discoveredWindowsProfiles();
			serverId = dal.createHost({
				type: "ssh",
				label: "server",
				sshHost: "admin@server",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
				os: "windows",
			}).id;
		});

		it("gets a profile of its own, named after its directory, and the other is left alone", async () => {
			const store = storePwsh();

			await connect();

			expect(dal.getLaunchProfileByName(QUALIFIED)?.shell).toBe(SERVER_PWSH);
			expect(dal.getLaunchProfile(store.id)).toEqual(store);
			expect(dal.getHostLaunchProfileOverride(serverId, store.id)).toBeUndefined();
			expect(defaultOf()).toEqual({ name: QUALIFIED, shell: SERVER_PWSH, setByUser: false });
		});

		it("seeds nothing more at the next connection", async () => {
			storePwsh();
			await connect();
			const profiles = dal.listLaunchProfiles();

			await connect();

			expect(dal.listLaunchProfiles()).toEqual(profiles);
			expect(defaultOf()?.name).toBe(QUALIFIED);
		});

		// What a hub before #816 left: its mark on the profile bearing the name.
		it("takes the hub's mark off a profile launching another path", async () => {
			const store = storePwsh();
			dal.upsertHostProfileOverride(serverId, store.id, "default", undefined, false);

			await connect();

			expect(defaultOf()).toEqual({ name: QUALIFIED, shell: SERVER_PWSH, setByUser: false });
			expect(dal.getLaunchProfile(store.id)).toEqual(store);
		});

		it("never takes off the user's, whatever path it launches", async () => {
			const store = storePwsh();
			dal.upsertHostProfileOverride(serverId, store.id, "default");

			await connect();

			expect(defaultOf()).toEqual({ name: "pwsh.exe", shell: STORE_PWSH, setByUser: true });
		});

		it("is numbered when its directory's name is taken too", async () => {
			storePwsh();
			dal.createLaunchProfile({
				name: QUALIFIED,
				shell: "C:\\Tools\\pwsh.exe",
				mode: "shell",
				elevated: false,
				supportedOs: "windows",
				iconType: "auto",
				sortOrder: 7,
			});

			await connect();

			expect(dal.getLaunchProfileByName(`${QUALIFIED} 2`)?.shell).toBe(SERVER_PWSH);
			expect(dal.getLaunchProfileByName(QUALIFIED)?.shell).toBe("C:\\Tools\\pwsh.exe");
		});

		it("renames a path-named seed of its own to a name that is free", async () => {
			storePwsh();
			const stale = dal.createLaunchProfile({
				name: SERVER_PWSH,
				shell: SERVER_PWSH,
				mode: "shell",
				elevated: false,
				supportedOs: "linux",
				iconType: "auto",
				sortOrder: 0,
			});

			await connect();

			expect(dal.getLaunchProfile(stale.id)?.name).toBe(QUALIFIED);
			expect(dal.getLaunchProfileByName("pwsh.exe")?.shell).toBe(STORE_PWSH);
			expect(defaultOf()?.name).toBe(QUALIFIED);
		});

		it("is told apart on a Unix host by its directory too", async () => {
			const other = dal.createHost({
				type: "ssh",
				label: "usrmerged",
				sshHost: "me@usrmerged",
				sshAuth: "key",
				sshKeyPath: "/nonexistent/key",
				os: "linux",
			}).id;
			await seedShellProfiles(hostId, ["/bin/bash"], "/bin/bash", "linux", dal);

			await seedShellProfiles(other, ["/usr/bin/bash"], "/usr/bin/bash", "linux", dal);

			expect(dal.getLaunchProfileByName("bash")?.shell).toBe("/bin/bash");
			expect(dal.getLaunchProfileByName("bash (/usr/bin)")?.shell).toBe("/usr/bin/bash");
			expect(dal.getLaunchProfile(dal.getHostDefaultOverride(other)?.profileId ?? "")?.shell).toBe(
				"/usr/bin/bash",
			);
		});

		// Edit Host's "Automatic": only a profile launching the reported shell.
		it("is not marked by restoreAgentDefaultProfile before it has a profile", () => {
			storePwsh();
			dal.updateHostDiscoveredShells(serverId, SERVER_SHELLS, SERVER_PWSH);

			restoreAgentDefaultProfile(serverId, dal);

			expect(dal.getHostDefaultOverride(serverId)).toBeUndefined();
		});
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
