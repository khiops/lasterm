import type { Host, LaunchProfile } from "@lasterm/shared";
import type { MetaDAL } from "../storage/meta.js";

/**
 * Infer the OS of a host for launch profile filtering.
 *
 * Resolution order:
 * 1. Agent-reported shells (discoveredShells): infer from path patterns.
 * 2. Local host: use process.platform.
 * 3. SSH host without HELLO data: 'unknown' (show all profiles).
 *
 * @param host  The host record from meta.db.
 */
export function resolveHostOs(host: Host): string {
	// Prefer explicitly stored OS (set after auto-detect on first SSH connect)
	if (host.os != null) return host.os;
	if (host.discoveredShells && host.discoveredShells.length > 0) {
		const hasWindowsShells = host.discoveredShells.some(
			(s) => s.includes("\\") || s.toLowerCase().endsWith(".exe"),
		);
		if (hasWindowsShells) return "windows";
		const hasMacPaths = host.discoveredShells.some(
			(s) => s.includes("/usr/local/") || s.includes("/opt/homebrew/"),
		);
		if (hasMacPaths) return "darwin";
		return "linux";
	}
	if (host.type === "local") {
		if (process.platform === "win32") return "windows";
		if (process.platform === "darwin") return "darwin";
		return "linux";
	}
	return "unknown";
}

/**
 * The launch profile a terminal asked for with neither a shell nor a profile
 * starts on this host (#802): the first of the host's profile menu, as
 * `GET /api/hosts/:id/profiles` lists it and Ctrl+Shift+1 starts it.
 *
 * The menu lists the host's default profile first, the ✓ one: the one the
 * user chose (Edit Host's Default Shell, or Settings › Profiles), else the one
 * the hub marked for the default shell the host's agent reports. A host with
 * none marked starts its first profile; one with no profile at all, none, and
 * its agent starts its own default shell. The local host is no exception: its
 * agent's HELLO marks its default as an SSH host's does.
 */
export function hostDefaultProfile(
	host: Host,
	metaDal: Pick<MetaDAL, "listHostProfiles">,
): LaunchProfile | undefined {
	return metaDal.listHostProfiles(host.id, resolveHostOs(host))[0];
}
