import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostArch, HostOs } from "@lasterm/shared";
import type { SFTPWrapper, Client as SshClient } from "ssh2";
import { HUB_VERSION } from "../build-version.js";
import { detectSea } from "../sea-addon-loader.js";
import {
	AGENT_TARGET_TRIPLES,
	type FetchAgentBinaryOptions,
	FetchError,
	fetchAgentBinary,
	isCacheDirSecure,
	isTrustedCacheBinary,
} from "./agent-fetch.js";
import type { OsDetectResult } from "./os-detect.js";
import { parseUnameOutput, parseWindowsArchOutput } from "./os-detect.js";
import { sshExec } from "./ssh-exec.js";

export type { OsDetectResult };

export class DeployError extends Error {
	constructor(
		public readonly code:
			| "AGENT_BINARY_REJECTED"
			| "AGENT_BINARY_UNTRUSTED"
			| "AGENT_NOT_AVAILABLE",
		message: string,
	) {
		super(message);
		this.name = "DeployError";
	}
}

/** Callback to prompt user for binary trust decision. */
export type BinaryVerifyPromptFn = (
	hostId: string,
	hostname: string,
	remotePath: string,
	remoteSha256: string,
	os: HostOs,
	arch: HostArch,
	mismatch: boolean,
	pinnedSha256?: string,
) => Promise<"trust_permanent" | "trust_once" | "reject">;

export type AgentBinaryFetcher = (options: FetchAgentBinaryOptions) => Promise<string>;

export interface DeployOptions {
	binaryCache: string;
	hostname: string;
	hostId: string;
	pinnedSha256?: string | null;
	sessionTrustedSha256?: string | null;
	promptBinaryVerify?: BinaryVerifyPromptFn;
	onAgentPinned?: (hostId: string, sha256: string) => void;
	onAgentTrustOnce?: (hostId: string, sha256: string) => void;
	onAgentUpdated?: (hostId: string) => void;
	fetchAgentBinary?: AgentBinaryFetcher;
	detectSea?: () => boolean;
	hubVersion?: string;
}

export interface DeployResult {
	/** true if a binary was uploaded (false = agent was already present) */
	deployed: boolean;
	/** true when an existing remote agent's SHA matched the trusted hub-version cache binary */
	remoteMatchesHubVersionCache: boolean;
	/** path where agent is/was found on the remote host */
	remotePath: string;
	/** detected OS (null if the agent was already present or os was known) */
	os: HostOs | null;
	/** detected arch (null if the agent was already present or arch was known) */
	arch: HostArch | null;
}

/** Common paths to check when which/where are not available */
const COMMON_AGENT_PATHS_UNIX = [
	"$HOME/.local/bin/lasterm-agent",
	"/usr/local/bin/lasterm-agent",
	"/usr/bin/lasterm-agent",
	"/opt/lasterm/lasterm-agent",
];

const COMMON_AGENT_PATHS_WINDOWS = [
	"%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe",
	"%ProgramFiles%\\lasterm\\lasterm-agent.exe",
];

const STRICT_SEMVER = /^\d+\.\d+\.\d+$/;

function canAutoFetchVersion(version: string): boolean {
	return STRICT_SEMVER.test(version) && version !== "0.0.0";
}

function getAgentCacheFileName(os: HostOs, arch: HostArch, version: string): string {
	const target = AGENT_TARGET_TRIPLES[os][arch];
	return `lasterm-agent-${os}-${arch}-${version}${target.ext}`;
}

