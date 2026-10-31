import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
	discoverUnixShells,
	discoverWindowsShells,
	type EnvLookup,
	findWindowsTerminalSettingsPath,
	firstReportedWindowsShell,
	importWindowsTerminalProfiles,
	parseCommandLine,
	parseWindowsTerminalSettings,
	probeWslDistributions,
	reportedWindowsShell,
	seedShellProfiles,
} from "./shell-discovery.js";
import type { DatabaseManager } from "./storage/db.js";
import { openTestDatabases } from "./storage/db.js";
import { MetaDAL } from "./storage/meta.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		readFileSync: vi.fn(actual.readFileSync),
		readdirSync: vi.fn(actual.readdirSync),
	};
});

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(
			(_file: string, _args: string[], _options: unknown, callback: ProbeCallback) => {
				callback(new Error("not mocked"), "");
			},
		),
	};
});

type ProbeCallback = (error: Error | null, stdout: string) => void;

/** Answer every probe the discovery runs: what it prints, or the error it fails with. */
async function answerProbes(
	answer: (file: string, args: string[]) => string | Error,
): Promise<void> {
	const { execFile } = vi.mocked(await import("node:child_process"));
	execFile.mockImplementation(((
		file: string,
		args: string[],
		_options: unknown,
		callback: ProbeCallback,
	) => {
		const result = answer(file, args);
		if (result instanceof Error) callback(result, "");
		else callback(null, result);
	}) as unknown as typeof import("node:child_process").execFile);
}

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

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

// ─── parseCommandLine ─────────────────────────────────────────────────────────

describe("parseCommandLine", () => {
	it("splits a bare executable", () => {
		expect(parseCommandLine("pwsh.exe")).toEqual(["pwsh.exe"]);
	});

	it("splits an executable and args", () => {
		expect(parseCommandLine("bash.exe --login -i")).toEqual(["bash.exe", "--login", "-i"]);
	});

	it("handles a quoted path with spaces", () => {
		expect(parseCommandLine('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i')).toEqual([
			"C:\\Program Files\\Git\\bin\\bash.exe",
			"--login",
			"-i",
		]);
	});

	it("handles an absolute path without quotes", () => {
		expect(parseCommandLine("C:\\Windows\\System32\\cmd.exe")).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
		]);
	});

	it("returns empty array for empty string", () => {
		expect(parseCommandLine("")).toEqual([]);
	});

	it("collapses multiple spaces between tokens", () => {
		expect(parseCommandLine("wsl.exe  --distribution  Ubuntu")).toEqual([
			"wsl.exe",
			"--distribution",
			"Ubuntu",
		]);
	});
});

// ─── parseWindowsTerminalSettings ────────────────────────────────────────────

describe("parseWindowsTerminalSettings", () => {
	it("parses a typical settings.json structure", () => {
		const settings = JSON.stringify({
			profiles: {
				list: [
					{ name: "PowerShell", commandline: "pwsh.exe" },
					{ name: "Command Prompt", commandline: "cmd.exe" },
				],
			},
		});
		const result = parseWindowsTerminalSettings(settings);
		expect(result).toHaveLength(2);
		expect(result[0]?.name).toBe("PowerShell");
		expect(result[1]?.name).toBe("Command Prompt");
	});

	it("filters out hidden profiles", () => {
		const settings = JSON.stringify({
			profiles: {
				list: [
					{ name: "PowerShell", commandline: "pwsh.exe" },
					{ name: "Hidden", commandline: "hidden.exe", hidden: true },
				],
			},
		});
		const result = parseWindowsTerminalSettings(settings);
		expect(result).toHaveLength(1);
		expect(result[0]?.name).toBe("PowerShell");
	});

	it("returns empty array for invalid JSON", () => {
		expect(parseWindowsTerminalSettings("not json")).toEqual([]);
	});

	it("returns empty array when profiles.list is absent", () => {
		expect(parseWindowsTerminalSettings(JSON.stringify({ profiles: {} }))).toEqual([]);
	});

	it("returns empty array for empty profiles.list", () => {
		expect(parseWindowsTerminalSettings(JSON.stringify({ profiles: { list: [] } }))).toEqual([]);
	});

	it("extracts startingDirectory and icon", () => {
		const settings = JSON.stringify({
			profiles: {
				list: [
					{
						name: "Dev Shell",
						commandline: "pwsh.exe",
						startingDirectory: "C:\\dev",
						icon: "ms-appx:///Images/icon.png",
					},
				],
			},
		});
		const result = parseWindowsTerminalSettings(settings);
		expect(result[0]?.startingDirectory).toBe("C:\\dev");
		expect(result[0]?.icon).toBe("ms-appx:///Images/icon.png");
	});
});

