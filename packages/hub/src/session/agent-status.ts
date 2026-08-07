import { execFile as execFileCallback } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HUB_VERSION } from "../build-version.js";
import { resolveAgentBinaryPath as defaultResolveAgentBinaryPath } from "../sea-agent-resolver.js";
import {
	AGENT_TARGET_TRIPLES,
	isCacheDirSecure,
	isTrustedCacheBinary,
	validateAgentVersion,
} from "./agent-cache.js";
import { getBinaryCacheDir } from "./agent-deployer.js";

const execFile = promisify(execFileCallback);
const AGENT_VERSION_TIMEOUT_MS = 5_000;
const AGENT_VERSION_MAX_BUFFER = 64 * 1024;

export type AgentTargetOs = "linux" | "windows" | "darwin";
export type AgentTargetArch = "x64" | "arm64";
export type AgentTargetState =
	| "bundled"
	| "error"
	| "cached"
	| "stale"
	| "missing"
	| "untrusted"
	| "unsupported";

export type AgentVersionReader = (binaryPath: string) => string | Promise<string>;

export interface HubPlatform {
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
}

export interface AgentTargetStatusRow {
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly triple: string | null;
	readonly status: AgentTargetState;
	readonly version?: string;
	readonly expected_version: string;
	readonly size?: number;
	readonly mtime?: string;
}

export interface AgentTargetStatusSnapshot {
	readonly hub_version: string;
	readonly targets: AgentTargetStatusRow[];
}

export interface ComputeTargetStatusOptions {
	readonly cacheDir?: string;
	readonly hubVersion?: string;
	readonly versionReader?: AgentVersionReader;
	readonly resolveAgentBinaryPath?: () => string | null;
	readonly hubPlatform?: HubPlatform | null;
}

type TargetEntry = (typeof AGENT_TARGET_TRIPLES)[AgentTargetOs][AgentTargetArch];

interface CacheCandidate {
	readonly path: string;
	readonly version: string;
}

interface TrustedCacheEntry {
	readonly version: string;
	readonly size: number;
	readonly mtime: string;
}

const TARGET_OSES = Object.keys(AGENT_TARGET_TRIPLES) as AgentTargetOs[];
const versionMemo = new WeakMap<AgentVersionReader, Map<string, string>>();

export async function computeTargetStatus(
	opts: ComputeTargetStatusOptions = {},
): Promise<AgentTargetStatusSnapshot> {
	const cacheDir = opts.cacheDir ?? getBinaryCacheDir();
	const hubVersion = opts.hubVersion ?? HUB_VERSION;
	const hubPlatform =
		opts.hubPlatform === undefined
			? getHubPlatform(process.platform, process.arch)
			: opts.hubPlatform;
	const versionReader = opts.versionReader ?? readBundledAgentVersion;
	const resolveBundledAgentPath = opts.resolveAgentBinaryPath ?? defaultResolveAgentBinaryPath;

	const targets: AgentTargetStatusRow[] = [];
	for (const os of TARGET_OSES) {
		const arches = AGENT_TARGET_TRIPLES[os];
		for (const arch of Object.keys(arches) as AgentTargetArch[]) {
			const target = arches[arch];
			if (hubPlatform?.os === os && hubPlatform.arch === arch) {
				targets.push(
					await computeBundledTargetStatus({
						os,
						arch,
						target,
						hubVersion,
						versionReader,
						resolveBundledAgentPath,
					}),
				);
				continue;
			}
			targets.push(computeRemoteTargetStatus({ cacheDir, hubVersion, os, arch, target }));
		}
	}

	return { hub_version: hubVersion, targets };
}

export async function readBundledAgentVersion(binaryPath: string): Promise<string> {
	const result = await execFile(binaryPath, ["--version"], {
		encoding: "utf8",
		maxBuffer: AGENT_VERSION_MAX_BUFFER,
		timeout: AGENT_VERSION_TIMEOUT_MS,
		windowsHide: true,
	});
	return parseVersionOutput(`${result.stdout}\n${result.stderr}`);
}

export function getHubPlatform(
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
): HubPlatform | null {
	const os =
		platform === "linux" || platform === "darwin"
			? platform
			: platform === "win32"
				? "windows"
				: null;
	const targetArch = arch === "x64" || arch === "arm64" ? arch : null;
	if (!os || !targetArch) return null;
	return { os, arch: targetArch };
}

