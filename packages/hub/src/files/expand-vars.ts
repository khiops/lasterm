/**
 * `${VAR}` in a folder written in the settings, expanded as the agent expands a
 * launch profile's `cwd` before it starts a terminal there
 * (`crates/lasterm-agent/src/expand.rs`, `expand_vars`), so that the same text
 * names the same folder in both places (#836). The rules, the agent's:
 *
 * - `${VAR}` is the variable's value, or stays as it is when it has none;
 * - `\${VAR}` is the text `${VAR}`, its backslash consumed;
 * - `\\` is one backslash, so `\\${VAR}` is a backslash and the value;
 * - `$VAR`, without braces, is not expanded;
 * - one pass: a value is never read again for variables.
 *
 * What a name is worth is the caller's to say (`lookup`): the agent asks the
 * terminal's environment map first, then its own environment, and on a Windows
 * host without regard to case.
 */

/** Where the `}` closing a `${` that starts at `from` (just past the `{`) is, or -1. */
function closingBrace(text: string, from: number): number {
	return text.indexOf("}", from);
}

/** Expand `text`, asking `lookup` for each variable it names; see the rules above. */
export function expandVariables(
	text: string,
	lookup: (name: string) => string | undefined,
): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const char = text[i];
		if (char === "\\") {
			const next = text[i + 1];
			if (next === "\\") {
				// `\\` is one backslash; followed by `${`, the variable is expanded after it.
				out += "\\";
				i += 2;
				continue;
			}
			if (next === "$" && text[i + 2] === "{") {
				const close = closingBrace(text, i + 3);
				if (close !== -1) {
					out += text.slice(i + 1, close + 1);
					i = close + 1;
					continue;
				}
			}
			out += "\\";
			i += 1;
			continue;
		}
		if (char === "$" && text[i + 1] === "{") {
			const close = closingBrace(text, i + 2);
			if (close !== -1) {
				const value = lookup(text.slice(i + 2, close));
				out += value ?? text.slice(i, close + 1);
				i = close + 1;
				continue;
			}
		}
		out += char;
		i += 1;
	}
	return out;
}

/**
 * The names `text` asks to expand, each once, in order: those `expandVariables`
 * would look up. An escaped `\${VAR}` names none.
 */
export function referencedVariables(text: string): string[] {
	const names: string[] = [];
	expandVariables(text, (name) => {
		if (!names.includes(name)) names.push(name);
		return undefined;
	});
	return names;
}

/**
 * A lookup in a map of variables, as the host reads names: without regard to
 * case on Windows (`Path` is `PATH`), exactly elsewhere.
 */
export function lookupIn(
	variables: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
	ignoreCase: boolean,
): (name: string) => string | undefined {
	const entries: [string, string][] =
		variables instanceof Map ? [...variables] : Object.entries(variables);
	if (!ignoreCase) {
		const exact = new Map(entries);
		return (name) => exact.get(name);
	}
	const folded = new Map<string, string>();
	// The first spelling wins, as the agent's `find` takes the first match.
	for (const [name, value] of entries) {
		const key = name.toLowerCase();
		if (!folded.has(key)) folded.set(key, value);
	}
	return (name) => folded.get(name.toLowerCase());
}