// ─── importWindowsTerminalProfiles ───────────────────────────────────────────

describe("importWindowsTerminalProfiles", () => {
	let dbs: DatabaseManager;
	let dal: MetaDAL;

	beforeEach(() => {
		dbs = openTestDatabases();
		dal = new MetaDAL(dbs.meta);
	});

	afterEach(() => {
		dbs.close();
	});

	it("imports profiles from a parsed WT settings list", () => {
		const result = importWindowsTerminalProfiles(dal, [
			{ name: "PowerShell", commandline: "pwsh.exe" },
			{ name: "Command Prompt", commandline: "cmd.exe" },
		]);

		expect(result.imported).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.profiles).toHaveLength(2);

		const profiles = dal.listLaunchProfiles();
		expect(profiles).toHaveLength(2);
		expect(profiles[0]?.shell).toBe("pwsh.exe");
		expect(profiles[1]?.shell).toBe("cmd.exe");
	});

	it("skips profiles with no commandline", () => {
		const result = importWindowsTerminalProfiles(dal, [
			{ name: "PowerShell", commandline: "pwsh.exe" },
			{ name: "Azure Cloud Shell" }, // no commandline
		]);

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(1);
	});

	it("skips profiles that already exist by name (case-insensitive)", () => {
		dal.createLaunchProfile(makeProfile({ name: "PowerShell", shell: "pwsh.exe" }));

		const result = importWindowsTerminalProfiles(dal, [
			{ name: "PowerShell", commandline: "pwsh.exe" },
			{ name: "POWERSHELL", commandline: "pwsh.exe" }, // different casing
			{ name: "Command Prompt", commandline: "cmd.exe" },
		]);

		expect(result.imported).toBe(1); // only Command Prompt
		expect(result.skipped).toBe(2);
	});

	it("parses commandline with args", () => {
		importWindowsTerminalProfiles(dal, [
			{ name: "Git Bash", commandline: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i' },
		]);

		const profiles = dal.listLaunchProfiles();
		expect(profiles[0]?.shell).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
		expect(profiles[0]?.args).toEqual(["--login", "-i"]);
	});

	it("stores startingDirectory as cwd", () => {
		importWindowsTerminalProfiles(dal, [
			{
				name: "Dev Shell",
				commandline: "pwsh.exe",
				startingDirectory: "C:\\dev",
			},
		]);

		const profiles = dal.listLaunchProfiles();
		expect(profiles[0]?.cwd).toBe("C:\\dev");
	});

	it("sets supportedOs to windows for all imported profiles", () => {
		importWindowsTerminalProfiles(dal, [{ name: "PowerShell", commandline: "pwsh.exe" }]);

		const profiles = dal.listLaunchProfiles();
		expect(profiles[0]?.supportedOs).toBe("windows");
	});

	it("handles empty list gracefully", () => {
		const result = importWindowsTerminalProfiles(dal, []);
		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.profiles).toHaveLength(0);
	});
});

// ─── findWindowsTerminalSettingsPath ─────────────────────────────────────────

describe("findWindowsTerminalSettingsPath", () => {
	beforeEach(() => {
		vi.stubEnv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.mocked(existsSync).mockRestore();
	});

	it("returns null when LOCALAPPDATA is not set", () => {
		vi.unstubAllEnvs();
		vi.stubEnv("LOCALAPPDATA", "");
		// Without LOCALAPPDATA set, the function should return null
		mockExistsSync.mockReturnValue(false);
		const result = findWindowsTerminalSettingsPath();
		expect(result).toBeNull();
	});

	it("returns unpackaged path when it exists", () => {
		const unpackaged = join(
			"C:\\Users\\test\\AppData\\Local",
			"Microsoft",
			"Windows Terminal",
			"settings.json",
		);
		mockExistsSync.mockImplementation((p) => p === unpackaged);

		const result = findWindowsTerminalSettingsPath();
		expect(result).toBe(unpackaged);
	});

	it("returns null when no settings.json is found", async () => {
		mockExistsSync.mockReturnValue(false);
		const { readdirSync } = vi.mocked(await import("node:fs"));
		readdirSync.mockReturnValue([]);

		const result = findWindowsTerminalSettingsPath();
		expect(result).toBeNull();
	});
});

