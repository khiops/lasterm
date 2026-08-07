import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";

export type FetchErrorCode =
	| "BAD_VERSION"
	| "UNSUPPORTED_TARGET"
	| "NOT_FOUND"
	| "RELEASE_INCOMPLETE"
	| "RATE_LIMITED"
	| "PRIVATE_OR_FORBIDDEN"
	| "NETWORK"
	| "TOO_LARGE"
	| "DISK"
	| "CHECKSUM_MISMATCH"
	| "CHECKSUM_MISSING"
	| "ALREADY_CURRENT";

export type FetchErrorPolicyCode = "INSECURE_CACHE_DIR";

export class FetchError extends Error {
	readonly code: FetchErrorCode;
	readonly policyCode?: FetchErrorPolicyCode;

	constructor(
		code: FetchErrorCode,
		message: string,
		opts: { readonly policyCode?: FetchErrorPolicyCode } = {},
	) {
		super(message);
		this.name = "FetchError";
		this.code = code;
		if (opts.policyCode !== undefined) this.policyCode = opts.policyCode;
	}
}

type AgentTargetEntry = {
	readonly triple: string | null;
	readonly ext: "" | ".exe";
	readonly built: boolean;
};

export type ResolvedTarget = {
	readonly triple: string;
	readonly ext: "" | ".exe";
};

export const AGENT_TARGET_TRIPLES = {
	linux: {
		x64: { triple: "x86_64-unknown-linux-gnu", ext: "", built: true },
		arm64: { triple: "aarch64-unknown-linux-gnu", ext: "", built: true },
	},
	windows: {
		x64: { triple: "x86_64-pc-windows-msvc", ext: ".exe", built: true },
		arm64: { triple: null, ext: ".exe", built: false },
	},
	darwin: {
		x64: { triple: null, ext: "", built: false },
		arm64: { triple: null, ext: "", built: false },
	},
} as const satisfies Record<string, Record<string, AgentTargetEntry>>;

const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;
const TEMP_SUFFIX = /^\.(\d+)\.([0-9a-f]{16})\.tmp$/;

export const AGENT_FETCH_MAX_BYTES = 64 * 1024 * 1024;
export const AGENT_FETCH_MANIFEST_MAX_BYTES = 1024 * 1024;
export const AGENT_FETCH_TOTAL_TIMEOUT_MS = 120_000;
export const AGENT_FETCH_IDLE_TIMEOUT_MS = 30_000;

export function validateAgentVersion(version: string): void {
	if (!STRICT_SEMVER.test(version) || version === "0.0.0") {
		throw new FetchError(
			"BAD_VERSION",
			`Bad Lasterm agent version "${version}". Use a released strict semver like 0.4.0, or rerun lasterm-hub agent fetch --version <x.y.z> with a real release version before downloading.`,
		);
	}
}

export function resolveTarget(os: string, arch: string): ResolvedTarget | null {
	const table = AGENT_TARGET_TRIPLES as Record<
		string,
		Record<string, AgentTargetEntry> | undefined
	>;
	const row = table[os]?.[arch];
	if (!row?.built || !row.triple) return null;
	return { triple: row.triple, ext: row.ext };
}

export function parseChecksumManifest(manifest: string, expectedBasename: string): string | null {
	let found: string | null = null;
	const seenFiles = new Set<string>();

	for (const rawLine of manifest.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (line.length === 0) continue;

		const match = /^([0-9a-fA-F]{64})[ \t]+[*]?(.+)$/.exec(line);
		if (!match) {
			throw new FetchError(
				"CHECKSUM_MISMATCH",
				`Checksum manifest has an invalid line. Re-download SHA256SUMS or publish a sha256sum-compatible line for ${expectedBasename}.`,
			);
		}

		const digest = match[1]?.toLowerCase();
		const filename = match[2];
		if (!digest || !filename) {
			throw new FetchError(
				"CHECKSUM_MISMATCH",
				`Checksum manifest has an invalid line. Re-download SHA256SUMS or publish a sha256sum-compatible line for ${expectedBasename}.`,
			);
		}
		if (filename.includes("/") || filename.includes("\\")) {
			throw new FetchError(
				"CHECKSUM_MISMATCH",
				`Checksum manifest must name ${expectedBasename} by exact basename only, not a path-prefixed filename.`,
			);
		}
		if (seenFiles.has(filename)) {
			throw new FetchError(
				"CHECKSUM_MISMATCH",
				`Checksum manifest lists ${filename} more than once. Remove duplicate SHA256SUMS lines and rerun the agent fetch.`,
			);
		}
		seenFiles.add(filename);

		if (filename !== expectedBasename) continue;
		found = digest;
	}

	return found;
}

