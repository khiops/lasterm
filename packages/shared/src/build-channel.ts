/**
 * The build channel: `release` for what the release workflow builds, `dev` for
 * every other build (#1084). A development build and the Store install then use
 * different pipes, locks and directories, so both run on one Windows account.
 *
 * The rule, the same in every language that names: the build environment's
 * `LASTERM_CHANNEL` set to exactly `release` gives `release`; anything else,
 * absent included, gives `dev`.
 *
 * The hub executable has its channel fixed when it is built: build-sea-hub.ts
 * replaces `__LASTERM_CHANNEL_MARKER__` with the literal
 * `lasterm-build-channel:<channel>`, which pack-msix.ps1 searches the binary
 * for. A hub run from source has no such literal and reads `LASTERM_CHANNEL`
 * from its environment.
 */

export type BuildChannel = "release" | "dev";

/** The marker's prefix; the binary holds it followed by its channel only. */
export const CHANNEL_MARKER_PREFIX = "lasterm-build-channel:";

declare const __LASTERM_CHANNEL_MARKER__: string | undefined;

/** The channel a `LASTERM_CHANNEL` value gives. */
export function channelFromValue(value: string | undefined): BuildChannel {
	return value === "release" ? "release" : "dev";
}

/** The channel the build fixed, or for a source run, the environment's. */
export function buildChannel(): BuildChannel {
	const marker =
		typeof __LASTERM_CHANNEL_MARKER__ === "string" ? __LASTERM_CHANNEL_MARKER__ : undefined;
	if (marker !== undefined) {
		return channelFromValue(marker.slice(CHANNEL_MARKER_PREFIX.length));
	}
	return channelFromValue(process.env.LASTERM_CHANNEL);
}

/** The name every channel-specific directory, pipe and lock is built from. */
export function channelBaseName(channel: BuildChannel): string {
	return channel === "release" ? "lasterm" : "lasterm-dev";
}
