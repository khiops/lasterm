import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type SshConfigEntry, sshPortFromText } from "@lasterm/shared";

const GIT_HOSTS = new Set([
	"github.com",
	"gitlab.com",
	"bitbucket.org",
	"ssh.dev.azure.com",
	"vs-ssh.visualstudio.com",
]);

export interface ParseResult {
	entries: SshConfigEntry[];
	hasInclude: boolean;
}

/** A line of the file: its keyword, lower-cased, and its arguments. */
interface Directive {
	key: string;
	args: string[];
}

const WHITESPACE = new Set([" ", "\t", "\r", "\n"]);

function isWildcard(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?");
}

function isGitHost(name: string, hostname: string | null): boolean {
	if (hostname && GIT_HOSTS.has(hostname.toLowerCase())) return true;
	if (GIT_HOSTS.has(name.toLowerCase())) return true;
	return false;
}

/** `~` and `~/…` under `home`; anything else, `~login/…` included, as written. */
function resolveIdentityFile(path: string, home: string): string {
	if (path.startsWith("~/")) {
		return resolve(home, path.slice(2));
	}
	if (path === "~") {
		return home;
	}
	return path;
}

/**
 * The arguments of a line's rest, split as ssh's `argv_split` splits them:
 * on whitespace outside quotes, `"…"` and `'…'` quoting and their quotes
 * removed wherever they sit in a word, a backslash before a quote, a backslash
 * or (outside quotes) a space giving that character, any other backslash kept,
 * and a word starting with `#` outside quotes ending the line. Null for an
 * unbalanced quote, a line ssh refuses.
 */
function splitArguments(rest: string): string[] | null {
	const args: string[] = [];
	let current = "";
	let inWord = false;
	let quote: string | null = null;
	for (let i = 0; i < rest.length; i++) {
		const character = rest[i] as string;
		if (quote === null && WHITESPACE.has(character)) {
			if (inWord) args.push(current);
			current = "";
			inWord = false;
			continue;
		}
		if (quote === null && !inWord && character === "#") break;
		inWord = true;
		if (character === "\\") {
			const next = rest[i + 1];
			if (next === '"' || next === "'" || next === "\\" || (quote === null && next === " ")) {
				current += next;
				i++;
			} else {
				current += character;
			}
			continue;
		}
		if (quote === null && (character === '"' || character === "'")) {
			quote = character;
			continue;
		}
		if (character === quote) {
			quote = null;
			continue;
		}
		current += character;
	}
	if (quote !== null) return null;
	if (inWord) args.push(current);
	return args;
}

/**
 * A line's keyword, lower-cased, and its arguments, or null for a blank line, a
 * comment or a line ssh refuses. The keyword ends at whitespace or `=`, and
 * whitespace around one `=` separator is skipped: `Key Value`, `Key=Value` and
 * `Key = Value` are the same line.
 */
function splitDirective(rawLine: string): Directive | null {
	let i = 0;
	while (i < rawLine.length && WHITESPACE.has(rawLine[i] as string)) i++;
	if (i === rawLine.length || rawLine[i] === "#") return null;
	const start = i;
	while (i < rawLine.length && !WHITESPACE.has(rawLine[i] as string) && rawLine[i] !== "=") i++;
	const key = rawLine.slice(start, i).toLowerCase();
	while (i < rawLine.length && WHITESPACE.has(rawLine[i] as string)) i++;
	if (rawLine[i] === "=") {
		i++;
		while (i < rawLine.length && WHITESPACE.has(rawLine[i] as string)) i++;
	}
	const args = splitArguments(rawLine.slice(i));
	return args === null ? null : { key, args };
}

function directivesOf(content: string): Directive[] {
	return content
		.split("\n")
		.map(splitDirective)
		.filter((directive): directive is Directive => directive !== null);
}

