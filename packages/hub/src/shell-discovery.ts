import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, win32 } from "node:path";
import type { LaunchProfile } from "@lasterm/shared";
import type { MetaDAL } from "./storage/meta.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredShell {
	label: string;
	shell: string;
	args?: string[];
	supportedOs: LaunchProfile["supportedOs"];
	iconType: LaunchProfile["iconType"];
	iconValue?: string;
}

export interface ShellDiscoveryResult {
	profilesCreated: number;
	profiles: LaunchProfile[];
}

// ─── Windows shell probing ────────────────────────────────────────────────────

/**
 * Probe for shells available on Windows.
 *
 * Priority order (first discovered becomes the default):
 *   1. PowerShell Core (pwsh.exe) — modern, cross-platform
 *   2. Windows PowerShell (powershell.exe) — built-in
 *   3. Command Prompt (cmd.exe) — always present
 *   4. Git Bash (bash.exe) — if Git for Windows is installed
 *   5. WSL distributions — one entry per distro via wsl.exe
 */
export async function discoverWindowsShells(): Promise<DiscoveredShell[]> {
	const shells: DiscoveredShell[] = [];

	// Every probe is a process, and on a loaded machine each can take seconds:
	// they run together, and off the event loop the hub is starting on.
	const wslExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
	const [pwshFromPath, powershellFromPath, gitBashFromPath, wslPath] = await Promise.all([
		resolveFromPath("pwsh.exe"),
		resolveFromPath("powershell.exe"),
		resolveFromPath("bash.exe"),
		existsSync(wslExe) ? Promise.resolve(wslExe) : resolveFromPath("wsl.exe"),
	]);
	const wslDistros = wslPath ? await probeWslDistributions(wslPath) : [];

	// PowerShell Core (pwsh.exe) — modern, cross-platform
	const pwshPaths = [
		join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
		join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "pwsh.exe"),
	];
	const pwsh = pwshFromPath ?? pwshPaths.find((p) => existsSync(p)) ?? null;
	if (pwsh) {
		shells.push({
			label: "PowerShell",
			shell: pwsh,
			supportedOs: "windows",
			iconType: "auto",
		});
	}

	// Windows PowerShell (powershell.exe) — built-in
	const powershellFixed = join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const powershell = existsSync(powershellFixed) ? powershellFixed : (powershellFromPath ?? null);
	if (powershell) {
		shells.push({
			label: "Windows PowerShell",
			shell: powershell,
			supportedOs: "windows",
			iconType: "auto",
		});
	}

	// Command Prompt (cmd.exe) — always available
	const cmdPath =
		process.env.COMSPEC ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
	shells.push({
		label: "Command Prompt",
		shell: cmdPath,
		supportedOs: "windows",
		iconType: "auto",
	});

	// Git Bash — check common install locations + PATH
	const localAppData = process.env.LOCALAPPDATA ?? "";
	const bashPaths = [
		join("C:\\Program Files", "Git", "bin", "bash.exe"),
		join("C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
		...(localAppData ? [join(localAppData, "Programs", "Git", "bin", "bash.exe")] : []),
	];
	const gitBash = bashPaths.find((p) => existsSync(p)) ?? gitBashFromPath ?? null;
	if (gitBash) {
		shells.push({
			label: "Git Bash",
			shell: gitBash,
			args: ["--login", "-i"],
			supportedOs: "windows",
			iconType: "auto",
		});
	}

	// WSL distributions — one profile per distro, using wsl.exe
	if (wslPath) {
		for (const distro of wslDistros) {
			shells.push({
				label: `WSL: ${distro}`,
				shell: wslPath,
				args: ["--distribution", distro],
				supportedOs: "windows",
				iconType: "auto",
			});
		}
	}

	return shells;
}

/**
 * Probe for shells available on Unix/Linux/macOS.
 *
 * Reads `/etc/shells` (POSIX standard, works on Linux + macOS), deduplicates
 * by basename (e.g. `/bin/bash` and `/usr/bin/bash` → one "Bash" profile),
 * and puts $SHELL first so it becomes the default.
 */
export function discoverUnixShells(): DiscoveredShell[] {
	const shells: DiscoveredShell[] = [];
	const seenPaths = new Set<string>();
	const seenBasenames = new Set<string>();

	const platform = process.platform;
	const os: LaunchProfile["supportedOs"] = platform === "darwin" ? "darwin" : "linux";

	function add(shellPath: string): void {
		if (seenPaths.has(shellPath)) return;
		const base = basename(shellPath);
		if (seenBasenames.has(base)) return;
		if (!existsSync(shellPath)) return;
		seenPaths.add(shellPath);
		seenBasenames.add(base);
		shells.push({
			label: shellBasenameToLabel(shellPath),
			shell: shellPath,
			supportedOs: os,
			iconType: "auto",
		});
	}

	// $SHELL first — user's preferred shell becomes the default profile
	const envShell = process.env.SHELL;
	if (envShell && envShell.length > 0) {
		add(envShell);
	}

	// Parse /etc/shells (POSIX standard — one absolute path per line, # comments)
	const etcShells = parseEtcShells();
	for (const shellPath of etcShells) {
		add(shellPath);
	}

	return shells;
}

