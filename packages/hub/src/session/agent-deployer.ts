import { createHash, randomBytes } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostArch, HostOs } from "@lasterm/shared";
import { lastermDir } from "@lasterm/shared/dist/platform-dirs.js";
import type { ClientChannel, SFTPWrapper, Client as SshClient } from "ssh2";
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
	/**
	 * Whether the server offers SFTP, as the connection's probe found (#722), or
	 * the probe still running. An upload waits for it; without it, SFTP is tried
	 * first.
	 */
	sftp?: SftpSupport | Promise<SftpSupport>;
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

type KnownFolder = "LocalApplicationData" | "ProgramFiles";
type FolderResult = { path: string } | { reason: string };

const COMMON_AGENT_PATHS_WINDOWS: readonly [KnownFolder, string][] = [
	["LocalApplicationData", "lasterm\\lasterm-agent.exe"],
	["ProgramFiles", "lasterm\\lasterm-agent.exe"],
];

/**
 * A Windows path the deployer may use: drive-absolute (`C:\…`) or UNC (`\\server\share…`, as a
 * known folder redirected to a network share is), with no `"`, which no Windows file name holds,
 * and no control character. Every command takes the path as Base64 data, and SFTP takes it as
 * it is, so `%`, `!`, `$`, quotes and spaces mean nothing to cmd.exe or PowerShell (#714).
 */
function isWindowsPath(path: string): boolean {
	return /^(?:[A-Za-z]:\\|\\\\[^\\/.?][^\\/]*\\[^\\/])/.test(path) && !/["\p{Cc}]/u.test(path);
}

function joinWindowsPath(folder: string, relative: string): string {
	return `${folder}${folder.endsWith("\\") ? "" : "\\"}${relative}`;
}

/**
 * What every command the hub runs on a Windows host prints just before its answer (#749).
 *
 * Win32-OpenSSH runs a command through the account's shell, and that shell may print first:
 * under a PowerShell `DefaultShell`, the account's profile runs before every command, since sshd
 * passes no `-NoProfile`; under cmd.exe, its AutoRun does (`chcp 65001` prints "Active code
 * page"). So the answer is what follows the last marker. Nothing an answer holds (Base64, digits,
 * hexadecimal, an architecture's name) contains a `-`, so no answer can hold the marker; and a
 * profile that printed it would still come before the command's own.
 */
export const WINDOWS_REPLY_MARKER = "lasterm-reply-4d9b1f";

/** What a Windows command answered after `WINDOWS_REPLY_MARKER`, trimmed; null without one. */
function windowsReply(stdout: string): string | null {
	const at = stdout.lastIndexOf(WINDOWS_REPLY_MARKER);
	return at === -1 ? null : stdout.slice(at + WINDOWS_REPLY_MARKER.length).trim();
}

/** The PowerShell statement that prints `WINDOWS_REPLY_MARKER`, a line feed, then `expression`. */
function powerShellReply(expression: string): string {
	return `[Console]::Out.Write('${WINDOWS_REPLY_MARKER}'+[char]10+(${expression}))`;
}

/**
 * A path a Windows command printed as Base64 of its UTF-8 bytes, decoded: a path survives the
 * console code page that way. Null for anything else, or an empty path.
 */
function decodeBase64Path(encoded: string): string | null {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.toString("base64") !== encoded) return null;
	try {
		const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return path === "" || /\p{Cc}/u.test(path) ? null : path;
	} catch {
		return null;
	}
}

/** The command that prints where a known folder is on a Windows host, as Base64 after the marker. */
export function windowsKnownFolderCommand(folder: KnownFolder): string {
	return encodedPowerShell(
		powerShellReply(
			`[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('${folder}')))`,
		),
	);
}

