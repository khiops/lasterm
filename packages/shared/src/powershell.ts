/**
 * PowerShell and its directory (#839).
 *
 * `Set-Location` moves PowerShell's location but not its process directory, so
 * an agent cannot read where it is (#834). PowerShell says it on every prompt
 * instead: with the snippet the README gives for `$PROFILE`, or with a launch
 * profile's `reportDirectory`, which has a Windows agent start the shell with
 * that same snippet.
 */

/**
 * The README's section on both, which a client links to where it cannot follow
 * a PowerShell terminal: the files panel's "How to make it" (#836), the launch
 * profile form.
 */
export const POWERSHELL_DIRECTORY_HELP_URL =
	"https://github.com/khiops/lasterm#following-powershells-directory";

/**
 * Whether `shell` names a PowerShell, as an agent applies a launch profile's
 * `reportDirectory`: its file name is `pwsh` or `powershell`, with or without
 * `.exe`, in any case.
 */
export function isPowerShell(shell: string): boolean {
	const name = (shell.split(/[\\/]/).pop() ?? "").toLowerCase();
	const stem = name.endsWith(".exe") ? name.slice(0, -".exe".length) : name;
	return stem === "pwsh" || stem === "powershell";
}