async function computeBundledTargetStatus(args: {
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly target: TargetEntry;
	readonly hubVersion: string;
	readonly versionReader: AgentVersionReader;
	readonly resolveBundledAgentPath: () => string | null;
}): Promise<AgentTargetStatusRow> {
	const base = baseRow(args.os, args.arch, args.target, args.hubVersion);
	let binaryPath: string | null = null;
	try {
		binaryPath = args.resolveBundledAgentPath();
	} catch {
		binaryPath = null;
	}
	if (!binaryPath) return { ...base, status: "error" };

	try {
		const version = await memoizedVersionRead(binaryPath, args.versionReader);
		return { ...base, status: "bundled", version };
	} catch {
		return { ...base, status: "error" };
	}
}

function computeRemoteTargetStatus(args: {
	readonly cacheDir: string;
	readonly hubVersion: string;
	readonly os: AgentTargetOs;
	readonly arch: AgentTargetArch;
	readonly target: TargetEntry;
}): AgentTargetStatusRow {
	const base = baseRow(args.os, args.arch, args.target, args.hubVersion);
	if (!args.target.built || !args.target.triple) return { ...base, status: "unsupported" };

	const candidates = readCacheCandidates(args.cacheDir, args.os, args.arch, args.target.ext);
	if (candidates.length === 0) return { ...base, status: "missing" };

	const cacheDirSecure = isCacheDirSecure(args.cacheDir);
	const trusted: TrustedCacheEntry[] = [];
	let hasUntrusted = false;

	for (const candidate of candidates) {
		if (!cacheDirSecure || !isTrustedCacheBinary(candidate.path)) {
			hasUntrusted = true;
			continue;
		}
		try {
			validateAgentVersion(candidate.version);
			const info = lstatSync(candidate.path);
			trusted.push({
				version: candidate.version,
				size: info.size,
				mtime: info.mtime.toISOString(),
			});
		} catch {
			// Invalid version-shaped names are ignored as non-deployable cache entries.
		}
	}

	if (hasUntrusted) return { ...base, status: "untrusted" };

	const current = trusted.find((entry) => entry.version === args.hubVersion);
	if (current) {
		return {
			...base,
			status: "cached",
			version: current.version,
			size: current.size,
			mtime: current.mtime,
		};
	}

	const newest = trusted.sort((left, right) => compareSemver(left.version, right.version)).at(-1);
	if (!newest) return { ...base, status: "missing" };
	return {
		...base,
		status: "stale",
		version: newest.version,
		size: newest.size,
		mtime: newest.mtime,
	};
}

function readCacheCandidates(
	cacheDir: string,
	os: AgentTargetOs,
	arch: AgentTargetArch,
	ext: "" | ".exe",
): CacheCandidate[] {
	let names: string[];
	try {
		names = readdirSync(cacheDir);
	} catch {
		return [];
	}

	const prefix = `lasterm-agent-${os}-${arch}-`;
	const candidates: CacheCandidate[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		if (ext.length > 0 && !name.endsWith(ext)) continue;
		const versionEnd = ext.length > 0 ? name.length - ext.length : name.length;
		const version = name.slice(prefix.length, versionEnd);
		if (!version) continue;
		candidates.push({ path: join(cacheDir, name), version });
	}
	return candidates;
}

function baseRow(
	os: AgentTargetOs,
	arch: AgentTargetArch,
	target: TargetEntry,
	hubVersion: string,
): Omit<AgentTargetStatusRow, "status"> {
	return {
		os,
		arch,
		triple: target.triple,
		expected_version: hubVersion,
	};
}

async function memoizedVersionRead(
	binaryPath: string,
	versionReader: AgentVersionReader,
): Promise<string> {
	const readerCache = versionMemo.get(versionReader);
	const cached = readerCache?.get(binaryPath);
	if (cached) return cached;

	const version = await versionReader(binaryPath);
	let writableCache = readerCache;
	if (!writableCache) {
		writableCache = new Map<string, string>();
		versionMemo.set(versionReader, writableCache);
	}
	writableCache.set(binaryPath, version);
	return version;
}

function parseVersionOutput(output: string): string {
	const match = /\b(\d+\.\d+\.\d+)\b/.exec(output);
	if (!match?.[1]) throw new Error("version unreadable");
	return match[1];
}

function compareSemver(left: string, right: string): number {
	const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
	const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < 3; i++) {
		const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
