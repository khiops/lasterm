import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	CONNECT_TIMEOUT_MAX_SECONDS,
	CONNECT_TIMEOUT_MIN_SECONDS,
	type SshConfigEntry,
	sshPortFromText,
} from "@lasterm/shared";

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

/** One `Host` pattern, `*` and `?` included, as a matcher; case counts, as in ssh. */
function hostPattern(pattern: string): RegExp {
	const expression = pattern
		.split("")
		.map((character) => {
			if (character === "*") return ".*";
			if (character === "?") return ".";
			return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${expression}$`);
}

/** A `Host` line's patterns, compiled once: literal ones by name, the others as matchers. */
interface HostLine {
	patterns: string[];
	literals: Set<string>;
	wildcards: RegExp[];
	negatedLiterals: Set<string>;
	negatedWildcards: RegExp[];
}

function hostLineOf(patterns: string[]): HostLine {
	const line: HostLine = {
		patterns,
		literals: new Set(),
		wildcards: [],
		negatedLiterals: new Set(),
		negatedWildcards: [],
	};
	for (const raw of patterns) {
		const negated = raw.startsWith("!");
		const pattern = negated ? raw.slice(1) : raw;
		if (isWildcard(pattern)) {
			(negated ? line.negatedWildcards : line.wildcards).push(hostPattern(pattern));
		} else {
			(negated ? line.negatedLiterals : line.literals).add(pattern);
		}
	}
	return line;
}

/**
 * Whether a `Host` line applies to `name`: one of its patterns takes it, and
 * none of its negated ones (`!pattern`) does.
 */
function hostLineApplies(line: HostLine, name: string): boolean {
	if (line.negatedLiterals.has(name) || line.negatedWildcards.some((re) => re.test(name))) {
		return false;
	}
	return line.literals.has(name) || line.wildcards.some((re) => re.test(name));
}

/**
 * A part of the file and the lines in it: the lines before any `Host` apply to
 * every host, those after a `Host` line to the names it takes, and those after
 * a `Match` line, which is not evaluated, to none.
 */
interface Section {
	host: HostLine | "every" | "none";
	lines: Directive[];
}

/**
 * The parts of a file, indexed so a name is checked only against the parts that
 * can apply to it: those its literal patterns name, and those every name has to
 * be tried against (before any `Host`, or with a `*`/`?` pattern). One pass per
 * alias over the whole file made a request's cost grow with the square of the
 * number of hosts.
 */
interface Sections {
	list: Section[];
	general: number[];
	byName: Map<string, number[]>;
}

function sectionsOf(directives: Directive[]): Sections {
	const list: Section[] = [{ host: "every", lines: [] }];
	for (const directive of directives) {
		if (directive.key === "host") {
			list.push({ host: hostLineOf(directive.args), lines: [] });
		} else if (directive.key === "match") {
			list.push({ host: "none", lines: [] });
		} else {
			(list[list.length - 1] as Section).lines.push(directive);
		}
	}
	const general: number[] = [];
	const byName = new Map<string, number[]>();
	list.forEach(({ host }, index) => {
		if (host === "none") return;
		if (host === "every" || host.wildcards.length > 0) {
			general.push(index);
			return;
		}
		for (const name of host.literals) {
			const indexes = byName.get(name);
			if (indexes === undefined) byName.set(name, [index]);
			else if (indexes[indexes.length - 1] !== index) indexes.push(index);
		}
	});
	return { list, general, byName };
}

/** The lines that apply to `alias`, in file order. */
function* applyingTo(sections: Sections, alias: string): Generator<Directive> {
	const named = sections.byName.get(alias) ?? [];
	const { general } = sections;
	// Both lists ascend: merge them to keep file order.
	let g = 0;
	let n = 0;
	while (g < general.length || n < named.length) {
		const fromGeneral =
			n >= named.length || (g < general.length && (general[g] as number) < (named[n] as number));
		const index = fromGeneral ? (general[g++] as number) : (named[n++] as number);
		const { host, lines } = sections.list[index] as Section;
		if (host === "every" || (host !== "none" && hostLineApplies(host, alias))) yield* lines;
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
 * `checked` keeps each path's answer for the whole file, so a key every alias
 * inherits is looked at once.
 */
function usableIdentityFile(
	value: string,
	home: string,
	checked: Map<string, boolean>,
): string | null {
	if (value.toLowerCase() === "none" || value.includes("%") || value.includes("${")) return null;
	const path = resolveIdentityFile(value, home);
	let isFile = checked.get(path);
	if (isFile === undefined) {
		try {
			isFile = statSync(path).isFile();
		} catch {
			isFile = false;
		}
		checked.set(path, isFile);
	}
	return isFile ? path : null;
}

/**
 * The entry for `alias`: for each field, the first value obtained in the parts
 * that apply to it, in file order, as ssh(1) takes them (ssh_config(5)), within
 * what lasterm keeps of it: the first usable `IdentityFile` only, `HostName` as
 * written, no default but port 22, `Match` and `Include` left out.
 */
function resolveEntry(
	sections: Sections,
	alias: string,
	home: string,
	checked: Map<string, boolean>,
): SshConfigEntry {
	let hostname: string | null | undefined;
	let user: string | null | undefined;
	let port: number | undefined;
	let identityFile: string | undefined;
	// ProxyJump and ProxyCommand share one slot: the first of either decides.
	let proxyJump: string | null | undefined;

	for (const directive of applyingTo(sections, alias)) {
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
				if (identityFile !== undefined) break;
				const value = onlyArgument(directive);
				const path = value === null ? null : usableIdentityFile(value, home, checked);
				if (path !== null) identityFile = path;
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
 * by `resolveEntry`. An alias is a `Host` pattern with no `*` or `?` that does
 * not start with `!`, listed only when its own line applies to it. `Include`
 * is not followed; that there is one is said by `hasInclude`.
 */
export function parseSshConfig(content: string, home: string = homedir()): ParseResult {
	const directives = directivesOf(content);
	const sections = sectionsOf(directives);
	const aliases = new Set<string>();
	for (const { host } of sections.list) {
		if (host === "every" || host === "none") continue;
		for (const pattern of host.patterns) {
			if (isWildcard(pattern) || pattern.startsWith("!") || aliases.has(pattern)) continue;
			if (hostLineApplies(host, pattern)) aliases.add(pattern);
		}
	}
	const checked = new Map<string, boolean>();
	return {
		entries: [...aliases].map((alias) => resolveEntry(sections, alias, home, checked)),
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
	for (const directive of applyingTo(sectionsOf(directivesOf(content)), alias)) {
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

/** Seconds per `convtime` unit (OpenSSH misc.c); no unit is seconds. */
const CONVTIME_UNIT_SECONDS: Record<string, number> = {
	s: 1,
	m: 60,
	h: 3_600,
	d: 86_400,
	w: 604_800,
};

/**
 * The seconds a `ConnectTimeout` argument names, or null for none (#1034): a
 * subset of OpenSSH's `convtime`, one or more `<digits>[smhdw]`, any case,
 * summed. `none`, a fraction (`25.5`) or anything else is no value.
 */
function convtimeSeconds(word: string): number | null {
	if (!/^(?:[0-9]+[smhdwSMHDW]?)+$/.test(word)) return null;
	let seconds = 0;
	for (const [, digits, unit] of word.matchAll(/([0-9]+)([smhdwSMHDW]?)/g)) {
		seconds += Number(digits) * (CONVTIME_UNIT_SECONDS[(unit ?? "").toLowerCase()] ?? 1);
	}
	return seconds;
}

/**
 * The connection timeout this configuration gives the host `name`, in seconds,
 * as Lasterm takes it (#1034): the first `ConnectTimeout` among the lines that
 * apply to `name`, as for `IdentityAgent`, its one argument read by
 * `convtimeSeconds`; a line with more than one argument is no value. A value
 * under `CONNECT_TIMEOUT_MIN_SECONDS` is none, since the setting only gives a
 * host more time than the hub's own limits; one over
 * `CONNECT_TIMEOUT_MAX_SECONDS` is that maximum.
 */
export function resolveConnectTimeout(content: string, name: string): number | null {
	for (const directive of applyingTo(sectionsOf(directivesOf(content)), name)) {
		if (directive.key !== "connecttimeout") continue;
		const word = onlyArgument(directive);
		const seconds = word === null ? null : convtimeSeconds(word);
		if (seconds === null || seconds < CONNECT_TIMEOUT_MIN_SECONDS) return null;
		return Math.min(seconds, CONNECT_TIMEOUT_MAX_SECONDS);
	}
	return null;
}

/**
 * The connection timeout `~/.ssh/config` gives the first of `names` it gives
 * one, in seconds, or null (#1034). The names are the host's alias, then its
 * hostname, as ssh(1) matches the name it is given. A file that is missing or
 * cannot be read gives none.
 */
export function sshConfigConnectTimeout(
	names: readonly string[],
	home: string = homedir(),
): number | null {
	let content: string;
	try {
		content = readFileSync(resolve(home, ".ssh", "config"), "utf-8");
	} catch {
		return null;
	}
	for (const name of names) {
		const seconds = resolveConnectTimeout(content, name);
		if (seconds !== null) return seconds;
	}
	return null;
}