async function resolveLocalAgentBinary(
	os: HostOs,
	arch: HostArch,
	options: DeployOptions,
	hubVersion: string,
): Promise<string | null> {
	// HUB_VERSION flows into the cache filename and can derive from the untrusted
	// LASTERM_VERSION env. An unvalidated value (path separators, "..") could
	// resolve OUTSIDE the cache dir and load a planted binary that is then deployed
	// as a trusted local agent (cache binaries bypass the remote TOFU gate). Refuse
	// anything that is not a strict semver BEFORE constructing any path.
	if (!STRICT_SEMVER.test(hubVersion)) return null;
	const localBinary = join(options.binaryCache, getAgentCacheFileName(os, arch, hubVersion));
	// Only trust a cache HIT if BOTH the cache dir AND the binary entry pass the
	// fetch-path hardening: a secure dir (real, owned, 0700) AND a binary that is a
	// regular file (not a planted symlink) owned by us. A cached binary bypasses the
	// remote TOFU gate, so anything unsafe must NOT be deployed — fall through to the
	// fetch path, which re-checks and reports the failure clearly.
	if (isCacheDirSecure(options.binaryCache) && isTrustedCacheBinary(localBinary)) {
		return localBinary;
	}

	const seaDetector = options.detectSea ?? detectSea;
	if (!seaDetector() || !canAutoFetchVersion(hubVersion)) return null;

	const fetcher = options.fetchAgentBinary ?? fetchAgentBinary;
	try {
		return await fetcher({
			os,
			arch,
			version: hubVersion,
			cacheDir: options.binaryCache,
		});
	} catch (error) {
		if (error instanceof FetchError) {
			throw new DeployError("AGENT_NOT_AVAILABLE", error.message);
		}
		throw error;
	}
}

/**
 * Check if lasterm-agent exists on the remote host.
 * Returns the remote path if found, null otherwise.
 */
export async function checkRemoteAgent(client: SshClient): Promise<string | null> {
	// 1. Try which (Linux/macOS)
	try {
		const { stdout, exitCode } = await sshExec(client, "which lasterm-agent");
		if (exitCode === 0) {
			const p = stdout.trim();
			if (p) return p;
		}
	} catch {
		// ignore — fall through
	}

	// 2. Try where (Windows)
	try {
		const { stdout, exitCode } = await sshExec(client, "where lasterm-agent");
		if (exitCode === 0) {
			const firstLine = stdout.split(/\r?\n/)[0]?.trim();
			if (firstLine) return firstLine;
		}
	} catch {
		// ignore — fall through
	}

	// 3. Try common Unix paths via test -x
	for (const rawPath of COMMON_AGENT_PATHS_UNIX) {
		try {
			const { stdout: resolved, exitCode } = await sshExec(
				client,
				`test -x "${rawPath}" && echo "${rawPath}"`,
			);
			if (exitCode === 0 && resolved.trim()) return resolved.trim();
		} catch {
			// ignore
		}
	}

	// 4. Try common Windows paths
	// NOTE: `if exist` is a cmd.exe built-in and will fail if the remote shell
	// is PowerShell. The `where` check above (step 2) already covers the common
	// case; this loop is a best-effort fallback for cmd.exe sessions only.
	for (const rawPath of COMMON_AGENT_PATHS_WINDOWS) {
		try {
			const { stdout, exitCode } = await sshExec(client, `if exist "${rawPath}" echo ok`);
			if (exitCode === 0 && stdout.trim() === "ok") return rawPath;
		} catch {
			// ignore
		}
	}

	return null;
}

/**
 * Detect OS and architecture of the remote host.
 * Tries uname -sm (Linux/macOS) first, then PROCESSOR_ARCHITECTURE (Windows).
 */
export async function detectRemoteOsArch(client: SshClient): Promise<OsDetectResult | null> {
	// 1. Try uname -sm (Linux / macOS)
	try {
		const { stdout, exitCode } = await sshExec(client, "uname -sm");
		if (exitCode === 0) {
			const result = parseUnameOutput(stdout);
			if (result) return result;
		}
	} catch {
		// ignore — Windows does not have uname
	}

	// 2. Try Windows PROCESSOR_ARCHITECTURE
	try {
		const { stdout, exitCode } = await sshExec(client, "echo %PROCESSOR_ARCHITECTURE%");
		if (exitCode === 0) {
			const result = parseWindowsArchOutput(stdout);
			if (result) return result;
		}
	} catch {
		// ignore
	}

	return null;
}