export function verifyAndPlace(
	tempBinaryPath: string,
	expectedBasename: string,
	manifestContent: string,
	cacheDir: string,
	opts: { readonly force?: boolean } = {},
): string {
	assertBasename(expectedBasename);

	const expected = parseChecksumManifest(manifestContent, expectedBasename);
	if (!expected) {
		throw new FetchError(
			"CHECKSUM_MISSING",
			`Missing checksum entry for ${expectedBasename}. Re-download SHA256SUMS or publish a sha256sum-compatible line for ${expectedBasename}.`,
		);
	}

	const actual = sha256File(tempBinaryPath);
	if (actual !== expected) {
		throw new FetchError(
			"CHECKSUM_MISMATCH",
			`Checksum mismatch for ${expectedBasename}. Delete the partial download and retry before trusting the cached agent binary.`,
		);
	}

	ensureCacheDir(cacheDir);
	assertTrustedTempBinary(tempBinaryPath);

	const finalPath = join(
		cacheDir,
		resolveCacheBasename(tempBinaryPath, expectedBasename, cacheDir),
	);
	if (!opts.force) assertCanPlaceWithoutForce(finalPath);

	chmodSync(tempBinaryPath, 0o755);
	renameSync(tempBinaryPath, finalPath);
	return finalPath;
}

export function pruneAgentBinaryCache(cacheDir: string, version: string): number {
	validateAgentVersion(version);

	// Never prune through an untrusted/symlinked cache dir: readdirSync follows a
	// directory symlink and would delete matching lasterm-agent-* files in the link
	// target. isCacheDirSecure also returns false for a missing dir.
	if (!isCacheDirSecure(cacheDir)) return 0;

	let removed = 0;
	for (const name of readdirSync(cacheDir)) {
		const parsed = parseAgentBinaryCacheName(name);
		if (!parsed || parsed.version === version) continue;

		const path = join(cacheDir, name);
		try {
			// lstat (not stat): never follow a symlink when deciding what to delete.
			if (!lstatSync(path).isFile()) continue;
			rmSync(path);
			removed++;
		} catch {
			// Entry vanished or was unremovable mid-prune (raced removal); prune is
			// best-effort cleanup, so skip it.
		}
	}
	return removed;
}

export function ensureCacheDir(cacheDir: string): void {
	try {
		mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
	} catch (error) {
		if (isErrno(error, "ENOSPC")) throw diskError(cacheDir, cacheDir, error);
		throw new FetchError(
			"DISK",
			`Could not create Lasterm agent cache directory ${cacheDir}. Fix permissions or create it with mode 0700, then rerun the agent fetch.`,
		);
	}
	assertSecureCacheDir(cacheDir);
}

// mkdirSync's mode only applies when it CREATES the directory; a pre-existing
// cache dir with loose permissions (or a hostile owner / symlink) would let a
// local attacker swap the temp or final binary after checksum verification.
// Because this cache holds executables that get uploaded to and run on remote
// hosts, reject an unsafe directory and tighten a loose one we own.
export function assertSecureCacheDir(cacheDir: string): void {
	if (lstatSync(cacheDir).isSymbolicLink()) {
		throw insecureCacheDirError(
			`Lasterm agent cache ${cacheDir} is a symlink; refusing to place agent binaries there. Replace it with a real directory (mode 0700) and rerun the agent fetch.`,
		);
	}
	// POSIX ownership/permission model only (skip on Windows).
	if (process.platform === "win32") return;
	const stat = statSync(cacheDir);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw insecureCacheDirError(
			`Lasterm agent cache ${cacheDir} is not owned by the current user; refusing to place agent binaries there. Fix its ownership (or point the cache elsewhere), then rerun the agent fetch.`,
		);
	}
	// Owned by us but group/other-accessible — tighten to 0700.
	if ((stat.mode & 0o077) !== 0) {
		try {
			chmodSync(cacheDir, 0o700);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw insecureCacheDirError(
				`Lasterm agent cache ${cacheDir} has loose permissions and could not be tightened to mode 0700: ${detail}. Fix permissions and rerun the agent fetch.`,
			);
		}
	}
}

/**
 * True only if `cacheDir` exists and is safe to trust for cached agent binaries:
 * a real directory (not a symlink), owned by the current user, with no group/other
 * write access (tightened to 0700 if it was loose). A non-existent or unsafe dir
 * returns false. Lets the deployer's cache-HIT path enforce the SAME hardening the
 * fetch path applies, so a binary planted in an insecure cache cannot be deployed
 * as a trusted local agent.
 */
export function isCacheDirSecure(cacheDir: string): boolean {
	try {
		assertSecureCacheDir(cacheDir);
		return true;
	} catch {
		return false;
	}
}

/**
 * True only if `filePath` is a regular file (not a symlink, directory, or special
 * file) owned by the current user on POSIX — i.e. a cached binary safe to deploy
 * without the remote TOFU check. Uses lstat (NOT stat), so a planted symlink in an
 * otherwise-secure cache dir is rejected rather than followed and uploaded as a
 * trusted local agent.
 */
export function isTrustedCacheBinary(filePath: string): boolean {
	try {
		const info = lstatSync(filePath);
		if (!info.isFile()) return false;
		if (process.platform === "win32") return true;
		const uid = process.getuid?.();
		return uid === undefined || info.uid === uid;
	} catch {
		return false;
	}
}

