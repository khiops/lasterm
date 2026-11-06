import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import type { ClientChannel, SFTPWrapper, Client as SshClient } from "ssh2";

/**
 * What the hub uses to reach a host's files over its SSH connection: an SFTP
 * session and the requests bound to it, the mkdir walk, a command fed on its
 * stdin, and how a Windows command answers (#832). The agent deployment uses
 * them to upload the agent, and the file service to browse the host.
 */

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
export function windowsReply(stdout: string): string | null {
	const at = stdout.lastIndexOf(WINDOWS_REPLY_MARKER);
	return at === -1 ? null : stdout.slice(at + WINDOWS_REPLY_MARKER.length).trim();
}

/** The PowerShell statement that prints `WINDOWS_REPLY_MARKER`, a line feed, then `expression`. */
export function powerShellReply(expression: string): string {
	return `[Console]::Out.Write('${WINDOWS_REPLY_MARKER}'+[char]10+(${expression}))`;
}

/**
 * A path a Windows command printed as Base64 of its UTF-8 bytes, decoded: a path survives the
 * console code page that way. Null for anything else, or an empty path.
 */
export function decodeBase64Path(encoded: string): string | null {
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

/**
 * A PowerShell script as a command line that cmd.exe and a PowerShell
 * `DefaultShell` both pass on unchanged: `-EncodedCommand` takes Base64 of its
 * UTF-16LE text (#714).
 */
export function encodedPowerShell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/**
 * The PowerShell statement that sets `$p` (or `$<name>`) to `path`, or any
 * other text, which travels as Base64 of its UTF-8 bytes: quotes, `%`, `!`,
 * `$`, spaces and non-ASCII reach it as data.
 */
export function powerShellPathVariable(path: string, name = "p"): string {
	const encodedPath = Buffer.from(path, "utf8").toString("base64");
	return `$${name}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`;
}

export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What a remote command said on stderr, without PowerShell's CLIXML wrapping, and short. */
export function readableStderr(stderr: string): string {
	let text = stderr;
	if (text.trimStart().startsWith("#< CLIXML")) {
		text = [...text.matchAll(/<S S="Error">(.*?)<\/S>/g)]
			.map((match) => (match[1] ?? "").replace(/_x000D__x000A_/g, " "))
			.join("");
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function exitFailure(exitCode: number | null, stderr: string): Error {
	const said = readableStderr(stderr);
	const how =
		exitCode === null
			? "the channel closed before the command said how it ended"
			: `exit ${exitCode}`;
	return new Error(said === "" ? how : `${how}: ${said}`);
}

export type SftpSession = {
	readonly channel: SFTPWrapper;
	ended: boolean;
	readonly endedSignal: Promise<void>;
};

/**
 * openSftp attaches end/close listeners before resolving its session, which
 * guards upload requests against channel loss. The caller must end its channel.
 */
export function openSftp(client: SshClient): Promise<SftpSession> {
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

/** Said when the SFTP channel a request was on closed before it was answered. */
export class SftpChannelClosed extends Error {
	constructor(cause?: unknown) {
		super("the SFTP channel closed", { cause });
		this.name = "SftpChannelClosed";
	}
}

export function sftpClosed(cause?: unknown): Error {
	return new SftpChannelClosed(cause);
}

export async function sftpRequest<T>(
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

/**
 * The directories `mkdir -p` would create for `remotePath`, shallowest first, each a literal
 * prefix of it: the levels below a POSIX root, a drive's root (`C:\`) or a UNC share
 * (`\\server\share`), none of which can be created (#832). A relative path starts at its first
 * name.
 */
export function mkdirLevels(remotePath: string): string[] {
	const separator = remotePath.includes("/") ? "/" : "\\";
	const root =
		/^[A-Za-z]:\\/.exec(remotePath)?.[0] ?? /^\\\\[^\\]+\\[^\\]+/.exec(remotePath)?.[0] ?? "";
	const levels: string[] = [];
	for (let end = Math.max(1, root.length); end <= remotePath.length; end++) {
		if (end !== remotePath.length && remotePath[end] !== separator) continue;
		const level = remotePath.slice(0, end);
		if (level.endsWith(separator) || level.length <= root.length) continue;
		levels.push(level);
	}
	return levels;
}

/**
 * mkdir -p via SFTP for an absolute POSIX or drive-absolute parent, advisory: creates its
 * missing levels (`mkdirLevels`), and returns an error naming every level it could not create.
 * sftpMkdir rejects when its session ends or ssh2 throws synchronously.
 */
export async function sftpMkdir(sftp: SftpSession, remotePath: string): Promise<Error | undefined> {
	if (sftp.ended) throw sftpClosed();
	const levels = mkdirLevels(remotePath);
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
export function sftpMkdirOnce(sftp: SftpSession, remotePath: string): Promise<void> {
	return sftpRequest(
		sftp,
		(done) => {
			sftp.channel.mkdir(remotePath, (error) => done(error, undefined));
		},
		true,
	);
}

/**
 * How long an upload over an exec channel may go without moving a byte before
 * it is given up. Not a bound on the whole upload, which takes what the link
 * needs: a lost connection closes the channel, and that ends it too.
 */
export const EXEC_UPLOAD_STALL_MS = 60_000;

/** What a command fed on its stdin printed, and its exit code: null when the channel closed without one. */
export interface StdinExecResult {
	stdout: Buffer;
	stderr: string;
	exitCode: number | null;
}

/**
 * Run `command` with what `input` reads on its stdin, and say how it ended: its
 * exit code, or null when the channel closed without one (a lost connection).
 * Given up, the channel closed, after `stallMs` without a byte moving either way.
 */
export function execWithStdin(
	client: SshClient,
	command: string,
	input: () => Readable,
	stallMs: number = EXEC_UPLOAD_STALL_MS,
	what = "the upload",
): Promise<StdinExecResult> {
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
			const source = input();
			const finish = (): void => {
				settled = true;
				clearTimeout(stall);
				source.unpipe(stream);
				source.destroy();
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
					() => giveUp(new Error(`nothing moved for ${stallMs / 1000} s, so ${what} was given up`)),
					stallMs,
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
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: exitCode ?? (typeof code === "number" ? code : null),
				});
			});
			source.on("data", moved);
			source.on("end", moved);
			source.on("error", giveUp);
			source.pipe(stream);
		};
		try {
			client.exec(command, onChannel);
		} catch (error) {
			reject(error);
		}
	});
}

/**
 * Run `command` with the local file on its stdin, and say how it ended: its
 * exit code, or null when the channel closed without one (a lost connection).
 */
export async function execWithFileOnStdin(
	client: SshClient,
	command: string,
	localPath: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	const { stdout, stderr, exitCode } = await execWithStdin(client, command, () =>
		createReadStream(localPath),
	);
	return { stdout: stdout.toString("utf8"), stderr, exitCode };
}
