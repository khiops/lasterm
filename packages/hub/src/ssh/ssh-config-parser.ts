import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SshConfigEntry } from "@lasterm/shared";

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

export function parseSshConfig(content: string): ParseResult {
	const entries: SshConfigEntry[] = [];
	let hasInclude = false;

	const lines = content.split("\n");

	// Accumulate blocks: each Host line may have multiple patterns.
	// We track a list of current blocks (one per non-wildcard pattern).
	let currentBlocks: HostBlock[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();

		// Skip empty lines and comments
		if (line === "" || line.startsWith("#")) {
			continue;
		}

		// Split into key and value. Supports both "Key Value" and "Key=Value".
		const eqIdx = line.indexOf("=");
		const spaceIdx = line.indexOf(" ");
		const tabIdx = line.indexOf("\t");

		if (eqIdx === -1 && spaceIdx === -1 && tabIdx === -1) {
			// No separator — skip malformed line
			continue;
		}

		// Find the first separator (space, tab, or =)
		const candidates = [eqIdx, spaceIdx, tabIdx].filter((i) => i > 0);
		if (candidates.length === 0) continue;
		const separatorIdx = Math.min(...candidates);

		const key = line.slice(0, separatorIdx).toLowerCase();
		const value = line.slice(separatorIdx + 1).trim();

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
				const port = Number.parseInt(value, 10);
				if (!Number.isNaN(port) && port > 0 && port <= 65535) {
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