/**
 * Parse /etc/shells — returns valid shell paths.
 * Format: one absolute path per line, lines starting with # are comments.
 * Works on Linux, macOS, and most BSDs.
 */
export function parseEtcShells(): string[] {
	try {
		const content = readFileSync("/etc/shells", "utf8");
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#") && line.startsWith("/"));
	} catch {
		return [];
	}
}

// ─── Auto-creation on first startup ──────────────────────────────────────────

/**
 * Detect available shells and seed the `launch_profiles` table.
 *
 * Idempotent: does nothing when profiles already exist.
 *
 * Returns the number of profiles created (0 if already seeded).
 */
export async function seedShellProfiles(metaDal: MetaDAL): Promise<ShellDiscoveryResult> {
	// Idempotency guard
	if (metaDal.countLaunchProfiles() > 0) {
		return { profilesCreated: 0, profiles: [] };
	}

	const discovered =
		process.platform === "win32" ? await discoverWindowsShells() : discoverUnixShells();

	// The probes took time, and the hub was serving meanwhile: a profile made in
	// that window means someone has already chosen, and seeding now would
	// surround their choice with a dozen they did not ask for.
	if (metaDal.countLaunchProfiles() > 0) {
		return { profilesCreated: 0, profiles: [] };
	}

	if (discovered.length === 0) {
		return { profilesCreated: 0, profiles: [] };
	}

	const created: LaunchProfile[] = [];

	for (const [i, discovered_shell] of discovered.entries()) {
		// Skip if a profile with this name already exists (defensive — shouldn't
		// happen on first boot but guards against race conditions)
		const existing = metaDal.getLaunchProfileByName(discovered_shell.label);
		if (existing) continue;

		const profile = metaDal.createLaunchProfile({
			name: discovered_shell.label,
			shell: discovered_shell.shell,
			mode: "shell",
			elevated: false,
			supportedOs: discovered_shell.supportedOs,
			iconType: discovered_shell.iconType,
			sortOrder: i,
			...(discovered_shell.args !== undefined && discovered_shell.args.length > 0
				? { args: discovered_shell.args }
				: {}),
			...(discovered_shell.iconValue !== undefined
				? { iconValue: discovered_shell.iconValue }
				: {}),
		});

		created.push(profile);
	}

	return { profilesCreated: created.length, profiles: created };
}

// ─── Windows Terminal import ──────────────────────────────────────────────────

export interface WindowsTerminalProfile {
	name: string;
	commandline?: string;
	startingDirectory?: string;
	icon?: string;
	hidden?: boolean;
}

export interface WindowsTerminalSettings {
	profiles?: {
		list?: WindowsTerminalProfile[];
	};
}

export interface WtImportResult {
	imported: number;
	skipped: number;
	profiles: LaunchProfile[];
}

/**
 * Locate Windows Terminal's settings.json.
 *
 * Two possible locations:
 *   1. Unpackaged (msstore/winget): %LOCALAPPDATA%\Microsoft\Windows Terminal\settings.json
 *   2. Packaged (Store): %LOCALAPPDATA%\Packages\Microsoft.WindowsTerminal_*\LocalState\settings.json
 */