// ─── probeWslDistributions ────────────────────────────────────────────────────

describe("probeWslDistributions", () => {
	it("returns empty array when the probe fails", async () => {
		await answerProbes(() => new Error("wsl not installed"));

		const result = await probeWslDistributions("C:\\Windows\\System32\\wsl.exe");
		expect(result).toEqual([]);
	});

	it("parses UTF-16LE output and splits by newline", async () => {
		// Simulate UTF-16LE output (as a regular string: the probe asks for it decoded)
		await answerProbes(() => "Ubuntu\r\nDebian\r\n");

		const result = await probeWslDistributions("C:\\Windows\\System32\\wsl.exe");
		expect(result).toEqual(["Ubuntu", "Debian"]);
	});

	it("filters out empty lines from wsl output", async () => {
		await answerProbes(() => "Ubuntu\r\n\r\nDebian\r\n");

		const result = await probeWslDistributions("C:\\Windows\\System32\\wsl.exe");
		expect(result).toEqual(["Ubuntu", "Debian"]);
	});
});

// ─── discoverUnixShells ───────────────────────────────────────────────────────

describe.skipIf(process.platform === "win32")("discoverUnixShells", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.mocked(existsSync).mockRestore();
		vi.mocked(readFileSync).mockRestore();
	});

	/** Return a fake /etc/shells content listing the given paths. */
	function fakeEtcShells(...paths: string[]): string {
		return `# fake /etc/shells for tests\n${paths.join("\n")}\n`;
	}

	it("includes $SHELL when it exists", () => {
		vi.stubEnv("SHELL", "/bin/zsh");
		// /etc/shells is empty — only $SHELL is the source
		mockReadFileSync.mockReturnValue(fakeEtcShells());
		mockExistsSync.mockImplementation((p) => p === "/bin/zsh");

		const shells = discoverUnixShells();
		expect(shells.length).toBeGreaterThanOrEqual(1);
		expect(shells[0]?.shell).toBe("/bin/zsh");
		expect(shells[0]?.label).toBe("Zsh");
	});

	it("deduplicates $SHELL against /etc/shells entries with the same basename", () => {
		vi.stubEnv("SHELL", "/bin/bash");
		// /etc/shells also lists bash — it must appear only once
		mockReadFileSync.mockReturnValue(fakeEtcShells("/bin/bash", "/usr/bin/bash"));
		mockExistsSync.mockImplementation((p) => p === "/bin/bash");

		const shells = discoverUnixShells();
		const bashShells = shells.filter((s) => s.shell === "/bin/bash");
		expect(bashShells).toHaveLength(1);
	});

	it("includes /bin/bash and /bin/zsh when they exist in /etc/shells", () => {
		vi.stubEnv("SHELL", "");
		// Both shells listed in /etc/shells and both exist on disk
		mockReadFileSync.mockReturnValue(fakeEtcShells("/bin/bash", "/bin/zsh"));
		mockExistsSync.mockImplementation((p) => p === "/bin/bash" || p === "/bin/zsh");

		const shells = discoverUnixShells();
		const paths = shells.map((s) => s.shell);
		expect(paths).toContain("/bin/bash");
		expect(paths).toContain("/bin/zsh");
	});

	it("excludes /etc/shells entries that do not exist on disk", () => {
		vi.stubEnv("SHELL", "");
		// /etc/shells lists three shells but only bash is present on disk
		mockReadFileSync.mockReturnValue(fakeEtcShells("/bin/bash", "/bin/zsh", "/bin/fish"));
		mockExistsSync.mockImplementation((p) => p === "/bin/bash");

		const shells = discoverUnixShells();
		const paths = shells.map((s) => s.shell);
		expect(paths).toContain("/bin/bash");
		expect(paths).not.toContain("/bin/zsh");
		expect(paths).not.toContain("/bin/fish");
	});

	it("returns empty when no shells exist", () => {
		vi.stubEnv("SHELL", "");
		mockReadFileSync.mockReturnValue(fakeEtcShells("/bin/bash", "/bin/zsh"));
		mockExistsSync.mockReturnValue(false);

		const shells = discoverUnixShells();
		expect(shells).toHaveLength(0);
	});

	it("sets supportedOs to linux on linux platform", () => {
		vi.stubEnv("SHELL", "/bin/bash");
		mockReadFileSync.mockReturnValue(fakeEtcShells("/bin/bash"));
		mockExistsSync.mockImplementation((p) => p === "/bin/bash");
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");

		const shells = discoverUnixShells();
		expect(shells[0]?.supportedOs).toBe("linux");
	});
});

