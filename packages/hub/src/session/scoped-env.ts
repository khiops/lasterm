import type { TerminalProfile } from "@lasterm/shared";

/**
 * The variables a scope asks its terminals to be spawned with.
 *
 * The cascade has already merged them key by key — global, then host, then
 * channel — so this only has to answer for what a profile holds: the values
 * come from `profile_json`, which is data, and a terminal is not the place to
 * find out that something in there was a number.
 *
 * Names are kept as written: a shell reads `Path` and `PATH` as one variable on
 * Windows and as two on Unix, and it is not this layer's place to decide which.
 */
export function scopedEnv(profile: TerminalProfile | null | undefined): Record<string, string> {
	const declared = profile?.env;
	if (declared === null || declared === undefined || typeof declared !== "object") return {};

	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(declared)) {
		// An empty name reaches the platform as a malformed entry, and a value
		// that is not a string was never one: neither is passed on.
		if (name === "" || typeof value !== "string") continue;
		env[name] = value;
	}
	return env;
}
