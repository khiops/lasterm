import { readFileSync } from "node:fs";
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

interface HostBlock {
	name: string;
	hostname: string | null;
	port: number;
	user: string | null;
	identityFile: string | null;
	proxyJump: string | null;
}

function isWildcard(pattern: string): boolean {
	return pattern.includes("*") || pattern.includes("?");
}

function isGitHost(name: string, hostname: string | null): boolean {
	if (hostname && GIT_HOSTS.has(hostname.toLowerCase())) return true;
	if (GIT_HOSTS.has(name.toLowerCase())) return true;
	return false;
}

function resolveIdentityFile(path: string): string {
	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}
	if (path === "~") {
		return homedir();
	}
	return path;
}

function finalizeBlock(block: HostBlock): SshConfigEntry {
	return {
		name: block.name,
		hostname: block.hostname,
		port: block.port,
		user: block.user,
		identityFile: block.identityFile,
		proxyJump: block.proxyJump,
		isGitHost: isGitHost(block.name, block.hostname),
	};
}

function makeBlock(name: string): HostBlock {
	return {
		name,
		hostname: null,
		port: 22,
		user: null,
		identityFile: null,
		proxyJump: null,
	};
}

/**
 * A line's keyword, lower-cased, and its value, or null for a blank line, a
 * comment or a malformed line. Supports both "Key Value" and "Key=Value".
 */
function splitDirective(rawLine: string): { key: string; value: string } | null {
	const line = rawLine.trim();

	// Skip empty lines and comments
	if (line === "" || line.startsWith("#")) {
		return null;
	}

	const eqIdx = line.indexOf("=");
	const spaceIdx = line.indexOf(" ");
	const tabIdx = line.indexOf("\t");

	if (eqIdx === -1 && spaceIdx === -1 && tabIdx === -1) {
		// No separator — skip malformed line
		return null;
	}

	// Find the first separator (space, tab, or =)
	const candidates = [eqIdx, spaceIdx, tabIdx].filter((i) => i > 0);
	if (candidates.length === 0) return null;
	const separatorIdx = Math.min(...candidates);

	return {
		key: line.slice(0, separatorIdx).toLowerCase(),
		value: line.slice(separatorIdx + 1).trim(),
	};
}

/**
 * The port a `Port` line's value names, or null for a malformed one, which
 * keeps 22. Read as OpenSSH reads it: the arguments end at a word starting
 * with `#`, so `Port 2222 # office` is 2222, and there must be exactly one, a
 * whole number from 1 to 65535 in digits. parseInt took `2222abc` for 2222 and
 * `1.5` for 1, lines OpenSSH refuses (#902).
 */
function portOfDirective(value: string): number | null {
	const words = value.split(/[ \t]+/);
	const comment = words.findIndex((word) => word.startsWith("#"));
	const [port, ...extra] = comment === -1 ? words : words.slice(0, comment);
	return port !== undefined && extra.length === 0 ? sshPortFromText(port) : null;
}

export function parseSshConfig(content: string): ParseResult {
	const entries: SshConfigEntry[] = [];
	let hasInclude = false;

	const lines = content.split("\n");

	// Accumulate blocks: each Host line may have multiple patterns.
	// We track a list of current blocks (one per non-wildcard pattern).
	let currentBlocks: HostBlock[] = [];

	for (const rawLine of lines) {
		const directive = splitDirective(rawLine);
		if (directive === null) continue;
		const { key, value } = directive;

		if (key === "include") {
			hasInclude = true;
			continue;
		}

		if (key === "host") {
			// Finalize previous blocks
			for (const block of currentBlocks) {
				entries.push(finalizeBlock(block));
			}
			currentBlocks = [];

			// Parse patterns (space-separated)
			const patterns = value.split(/\s+/).filter((p) => p.length > 0);
			for (const pattern of patterns) {
				if (!isWildcard(pattern)) {
					currentBlocks.push(makeBlock(pattern));
				}
			}
			continue;
		}

		// Apply directive to all current blocks
		if (currentBlocks.length === 0) continue;

		switch (key) {
			case "hostname":
				for (const block of currentBlocks) {
					block.hostname = value;
				}
				break;
			case "port": {
				const port = portOfDirective(value);
				if (port !== null) {
					for (const block of currentBlocks) {
						block.port = port;
					}
				}
				// Malformed port: keep default 22
				break;
			}
			case "user":
				for (const block of currentBlocks) {
					block.user = value;
				}
				break;
			case "identityfile":
				for (const block of currentBlocks) {
					block.identityFile = resolveIdentityFile(value);
				}
				break;
			case "proxyjump":
				for (const block of currentBlocks) {
					block.proxyJump = value;
				}
				break;
			// Other directives are ignored
		}
	}

	// Finalize any remaining blocks
	for (const block of currentBlocks) {
		entries.push(finalizeBlock(block));
	}

	return { entries, hasInclude };
}

export function readSshConfig(): ParseResult {
	const configPath = resolve(homedir(), ".ssh", "config");
	const content = readFileSync(configPath, "utf-8");
	return parseSshConfig(content);
}

/** Whether one `Host` pattern, `*` and `?` included, takes `name`; case aside, as ssh(1) lowers the name. */
function hostPatternMatches(pattern: string, name: string): boolean {
	const expression = pattern
		.split("")
		.map((character) => {
			if (character === "*") return ".*";
			if (character === "?") return ".";
			return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${expression}$`, "i").test(name);
}

/**
 * Whether a `Host` line applies to `name`: one of its patterns takes it, and
 * none of its negated ones (`!pattern`) does.
 */
function hostLineApplies(patterns: string, name: string): boolean {
	let applies = false;
	for (const raw of patterns.split(/\s+/)) {
		if (raw === "") continue;
		const negated = raw.startsWith("!");
		if (!hostPatternMatches(negated ? raw.slice(1) : raw, name)) continue;
		if (negated) return false;
		applies = true;
	}
	return applies;
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
	// Before any Host or Match line, a directive applies to every host.
	let applies = true;
	for (const rawLine of content.split("\n")) {
		const directive = splitDirective(rawLine);
		if (directive === null) continue;
		const { key, value } = directive;
		if (key === "host") {
			applies = hostLineApplies(value, alias);
			continue;
		}
		if (key === "match") {
			applies = false;
			continue;
		}
		if (applies && key === "identityagent") {
			return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
				? value.slice(1, -1)
				: value;
		}
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
