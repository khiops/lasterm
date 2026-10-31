import type { LaunchProfile, SupportedOs } from "@lasterm/shared";
import type { MetaDAL } from "../storage/meta.js";

/** A path as a Windows agent reports it: `C:\...`, or any backslash. */
function isWindowsPath(path: string): boolean {
	return /^[A-Za-z]:/.test(path) || path.includes("\\");
}

/**
 * Map a host's OS to a SupportedOs value for launch profiles. A host whose OS
 * was never detected, the local one among them, is told by its shell paths.
 */
function hostSupportedOs(os: string | null, shellPath: string): SupportedOs {
	if (os === "darwin") return "darwin";
	if (os === "windows") return "windows";
	if (os === "linux") return "linux";
	return isWindowsPath(shellPath) ? "windows" : "linux";
}

/** A shell's file name, whichever separator its path uses. */
function shellFileName(shellPath: string): string {
	return shellPath.split(/[\\/]/).at(-1) || shellPath;
}

/** Whether two paths name the same shell. Windows paths ignore case. */
function sameShell(a: string, b: string): boolean {
	return isWindowsPath(a) && isWindowsPath(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * A profile an earlier seeding named after a whole Windows path, since it read
 * a file name only after a `/`, and that nobody has edited since: it holds
 * nothing but the path, so a profile launching the same shell replaces it.
 */
function isPathNamedSeed(profile: LaunchProfile): boolean {
	return (
		profile.name === profile.shell &&
		isWindowsPath(profile.shell) &&
		profile.args === undefined &&
		profile.cwd === undefined &&
		profile.env === undefined &&
		profile.mode === "shell" &&
		!profile.elevated &&
		profile.iconType === "auto" &&
		profile.iconValue === undefined &&
		profile.color === undefined &&
		profile.profileOverrides === undefined
	);
}

/**
 * The profile seeding gives a shell, when one exists: one launching it with no
 * arguments, else one launching it, else one bearing its name. `stale` lists
 * the profiles an earlier seeding named after the whole path, which the
 * seeding renames or removes.
 */
function profileForShell(
	shellPath: string,
	profiles: LaunchProfile[],
	metaDal: Pick<MetaDAL, "getLaunchProfileByName">,
): { profile: LaunchProfile | undefined; stale: LaunchProfile[] } {
	const launching = profiles.filter((p) => sameShell(p.shell, shellPath));
	const stale = launching.filter(isPathNamedSeed);
	const current = launching.filter((p) => !isPathNamedSeed(p));
	const profile =
		current.find((p) => p.args === undefined) ??
		current[0] ??
		metaDal.getLaunchProfileByName(shellFileName(shellPath));
	return { profile, stale };
}

/**
 * Mark the profile of the agent's default shell as the host's default, unless
 * the user set one (#800), whichever it is, or hid this one. The mark is the
 * hub's (`set_by_user` 0): it follows the agent's default when that changes.
 */
function markAgentDefault(
	hostId: string,
	profileId: string,
	metaDal: Pick<
		MetaDAL,
		"getHostDefaultOverride" | "getHostLaunchProfileOverride" | "upsertHostProfileOverride"
	>,
): void {
	const marked = metaDal.getHostDefaultOverride(hostId);
	const hidden = metaDal.getHostLaunchProfileOverride(hostId, profileId)?.overrideType === "hide";
	if (!marked?.setByUser && marked?.profileId !== profileId && !hidden) {
		metaDal.upsertHostProfileOverride(hostId, profileId, "default", undefined, false);
	}
}

/**
 * Give a host that has no default profile the one of its agent's default
 * shell, as its agent last reported it, at once rather than at its next
 * connection: called when the user's default goes (#802), so that Edit
 * Host's "Automatic" applies to the next terminal. Marks only a profile that
 * exists: one the user deleted comes back with the next connection, as it
 * always did, not now. Nothing for a host whose agent never reported one.
 */
export function restoreAgentDefaultProfile(
	hostId: string,
	metaDal: Pick<
		MetaDAL,
		| "getHost"
		| "listLaunchProfiles"
		| "getLaunchProfileByName"
		| "getHostDefaultOverride"
		| "getHostLaunchProfileOverride"
		| "upsertHostProfileOverride"
	>,
): void {
	if (metaDal.getHostDefaultOverride(hostId) !== undefined) return;
	const reported = metaDal.getHost(hostId)?.discoveredDefaultShell;
	if (reported === undefined) return;
	const { profile, stale } = profileForShell(reported, metaDal.listLaunchProfiles(), metaDal);
	const found = profile ?? stale[0];
	if (found !== undefined) markAgentDefault(hostId, found.id, metaDal);
}

/**
 * Auto-seed launch profiles for the shells an agent reports in its HELLO.
 *
 * A shell some profile already launches reuses that profile, so the local
 * host's "Command Prompt" is not listed a second time as `cmd.exe`. Idempotent:
 * it pins a profile only when the host neither sees it nor holds an override
 * for it, so a profile the user hid stays hidden.
 *
 * The profile of the agent's default shell becomes the host's default when the
 * host has none, or when the one it has is an earlier seeding's, so it follows
 * the agent's default when that changes. A default the user set is never
 * replaced (#800), and a profile the user hid is not marked.
 */
export async function seedShellProfiles(
	hostId: string,
	availableShells: string[],
	defaultShell: string | undefined,
	os: string | null,
	metaDal: Pick<
		MetaDAL,
		| "listHostProfiles"
		| "listLaunchProfiles"
		| "getLaunchProfileByName"
		| "getHostLaunchProfileOverride"
		| "getHostDefaultOverride"
		| "createLaunchProfile"
		| "updateLaunchProfile"
		| "deleteLaunchProfile"
		| "upsertHostProfileOverride"
	>,
): Promise<void> {
	const supportedOs = hostSupportedOs(os, availableShells[0] ?? "");

	// Profiles this host already sees, so a seeded shell is not pinned twice
	const visible = new Set<string>(metaDal.listHostProfiles(hostId, supportedOs).map((p) => p.id));
	const profiles = metaDal.listLaunchProfiles();

	let seededCount = 0;
	let defaultProfileId: string | undefined;

	for (const [i, shellPath] of availableShells.entries()) {
		const name = shellFileName(shellPath);
		const found = profileForShell(shellPath, profiles, metaDal);
		const stale = found.stale;

		// A profile launching this shell, one bearing its name, or a stale one renamed
		let profile =
			found.profile ??
			(stale[0] && metaDal.updateLaunchProfile(stale[0].id, { name, supportedOs }));
		if (!profile) {
			profile = metaDal.createLaunchProfile({
				name,
				shell: shellPath,
				mode: "shell",
				elevated: false,
				supportedOs,
				iconType: "auto",
				sortOrder: i,
			});
			seededCount++;
		}
		for (const duplicate of stale) {
			if (duplicate.id !== profile.id) metaDal.deleteLaunchProfile(duplicate.id);
		}

		if (!visible.has(profile.id) && !metaDal.getHostLaunchProfileOverride(hostId, profile.id)) {
			metaDal.upsertHostProfileOverride(hostId, profile.id, "pin", i, false);
		}

		if (defaultShell !== undefined && sameShell(shellPath, defaultShell)) {
			defaultProfileId = profile.id;
		}
	}

	if (defaultProfileId !== undefined) markAgentDefault(hostId, defaultProfileId, metaDal);

	console.error(`[lasterm-ssh] seeded ${seededCount} shell profiles for host ${hostId}`);
}
