import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
export function discoverWindowsShells(): DiscoveredShell[] {
	const shells: DiscoveredShell[] = [];

	// PowerShell Core (pwsh.exe) — modern, cross-platform
	const pwshPaths = [
		join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
		join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "pwsh.exe"),
	];
	const pwshFromPath = resolveFromPath("pwsh.exe");
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
	const powershellFromPath = resolveFromPath("powershell.exe");
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
	const gitBashFromPath = resolveFromPath("bash.exe");
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
	const wslExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe");
	const wslPath = existsSync(wslExe) ? wslExe : (resolveFromPath("wsl.exe") ?? null);
	if (wslPath) {
		const wslDistros = probeWslDistributions(wslPath);
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
 * Idempotent: does nothing when profiles already exist (same guard as
 * `migrateLegacyShellDefaults`).
 *
 * Returns the number of profiles created (0 if already seeded).
 */
export async function seedShellProfiles(metaDal: MetaDAL): Promise<ShellDiscoveryResult> {
	// Idempotency guard — consistent with migrateLegacyShellDefaults
	if (metaDal.countLaunchProfiles() > 0) {
		return { profilesCreated: 0, profiles: [] };
	}

	const discovered = process.platform === "win32" ? discoverWindowsShells() : discoverUnixShells();

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
 * Resolve a bare executable name (e.g. "pwsh.exe") to an absolute path via
 * the OS path resolution mechanism.
 *
 * On Windows: uses `where.exe` (no shell involved — execFileSync with fixed args).
 * On Unix: uses `which` (for testing on non-Windows hosts only).
 *
 * Returns null when the executable is not on PATH or the command fails.
 */
export function resolveFromPath(executable: string): string | null {
	try {
		if (process.platform === "win32") {
			// where.exe is always present in System32 — use absolute path to avoid PATH injection
			const whereExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
			const firstLine = (
				execFileSync(whereExe, [executable], {
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 3000,
				})
					.trim()
					.split("\n")[0] ?? ""
			).trim();
			return firstLine.length > 0 ? firstLine : null;
		}
		// Unix fallback — only used in tests / non-Windows environments
		const result = execFileSync("which", [executable], {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 3000,
		}).trim();
		return result.length > 0 ? result : null;
	} catch {
		return null;
	}
}

/**
 * Run `wsl --list --quiet` and parse the distribution names.
 * Returns an empty array when WSL is not installed or returns no distros.
 *
 * @param wslPath - absolute path to wsl.exe (never comes from user input)
 */
export function probeWslDistributions(wslPath: string): string[] {
	try {
		const output = execFileSync(wslPath, ["--list", "--quiet"], {
			encoding: "utf16le", // WSL outputs UTF-16LE
			stdio: ["pipe", "pipe", "pipe"],
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
