import type { Channel, Host, LaunchProfile, TerminalProfile } from "@lasterm/shared";
import { envNamesIgnoreCase, resolveEnvironmentChanges } from "../session/spawn-environment.js";
import type { StartFolderSettings } from "./host-files-service.js";

/** What `startFolderSettings` reads of the hub's records. */
export interface StartFolderRecords {
	getChannelWithHost(channelId: string): { channel: Channel; hostId: string } | null;
	getHost(hostId: string): Pick<Host, "type" | "os"> | undefined;
	getLaunchProfile(id: string): Pick<LaunchProfile, "env"> | undefined;
}

/** What `startFolderSettings` reads of the configuration cascade (`ConfigResolver`). */
export interface StartFolderConfig {
	resolve(hostId?: string, channelId?: string): TerminalProfile;
	environmentLayers(hostId?: string, channelId?: string): unknown[];
}

/**
 * The folder a panel opens at for a terminal whose directory is unknown, as
 * its settings say it (#836): its host's `transferFallbackDir`, which the
 * cascade resolves for that terminal (a terminal's own profile refuses it), and
 * the variables the agent would read first to expand it, those a SPAWN of that
 * terminal carries: its scopes' and its launch profile's, as a restart sends
 * them (`ChannelLifecycleManager.restartEnv`). The variables a scope removes
 * are not read: the agent expands a `cwd` from the SPAWN's map, then from its
 * own environment, which a removal does not touch.
 */
export function startFolderSettings(
	channelId: string,
	records: StartFolderRecords,
	config: StartFolderConfig,
): StartFolderSettings {
	const found = records.getChannelWithHost(channelId);
	if (found === null) return { fallbackDir: "", env: {} };
	const { channel, hostId } = found;
	const fallbackDir = config.resolve(hostId, channelId).transferFallbackDir;
	const launchProfile =
		channel.launchProfileId !== undefined
			? records.getLaunchProfile(channel.launchProfileId)
			: undefined;
	const host = records.getHost(hostId);
	const { env } = resolveEnvironmentChanges(
		[...config.environmentLayers(hostId, channelId), launchProfile?.env],
		host !== undefined && envNamesIgnoreCase(host),
	);
	return { fallbackDir: typeof fallbackDir === "string" ? fallbackDir : "", env };
}