// seedShellProfiles tests are in shell-discovery-seed.spec.ts
// (separated because this file's global node:fs mock breaks DB migrations)

// ─── discoverWindowsShells ────────────────────────────────────────────────────

describe("discoverWindowsShells", () => {
	beforeEach(() => {
		vi.stubEnv("SystemRoot", "C:\\Windows");
		vi.stubEnv("ProgramFiles", "C:\\Program Files");
		vi.stubEnv("LOCALAPPDATA", "C:\\Users\\test\\AppData\\Local");
		vi.stubEnv("COMSPEC", "C:\\Windows\\System32\\cmd.exe");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.mocked(existsSync).mockRestore();
	});

	it("always includes Command Prompt via COMSPEC", async () => {
		mockExistsSync.mockReturnValue(false);
		await answerProbes(() => new Error("not found"));

		const shells = await discoverWindowsShells();
		const cmd = shells.find((s) => s.label === "Command Prompt");
		expect(cmd).toBeDefined();
		expect(cmd?.shell).toBe("C:\\Windows\\System32\\cmd.exe");
	});

	it("includes Windows PowerShell from System32 path when it exists", async () => {
		const ps1Path = join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		mockExistsSync.mockImplementation((p) => p === ps1Path);
		await answerProbes(() => new Error("not found"));

		const shells = await discoverWindowsShells();
		const ps = shells.find((s) => s.label === "Windows PowerShell");
		expect(ps).toBeDefined();
		expect(ps?.shell).toBe(ps1Path);
	});

	it("includes Git Bash when installed in Program Files", async () => {
		const gitBashPath = join("C:\\Program Files", "Git", "bin", "bash.exe");
		mockExistsSync.mockImplementation((p) => p === gitBashPath);
		await answerProbes(() => new Error("not found"));

		const shells = await discoverWindowsShells();
		const bash = shells.find((s) => s.label === "Git Bash");
		expect(bash).toBeDefined();
		expect(bash?.args).toEqual(["--login", "-i"]);
	});

	it("includes WSL distros when wsl.exe exists and returns distros", async () => {
		const wslPath = join("C:\\Windows", "System32", "wsl.exe");
		mockExistsSync.mockImplementation((p) => p === wslPath);
		// Only wsl.exe answers: where.exe finds nothing on PATH.
		await answerProbes((file) =>
			file.endsWith("wsl.exe") ? "Ubuntu\r\nDebian\r\n" : new Error("not found"),
		);

		const shells = await discoverWindowsShells();
		const ubuntu = shells.find((s) => s.label === "WSL: Ubuntu");
		const debian = shells.find((s) => s.label === "WSL: Debian");
		expect(ubuntu).toBeDefined();
		expect(ubuntu?.args).toEqual(["--distribution", "Ubuntu"]);
		expect(debian).toBeDefined();
	});

	it("all discovered shells have supportedOs=windows", async () => {
		mockExistsSync.mockReturnValue(false);
		await answerProbes(() => new Error("not found"));

		const shells = await discoverWindowsShells();
		for (const s of shells) {
			expect(s.supportedOs).toBe("windows");
		}
	});
});

// ─── A Store shell, by the path its updates keep (#818) ──────────────────────
//
// A Store app's package directory is named for its version, and its next update
// replaces it: a profile seeded with that path then fails to start (#816). Its
// app execution alias stays. The agent decides the same way (shell.rs).

/** Where a Store PowerShell's package lives, until its next update. */
const STORE_PACKAGE =
	"C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe";
const PACKAGE_PWSH = `${STORE_PACKAGE}\\pwsh.exe`;
const LOCAL_APP_DATA = "C:\\Users\\test\\AppData\\Local";
/** The Store PowerShell's app execution alias. */
const STORE_PWSH = `${LOCAL_APP_DATA}\\Microsoft\\WindowsApps\\pwsh.exe`;
const PROGRAM_FILES_PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function vars(pairs: Record<string, string>): EnvLookup {
	return (name) => pairs[name];
}

