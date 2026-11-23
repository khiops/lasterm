/**
 * Session recordings (#80): what the hub and the client agree on.
 */

/** A recording ends once its export reaches this size, so the player can always reopen it. */
export const RECORDING_MAX_BYTES = 512 * 1024 * 1024;

/** The largest file the player opens. */
export const CAST_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/** Terminal sizes a cast may ask for (the limits Lasterm's terminals have). */
export const CAST_MAX_COLS = 500;
export const CAST_MAX_ROWS = 500;

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * The file name of a recording's export: `lasterm-<title slug>-<UTC start>.cast`.
 * The slug keeps lowercase ASCII letters and digits, turns every run of
 * anything else into one `-`, trims dashes and keeps 40 characters at most;
 * an empty slug becomes `terminal`. The hub's `Content-Disposition` and the
 * client's save dialog both use it.
 */
export function recordingFileName(title: string, startedAt: string): string {
	let slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	if (slug === "") slug = "terminal";
	const start = new Date(startedAt);
	const stamp = `${start.getUTCFullYear()}${pad(start.getUTCMonth() + 1)}${pad(start.getUTCDate())}-${pad(start.getUTCHours())}${pad(start.getUTCMinutes())}${pad(start.getUTCSeconds())}`;
	return `lasterm-${slug}-${stamp}.cast`;
}
