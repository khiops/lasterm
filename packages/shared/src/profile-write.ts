// One terminal-profile key written for a host or for every host, so that it
// holds on a given terminal (#835): the write "Always do this" makes for
// `whenEnded` (#574), the files panel's options (#836) and the conflict step
// of an upload (#837) make for theirs.
//
// A value set for a host does nothing on a terminal that overrides it, nor a
// value set globally on a terminal whose host or itself does. Writing at a
// scope therefore also drops the overrides nearer to that terminal: its own,
// and with a global write its host's. Other hosts and terminals keep theirs,
// as Settings shows them.

import type { TerminalProfileKey } from "./config.js";
import type { TerminalProfile } from "./entities.js";
import { HOST_ONLY_PROFILE_KEYS } from "./file-transfer.js";

/** Where the key is written: for the terminal's host, or for every host. */
export type ProfileWriteScope = "host" | "global";

/** The terminal the write has to hold on: its host and itself, as far as known. */
export interface ProfileWriteTarget {
	hostId: string | null;
	channelId: string | null;
}

/** The host's and the terminal's own profiles, as the cascade returns them for the target. */
export interface ProfileWriteLayers {
	host?: Partial<TerminalProfile> | undefined;
	channel?: Partial<TerminalProfile> | undefined;
}

/** An override nearer to the terminal than the scope written, which the write drops. */
export interface DroppedOverride {
	scope: "host" | "channel";
	/** What it said. */
	value: unknown;
}

/** One request to the hub's config routes. */
export interface ProfileWriteRequest {
	method: "PUT" | "PATCH";
	path: string;
	body: { terminal: Record<string, unknown> } | { profile: Record<string, unknown> };
}

export interface ProfileWritePlan {
	key: TerminalProfileKey;
	value: unknown;
	scope: ProfileWriteScope;
	target: ProfileWriteTarget;
	/** In order: the value first, then each drop. Stop at the first the hub refuses. */
	requests: ProfileWriteRequest[];
	/**
	 * The overrides the layers given hold that the write drops, nearest last:
	 * what a caller says before writing, "this terminal's own setting goes".
	 * Empty without layers. The drops are requested whatever the layers say,
	 * so that one made since they were read goes too.
	 */
	dropped: DroppedOverride[];
}

function hostPath(hostId: string): string {
	return `/api/hosts/${encodeURIComponent(hostId)}/profile`;
}

function channelPath(channelId: string): string {
	return `/api/channels/${encodeURIComponent(channelId)}/profile`;
}

function overrideIn(
	layer: Partial<TerminalProfile> | undefined,
	key: string,
): { value: unknown } | null {
	const value = layer?.[key];
	return value === undefined || value === null ? null : { value };
}

/**
 * Plan writing `key = value` for the target's host or globally, and dropping
 * the overrides nearer to the target terminal.
 *
 * - `host`: the host's profile gets the value; the terminal's own override goes.
 * - `global`: config.toml gets it; the host's override and the terminal's go.
 *
 * A key a terminal's profile never holds (`HOST_ONLY_PROFILE_KEYS`) has no
 * terminal override to drop. Without a host, a host write has nowhere to go:
 * null.
 */
export function planProfileWrite(
	key: TerminalProfileKey,
	value: unknown,
	scope: ProfileWriteScope,
	target: ProfileWriteTarget,
	layers: ProfileWriteLayers = {},
): ProfileWritePlan | null {
	if (scope === "host" && target.hostId === null) return null;

	const requests: ProfileWriteRequest[] = [];
	const dropped: DroppedOverride[] = [];

	if (scope === "global") {
		requests.push({
			method: "PUT",
			path: "/api/config/global",
			body: { terminal: { [key]: value } },
		});
		if (target.hostId !== null) {
			requests.push({
				method: "PATCH",
				path: hostPath(target.hostId),
				body: { profile: { [key]: null } },
			});
			const host = overrideIn(layers.host, key);
			if (host !== null) dropped.push({ scope: "host", ...host });
		}
	} else {
		requests.push({
			method: "PATCH",
			path: hostPath(target.hostId as string),
			body: { profile: { [key]: value } },
		});
	}

	if (target.channelId !== null && !HOST_ONLY_PROFILE_KEYS.includes(key)) {
		requests.push({
			method: "PATCH",
			path: channelPath(target.channelId),
			body: { profile: { [key]: null } },
		});
		const channel = overrideIn(layers.channel, key);
		if (channel !== null) dropped.push({ scope: "channel", ...channel });
	}

	return { key, value, scope, target, requests, dropped };
}