/** Whether one `Host` pattern, `*` and `?` included, takes `name`; case counts, as in ssh. */
function hostPatternMatches(pattern: string, name: string): boolean {
	const expression = pattern
		.split("")
		.map((character) => {
			if (character === "*") return ".*";
			if (character === "?") return ".";
			return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${expression}$`).test(name);
}

/**
 * Whether a `Host` line applies to `name`: one of its patterns takes it, and
 * none of its negated ones (`!pattern`) does.
 */
function hostLineApplies(patterns: string[], name: string): boolean {
	let applies = false;
	for (const raw of patterns) {
		const negated = raw.startsWith("!");
		if (!hostPatternMatches(negated ? raw.slice(1) : raw, name)) continue;
		if (negated) return false;
		applies = true;
	}
	return applies;
}

/**
 * The directives that apply to `alias`, in file order: the lines before any
 * `Host`, and those of every `Host` part that applies to it. A `Match` part is
 * not evaluated and counts as not applying.
 */
function* applyingTo(directives: Directive[], alias: string): Generator<Directive> {
	let applies = true;
	for (const directive of directives) {
		if (directive.key === "host") {
			applies = hostLineApplies(directive.args, alias);
		} else if (directive.key === "match") {
			applies = false;
		} else if (applies) {
			yield directive;
		}
	}
}

/** The one argument of a single-value keyword; a line with more is refused by ssh. */
function onlyArgument(directive: Directive): string | null {
	return directive.args.length === 1 ? (directive.args[0] as string) : null;
}

/** `HostName`'s `%h` (the alias as written) and `%%`; any other `%` sequence as written. */
function expandHostName(value: string, alias: string): string {
	return value.replace(/%([%h])/g, (_, token: string) => (token === "%" ? "%" : alias));
}

/** A `ProxyJump` hop written as `ssh://[user@]host[:port][/]`, in the form the jump reads. */
function jumpWithoutUri(value: string): string {
	return value
		.split(",")
		.map((hop) => (hop.startsWith("ssh://") ? hop.slice("ssh://".length).replace(/\/$/, "") : hop))
		.join(",");
}

/**
 * The key path of an `IdentityFile` value lasterm can sign with: not `none`, no
 * `%` or `${` token left unexpanded, and naming a file that exists. ssh tries
 * every identity listed and skips one it cannot load; the hub keeps one path.
 */
function usableIdentityFile(value: string, home: string): string | null {
	if (value.toLowerCase() === "none" || value.includes("%") || value.includes("${")) return null;
	const path = resolveIdentityFile(value, home);
	try {
		return statSync(path).isFile() ? path : null;
	} catch {
		return null;
	}
}

/**
 * The entry ssh(1) would use for `alias`: for each field, the first value
 * obtained in the parts that apply to it (ssh_config(5)).
 */
function resolveEntry(directives: Directive[], alias: string, home: string): SshConfigEntry {
	let hostname: string | null | undefined;
	let user: string | null | undefined;
	let port: number | undefined;
	let identityFile: string | undefined;
	// ProxyJump and ProxyCommand share one slot: the first of either decides.
	let proxyJump: string | null | undefined;

	for (const directive of applyingTo(directives, alias)) {
		switch (directive.key) {
			case "hostname": {
				const value = onlyArgument(directive);
				if (hostname === undefined && value !== null) hostname = expandHostName(value, alias);
				break;
			}
			case "user": {
				const value = onlyArgument(directive);
				if (user === undefined && value !== null) user = value;
				break;
			}
			case "port": {
				const value = onlyArgument(directive);
				const parsed = value === null ? null : sshPortFromText(value);
				if (port === undefined && parsed !== null) port = parsed;
				break;
			}
			case "identityfile": {
				const value = onlyArgument(directive);
				const path = value === null ? null : usableIdentityFile(value, home);
				if (identityFile === undefined && path !== null) identityFile = path;
				break;
			}
			case "proxyjump": {
				const value = onlyArgument(directive);
				if (proxyJump === undefined && value !== null) {
					proxyJump = value.toLowerCase() === "none" ? null : jumpWithoutUri(value);
				}
				break;
			}
			case "proxycommand":
				if (proxyJump === undefined && directive.args.length > 0) proxyJump = null;
				break;
			// Other directives are ignored
		}
	}

	const resolvedHostname = hostname ?? null;
	return {
		name: alias,
		hostname: resolvedHostname,
		port: port ?? 22,
		user: user ?? null,
		identityFile: identityFile ?? null,
		proxyJump: proxyJump ?? null,
		isGitHost: isGitHost(alias, resolvedHostname),
	};
}

/**
 * One entry per alias the file names, in the order first named, each resolved
 * as ssh(1) resolves it. An alias is a `Host` pattern with no `*`, `?` or `!`,
 * listed only when its own line applies to it. `Include` is not followed; that
 * there is one is said by `hasInclude`.
 */
export function parseSshConfig(content: string, home: string = homedir()): ParseResult {
	const directives = directivesOf(content);
	const aliases: string[] = [];
	for (const directive of directives) {
		if (directive.key !== "host") continue;
		for (const pattern of directive.args) {
			if (isWildcard(pattern) || pattern.startsWith("!") || aliases.includes(pattern)) continue;
			if (hostLineApplies(directive.args, pattern)) aliases.push(pattern);
		}
	}
	return {
		entries: aliases.map((alias) => resolveEntry(directives, alias, home)),
		hasInclude: directives.some((directive) => directive.key === "include"),
	};
}

export function readSshConfig(home: string = homedir()): ParseResult {
	const configPath = resolve(home, ".ssh", "config");
	const content = readFileSync(configPath, "utf-8");
	return parseSshConfig(content, home);
}

/**
 * The `IdentityAgent` this configuration gives the host `alias`, as ssh(1)
 * resolves it: the first value found in a part that applies to it, the lines
 * before any `Host` included. Null when it gives none.
 *
 * A `Match` block is not evaluated and counts as not applying, and an
 * `Include` is not followed, as `parseSshConfig` follows none either.
 */
export function resolveIdentityAgent(content: string, alias: string): string | null {
	for (const directive of applyingTo(directivesOf(content), alias)) {
		if (directive.key !== "identityagent") continue;
		const value = onlyArgument(directive);
		if (value !== null) return value;
	}
	return null;
}

/**
 * Whether `~/.ssh/config` keeps the SSH agent out of the host `alias`
 * (`IdentityAgent none`). A file that is missing or cannot be read says
 * nothing, and keeps nothing out.
 */
export function identityAgentIsNone(alias: string, home: string = homedir()): boolean {
	let content: string;
	try {
		content = readFileSync(resolve(home, ".ssh", "config"), "utf-8");
	} catch {
		return false;
	}
	return resolveIdentityAgent(content, alias)?.toLowerCase() === "none";
}