/** Ask the Windows host where a known folder is. Never throws. */
async function resolveKnownFolder(client: SshClient, folder: KnownFolder): Promise<FolderResult> {
	try {
		const { stdout, stderr, exitCode } = await sshExec(client, windowsKnownFolderCommand(folder));
		if (exitCode !== 0) return { reason: `exit ${exitCode}: ${stderr.trim()}` };
		const reply = windowsReply(stdout);
		const path = reply === null ? null : decodeBase64Path(reply);
		if (path === null) return { reason: "unexpected output" };
		if (!isWindowsPath(path)) {
			const why = path.includes('"')
				? "contains a double quote"
				: "not a drive or UNC path with backslashes";
			return { reason: `unsupported path ${path} (${why})` };
		}
		return { path: path.replace(/\\+$/, "") + (/^[A-Za-z]:\\+$/.test(path) ? "\\" : "") };
	} catch (error) {
		return { reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The PowerShell script that prints, after `WINDOWS_REPLY_MARKER`, every place the agent is on a
 * Windows host, in the order the hub prefers them, one per line as Base64 of the path's UTF-8
 * bytes, and nothing after the marker when there is none.
 *
 * First what `where.exe lasterm-agent` finds: the current directory, then each PATH entry, each
 * with every PATHEXT extension, the file name as the directory spells it. `where.exe` itself
 * prints in the console's code page, which loses what it cannot represent (#749). Then the known
 * folders (`COMMON_AGENT_PATHS_WINDOWS`). One command for all of it, since each one costs the
 * shell's start-up, the profile included; and only .NET: under a pwsh parent, Windows PowerShell
 * may not load its own utility module (#722).
 */
export function windowsFindAgentScript(): string {
	const encoded = "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f))+[char]10";
	return [
		"$o=''",
		"$x=[Environment]::GetEnvironmentVariable('PATHEXT');if(-not $x){$x='.COM;.EXE;.BAT;.CMD'}",
		`foreach($d in @([IO.Directory]::GetCurrentDirectory())+([Environment]::GetEnvironmentVariable('PATH') -split ';')){$d=$d.Trim().Trim([char]34);if(-not $d){continue};foreach($e in $x -split ';'){if(-not $e){continue};try{foreach($f in [IO.Directory]::GetFiles($d,'lasterm-agent'+$e.Trim())){$f=[IO.Path]::GetFullPath($f);$o+=${encoded}}}catch{}}}`,
		...COMMON_AGENT_PATHS_WINDOWS.map(
			([folder, relative]) =>
				`try{$d=[Environment]::GetFolderPath('${folder}');if($d){$f=[IO.Path]::Combine($d,'${relative}');if([IO.File]::Exists($f)){$o+=${encoded}}}}catch{}`,
		),
		powerShellReply("$o"),
		// A caught failure as the last statement would make it exit 1 (#725).
		"exit 0",
	].join(";");
}

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
 *
 * On Windows, one command that runs under cmd.exe or a PowerShell `DefaultShell` alike (#714)
 * does what `where.exe` did, then looks in the known folders (`windowsFindAgentScript`), and the
 * first place it names that the deployer can use is the agent's (#749).
 */
export async function checkRemoteAgent(client: SshClient, os: HostOs): Promise<string | null> {
	if (os === "windows") {
		try {
			const { stdout, exitCode } = await sshExec(
				client,
				encodedPowerShell(windowsFindAgentScript()),
			);
			const found = exitCode === 0 ? windowsReply(stdout) : null;
			for (const line of found?.split(/\s+/) ?? []) {
				const path = decodeBase64Path(line);
				if (path !== null && isWindowsPath(path)) return path;
			}
		} catch {
			// Not found, as far as anyone can tell.
		}
		return null;
	}

	try {
		const { stdout, exitCode } = await sshExec(client, "which lasterm-agent");
		if (exitCode === 0 && stdout.trim()) return stdout.trim();
	} catch {
		// Continue with the common paths.
	}
	for (const rawPath of COMMON_AGENT_PATHS_UNIX) {
		try {
			const { stdout, exitCode } = await sshExec(
				client,
				`test -x "${rawPath}" && echo "${rawPath}"`,
			);
			if (exitCode === 0 && stdout.trim()) return stdout.trim();
		} catch {
			// Continue with the next candidate.
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
 * The commands that print PROCESSOR_ARCHITECTURE on a Windows host after
 * `WINDOWS_REPLY_MARKER`, in turn until one is understood. cmd.exe runs the
 * first, as it always has. A PowerShell `DefaultShell` prints
 * `%PROCESSOR_ARCHITECTURE%` as it is, and the second asks PowerShell, under
 * either shell (#714). Not `cmd /c echo …`: through Win32-OpenSSH's
 * `cmd.exe /c "<command>"`, the inner cmd.exe also prints the closing quote.
 */
export const WINDOWS_ARCH_COMMANDS: readonly string[] = [
	`echo ${WINDOWS_REPLY_MARKER}%PROCESSOR_ARCHITECTURE%`,
	encodedPowerShell(powerShellReply("$env:PROCESSOR_ARCHITECTURE")),
];

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

	for (const command of WINDOWS_ARCH_COMMANDS) {
		try {
			const { stdout, exitCode } = await sshExec(client, command, timeoutMs);
			const arch = windowsReply(stdout);
			const parsed = exitCode === 0 && arch !== null ? parseWindowsArchOutput(arch) : null;
			if (parsed) return { system: `Windows ${arch}`, parsed };
		} catch {
			// ignore
		}
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

type SftpSession = {
	readonly channel: SFTPWrapper;
	ended: boolean;
	readonly endedSignal: Promise<void>;
};

/**
 * openSftp attaches end/close listeners before resolving its session, which
 * guards upload requests against channel loss. The caller must end its channel.
 */
function openSftp(client: SshClient): Promise<SftpSession> {
	return new Promise((resolve, reject) => {
		client.sftp((err, channel) => {
			if (err) {
				reject(err);
				return;
			}
			let signalEnd!: () => void;
			const session: SftpSession = {
				channel,
				ended: false,
				endedSignal: new Promise<void>((resolve) => {
					signalEnd = resolve;
				}),
			};
			const ended = () => {
				session.ended = true;
				signalEnd();
			};
			channel.on("end", ended);
			channel.on("close", ended);
			resolve(session);
		});
	});
}

function sftpClosed(cause?: unknown): Error {
	return new Error("the SFTP channel closed", { cause });
}

async function sftpRequest<T>(
	session: SftpSession,
	request: (done: (error: Error | undefined | null, value: T) => void) => void,
	advisory = false,
): Promise<T> {
	if (session.ended) throw sftpClosed();
	let requestError: unknown;
	const result = new Promise<T>((resolve, reject) => {
		try {
			request((error, value) => {
				requestError = error;
				if (session.ended) {
					reject(sftpClosed(error));
				} else if (error && !advisory) {
					reject(error);
				} else resolve(value);
			});
		} catch (error) {
			requestError = error;
			reject(error);
		}
	});
	try {
		const value = await Promise.race([
			result,
			session.endedSignal.then(() => {
				throw sftpClosed(requestError);
			}),
		]);
		if (session.ended && advisory) throw sftpClosed(requestError);
		return value;
	} catch (error) {
		if (session.ended) throw sftpClosed(requestError ?? error);
		throw error;
	}
}

/** Whether a server offers the SFTP subsystem, and if not, what said so. */
export type SftpSupport =
	| { readonly offered: true }
	| { readonly offered: false; readonly reason: string };

/** How long the probe waits for the server's SFTP to answer before taking it as absent. */
export const SFTP_PROBE_TIMEOUT_MS = 10_000;

/**
 * Ask once whether the server offers SFTP: open the subsystem, and close it as
 * soon as it answers (#722). Never rejects.
 *
 * A server without it (`Subsystem sftp` removed, a dropbear without
 * sftp-server, some appliances) refuses the request, and the agent then
 * travels over an exec channel instead. ssh2 hands back no channel whose
 * subsystem was refused, so that one stays open, idle, until the connection
 * ends; nothing asks for SFTP again on that connection.
 */
export function probeSftp(
	client: SshClient,
	timeoutMs: number = SFTP_PROBE_TIMEOUT_MS,
): Promise<SftpSupport> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (support: SftpSupport): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(support);
		};
		const timer = setTimeout(
			() => settle({ offered: false, reason: `no answer within ${timeoutMs / 1000} s` }),
			timeoutMs,
		);
		try {
			client.sftp((err, sftp) => {
				if (err) {
					settle({ offered: false, reason: err.message });
					return;
				}
				// The probe only asks; an upload opens its own session.
				sftp.end();
				settle({ offered: true });
			});
		} catch (err) {
			settle({ offered: false, reason: err instanceof Error ? err.message : String(err) });
		}
	});
}

/**
 * mkdir -p via SFTP for an absolute POSIX parent, advisory: creates its missing levels, each a
 * literal prefix of it, and returns an error naming every level it could not create.
 * sftpMkdir rejects when its session ends or ssh2 throws synchronously.
 */
async function sftpMkdir(sftp: SftpSession, remotePath: string): Promise<Error | undefined> {
	if (sftp.ended) throw sftpClosed();
	const separator = remotePath.includes("/") ? "/" : "\\";
	const levels: string[] = [];
	for (let end = 1; end <= remotePath.length; end++) {
		if (end !== remotePath.length && remotePath[end] !== separator) continue;
		const level = remotePath.slice(0, end);
		if (level.endsWith(separator)) continue;
		levels.push(level);
	}
	const isDirectory = (path: string): Promise<boolean> =>
		sftpRequest(
			sftp,
			(done) => {
				sftp.channel.stat(path, (error, attrs) => done(error, !error && attrs.isDirectory()));
			},
			true,
		);
	let existing = levels.length - 1;
	for (const level of [...levels].reverse()) {
		if (await isDirectory(level)) break;
		existing--;
	}
	const failures: { level: string; error: Error }[] = [];
	for (const level of levels.slice(existing + 1)) {
		const error = await sftpRequest<Error | undefined>(
			sftp,
			(done) => {
				sftp.channel.mkdir(level, (error) => done(error, error ?? undefined));
			},
			true,
		);
		if (error && !(await isDirectory(level))) failures.push({ level, error });
	}
	if (failures.length === 0) return undefined;
	return new Error(
		failures
			.map(({ level, error }) => `Could not create the directory ${level}: ${error.message}`)
			.join("; "),
		{
			cause:
				failures.length === 1
					? failures[0]?.error
					: new AggregateError(failures.map(({ error }) => error)),
		},
	);
}

/** One mkdir of a Windows or relative parent, its error ignored: SFTP does not expand these paths (#711). */
function sftpMkdirOnce(sftp: SftpSession, remotePath: string): Promise<void> {
	return sftpRequest(
		sftp,
		(done) => {
			sftp.channel.mkdir(remotePath, (error) => done(error, undefined));
		},
		true,
	);
}

/** The transfer error, joined with the directory walk's error when there is one, so neither is lost. */
function transferFailure(walkError: Error | undefined, transferError: unknown): unknown {
	if (!walkError) return transferError;
	const transferMessage =
		transferError instanceof Error ? transferError.message : String(transferError);
	return new Error(`${walkError.message}; the transfer also failed: ${transferMessage}`, {
		cause: new AggregateError(
			[walkError, transferError],
			"Directory creation and transfer both failed",
		),
	});
}

/** Upload a local file to a remote path via SFTP fastPut (streaming — handles large files). */
function sftpFastPut(sftp: SftpSession, localPath: string, remotePath: string): Promise<void> {
	return sftpRequest(sftp, (done) => {
		sftp.channel.fastPut(localPath, remotePath, (error) => done(error, undefined));
	});
}

/** chmod a remote file via SFTP. */
function sftpChmod(sftp: SftpSession, remotePath: string, mode: number): Promise<void> {
	return sftpRequest(sftp, (done) => {
		sftp.channel.chmod(remotePath, mode, (error) => done(error, undefined));
	});
}

/** Remove a remote file via SFTP, whatever happens: this only ever cleans up after a failure. */
function sftpUnlinkQuietly(sftp: SftpSession, remotePath: string): Promise<void> {
	return sftpRequest<void>(sftp, (done) => {
		sftp.channel.unlink(remotePath, (error) => done(error, undefined));
	}).catch(() => {});
}

/**
 * Rename `from` over `to` with OpenSSH's `posix-rename@openssh.com`, which is
 * rename(2): atomic, and it replaces a target that exists. The plain SFTP
 * rename is no use here, since it refuses a target that exists.
 *
 * Resolves false when the server does not offer the extension, which ssh2
 * says by throwing before it sends anything.
 */
function sftpPosixRename(sftp: SftpSession, from: string, to: string): Promise<boolean> {
	return sftpRequest(sftp, (done) => {
		try {
			sftp.channel.ext_openssh_rename(from, to, (error) => done(error, true));
		} catch (error) {
			if (sftp.ended) throw error;
			done(undefined, false);
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

/** Where the file name starts in `remotePath`: after its last separator, `\` counting on Windows. */
function fileNameStart(remotePath: string, os: HostOs): number {
	const cut =
		os === "windows"
			? Math.max(remotePath.lastIndexOf("/"), remotePath.lastIndexOf("\\"))
			: remotePath.lastIndexOf("/");
	return cut + 1;
}

/**
 * A name for the upload beside `remotePath`: same directory, so the rename
 * stays on one filesystem, and hidden and unique, so nothing takes it for the
 * agent and two uploads never share one.
 */
function uploadTempPath(remotePath: string, os: HostOs): string {
	const start = fileNameStart(remotePath, os);
	const dir = remotePath.slice(0, start);
	const name = remotePath.slice(start);
	return `${dir}.${name}.${randomBytes(8).toString("hex")}.partial`;
}

/**
 * How old, in minutes and by the remote's clock, an upload left beside the
 * agent must be before a later upload removes it.
 *
 * An upload in progress writes to its file continuously, so it is always
 * younger than this; one this old was abandoned, by a hub or a connection that
 * died during it.
 */
export const STALE_UPLOAD_MINUTES = 60;

/**
 * Remove what a crash mid-upload left beside the agent (#559).
 *
 * Only in the target's own directory, only the names `uploadTempPath` gives,
 * and only files older than `STALE_UPLOAD_MINUTES`: another hub may be
 * uploading into the same directory right now (#127), and its file is fresh.
 * The age is the remote's own judgement (`find -mmin`), so a hub whose clock
 * disagrees with the remote's cannot misjudge it.
 *
 * Best-effort: a remote that cannot run this keeps its leftovers, and the
 * upload goes ahead all the same. POSIX only: a Windows host sweeps the same
 * way once the upload is in place (`windowsReplaceScript`).
 */
async function sweepStaleUploads(client: SshClient, remotePath: string): Promise<void> {
	const cut = remotePath.lastIndexOf("/");
	const dir = cut === -1 ? "." : remotePath.slice(0, cut) || "/";
	// `find -name` reads its pattern as a glob, so the name is escaped for it,
	// and the random part is matched as the sixteen hex digits it always is.
	const name = remotePath.slice(cut + 1).replace(/[[\]*?\\]/g, "\\$&");
	const pattern = `.${name}.${"[0-9a-f]".repeat(16)}.partial`;
	try {
		await sshExec(
			client,
			`find ${quotePosix(dir)} -maxdepth 1 -type f -name ${quotePosix(pattern)} ` +
				`-mmin +${STALE_UPLOAD_MINUTES} -exec rm -f -- {} \\;`,
		);
	} catch {
		// Left for the next upload to try again.
	}
}

/** How the agent reached the remote: SFTP, or an exec channel's stdin (#722). */
export type AgentUploadTransport = "sftp" | "exec";

/**
 * Upload the agent binary to the remote host: over SFTP where the server
 * offers it, over an exec channel otherwise (#722).
 *
 * On a POSIX remote the binary is written beside the target under a
 * temporary name, made executable, and only then renamed over it (#555). A
 * remote daemon may be running from the target: Linux refuses to open a
 * running executable for writing (ETXTBSY, which SFTP only calls "Failure"),
 * while a rename leaves the running process its own inode and gives the next
 * launch the new file. The target is only ever replaced by a whole, executable
 * file. uploadOverSftp attempts temporary cleanup while its channel is usable;
 * a lost channel or connection may leave it for sweepStaleUploads. If the channel
 * is lost during rename, the target is the previous file or the complete new one.
 * A temporary left behind is removed by a later upload, once it is old
 * enough that nobody can still be writing it (`sweepStaleUploads`).
 *
 * A Windows remote gets the same temporary, and PowerShell moves it into place
 * (`windowsReplaceScript`, #725). Its agent runs on stdio and lives as long as
 * its connection, so another hub's session on the same account may be running
 * it. Windows refuses to open a running executable for writing, or to delete
 * it or rename anything over it, but lets it be renamed: the running file is
 * set aside, and the new one takes its name. The file set aside is deleted
 * once nothing runs it, by that upload or a later one.
 *
 * SFTP stays the first choice. The exec channel is used when the connection's
 * probe found no SFTP (`sftp`), or when SFTP cannot be opened; it carries the
 * same steps, and checks the bytes that arrived against the local binary's
 * SHA-256 before anything is made executable or moved into place. When both
 * fail, the error names both.
 */
export async function uploadAgentBinary(
	client: SshClient,
	localPath: string,
	remotePath: string,
	os: HostOs,
	sftp?: SftpSupport | Promise<SftpSupport>,
): Promise<AgentUploadTransport> {
	const support = await sftp;
	// Null once SFTP carried the upload; otherwise why it could not.
	const sftpFailure =
		support?.offered === false
			? `the server does not offer SFTP (${support.reason})`
			: await openSftp(client).then(
					(session) => uploadOverSftp(client, session, localPath, remotePath, os).then(() => null),
					(error: unknown) => `SFTP could not be opened (${describeError(error)})`,
				);
	if (sftpFailure === null) return "sftp";
	console.error(
		`[lasterm-ssh] agent upload: ${sftpFailure}; sending it over the SSH command channel`,
	);
	try {
		await uploadOverExec(client, localPath, remotePath, os);
	} catch (error) {
		throw new Error(
			`Could not upload the agent: ${sftpFailure}, and the upload over the SSH command channel failed too: ${describeError(error)}`,
			{ cause: error },
		);
	}
	return "exec";
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function uploadOverSftp(
	client: SshClient,
	sftp: SftpSession,
	localPath: string,
	remotePath: string,
	os: HostOs,
): Promise<void> {
	try {
		const parentDir = remotePath.includes("/")
			? remotePath.slice(0, remotePath.lastIndexOf("/"))
			: remotePath.includes("\\")
				? remotePath.slice(0, remotePath.lastIndexOf("\\"))
				: ".";
		// The walk only runs for an absolute POSIX parent: SFTP does not expand Windows or relative
		// paths (#711). Its error is reported only if the transfer then fails.
		const walkParent = os !== "windows" && parentDir.startsWith("/");
		let walkError: Error | undefined;
		try {
			if (walkParent) walkError = await sftpMkdir(sftp, parentDir);
			else if (parentDir && parentDir !== ".") await sftpMkdirOnce(sftp, parentDir);
		} catch (error) {
			throw new Error(
				`Could not create the directory ${parentDir}: ${sftp.ended ? "the SFTP channel closed" : describeError(error)}`,
				{ cause: error },
			);
		}

		// On Windows, moving the upload into place sweeps too.
		if (os !== "windows") await sweepStaleUploads(client, remotePath);
		const temp = uploadTempPath(remotePath, os);
		let step = `upload the agent to ${temp}`;
		try {
			await sftpFastPut(sftp, localPath, temp).catch((error) => {
				throw transferFailure(walkError, error);
			});
			step = `make ${temp} executable`;
			await sftpChmod(sftp, temp, 0o755);
			step = `move the agent into place at ${remotePath}`;
			if (os === "windows") await execWindowsReplace(client, temp, remotePath);
			else if (!(await sftpPosixRename(sftp, temp, remotePath))) {
				await execRename(client, temp, remotePath);
			}
		} catch (err) {
			await sftpUnlinkQuietly(sftp, temp);
			const message = describeError(err);
			throw new Error(`Could not ${step}: ${message}`, { cause: err });
		}
	} finally {
		sftp.channel.end();
	}
}

/**
 * How long an upload over an exec channel may go without moving a byte before
 * it is given up. Not a bound on the whole upload, which takes what the link
 * needs: a lost connection closes the channel, and that ends it too.
 */
const EXEC_UPLOAD_STALL_MS = 60_000;

/**
 * A PowerShell script as a command line that cmd.exe and a PowerShell
 * `DefaultShell` both pass on unchanged: `-EncodedCommand` takes Base64 of its
 * UTF-16LE text (#714).
 */
function encodedPowerShell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/**
 * The PowerShell statement that sets `$p` (or `$<name>`) to `path`, or any
 * other text, which travels as Base64 of its UTF-8 bytes: quotes, `%`, `!`,
 * `$`, spaces and non-ASCII reach it as data.
 */
function powerShellPathVariable(path: string, name = "p"): string {
	const encodedPath = Buffer.from(path, "utf8").toString("base64");
	return `$${name}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`;
}

/**
 * One argument as a Windows command line carries it, for `CommandLineToArgvW`,
 * the MSVC runtime and Rust's `std::env::args` to read back as it was:
 * quoted when it holds a space or a quote, a quote escaped, and the
 * backslashes before a quote or the closing one doubled.
 */
function quoteWindowsArgument(arg: string): string {
	if (arg !== "" && !/[\s"]/.test(arg)) return arg;
	return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The PowerShell script that runs `program` with `args` on a Windows host,
 * waits for it, and exits with its exit code (#714).
 *
 * The program inherits the shell's stdin, stdout and stderr and uses them
 * itself: `Process.Start` without redirection hands them on, so no byte that
 * flows passes through PowerShell, which would read native output as text and
 * write it out again re-encoded. The program and its arguments travel as Base64
 * data. Only .NET is called, no cmdlet (#722).
 */
function windowsLaunchScript(program: string, args: readonly string[]): string {
	return [
		"$ErrorActionPreference='Stop'",
		powerShellPathVariable(program),
		powerShellPathVariable(args.map(quoteWindowsArgument).join(" "), "a"),
		"$c=[Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{FileName=$p;Arguments=$a;UseShellExecute=$false})",
		"$c.WaitForExit()",
		"exit $c.ExitCode",
	].join(";");
}

/**
 * The command line that runs `program` with `args` on a Windows host, under
 * cmd.exe and a PowerShell `DefaultShell` alike: how the hub starts the agent
 * there (#714). A quoted path followed by arguments, as cmd.exe runs it, is a
 * parse error to PowerShell, and cmd.exe expands `%` in it.
 */
export function windowsLaunchCommand(program: string, args: readonly string[]): string {
	return encodedPowerShell(windowsLaunchScript(program, args));
}

/**
 * The command that writes what arrives on its stdin to `temp` (beside the
 * agent, whose directory it creates first), readable by its owner only, and
 * prints how many bytes it wrote. `cat` copies bytes as they are.
 */
export function posixUploadCommand(temp: string): string {
	const cut = temp.lastIndexOf("/");
	const dir = cut === -1 ? "." : temp.slice(0, cut) || "/";
	const file = quotePosix(temp);
	return `mkdir -p -- ${quotePosix(dir)} && umask 077 && cat > ${file} && wc -c < ${file}`;
}

/**
 * The command that writes what arrives on its stdin to `remotePath` on a
 * Windows host, creating its missing directories (#712), and prints how many
 * bytes it wrote, after `WINDOWS_REPLY_MARKER`. It runs under cmd.exe and under
 * a PowerShell `DefaultShell` alike, and the path reaches it only as Base64.
 */
export function windowsUploadCommand(remotePath: string): string {
	return encodedPowerShell(
		[
			"$ErrorActionPreference='Stop'",
			powerShellPathVariable(remotePath),
			"$d=[IO.Path]::GetDirectoryName($p)",
			"if($d){[void][IO.Directory]::CreateDirectory($d)}",
			"$i=[Console]::OpenStandardInput()",
			"$o=[IO.File]::Create($p)",
			"try{$i.CopyTo($o);$n=$o.Length}finally{$o.Dispose()}",
			powerShellReply("$n"),
		].join(";"),
	);
}

/**
 * The PowerShell script that moves the upload `temp` into place at `target` on
 * a Windows host (#725), then removes what earlier uploads left beside it.
 *
 * An agent may be running from `target`, for another hub's session on the
 * same account. Windows will not delete a running executable, nor rename
 * another file over it, but it renames it: the current file goes to `aside`,
 * the upload takes its name, and the running agent keeps its image. If the
 * upload cannot take the name, the current file goes back. In between, for
 * the length of one rename, nothing is at `target`.
 *
 * A move refused because another process has the file open (a sharing or
 * lock violation, as from an antivirus scan or another hub hashing it) is
 * tried again for about two seconds. Only .NET is called, no cmdlet: under a
 * pwsh parent, Windows PowerShell may not load its own utility module (#722).
 *
 * Then, best-effort: every `<agent>.old-*` that nothing runs any more, and
 * every upload temporary older than `STALE_UPLOAD_MINUTES` by the remote's
 * clock, as `sweepStaleUploads` does on POSIX. Deleting a file set aside fails
 * while it still runs, and it is left for a later upload. The script exits 0
 * explicitly: PowerShell would otherwise exit 1 when that caught failure is
 * the last thing it did, which is the usual case of a single running agent.
 */
export function windowsReplaceScript(temp: string, target: string, aside: string): string {
	return [
		"$ErrorActionPreference='Stop'",
		powerShellPathVariable(target),
		powerShellPathVariable(temp, "t"),
		powerShellPathVariable(aside, "o"),
		"function m($s,$d){for($i=1;;$i++){try{[IO.File]::Move($s,$d);return}catch [IO.IOException]{if($i -ge 10 -or (32,33 -notcontains ($_.Exception.GetBaseException().HResult -band 0xFFFF))){throw};[Threading.Thread]::Sleep(200)}}}",
		"$a=[IO.File]::Exists($p)",
		"if($a){m $p $o}",
		"try{m $t $p}catch{$e=$_;if($a){try{m $o $p}catch{}};throw $e}",
		`try{$d=[IO.Path]::GetDirectoryName($p);$n=[regex]::Escape([IO.Path]::GetFileName($p));$c=[DateTime]::UtcNow.AddMinutes(-${STALE_UPLOAD_MINUTES});foreach($f in [IO.Directory]::GetFiles($d)){$b=[IO.Path]::GetFileName($f);if(($b -match('^'+$n+'\\.old-[0-9a-f]{16}$')) -or (($b -match('^\\.'+$n+'\\.[0-9a-f]{16}\\.partial$')) -and ([IO.File]::GetLastWriteTimeUtc($f) -lt $c))){try{[IO.File]::Delete($f)}catch{}}}}catch{}`,
		// Reached only once the upload is in place. Without it, a deletion the
		// sweep caught as its last statement (the file set aside still runs)
		// makes Windows PowerShell exit 1 though nothing failed.
		"exit 0",
	].join(";");
}

/** How long PowerShell may take to move the agent into place, retries included. */
const WINDOWS_REPLACE_TIMEOUT_MS = 30_000;

/** Run `windowsReplaceScript` on the remote, with a fresh name for the file set aside. */
async function execWindowsReplace(client: SshClient, temp: string, target: string): Promise<void> {
	const aside = `${target}.old-${randomBytes(8).toString("hex")}`;
	const { stderr, exitCode } = await sshExec(
		client,
		encodedPowerShell(windowsReplaceScript(temp, target, aside)),
		WINDOWS_REPLACE_TIMEOUT_MS,
	);
	if (exitCode !== 0) throw exitFailure(exitCode, stderr);
}

/** The PowerShell script that deletes `path` if it can: cleanup after a failure. */
function windowsDeleteScript(path: string): string {
	return [powerShellPathVariable(path), "[IO.File]::Delete($p)"].join(";");
}

/** What a remote command said on stderr, without PowerShell's CLIXML wrapping, and short. */
function readableStderr(stderr: string): string {
	let text = stderr;
	if (text.trimStart().startsWith("#< CLIXML")) {
		text = [...text.matchAll(/<S S="Error">(.*?)<\/S>/g)]
			.map((match) => (match[1] ?? "").replace(/_x000D__x000A_/g, " "))
			.join("");
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function exitFailure(exitCode: number | null, stderr: string): Error {
	const said = readableStderr(stderr);
	const how =
		exitCode === null
			? "the channel closed before the command said how it ended"
			: `exit ${exitCode}`;
	return new Error(said === "" ? how : `${how}: ${said}`);
}

/**
 * Run `command` with the local file on its stdin, and say how it ended: its
 * exit code, or null when the channel closed without one (a lost connection).
 */
function execWithFileOnStdin(
	client: SshClient,
	command: string,
	localPath: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const onChannel = (err: Error | undefined, stream: ClientChannel): void => {
			if (err) {
				reject(err);
				return;
			}
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let exitCode: number | null = null;
			let settled = false;
			let stall: ReturnType<typeof setTimeout> | undefined;
			const file = createReadStream(localPath);
			const finish = (): void => {
				settled = true;
				clearTimeout(stall);
				file.unpipe(stream);
				file.destroy();
			};
			// Said at once: a host that stopped answering may never confirm the close.
			const giveUp = (error: Error): void => {
				if (settled) return;
				finish();
				stream.close();
				reject(error);
			};
			const moved = (): void => {
				if (settled) return;
				clearTimeout(stall);
				stall = setTimeout(
					() =>
						giveUp(
							new Error(
								`nothing moved for ${EXEC_UPLOAD_STALL_MS / 1000} s, so the upload was given up`,
							),
						),
					EXEC_UPLOAD_STALL_MS,
				);
			};
			moved();
			stream.on("data", (chunk: Buffer) => {
				moved();
				stdout.push(chunk);
			});
			stream.stderr.on("data", (chunk: Buffer) => {
				moved();
				stderr.push(chunk);
			});
			stream.on("exit", (code: unknown) => {
				if (typeof code === "number") exitCode = code;
			});
			// What ended it is said by the close that always follows.
			stream.on("error", () => {});
			stream.on("close", (code: unknown) => {
				if (settled) return;
				finish();
				resolve({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: exitCode ?? (typeof code === "number" ? code : null),
				});
			});
			file.on("data", moved);
			file.on("end", moved);
			file.on("error", giveUp);
			file.pipe(stream);
		};
		try {
			client.exec(command, onChannel);
		} catch (error) {
			reject(error);
		}
	});
}

/** Remove a remote file over exec, whatever happens: this only ever cleans up after a failure. */
async function execUnlinkQuietly(client: SshClient, remotePath: string, os: HostOs): Promise<void> {
	try {
		await sshExec(
			client,
			os === "windows"
				? encodedPowerShell(windowsDeleteScript(remotePath))
				: `rm -f -- ${quotePosix(remotePath)}`,
		);
	} catch {
		// Left for sweepStaleUploads.
	}
}

/**
 * Stream the binary to `remotePath` over the exec channel, then check that
 * every byte arrived (`wc -c`, or the length PowerShell wrote) and that their
 * SHA-256 is the local binary's, before anything runs them.
 */
async function writeOverExec(
	client: SshClient,
	localPath: string,
	command: string,
	remotePath: string,
	os: HostOs,
): Promise<void> {
	const size = statSync(localPath).size;
	const { stdout, stderr, exitCode } = await execWithFileOnStdin(client, command, localPath);
	if (exitCode !== 0) throw exitFailure(exitCode, stderr);
	const counted = /^\s*(\d+)\s*$/.exec(
		(os === "windows" ? windowsReply(stdout) : stdout) ?? "",
	)?.[1];
	if (counted === undefined) throw new Error("the remote did not say how many bytes it wrote");
	if (Number(counted) !== size) throw new Error(`${counted} of ${size} bytes arrived`);
	const localSha = getLocalSha256(localPath);
	const hashed = await hashRemoteFile(client, remotePath, os);
	if (!("sha256" in hashed)) {
		throw new Error(`its SHA-256 could not be computed there: ${hashed.reason}`);
	}
	if (hashed.sha256 !== localSha) throw new Error("its SHA-256 is not the local binary's");
}

/** The exec channel's version of `uploadOverSftp`: the same steps, the bytes on stdin. */
async function uploadOverExec(
	client: SshClient,
	localPath: string,
	remotePath: string,
	os: HostOs,
): Promise<void> {
	if (os === "windows") {
		const temp = uploadTempPath(remotePath, os);
		let step = `upload the agent to ${temp}`;
		try {
			await writeOverExec(client, localPath, windowsUploadCommand(temp), temp, os);
			step = `move the agent into place at ${remotePath}`;
			await execWindowsReplace(client, temp, remotePath);
		} catch (err) {
			await execUnlinkQuietly(client, temp, os);
			throw new Error(`Could not ${step}: ${describeError(err)}`, { cause: err });
		}
		return;
	}

	await sweepStaleUploads(client, remotePath);
	const temp = uploadTempPath(remotePath, os);
	let step = `upload the agent to ${temp}`;
	try {
		await writeOverExec(client, localPath, posixUploadCommand(temp), temp, os);
		step = `make ${temp} executable`;
		const { stderr, exitCode } = await sshExec(client, `chmod 755 -- ${quotePosix(temp)}`);
		if (exitCode !== 0) throw exitFailure(exitCode, stderr);
		step = `move the agent into place at ${remotePath}`;
		await execRename(client, temp, remotePath);
	} catch (err) {
		await execUnlinkQuietly(client, temp, os);
		throw new Error(`Could not ${step}: ${describeError(err)}`, { cause: err });
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
		const folder = await resolveKnownFolder(client, "LocalApplicationData");
		if (!("path" in folder)) {
			throw new Error(
				`Could not determine the LocalAppData directory of the Windows host: ${folder.reason}`,
			);
		}
		return joinWindowsPath(folder.path, "lasterm\\lasterm-agent.exe");
	}
	const home = await resolveRemoteHome(client);
	return `${home}/.local/bin/lasterm-agent`;
}

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

	let os = host.os;
	let arch = host.arch;
	if (!os || !arch) {
		const read = await readRemoteSystem(client);
		const detected = read?.parsed;
		if (!detected) throw noAgentTargetError(read);
		os = detected.os;
		arch = detected.arch;
	}
	const existingPath = await checkRemoteAgent(client, os);

	if (existingPath) {
		// --- Branch A: agent already exists ---

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
			// An agent may be running from existingPath; the upload goes beside it
			// and is renamed over it (on Windows, the running file is renamed
			// aside first), so that agent keeps running the old version until
			// someone replaces it (#456, #555, #725).
			await uploadAgentBinary(client, localBinary, existingPath, os, options.sftp);
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

	// 3. Locate the binary in the local cache
	const localBinary = await resolveLocalAgentBinary(os, arch, options, hubVersion);
	if (localBinary === null) {
		const expectedBinary = join(binaryCache, getAgentCacheFileName(os, arch, hubVersion));
		throw new DeployError(
			"AGENT_NOT_AVAILABLE",
			`Agent binary not found in cache: ${expectedBinary}. Build it or copy it to the binary cache (see docs/SPEC.md §3.5).`,
		);
	}

	// 4. Determine remote install path (expands ~ using remote $HOME)
	const remotePath = await resolveRemotePath(client, os);

	// 5. Upload: SFTP where the server offers it, else over an exec channel (#722)
	await uploadAgentBinary(client, localBinary, remotePath, os, options.sftp);

	return { deployed: true, remoteMatchesHubVersionCache: false, remotePath, os, arch };
}

/** The binary cache directory inside the hub state dir. */
export function getBinaryCacheDir(): string {
	return join(lastermDir("state"), "binaries");
}

/**
 * Compute the SHA256 hash of a remote file by running sha256sum (Linux/macOS)
 * or .NET's SHA256 under PowerShell (Windows) over SSH.
 * Returns the lowercase hex digest, or null on failure.
 *
 * Not Get-FileHash: Windows PowerShell autoloads it from the first
 * Microsoft.PowerShell.Utility on PSModulePath, and with PowerShell 7's first,
 * as a pwsh parent leaves it (a pwsh `DefaultShell`, #714, or the GitHub
 * Windows runner), it does not know the command (#722).
 */
export async function getRemoteSha256(
	client: SshClient,
	remotePath: string,
	os: HostOs,
): Promise<string | null> {
	const hashed = await hashRemoteFile(client, remotePath, os);
	return "sha256" in hashed ? hashed.sha256 : null;
}

/**
 * The PowerShell script that prints the lowercase SHA-256 of `path` after
 * `WINDOWS_REPLY_MARKER`, with .NET alone.
 */
export function windowsHashScript(path: string): string {
	return [
		"$ErrorActionPreference='Stop'",
		powerShellPathVariable(path),
		"$s=[IO.File]::OpenRead($p)",
		"try{$h=[Security.Cryptography.SHA256]::Create().ComputeHash($s)}finally{$s.Dispose()}",
		powerShellReply("[BitConverter]::ToString($h).Replace('-','').ToLower()"),
	].join(";");
}

/** `getRemoteSha256`, saying why when there is no hash: what the command said, or its error. */
async function hashRemoteFile(
	client: SshClient,
	remotePath: string,
	os: HostOs,
): Promise<{ sha256: string } | { reason: string }> {
	try {
		const escapedPath = remotePath.replace(/'/g, "'\\''");
		let cmd: string;
		if (os === "windows") {
			cmd = encodedPowerShell(windowsHashScript(remotePath));
		} else if (os === "darwin") {
			// macOS ships shasum (not sha256sum); same output format: "hash  filename"
			cmd = `shasum -a 256 '${escapedPath}'`;
		} else {
			cmd = `sha256sum '${escapedPath}'`;
		}
		const { stdout, stderr, exitCode } = await sshExec(client, cmd);
		if (exitCode !== 0) return { reason: exitFailure(exitCode, stderr).message };
		// sha256sum: "hash  filename" — take first 64 hex chars
		// PowerShell: just the hash, after the marker
		const trimmed = (os === "windows" ? windowsReply(stdout) : stdout.trim()) ?? "";
		const sha256 = trimmed.match(/^([a-f0-9]{64})/i)?.[1]?.toLowerCase();
		return sha256 !== undefined ? { sha256 } : { reason: "it printed no SHA-256" };
	} catch (error) {
		return { reason: describeError(error) };
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
