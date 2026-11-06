/**
 * A terminal's working directory as its agent says it (CWD_CHANGE, #834).
 *
 * The hub keeps the last one per channel in memory, relays each to the
 * clients attached to the channel, and gives it in ATTACH_OK and STATE_SYNC.
 * It never writes it to `channels.cwd`, which stays the directory the terminal
 * starts in. A directory is user content: nothing here logs one.
 */

import type { CwdSource, LiveCwd, UiAttachOkMessage } from "@lasterm/shared";

const SOURCES: ReadonlySet<string> = new Set<CwdSource>(["shell", "process", "start"]);

/**
 * What a CWD_CHANGE from an agent says, or null when it is not one: a
 * directory that is neither a string nor null, or a source this hub does not
 * know. Fields of the wrong type that it may leave out are left out.
 */
export function liveCwdOf(msg: Record<string, unknown>): LiveCwd | null {
	const { cwd, source, atPrompt, foreground, otherHost } = msg;
	if (cwd !== null && typeof cwd !== "string") return null;
	if (typeof source !== "string" || !SOURCES.has(source)) return null;
	return {
		cwd,
		source: source as CwdSource,
		...(typeof atPrompt === "boolean" && { atPrompt }),
		...(typeof foreground === "string" && { foreground }),
		...(typeof otherHost === "string" && { otherHost }),
	};
}

/** What ATTACH_OK and a STATE_SYNC entry say of a terminal's directory: nothing until it is known. */
export function cwdFields(
	live: LiveCwd | undefined,
): Pick<UiAttachOkMessage, "cwd" | "cwdSource" | "foreground"> {
	if (live === undefined) return {};
	return {
		cwd: live.cwd,
		cwdSource: live.source,
		...(live.foreground !== undefined && { foreground: live.foreground }),
	};
}