const WINDOWS_ENV = vars({ ProgramFiles: "C:\\Program Files", LOCALAPPDATA: LOCAL_APP_DATA });

/** A disk holding these files, and nothing else. */
function onDisk(...files: string[]): (path: string) => boolean {
	return (path) => files.includes(path);
}

describe("reportedWindowsShell (#818)", () => {
	it("reports a Store package's shell by its alias", () => {
		expect(reportedWindowsShell(PACKAGE_PWSH, WINDOWS_ENV, onDisk(STORE_PWSH))).toBe(STORE_PWSH);
	});

	it("reports none when the alias does not exist, or there is no LOCALAPPDATA to find it in", () => {
		expect(reportedWindowsShell(PACKAGE_PWSH, WINDOWS_ENV, onDisk())).toBeNull();
		for (const env of [
			vars({ ProgramFiles: "C:\\Program Files" }),
			vars({ ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "" }),
		]) {
			expect(reportedWindowsShell(PACKAGE_PWSH, env, () => true)).toBeNull();
		}
	});

	it("reports any other path as found", () => {
		for (const found of [
			PROGRAM_FILES_PWSH,
			POWERSHELL,
			STORE_PWSH,
			"C:\\Program Files\\WindowsAppsOld\\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe\\pwsh.exe",
		]) {
			expect(reportedWindowsShell(found, WINDOWS_ENV, () => false)).toBe(found);
		}
	});

	it("tells a Store package case aside", () => {
		expect(reportedWindowsShell(PACKAGE_PWSH.toLowerCase(), WINDOWS_ENV, onDisk(STORE_PWSH))).toBe(
			STORE_PWSH,
		);
		const shouting = vars({ ProgramFiles: "C:\\PROGRAM FILES\\", LOCALAPPDATA: LOCAL_APP_DATA });
		expect(reportedWindowsShell(PACKAGE_PWSH, shouting, onDisk(STORE_PWSH))).toBe(STORE_PWSH);
	});

	it("finds the Store packages under ProgramFiles, C:\\Program Files when it is unset or empty", () => {
		for (const env of [
			vars({ LOCALAPPDATA: LOCAL_APP_DATA }),
			vars({ LOCALAPPDATA: LOCAL_APP_DATA, ProgramFiles: "" }),
		]) {
			expect(reportedWindowsShell(PACKAGE_PWSH, env, onDisk(STORE_PWSH))).toBe(STORE_PWSH);
		}
		const elsewhere =
			"D:\\Apps\\WindowsApps\\Microsoft.PowerShell_7.6.8.0_x64__8wekyb3d8bbwe\\pwsh.exe";
		const env = vars({ LOCALAPPDATA: LOCAL_APP_DATA, ProgramFiles: "D:\\Apps" });
		expect(reportedWindowsShell(elsewhere, env, onDisk(STORE_PWSH))).toBe(STORE_PWSH);
	});
});

describe("firstReportedWindowsShell (#818)", () => {
	it("skips a Store package's path without an alias for the next where.exe line", () => {
		expect(
			firstReportedWindowsShell(
				[`${PACKAGE_PWSH}\r`, `${PROGRAM_FILES_PWSH}\r`, ""],
				WINDOWS_ENV,
				onDisk(),
			),
		).toBe(PROGRAM_FILES_PWSH);
		expect(firstReportedWindowsShell([`${PACKAGE_PWSH}\r`, ""], WINDOWS_ENV, onDisk())).toBeNull();
	});

	it("names the alias once when where.exe also finds it, whichever comes first", () => {
		for (const lines of [
			[PACKAGE_PWSH, STORE_PWSH],
			[STORE_PWSH, PACKAGE_PWSH],
		]) {
			expect(firstReportedWindowsShell(lines, WINDOWS_ENV, onDisk(STORE_PWSH))).toBe(STORE_PWSH);
		}
	});
});