export function findWindowsTerminalSettingsPath(): string | null {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return null;

	// Unpackaged location (try first — simpler path)
	const unpackaged = join(localAppData, "Microsoft", "Windows Terminal", "settings.json");
	if (existsSync(unpackaged)) return unpackaged;

	// Packaged (Store version): look for the package directory
	const packagesDir = join(localAppData, "Packages");
	if (!existsSync(packagesDir)) return null;

	try {
		const entries = readdirSync(packagesDir);
		for (const entry of entries) {
			if (entry.startsWith("Microsoft.WindowsTerminal_")) {
				const candidate = join(packagesDir, entry, "LocalState", "settings.json");
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// Packages directory not accessible
	}

	return null;
}

/**
 * Parse Windows Terminal settings.json and return profile descriptors.
 */
export function parseWindowsTerminalSettings(settingsJson: string): WindowsTerminalProfile[] {
	let parsed: WindowsTerminalSettings;
	try {
		parsed = JSON.parse(settingsJson) as WindowsTerminalSettings;
	} catch {
		return [];
	}

	const list = parsed?.profiles?.list;
	if (!Array.isArray(list)) return [];

	return list.filter((p): p is WindowsTerminalProfile => {
		return (
			typeof p === "object" &&
			p !== null &&
			typeof p.name === "string" &&
			p.name.length > 0 &&
			p.hidden !== true
		);
	});
}

/**
 * Import profiles from Windows Terminal settings into the launch_profiles table.
 *
 * Skips profiles that:
 *  - have no `commandline` (fragment or dynamic profiles with no explicit command)
 *  - already exist by name (case-insensitive)
 */
export function importWindowsTerminalProfiles(
	metaDal: MetaDAL,
	profiles: WindowsTerminalProfile[],
): WtImportResult {
	let imported = 0;
	let skipped = 0;
	const createdProfiles: LaunchProfile[] = [];

	const existing = new Set(metaDal.listLaunchProfiles().map((p) => p.name.toLowerCase()));

	for (const [i, wtp] of profiles.entries()) {
		// Skip entries with no commandline (built-in dynamic profiles like "Azure Cloud Shell")
		if (!wtp.commandline || wtp.commandline.trim().length === 0) {
			skipped++;
			continue;
		}

		// Skip if already exists by name
		if (existing.has(wtp.name.toLowerCase())) {
			skipped++;
			continue;
		}

		// Parse commandline: first token is the shell, rest are args
		const parts = parseCommandLine(wtp.commandline.trim());
		if (parts.length === 0) {
			skipped++;
			continue;
		}

		const [shellBin, ...args] = parts;
		// parts is guaranteed non-empty here — shellBin is always defined
		const shell = shellBin as string;

		const sortBase = metaDal.countLaunchProfiles();

		const profile = metaDal.createLaunchProfile({
			name: wtp.name,
			shell,
			mode: "shell",
			elevated: false,
			supportedOs: "windows",
			iconType: "auto",
			sortOrder: sortBase + i,
			...(args.length > 0 ? { args } : {}),
			...(wtp.startingDirectory && wtp.startingDirectory.length > 0
				? { cwd: wtp.startingDirectory }
				: {}),
		});

		existing.add(wtp.name.toLowerCase());
		createdProfiles.push(profile);
		imported++;
	}

	return { imported, skipped, profiles: createdProfiles };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a probe and return what it printed, without holding the event loop.
 *
 * These ran through `execFileSync` inside an `async` function, which is still
 * synchronous up to its first `await`: a hub's first start stood still for as
 * long as `where.exe` and `wsl.exe` took — two seconds alone, over twenty on a
 * loaded machine — and a client waiting for it to listen waited as long.
 * `windowsHide` keeps each probe from flashing a console window over the app.
 */
function runProbe(
	file: string,
	args: string[],
	options: { encoding: BufferEncoding; timeout: number },
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { ...options, windowsHide: true }, (error, stdout) => {
			if (error) reject(error);
			else resolve(String(stdout));
		});
	});
}

/**
 * Resolve a bare executable name (e.g. "pwsh.exe") to an absolute path via
 * the OS path resolution mechanism.
 *
 * On Windows: uses `where.exe` (no shell involved — execFile with fixed args),
 * and takes the first path it prints as {@link firstReportedWindowsShell} does:
 * a Store app's by its alias, never by its versioned directory (#818) nor by
 * a second alias (#821).
 * On Unix: uses `which` (for testing on non-Windows hosts only).
 *
 * Resolves null when the executable is not on PATH or the command fails.
 */
export async function resolveFromPath(executable: string): Promise<string | null> {
	try {
		if (process.platform === "win32") {
			// where.exe is always present in System32 — use absolute path to avoid PATH injection
			const whereExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
			const output = await runProbe(whereExe, [executable], { encoding: "utf8", timeout: 3000 });
			return firstReportedWindowsShell(
				output.split("\n"),
				(name) => process.env[name],
				linkOrFileExists,
			);
		}
		// Unix fallback — only used in tests / non-Windows environments
		const result = (
			await runProbe("which", [executable], { encoding: "utf8", timeout: 3000 })
		).trim();
		return result.length > 0 ? result : null;
	} catch {
		return null;
	}
}

// ─── A Store shell, by the path its updates keep (#818) ──────────────────────

/** Reads an environment variable: `undefined` when it is unset. */
export type EnvLookup = (name: string) => string | undefined;

/**
 * Whether something is at `path`, a link included, without following it.
 *
 * An app execution alias is a reparse point Node cannot open: `existsSync`
 * says it is not there, and `statSync` fails with EACCES. `lstatSync` reads
 * the link itself, which is what tells whether the alias exists (#818).
 */
export function linkOrFileExists(path: string): boolean {
	try {
		return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
	} catch {
		return false;
	}
}

/**
 * The first of `found`, the lines `where.exe` printed, that
 * {@link reportedWindowsShell} reports, as it reports it: a line it does not
 * report leaves the search to the next. Blank lines, and the `\r` that ends
 * each line, are ignored. `null` when none is reported.
 */
