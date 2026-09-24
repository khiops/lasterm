import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostArch, HostOs } from "@lasterm/shared";
import { lastermDir } from "@lasterm/shared/dist/platform-dirs.js";
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
import { quotePosix } from "./remote-daemon.js";
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

/**
 * A remote binary nobody here has approved, handed back for a decision.
 *
 * Thrown rather than asked about, because this happens over a live SSH
 * connection: the caller closes it, asks, and comes again with the answer in
 * `approvedSha256`. What it carries is what the person will be shown.
 */
export class AgentBinaryDecisionNeeded extends Error {
	readonly hostId: string;
	readonly hostname: string;
	readonly remotePath: string;
	readonly remoteSha256: string;
	readonly os: HostOs;
	readonly arch: HostArch;
	readonly mismatch: boolean;
	readonly pinnedSha256?: string;

	constructor(facts: {
		hostId: string;
		hostname: string;
		remotePath: string;
		remoteSha256: string;
		os: HostOs;
		arch: HostArch;
		mismatch: boolean;
		pinnedSha256?: string;
	}) {
		super(
			`The remote agent at ${facts.remotePath} (sha256: ${facts.remoteSha256}) needs a decision.`,
		);
		this.name = "AgentBinaryDecisionNeeded";
		this.hostId = facts.hostId;
		this.hostname = facts.hostname;
		this.remotePath = facts.remotePath;
		this.remoteSha256 = facts.remoteSha256;
		this.os = facts.os;
		this.arch = facts.arch;
		this.mismatch = facts.mismatch;
		if (facts.pinnedSha256 !== undefined) this.pinnedSha256 = facts.pinnedSha256;
	}
}