export function createUniqueTempPath(finalPath: string): string {
	for (let attempt = 0; attempt < 32; attempt++) {
		const rand = randomBytes(8).toString("hex");
		const tempPath = `${finalPath}.${process.pid}.${rand}.tmp`;
		if (!existsSync(tempPath)) return tempPath;
	}
	throw new FetchError(
		"DISK",
		`Could not allocate a unique temp file beside ${finalPath}. Remove stale *.tmp files from the cache and rerun the agent fetch.`,
	);
}

export function removeFileIfPresent(path: string): void {
	rmSync(path, { force: true });
}

export function diskError(path: string, finalPath: string, error: unknown): FetchError {
	const detail = error instanceof Error ? error.message : String(error);
	return new FetchError(
		"DISK",
		`Disk error while writing ${path}: ${detail}. Free space or fix cache permissions, then rerun the agent fetch or manually place the binary at ${finalPath}.`,
	);
}

function insecureCacheDirError(message: string): FetchError {
	return new FetchError("DISK", message, { policyCode: "INSECURE_CACHE_DIR" });
}

function parseAgentBinaryCacheName(name: string): { readonly version: string } | null {
	for (const [os, arches] of Object.entries(AGENT_TARGET_TRIPLES)) {
		if (!arches) continue;
		for (const [arch, target] of Object.entries(arches)) {
			const prefix = `lasterm-agent-${os}-${arch}-`;
			if (!name.startsWith(prefix) || !name.endsWith(target.ext)) continue;
			const versionEnd = target.ext.length > 0 ? name.length - target.ext.length : name.length;
			const version = name.slice(prefix.length, versionEnd);
			if (STRICT_SEMVER.test(version)) return { version };
		}
	}
	return null;
}

function assertBasename(value: string): void {
	if (
		value.length === 0 ||
		value.includes("/") ||
		value.includes("\\") ||
		basename(value) !== value
	) {
		throw new FetchError(
			"CHECKSUM_MISMATCH",
			`Checksum manifest must name ${value} by exact basename only, not a path-prefixed filename.`,
		);
	}
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertTrustedTempBinary(path: string): void {
	const info = lstatSync(path);
	if (!info.isFile()) {
		throw new FetchError(
			"DISK",
			`Lasterm agent temp binary ${path} is not a regular file; refusing to place it in the cache.`,
		);
	}
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && info.uid !== uid) {
		throw new FetchError(
			"DISK",
			`Lasterm agent temp binary ${path} is not owned by the current user; refusing to place it in the cache.`,
		);
	}
}

function assertCanPlaceWithoutForce(finalPath: string): void {
	try {
		const info = lstatSync(finalPath);
		if (info.isSymbolicLink()) {
			throw new FetchError(
				"DISK",
				`Lasterm agent cache entry ${finalPath} is a symlink; refusing to overwrite it. Remove it and retry.`,
			);
		}
		if (isTrustedCacheBinary(finalPath)) {
			throw new FetchError(
				"ALREADY_CURRENT",
				`Lasterm agent cache entry ${finalPath} already exists. Use force to replace it.`,
			);
		}
		throw new FetchError(
			"DISK",
			`Lasterm agent cache entry ${finalPath} is not a trusted regular file; refusing to overwrite it. Remove it and retry.`,
		);
	} catch (error) {
		if (error instanceof FetchError) throw error;
		if (isErrno(error, "ENOENT")) return;
		throw error;
	}
}

function resolveCacheBasename(
	tempBinaryPath: string,
	expectedBasename: string,
	cacheDir: string,
): string {
	const fromExpected = cacheBasenameFromReleaseAsset(expectedBasename);
	if (fromExpected) return fromExpected;

	const fromTemp = cacheBasenameFromTempPath(tempBinaryPath, cacheDir);
	if (fromTemp) return fromTemp;

	return expectedBasename;
}

function cacheBasenameFromReleaseAsset(expectedBasename: string): string | null {
	for (const [os, arches] of Object.entries(AGENT_TARGET_TRIPLES)) {
		if (!arches) continue;
		for (const [arch, target] of Object.entries(arches)) {
			if (!target.built || !target.triple) continue;
			const prefix = `lasterm-agent-${target.triple}-`;
			if (!expectedBasename.startsWith(prefix) || !expectedBasename.endsWith(target.ext)) {
				continue;
			}
			const versionEnd =
				target.ext.length > 0
					? expectedBasename.length - target.ext.length
					: expectedBasename.length;
			const version = expectedBasename.slice(prefix.length, versionEnd);
			validateAgentVersion(version);
			return `lasterm-agent-${os}-${arch}-${version}${target.ext}`;
		}
	}
	return null;
}

function cacheBasenameFromTempPath(tempBinaryPath: string, cacheDir: string): string | null {
	if (resolvePath(dirname(tempBinaryPath)) !== resolvePath(cacheDir)) return null;
	const tempBase = basename(tempBinaryPath);
	for (const suffix of tempBase.matchAll(/\.\d+\.[0-9a-f]{16}\.tmp/g)) {
		const suffixText = suffix[0];
		if (!TEMP_SUFFIX.test(suffixText) || !tempBase.endsWith(suffixText)) continue;
		const finalBase = tempBase.slice(0, tempBase.length - suffixText.length);
		return finalBase.length > 0 ? finalBase : null;
	}
	return null;
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