/**
 * Open an SFTP channel from the SSH client.
 * Returns the SFTPWrapper, which must be explicitly closed after use.
 */
function openSftp(client: SshClient): Promise<SFTPWrapper> {
	return new Promise((resolve, reject) => {
		client.sftp((err, sftp) => {
			if (err) reject(err);
			else resolve(sftp);
		});
	});
}

/** mkdir -p via SFTP: creates dir and ignores EEXIST errors. */
function sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
	return new Promise((resolve) => {
		sftp.mkdir(remotePath, (_err) => {
			// Swallow all errors: EEXIST is expected when the directory already
			// exists. Other errors (e.g. permission denied) will surface at
			// fastPut time, which provides a clearer message.
			resolve();
		});
	});
}

/** Upload a local file to a remote path via SFTP fastPut (streaming — handles large files). */
function sftpFastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.fastPut(localPath, remotePath, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/** chmod a remote file via SFTP. */
function sftpChmod(sftp: SFTPWrapper, remotePath: string, mode: number): Promise<void> {
	return new Promise((resolve, reject) => {
		sftp.chmod(remotePath, mode, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/**
 * Upload the agent binary to the remote host via SFTP.
 * Ensures the parent directory exists, uploads with fastPut (streaming),
 * then chmod 755 the binary.
 */
export async function uploadAgentBinary(
	client: SshClient,
	localPath: string,
	remotePath: string,
): Promise<void> {
	const sftp = await openSftp(client);
	try {
		// Ensure parent directory exists (ignore failures — will fail at fastPut if real error)
		const parentDir = remotePath.includes("/")
			? remotePath.slice(0, remotePath.lastIndexOf("/"))
			: remotePath.includes("\\")
				? remotePath.slice(0, remotePath.lastIndexOf("\\"))
				: ".";
		if (parentDir && parentDir !== ".") {
			await sftpMkdir(sftp, parentDir);
		}

		// Upload binary using fastPut (streaming — handles large binaries ~120 MB)
		await sftpFastPut(sftp, localPath, remotePath);

		// Make executable (chmod 755) — no-op on Windows but harmless
		await sftpChmod(sftp, remotePath, 0o755);
	} finally {
		sftp.end();
	}
}

/**
 * Resolve the remote home directory by running echo $HOME via SSH.
 * Falls back to "~" if the command fails or returns the literal $HOME.
 */
async function resolveRemoteHome(client: SshClient): Promise<string> {
	try {
		const { stdout, exitCode } = await sshExec(client, "echo $HOME");
		if (exitCode === 0) {
			const home = stdout.trim();
			if (home && home !== "$HOME") return home;
		}
	} catch {
		// ignore
	}
	return "~";
}

/**
 * Determine the remote install path for the agent binary.
 * Expands ~ using the actual remote home directory.
 */
async function resolveRemotePath(client: SshClient, os: HostOs): Promise<string> {
	if (os === "windows") {
		return "%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe";
	}
	const home = await resolveRemoteHome(client);
	return `${home}/.local/bin/lasterm-agent`;
}

/**
 * Full auto-deploy flow.
 *
 * 1. Check if lasterm-agent is already on the remote host.
 * 2. If not found, detect OS/arch (or use known values from host record).
 * 3. Locate the correct pre-built binary in the local binary cache.
 * 4. Upload via SFTP.
 *
 * Auto-deploy is best-effort — callers should catch errors and fall back
 * to attempting lasterm-agent --stdio directly.
 */
/**
 * Full auto-deploy flow with SHA256 integrity verification and TOFU support.
 *
 * Branch A — agent found on remote:
 *   If we have a local binary: compare SHA256 hashes, re-upload on mismatch.
 *   If no local binary: run TOFU flow (pin check / prompt / session trust).
 *
 * Branch B — agent not found:
 *   Upload from local cache, or throw DeployError("AGENT_NOT_AVAILABLE").
 *
 * Auto-deploy is best-effort — callers should catch DeployError and surface
 * it appropriately (prompt, modal, fallback).
 */
export async function deployAgentIfNeeded(
	client: SshClient,
	host: { os: HostOs | null; arch: HostArch | null },
	options: DeployOptions,
): Promise<DeployResult> {
	const {
		binaryCache,
		hostname,
		hostId,
		pinnedSha256,
		sessionTrustedSha256,
		promptBinaryVerify,
		onAgentPinned,
		onAgentTrustOnce,
		onAgentUpdated,
	} = options;
	const hubVersion = options.hubVersion ?? HUB_VERSION;

	// 1. Check if agent is already present on the remote host
	const existingPath = await checkRemoteAgent(client);

	if (existingPath) {
		// --- Branch A: agent already exists ---

		// 1a. Detect OS/arch if not known (needed for SHA256 + binary name)
		let os = host.os;
		let arch = host.arch;
		if (!os || !arch) {
			const detected = await detectRemoteOsArch(client);
			if (!detected) {
				throw new Error(
					"Cannot detect remote OS/arch for agent deployment. " +
						"Set os/arch on the host manually or check SSH connectivity.",
				);
			}
			os = detected.os;
			arch = detected.arch;
		}

		// 1b. Compute remote SHA256
		const remoteSha = await getRemoteSha256(client, existingPath, os);

		// 1c. Do we have a local binary for this OS/arch?
		const localBinary = await resolveLocalAgentBinary(os, arch, options, hubVersion);

		if (localBinary !== null) {
			// Compare local vs remote SHA256 — re-upload on mismatch or unknown remote hash
			const localSha = getLocalSha256(localBinary);
			if (remoteSha !== null && localSha !== null && remoteSha === localSha) {
				// Hashes match — nothing to do
				return {
					deployed: false,
					remoteMatchesHubVersionCache: true,
					remotePath: existingPath,
					os,
					arch,
				};
			}
			// Mismatch (or remoteSha unavailable) — re-upload from trusted local copy
			await uploadAgentBinary(client, localBinary, existingPath);
			onAgentUpdated?.(hostId);
			// Refresh the pin to the newly uploaded binary's hash so the next
			// reconnect without local cache doesn't trigger another mismatch prompt.
			if (localSha !== null) {
				onAgentPinned?.(hostId, localSha);
			}
			return {
				deployed: true,
				remoteMatchesHubVersionCache: false,
				remotePath: existingPath,
				os,
				arch,
			};
		}

		// 1d. No local binary — TOFU flow
		if (remoteSha === null) {
			// Cannot verify, treat as untrusted
			throw new DeployError(
				"AGENT_BINARY_UNTRUSTED",
				`Cannot compute SHA256 for remote agent at ${existingPath}. Upload a known-good binary or verify the remote agent manually.`,
			);
		}

		// Session trust: already trusted this exact hash this session
		if (sessionTrustedSha256 && sessionTrustedSha256 === remoteSha) {
			return {
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: existingPath,
				os,
				arch,
			};
		}

		// Pinned trust: pinned hash matches remote — all good
		if (pinnedSha256 && pinnedSha256 === remoteSha) {
			return {
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: existingPath,
				os,
				arch,
			};
		}

		// Need to prompt
		if (!promptBinaryVerify) {
			throw new DeployError(
				"AGENT_BINARY_UNTRUSTED",
				`Remote agent at ${existingPath} (sha256: ${remoteSha}) cannot be verified — no verification prompt registered.`,
			);
		}

		const mismatch = pinnedSha256 != null && pinnedSha256 !== remoteSha;
		const action = await promptBinaryVerify(
			hostId,
			hostname,
			existingPath,
			remoteSha,
			os,
			arch,
			mismatch,
			pinnedSha256 ?? undefined,
		);

		if (action === "trust_permanent") {
			onAgentPinned?.(hostId, remoteSha);
			return {
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: existingPath,
				os,
				arch,
			};
		}
		if (action === "trust_once") {
			onAgentTrustOnce?.(hostId, remoteSha);
			return {
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: existingPath,
				os,
				arch,
			};
		}
		// action === "reject"
		throw new DeployError(
			"AGENT_BINARY_REJECTED",
			`User rejected remote agent binary at ${existingPath} (sha256: ${remoteSha}).`,
		);
	}

	// --- Branch B: agent not found — fresh deploy ---

	// 2. Detect OS/arch if not already known from the host record
	let os = host.os;
	let arch = host.arch;
	if (!os || !arch) {
		const detected = await detectRemoteOsArch(client);
		if (!detected) {
			throw new Error(
				"Cannot detect remote OS/arch for agent deployment. " +
					"Set os/arch on the host manually or check SSH connectivity.",
			);
		}
		os = detected.os;
		arch = detected.arch;
	}

	// 3. Locate the binary in the local cache
	const localBinary = await resolveLocalAgentBinary(os, arch, options, hubVersion);
	if (localBinary === null) {
		const expectedBinary = join(binaryCache, getAgentCacheFileName(os, arch, hubVersion));
		throw new DeployError(
			"AGENT_NOT_AVAILABLE",
			`Agent binary not found in cache: ${expectedBinary}. Build it or copy it to the binary cache (see docs/MVP_ROADMAP.md).`,
		);
	}

	// 4. Determine remote install path (expands ~ using remote $HOME)
	const remotePath = await resolveRemotePath(client, os);

	// 5. Upload via SFTP (fastPut handles large binaries efficiently)
	await uploadAgentBinary(client, localBinary, remotePath);

	return { deployed: true, remoteMatchesHubVersionCache: false, remotePath, os, arch };
}

/**
 * Return the path to the binary cache directory inside the hub state dir.
 * Uses the same XDG / platform-aware logic as getStateDir() in cli.ts.
 */
export function getBinaryCacheDir(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? "", "lasterm", "binaries");
	}
	const stateBase = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(stateBase, "lasterm", "binaries");
}

/**
 * Compute the SHA256 hash of a remote file by running sha256sum (Linux/macOS)
 * or PowerShell's Get-FileHash (Windows) over SSH.
 * Returns the lowercase hex digest, or null on failure.
 */
export async function getRemoteSha256(
	client: SshClient,
	remotePath: string,
	os: HostOs,
): Promise<string | null> {
	try {
		const escapedPath =
			os === "windows" ? remotePath.replace(/'/g, "''") : remotePath.replace(/'/g, "'\\''");
		let cmd: string;
		if (os === "windows") {
			cmd = `powershell -c "(Get-FileHash '${escapedPath}' -Algorithm SHA256).Hash.ToLower()"`;
		} else if (os === "darwin") {
			// macOS ships shasum (not sha256sum); same output format: "hash  filename"
			cmd = `shasum -a 256 '${escapedPath}'`;
		} else {
			cmd = `sha256sum '${escapedPath}'`;
		}
		const { stdout, exitCode } = await sshExec(client, cmd);
		if (exitCode !== 0) return null;
		const trimmed = stdout.trim();
		// sha256sum: "hash  filename" — take first 64 hex chars
		// PowerShell: just the hash on one line
		const match = trimmed.match(/^([a-f0-9]{64})/i);
		return match?.[1]?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

/**
 * Compute the SHA256 hash of a local file.
 * Returns the lowercase hex digest, or null if the file cannot be read.
 */
export function getLocalSha256(localPath: string): string | null {
	try {
		const data = readFileSync(localPath);
		return createHash("sha256").update(data).digest("hex");
	} catch {
		return null;
	}
}