export function firstReportedWindowsShell(
	found: readonly string[],
	env: EnvLookup,
	exists: (path: string) => boolean,
): string | null {
	for (const line of found) {
		const path = line.trim();
		if (path.length === 0) continue;
		const reported = reportedWindowsShell(path, env, exists);
		if (reported !== null) return reported;
	}
	return null;
}

/**
 * The path a Windows shell found at `found` is reported by, as the agent's
 * `reported_windows_shell` decides it: a Store app's by its app execution
 * alias, `%LOCALAPPDATA%\Microsoft\WindowsApps\<file name>`, which is one path
 * for one app, and which its updates keep.
 *
 * - Under `%ProgramFiles%\WindowsApps`, a Store app lives in a package
 *   directory named for its version, which the app's next Store update
 *   replaces: a launch profile seeded with that path then fails to start
 *   (#816, #818). Reported by its alias, or not at all (`null`) when that
 *   alias does not exist.
 * - Under `%LOCALAPPDATA%\Microsoft\WindowsApps`, an app also has an alias in
 *   a folder named for its package family, such as
 *   `Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe`: the same shell by a second
 *   path (#821). Reported by the alias beside that folder when it exists, else
 *   as found: it stays.
 * - Any other path is reported as found.
 *
 * `ProgramFiles` is `C:\Program Files` when unset or empty; paths are compared
 * case aside, as Windows reads them.
 */
export function reportedWindowsShell(
	found: string,
	env: EnvLookup,
	exists: (path: string) => boolean,
): string | null {
	const set = (name: string): string | undefined => {
		const value = env(name);
		return value !== undefined && value.length > 0 ? value : undefined;
	};
	const localAppData = set("LOCALAPPDATA");
	const aliases =
		localAppData === undefined ? undefined : win32.join(localAppData, "Microsoft", "WindowsApps");
	const alias = (): string | null => {
		if (aliases === undefined) return null;
		const path = win32.join(aliases, win32.basename(found));
		return exists(path) ? path : null;
	};

	const programFiles = set("ProgramFiles") ?? "C:\\Program Files";
	if (windowsDepthWithin(found, win32.join(programFiles, "WindowsApps")) > 0) return alias();
	if (aliases !== undefined && windowsDepthWithin(found, aliases) > 1) return alias() ?? found;
	return found;
}

/**
 * How many levels below the directory `dir` the Windows path `path` lies: 1
 * for a file in it, 2 for one in a folder of it, 0 when it is not inside it,
 * or is `dir` itself. Either separator, repeated or trailing ones aside, and
 * case aside.
 */
function windowsDepthWithin(path: string, dir: string): number {
	const parts = (of: string): string[] =>
		of
			.split(/[\\/]/)
			.filter((part) => part.length > 0)
			.map((part) => part.toLowerCase());
	const pathParts = parts(path);
	const dirParts = parts(dir);
	const inside =
		pathParts.length > dirParts.length && dirParts.every((part, i) => part === pathParts[i]);
	return inside ? pathParts.length - dirParts.length : 0;
}

/**
 * Run `wsl --list --quiet` and parse the distribution names.
 * Resolves an empty array when WSL is not installed or returns no distros.
 *
 * @param wslPath - absolute path to wsl.exe (never comes from user input)
 */
export async function probeWslDistributions(wslPath: string): Promise<string[]> {
	try {
		const output = await runProbe(wslPath, ["--list", "--quiet"], {
			encoding: "utf16le", // WSL outputs UTF-16LE
			timeout: 5000,
		});
		return output
			.split("\n")
			.map((line) => line.replace(/\r/g, "").trim())
			.filter((line) => line.length > 0);
	} catch {
		return [];
	}
}

/**
 * Map a shell path basename to a human-readable label.
 */
function shellBasenameToLabel(shellPath: string): string {
	const base = shellPath.split("/").pop()?.split("\\").pop() ?? shellPath;
	const map: Record<string, string> = {
		bash: "Bash",
		zsh: "Zsh",
		fish: "Fish",
		sh: "Shell",
		ksh: "KornShell",
		tcsh: "tcsh",
		csh: "csh",
		dash: "Dash",
		nu: "Nushell",
	};
	return map[base] ?? base;
}

/**
 * Naïve Windows commandline parser — handles double-quoted tokens.
 * Sufficient for shell paths like:
 *   `"C:\Program Files\Git\bin\bash.exe" --login -i`
 *   `C:\Windows\System32\cmd.exe`
 *   `pwsh.exe -NoExit`
 */
export function parseCommandLine(cmdline: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuote = false;

	for (let i = 0; i < cmdline.length; i++) {
		const ch = cmdline[i];
		if (ch === '"') {
			inQuote = !inQuote;
		} else if (ch === " " && !inQuote) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}
