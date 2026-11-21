// Whether a paste asks first, and what its card shows (#1015).
//
// A paste's lines are what `/\r\n|\r|\n/` splits it into, a single line
// break at the very end not counting: "ls\n" is one line, run as typing it
// and pressing Enter would; "a\n\n" is two. Counted in one pass, with no
// array of lines: a paste can be 16 MiB.

/** How many lines `text` holds, counting no further than `limit`. */
export function pasteLineCount(text: string, limit = Number.POSITIVE_INFINITY): number {
	let lines = 1;
	for (let at = 0; at < text.length && lines < limit; at++) {
		const unit = text.charCodeAt(at);
		if (unit !== 0x0d && unit !== 0x0a) continue;
		// A CR followed by an LF is one break.
		if (unit === 0x0d && text.charCodeAt(at + 1) === 0x0a) at++;
		// A break with nothing after it ends the last line rather than starting one.
		if (at + 1 < text.length) lines++;
	}
	return lines;
}

/**
 * The first `count` lines of `text`, without their line breaks, each kept to
 * its first `maxUnits` UTF-16 units: a card shows a prefix, and a line of a
 * 16 MiB paste is not copied whole for it.
 */
export function pasteFirstLines(
	text: string,
	count: number,
	maxUnits = Number.POSITIVE_INFINITY,
): string[] {
	const lines: string[] = [];
	const take = (start: number, end: number) =>
		lines.push(text.slice(start, Math.min(end, start + maxUnits)));
	let start = 0;
	for (let at = 0; at < text.length && lines.length < count; at++) {
		const unit = text.charCodeAt(at);
		if (unit !== 0x0d && unit !== 0x0a) continue;
		take(start, at);
		if (unit === 0x0d && text.charCodeAt(at + 1) === 0x0a) at++;
		start = at + 1;
	}
	if (lines.length < count && start < text.length) take(start, text.length);
	return lines;
}

/**
 * Whether a paste of two or more lines asks, by the resolved `pasteWarning`
 * and whether the program has bracketed paste on, as the pane's xterm last
 * parsed it. A value other than the three is "auto".
 */
export function pasteWarningAsks(warning: unknown, bracketed: boolean): boolean {
	if (warning === "never") return false;
	if (warning === "always") return true;
	return !bracketed;
}