describe("discoverWindowsShells with a Store PowerShell (#818)", () => {
	let platform: MockInstance;

	beforeEach(() => {
		// resolveFromPath asks where.exe on Windows only
		platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		vi.stubEnv("SystemRoot", "C:\\Windows");
		vi.stubEnv("ProgramFiles", "C:\\Program Files");
		vi.stubEnv("LOCALAPPDATA", LOCAL_APP_DATA);
		vi.stubEnv("COMSPEC", "C:\\Windows\\System32\\cmd.exe");
	});

	afterEach(() => {
		platform.mockRestore();
		vi.unstubAllEnvs();
		vi.mocked(existsSync).mockRestore();
	});

	/** where.exe prints `lines` for pwsh.exe, and finds nothing else. */
	async function whereFindsPwsh(...lines: string[]): Promise<void> {
		await answerProbes((file, args) =>
			file.endsWith("where.exe") && args[0] === "pwsh.exe"
				? `${lines.join("\r\n")}\r\n`
				: new Error("not found"),
		);
	}

	function powerShells(shells: { label: string; shell: string }[]): string[] {
		return shells.filter((shell) => shell.label === "PowerShell").map((shell) => shell.shell);
	}

	it("seeds a Store PowerShell by its alias, once, not by its package directory", async () => {
		mockExistsSync.mockImplementation((p) => p === STORE_PWSH);
		await whereFindsPwsh(PACKAGE_PWSH, STORE_PWSH);

		expect(powerShells(await discoverWindowsShells())).toEqual([STORE_PWSH]);
	});

	it("takes the next where.exe line when the package has no alias", async () => {
		mockExistsSync.mockReturnValue(false);
		await whereFindsPwsh(PACKAGE_PWSH, PROGRAM_FILES_PWSH);

		expect(powerShells(await discoverWindowsShells())).toEqual([PROGRAM_FILES_PWSH]);
	});

	it("seeds no PowerShell 7 that only its package directory holds", async () => {
		mockExistsSync.mockReturnValue(false);
		await whereFindsPwsh(PACKAGE_PWSH);

		const shells = await discoverWindowsShells();
		expect(powerShells(shells)).toEqual([]);
		expect(shells.map((shell) => shell.shell)).not.toContain(PACKAGE_PWSH);
	});
});

// ─── Probing without holding the hub ─────────────────────────────────────────
//
// Discovery ran `execFileSync` inside an `async` function, which is synchronous
// up to its first `await`: a hub's first start stood still for as long as
// `where.exe` and `wsl.exe` took — two seconds alone, twenty and more on a
// loaded machine, long enough for a client, or a test, to give up on it.

describe("shell discovery off the event loop", () => {
	beforeEach(() => {
		vi.stubEnv("SystemRoot", "C:Windows");
		vi.stubEnv("COMSPEC", "C:WindowsSystem32cmd.exe");
		mockExistsSync.mockReturnValue(false);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.mocked(existsSync).mockRestore();
	});

	it("starts every probe at once and answers only when they have", async () => {
		const pending: ProbeCallback[] = [];
		const { execFile } = vi.mocked(await import("node:child_process"));
		execFile.mockImplementation(((
			_file: string,
			_args: string[],
			_options: unknown,
			callback: ProbeCallback,
		) => {
			pending.push(callback);
		}) as unknown as typeof import("node:child_process").execFile);

		let done = false;
		const discovery = discoverWindowsShells().then((shells) => {
			done = true;
			return shells;
		});
		await new Promise((resolve) => setImmediate(resolve));

		// pwsh, powershell and bash on PATH, and where wsl.exe is: together.
		expect(pending).toHaveLength(4);
		expect(done).toBe(false);

		for (const callback of pending.splice(0)) callback(new Error("not found"), "");
		const shells = await discovery;
		expect(shells.map((shell) => shell.label)).toContain("Command Prompt");
	});

	it.skipIf(process.platform !== "win32")(
		"seeds nothing when someone made a profile while it was probing",
		async () => {
			// The migrations read their SQL from disk, through the very functions
			// earlier tests in this file answer for: give them the real ones back.
			const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
			vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
			vi.mocked(readdirSync).mockImplementation(fs.readdirSync);
			mockExistsSync.mockImplementation(fs.existsSync);
			const dbs = openTestDatabases();
			mockExistsSync.mockReturnValue(false);
			try {
				const dal = new MetaDAL(dbs.meta);
				await answerProbes(() => {
					// The hub serves while discovery runs: a profile can appear.
					if (dal.countLaunchProfiles() === 0) dal.createLaunchProfile(makeProfile());
					return new Error("not found");
				});

				const result = await seedShellProfiles(dal);

				expect(result.profilesCreated).toBe(0);
				expect(dal.countLaunchProfiles()).toBe(1);
			} finally {
				dbs.close();
			}
		},
	);
});