export interface DeployOptions {
	binaryCache: string;
	hostname: string;
	hostId: string;
	pinnedSha256?: string | null;
	sessionTrustedSha256?: string | null;
	/**
	 * The hash a person approved for this host, on the attempt before this one.
	 *
	 * Set when resuming after a decision: the binary found now must be the one
	 * that was shown, or the question is asked again about what is actually
	 * there.
	 */
	approvedSha256?: string | null;
	onAgentPinned?: (hostId: string, sha256: string) => void;
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

/** The remote system as it reported itself, and the agent target it maps to, if any. */
export interface RemoteSystem {
	/** `uname -sm`, or `Windows <arch>`: what the remote said, supported or not. */
	readonly system: string;
	readonly parsed: OsDetectResult | null;
}

/**
 * Read the remote system: `uname -sm` (Linux / macOS) first, then the Windows
 * PROCESSOR_ARCHITECTURE. `null` when the remote answered neither. A system it
 * did name but no agent is built for keeps its name, so that a refusal can say
 * which system it is (#401) rather than that none could be detected.
 */
export async function readRemoteSystem(
	client: SshClient,
	timeoutMs?: number,
): Promise<RemoteSystem | null> {
	let unix: string | null = null;
	try {
		const { stdout, exitCode } = await sshExec(client, "uname -sm", timeoutMs);
		if (exitCode === 0 && stdout.trim()) {
			unix = stdout.trim();
			const parsed = parseUnameOutput(unix);
			if (parsed) return { system: unix, parsed };
		}
	} catch {
		// ignore — Windows does not have uname
	}

	try {
		const { stdout, exitCode } = await sshExec(client, "echo %PROCESSOR_ARCHITECTURE%", timeoutMs);
		const arch = stdout.trim();
		const parsed = exitCode === 0 ? parseWindowsArchOutput(arch) : null;
		if (parsed) return { system: `Windows ${arch}`, parsed };
	} catch {
		// ignore
	}

	return unix === null ? null : { system: unix, parsed: null };
}

/** Detect OS and architecture of the remote host, when an agent target exists for it. */
export async function detectRemoteOsArch(client: SshClient): Promise<OsDetectResult | null> {
	return (await readRemoteSystem(client))?.parsed ?? null;
}

/** Why no agent target could be resolved for this remote. */
function noAgentTargetError(read: RemoteSystem | null): Error {
	if (read) {
		return new Error(
			`No Lasterm agent is built for this system (${read.system}), so sessions cannot start on it.`,
		);
	}
	return new Error(
		"Cannot detect remote OS/arch for agent deployment. " +
			"Set os/arch on the host manually or check SSH connectivity.",
	);
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

/** Remove a remote file via SFTP, whatever happens: this only ever cleans up after a failure. */
function sftpUnlinkQuietly(sftp: SFTPWrapper, remotePath: string): Promise<void> {
	return new Promise((resolve) => {
		try {
			sftp.unlink(remotePath, () => resolve());
		} catch {
			resolve();
		}
	});
}

/**
 * Rename `from` over `to` with OpenSSH's `posix-rename@openssh.com`, which is
 * rename(2): atomic, and it replaces a target that exists. The plain SFTP
 * rename is no use here, since it refuses a target that exists.
 *
 * Resolves false when the server does not offer the extension, which ssh2
 * says by throwing before it sends anything.
 */
function sftpPosixRename(sftp: SFTPWrapper, from: string, to: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		try {
			sftp.ext_openssh_rename(from, to, (err) => {
				if (err) reject(err);
				else resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}

/**
 * The same rename, run by the remote's shell, for a server without the
 * extension. `mv` within one directory is rename(2) too. A directory at the
 * target is refused rather than moved into.
 */
async function execRename(client: SshClient, from: string, to: string): Promise<void> {
	const target = quotePosix(to);
	const { stderr, exitCode } = await sshExec(
		client,
		`test ! -d ${target} && mv -f -- ${quotePosix(from)} ${target}`,
	);
	if (exitCode !== 0) {
		const said = stderr.trim();
		throw new Error(`exit ${exitCode}${said === "" ? "" : `: ${said}`}`);
	}
}

/**
 * A name for the upload beside `remotePath`: same directory, so the rename
 * stays on one filesystem, and hidden and unique, so nothing takes it for the
 * agent and two uploads never share one.
 */
function uploadTempPath(remotePath: string): string {
	const cut = remotePath.lastIndexOf("/");
	const dir = remotePath.slice(0, cut + 1);
	const name = remotePath.slice(cut + 1);
	return `${dir}.${name}.${randomBytes(8).toString("hex")}.partial`;
}

/**
 * Upload the agent binary to the remote host via SFTP.
 *
 * On a POSIX remote the binary is written beside the target under a
 * temporary name, made executable, and only then renamed over it (#555). A
 * remote daemon may be running from the target: Linux refuses to open a
 * running executable for writing (ETXTBSY, which SFTP only calls "Failure"),
 * while a rename leaves the running process its own inode and gives the next
 * launch the new file. The target is only ever replaced by a whole, executable
 * file; on any failure the temporary is removed and the target is as it was.
 *
 * A Windows remote is written in place, as before. Its agent runs on stdio and
 * exits with its connection, so nothing is running from the file, and the
 * rename would not help anyway: Windows refuses to replace a running
 * executable, and the `mv` fallback is a POSIX shell's.
 */
export async function uploadAgentBinary(
	client: SshClient,
	localPath: string,
	remotePath: string,
	os: HostOs,
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

		if (os === "windows") {
			// Upload binary using fastPut (streaming — handles large binaries ~120 MB)
			await sftpFastPut(sftp, localPath, remotePath);
			// Make executable (chmod 755) — no-op on Windows but harmless
			await sftpChmod(sftp, remotePath, 0o755);
			return;
		}

		const temp = uploadTempPath(remotePath);
		let step = `upload the agent to ${temp}`;
		try {
			await sftpFastPut(sftp, localPath, temp);
			step = `make ${temp} executable`;
			await sftpChmod(sftp, temp, 0o755);
			step = `move the agent into place at ${remotePath}`;
			if (!(await sftpPosixRename(sftp, temp, remotePath))) {
				await execRename(client, temp, remotePath);
			}
		} catch (err) {
			await sftpUnlinkQuietly(sftp, temp);
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Could not ${step}: ${message}`, { cause: err });
		}
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
		approvedSha256,
		onAgentPinned,
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
			const read = await readRemoteSystem(client);
			const detected = read?.parsed;
			if (!detected) throw noAgentTargetError(read);
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
			// Mismatch (or remoteSha unavailable) — re-upload from trusted local copy.
			// A daemon may be running from existingPath; the upload goes beside it
			// and is renamed over it, so the daemon keeps running the old version
			// until someone replaces it (#456, #555).
			await uploadAgentBinary(client, localBinary, existingPath, os);
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

		// The answer this very binary was already given, on the way here: a
		// decision was asked for, the connection was closed while it was
		// considered, and this is the resumed attempt. The comparison is against
		// the hash that was *shown*: a remote binary that changed while the
		// question was open was never the one anybody approved.
		if (approvedSha256 && approvedSha256 === remoteSha) {
			return {
				deployed: false,
				remoteMatchesHubVersionCache: false,
				remotePath: existingPath,
				os,
				arch,
			};
		}

		// Nobody can be asked from in here: this runs over a live SSH connection
		// to the remote machine, and a connection held open while a person thinks
		// is the thing that must not happen (#444). What is known is handed back,
		// the caller closes the connection, asks, and comes again with an answer.
		throw new AgentBinaryDecisionNeeded({
			hostId,
			hostname,
			remotePath: existingPath,
			remoteSha256: remoteSha,
			os,
			arch,
			mismatch: pinnedSha256 != null && pinnedSha256 !== remoteSha,
			...(pinnedSha256 != null ? { pinnedSha256 } : {}),
		});
	}

	// --- Branch B: agent not found — fresh deploy ---

	// 2. Detect OS/arch if not already known from the host record
	let os = host.os;
	let arch = host.arch;
	if (!os || !arch) {
		const read = await readRemoteSystem(client);
		const detected = read?.parsed;
		if (!detected) throw noAgentTargetError(read);
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
	await uploadAgentBinary(client, localBinary, remotePath, os);

	return { deployed: true, remoteMatchesHubVersionCache: false, remotePath, os, arch };
}

/** The binary cache directory inside the hub state dir. */
export function getBinaryCacheDir(): string {
	return join(lastermDir("state"), "binaries");
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
