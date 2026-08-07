import type { HostArch, HostOs } from "@lasterm/shared";

export interface OsDetectResult {
	os: HostOs;
	arch: HostArch;
}

/**
 * Parse output of `uname -sm` (Linux / macOS).
 *
 * Expected formats:
 *   "Linux x86_64"
 *   "Linux aarch64"
 *   "Darwin arm64"
 *   "Darwin x86_64"
 *
 * Returns null if the output cannot be parsed.
 */
export function parseUnameOutput(output: string): OsDetectResult | null {
	const trimmed = output.trim();
	if (!trimmed) return null;

	const parts = trimmed.split(/\s+/);
	if (parts.length < 2) return null;

	const sysname = parts[0];
	const machine = parts[1];

	if (!sysname || !machine) return null;

	let os: HostOs;
	if (sysname === "Linux") {
		os = "linux";
	} else if (sysname === "Darwin") {
		os = "darwin";
	} else {
		return null;
	}

	let arch: HostArch;
	const m = machine.toLowerCase();
	if (m === "x86_64" || m === "amd64") {
		arch = "x64";
	} else if (m === "aarch64" || m === "arm64") {
		arch = "arm64";
	} else {
		return null;
	}

	return { os, arch };
}

/**
 * Parse output of `echo %PROCESSOR_ARCHITECTURE%` (Windows cmd).
 *
 * Expected values: "AMD64", "ARM64"
 *
 * Returns null if the output cannot be parsed.
 */
export function parseWindowsArchOutput(output: string): OsDetectResult | null {
	const trimmed = output.trim().toUpperCase();
	if (!trimmed) return null;

	let arch: HostArch;
	if (trimmed === "AMD64") {
		arch = "x64";
	} else if (trimmed === "ARM64") {
		arch = "arm64";
	} else {
		return null;
	}

	return { os: "windows", arch };
}
