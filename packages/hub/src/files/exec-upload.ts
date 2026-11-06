// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the POSIX scripts hold the shell's own ${…} expansions, which are not templates
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { TransferVerification } from "@lasterm/shared";
import type { ClientChannel, Client as SshClient } from "ssh2";
import { quotePosix } from "../session/remote-daemon.js";
import { sshExec } from "../session/ssh-exec.js";
import {
	describeError,
	encodedPowerShell,
	execWithStdin,
	exitFailure,
	powerShellPathVariable,
	readableStderr,
	type StdinExecResult,
	WINDOWS_REPLY_MARKER,
	windowsReply,
} from "../session/ssh-file-transport.js";
import { type ExecFileBackend, posixScript, windowsScript } from "./exec-files.js";
import { FileAccessError, type FileEntry, REASONS } from "./host-files.js";
import type { PathStyle } from "./host-paths.js";
import {
	type FolderResult,
	type OpenOptions,
	type PlaceResult,
	TargetExists,
	type UploadBackend,
	UploadInterrupted,
	type UploadSink,
	VerifyFailed,
} from "./upload-backend.js";

/**
 * How long a write may wait for the host to take its bytes before the file is
 * given up as interrupted. Not a bound on the file: a lost connection ends it
 * too, and a slow link takes what it needs.
 */
const WRITE_STALL_MS = 60_000;

/** How long a script that places, creates or removes may go without a byte moving. */
const SCRIPT_STALL_MS = 60_000;

/** How long a PowerShell that places or removes may take, on top of the shell's start-up. */
const WINDOWS_TIMEOUT_MS = 60_000;

/** How long an aborted write waits for the host to finish what it was given. */
const ABORT_WAIT_MS = 30_000;

/** How many folders one script creates. */
const MKDIR_BATCH = 500;

/** A file's time as `touch -t` takes it, in UTC: `CCYYMMDDhhmm.SS`. */
export function touchStamp(mtimeMs: number): string {
	const date = new Date(Math.floor(mtimeMs / 1000) * 1000);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}.${two(date.getUTCSeconds())}`;
}

// ─── POSIX ────────────────────────────────────────────────────────────────────

/**
 * The script that writes what arrives on its stdin to the temporary `$1`, run
 * as `sh -c '<script>' sh <temp> <new|append> <stamp> <0|1>`: its text is
 * fixed, and the path an argument, so nothing of a name reaches a shell as
 * code, whatever the account's login shell. A folder that is not there is
 * said as such. A new temporary is created under `set -C`, which refuses one
 * that exists. Then its time (`touch -t`, in UTC,
 * as POSIX has it), its size, and with `1` its SHA-256 (`sha256sum`, else
 * `openssl dgst -sha256`, else `shasum -a 256`, each reading it on stdin so
 * that no name is printed), after the reply marker.
 */
export const POSIX_WRITE_SCRIPT = [
	`M=${WINDOWS_REPLY_MARKER}`,
	`r() { printf '%s\\n%s\\n' "$M" "$1"; exit 0; }`,
	"t=$1",
	"d=${t%/*}",
	'[ -n "$d" ] || d=/',
	'[ -d "$d" ] || r NOT_FOUND',
	'if [ "$2" = new ]; then',
	'  { [ -e "$t" ] || [ -L "$t" ]; } && r EXISTS',
	"  set -C",
	'  cat > "$t" || r FAILED',
	"else",
	'  [ -f "$t" ] || r NOT_FOUND',
	'  cat >> "$t" || r FAILED',
	"fi",
	'[ -n "$3" ] && TZ=UTC0 touch -t "$3" -- "$t" 2>/dev/null',
	'n=$(wc -c < "$t") || r FAILED',
	"h=-",
	'if [ "$4" = 1 ]; then',
	'  h=$(sha256sum < "$t" 2>/dev/null || openssl dgst -sha256 < "$t" 2>/dev/null || shasum -a 256 < "$t" 2>/dev/null) || h=-',
	"fi",
	`printf '%s\\nOK\\n%s\\n%s\\n' "$M" "$n" "$h"`,
].join("\n");

export function posixWriteCommand(temp: string, options: OpenOptions): string {
	return [
		"sh -c",
		quotePosix(POSIX_WRITE_SCRIPT),
		"sh",
		quotePosix(temp),
		options.resumeAt === 0 ? "new" : "append",
		quotePosix(options.mtime === null ? "" : touchStamp(options.mtime)),
		options.hash ? "1" : "0",
	].join(" ");
}

/**
 * The script that places `temp` under `target`. Without replacing: a hard
 * link (`ln`), which refuses a name that exists, then the temporary removed;
 * where the file system makes no hard links, the name is checked, then taken
 * with `mv` (a short race, said in PROTOCOL.md). Onto a folder, `ln` and `mv`
 * put what they are given inside it: the name is looked at first, and a folder
 * that took it meanwhile gives it back. Replace: `mv -f`, never onto a folder.
 */
export function posixPlaceScript(temp: string, target: string, replace: boolean): string {
	const lines = [`t=${quotePosix(temp)}`, `f=${quotePosix(target)}`];
	if (replace) {
		lines.push(
			'[ -d "$f" ] && r IS_DIRECTORY',
			'mv -f -- "$t" "$f" && r OK',
			'[ -e "$t" ] || r NOT_FOUND',
			"r FAILED",
		);
	} else {
		lines.push(
			'{ [ -e "$f" ] || [ -L "$f" ]; } && r EXISTS',
			// A folder that took the name meanwhile gets the link, or the file, inside
			// it, as `ln` and `mv` do onto one: it comes back out, and it is a conflict.
			'if ln -- "$t" "$f" 2>/dev/null; then',
			'  if [ -d "$f" ]; then rm -f -- "$f/${t##*/}"; r EXISTS; fi',
			'  rm -f -- "$t"; r OK',
			"fi",
			'{ [ -e "$f" ] || [ -L "$f" ]; } && r EXISTS',
			'[ -e "$t" ] || r NOT_FOUND',
			'if [ ! -e "$f" ] && [ ! -L "$f" ] && mv -- "$t" "$f"; then',
			'  if [ -d "$f" ]; then mv -- "$f/${t##*/}" "$t"; r EXISTS; fi',
			"  r OK",
			"fi",
			'{ [ -e "$f" ] || [ -L "$f" ]; } && r EXISTS',
			"r FAILED",
		);
	}
	return posixScript(lines.join("\n"));
}

/**
 * The script that creates each folder, in order, and prints a letter per
 * folder after `OK`: `C` created, `E` a folder (or a link to one) was there,
 * `F` something else is, `X` it could not be created.
 */
export function posixMkdirScript(paths: readonly string[]): string {
	return posixScript(
		[
			`printf '%s\\nOK\\n' "$M"`,
			...paths.map(
				(path) =>
					`p=${quotePosix(path)}; if [ -d "$p" ]; then echo E; elif [ -e "$p" ] || [ -L "$p" ]; then echo F; elif mkdir -- "$p" 2>/dev/null; then echo C; elif [ -d "$p" ]; then echo E; else echo X; fi`,
			),
		].join("\n"),
	);
}

export function posixRemoveScript(path: string): string {
	return posixScript([`rm -f -- ${quotePosix(path)}`, "r OK"].join("\n"));
}

// ─── Windows ──────────────────────────────────────────────────────────────────

/** What every Windows answer starts with, and how an exception becomes one. */
const WINDOWS_ERRORS =
	"function Why($e){$x=$e.Exception.GetBaseException();if($x -is [UnauthorizedAccessException]){Ans 'PERMISSION_DENIED'};if($x -is [IO.DirectoryNotFoundException]){Ans 'NOT_FOUND'}}";

/**
 * The PowerShell that writes what arrives on its stdin to the temporary `$p`:
 * a new one with `CreateNew`, which refuses one that exists, or appended to.
 * Flushed to the disk (`Flush($true)`), its time set, then its size and, when
 * asked, its SHA-256 by .NET, after the reply marker.
 */
export function windowsWriteScript(temp: string, options: OpenOptions): string {
	const open =
		options.resumeAt === 0
			? "if([IO.File]::Exists($p) -or [IO.Directory]::Exists($p)){Ans 'EXISTS'};$o=[IO.File]::Open($p,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)"
			: "if(-not [IO.File]::Exists($p)){Ans 'NOT_FOUND'};$o=[IO.File]::Open($p,[IO.FileMode]::Append,[IO.FileAccess]::Write)";
	return windowsScript(
		temp,
		WINDOWS_ERRORS,
		`try{${open}}catch{Why $_;if([IO.File]::Exists($p) -and ${options.resumeAt === 0 ? "$true" : "$false"}){Ans 'EXISTS'};throw}`,
		"$i=[Console]::OpenStandardInput()",
		"try{$i.CopyTo($o);$o.Flush($true)}finally{$o.Dispose()}",
		...(options.mtime === null
			? []
			: [
					`[IO.File]::SetLastWriteTimeUtc($p,[DateTimeOffset]::FromUnixTimeMilliseconds(${Math.floor(options.mtime)}).UtcDateTime)`,
				]),
		"$n=[IO.FileInfo]::new($p).Length",
		"$h='-'",
		...(options.hash
			? [
					"$s=[IO.File]::OpenRead($p);try{$h=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-','').ToLower()}finally{$s.Dispose()}",
				]
			: []),
		"Ans ('OK'+[char]10+$n+[char]10+$h)",
	);
}

/** A move, tried again for about two seconds while another process has the file open (32, 33). */
const WINDOWS_MOVE =
	"function m($s,$d){for($i=1;;$i++){try{[IO.File]::Move($s,$d);return}catch [IO.IOException]{if([IO.File]::Exists($d) -or [IO.Directory]::Exists($d)){throw};if($i -ge 10 -or (32,33 -notcontains ($_.Exception.GetBaseException().HResult -band 0xFFFF))){throw};[Threading.Thread]::Sleep(200)}}}";

/**
 * The PowerShell that places `$t` under `$p`. Without replacing:
 * `[IO.File]::Move`, which refuses a name that exists. Replace: the file
 * there is moved aside to `$o`, the temporary takes the name, then what was
 * set aside is deleted; if the temporary cannot take it, the file goes back.
 */
export function windowsPlaceScript(
	temp: string,
	target: string,
	replace: boolean,
	aside: string,
): string {
	const taken = "([IO.File]::Exists($p) -or [IO.Directory]::Exists($p))";
	return windowsScript(
		target,
		powerShellPathVariable(temp, "t"),
		powerShellPathVariable(aside, "o"),
		WINDOWS_ERRORS,
		WINDOWS_MOVE,
		"if(-not [IO.File]::Exists($t)){Ans 'NOT_FOUND'}",
		...(replace
			? [
					"if([IO.Directory]::Exists($p)){Ans 'IS_DIRECTORY'}",
					"$a=[IO.File]::Exists($p)",
					"try{if($a){m $p $o};try{m $t $p}catch{$e=$_;if($a){try{m $o $p}catch{}};throw $e}}catch{Why $_;throw}",
					"if($a){try{[IO.File]::Delete($o)}catch{}}",
				]
			: [`if${taken}{Ans 'EXISTS'}`, `try{m $t $p}catch{if${taken}{Ans 'EXISTS'};Why $_;throw}`]),
		"Ans 'OK'",
	);
}

/** The PowerShell that creates the folders whose paths arrive on stdin, one Base64 line each (see `posixMkdirScript`). */
export function windowsMkdirScript(): string {
	return windowsScript(
		null,
		"$r=[IO.StreamReader]::new([Console]::OpenStandardInput())",
		"$b=[Text.StringBuilder]::new()",
		"while(($l=$r.ReadLine()) -ne $null){if($l -eq ''){continue};$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($l));if([IO.Directory]::Exists($p)){$c='E'}elseif([IO.File]::Exists($p)){$c='F'}else{try{[void][IO.Directory]::CreateDirectory($p);$c='C'}catch{if([IO.Directory]::Exists($p)){$c='E'}else{$c='X'}}};[void]$b.Append($c+[char]10)}",
		"Ans ('OK'+[char]10+$b)",
	);
}

export function windowsRemoveScript(path: string): string {
	return windowsScript(path, "try{[IO.File]::Delete($p)}catch{}", "Ans 'OK'");
}

// ─── A command fed as the bytes come ─────────────────────────────────────────

/** A command whose stdin the hub writes as a client's chunks arrive. */
interface StreamedCommand {
	write(data: Buffer): Promise<void>;
	/** Close its stdin, and say how it ended. */
	end(): Promise<StdinExecResult>;
	close(): void;
	readonly done: Promise<StdinExecResult>;
}

function streamCommand(client: SshClient, command: string): Promise<StreamedCommand> {
	return new Promise((resolve, reject) => {
		const onChannel = (err: Error | undefined, stream: ClientChannel): void => {
			if (err) {
				reject(err);
				return;
			}
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let exitCode: number | null = null;
			let ended = false;
			let settle!: (result: StdinExecResult) => void;
			const done = new Promise<StdinExecResult>((resolveDone) => {
				settle = resolveDone;
			});
			stream.on("data", (chunk: Buffer) => stdout.push(chunk));
			stream.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
			stream.on("exit", (code: unknown) => {
				if (typeof code === "number") exitCode = code;
			});
			// What ended it is said by the close that always follows.
			stream.on("error", () => {});
			stream.on("close", () => {
				ended = true;
				settle({
					stdout: Buffer.concat(stdout),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode,
				});
			});
			const close = (): void => {
				try {
					stream.close();
				} catch {
					// The connection is gone, and the channel with it.
				}
			};
			resolve({
				write: (data) =>
					new Promise<void>((resolveWrite, rejectWrite) => {
						if (ended) {
							rejectWrite(new UploadInterrupted("The command on the host ended"));
							return;
						}
						const stall = setTimeout(() => {
							close();
							rejectWrite(
								new UploadInterrupted(
									`The host took no byte for ${WRITE_STALL_MS / 1000} s, so the file was stopped`,
								),
							);
						}, WRITE_STALL_MS);
						void done.then(() => {
							clearTimeout(stall);
							rejectWrite(new UploadInterrupted("The command on the host ended"));
						});
						stream.write(data, (error) => {
							clearTimeout(stall);
							if (error) rejectWrite(new UploadInterrupted(describeError(error), { cause: error }));
							else resolveWrite();
						});
					}),
				end: () => {
					if (!ended) stream.end();
					return done;
				},
				close,
				done,
			});
		};
		try {
			client.exec(command, onChannel);
		} catch (error) {
			reject(error);
		}
	});
}

/** What a script answered after the reply marker: its first line, and the lines after. */
function replyOf(result: { stdout: Buffer | string }): { status: string; lines: string[] } | null {
	const reply = windowsReply(result.stdout.toString());
	if (reply === null) return null;
	const [status = "", ...lines] = reply.split(/\r?\n/);
	return { status: status.trim(), lines: lines.map((line) => line.trim()) };
}

/** Whether what the host said is a full disk: GNU and BusyBox `cat`, and .NET. */
function sayFullDisk(said: string): boolean {
	return /No space left|Disk quota exceeded|not enough space on the disk/i.test(said);
}

class ExecSink implements UploadSink {
	constructor(
		private readonly backend: ExecUploadBackend,
		private readonly command: StreamedCommand,
		private readonly options: OpenOptions,
	) {}

	async write(data: Buffer): Promise<void> {
		try {
			await this.command.write(data);
		} catch (error) {
			// The command ended early: what it said is why.
			const ended = await Promise.race([
				this.command.done,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
			]);
			if (ended !== null) throw this.backend.writeFailure(ended, error);
			throw this.backend.interrupted(error);
		}
	}

	async finish(sha256: string | null): Promise<TransferVerification> {
		const result = await this.command.end();
		const reply = replyOf(result);
		if (reply?.status !== "OK") throw this.backend.writeFailure(result);
		const [counted = "", hashed = "-"] = reply.lines;
		if (Number(counted) !== this.options.size) {
			throw new VerifyFailed(
				"SIZE_MISMATCH",
				`${counted || "no"} of ${this.options.size} bytes are on the host`,
			);
		}
		if (sha256 === null) return "size";
		const theirs = /[0-9a-f]{64}/i.exec(hashed)?.[0]?.toLowerCase();
		if (theirs === undefined) return "no_hash_tool";
		if (theirs !== sha256) {
			throw new VerifyFailed("HASH_MISMATCH", "Its SHA-256 on the host is not what was sent");
		}
		return "sha256";
	}

	async abort(): Promise<void> {
		const ended = this.command.end();
		const waited = await Promise.race([
			ended.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ABORT_WAIT_MS)),
		]);
		if (!waited) this.command.close();
	}
}

/**
 * A remote host's files for an upload over SSH commands, for a server that
 * offers no SFTP (#722) or whose SFTP could not be opened.
 *
 * Each file's bytes go on the stdin of one command, as a client sends them:
 * POSIX `cat` into a temporary created under `set -C`, Windows .NET's
 * `CreateNew`. The host then reports its size and, with `transfer_verify`,
 * hashes it before it is placed; the hub hashes the same bytes as they pass,
 * and a file whose hashes differ is not placed. Placing is a second command
 * (`posixPlaceScript`, `windowsPlaceScript`). Every path reaches the host as
 * data: a `sh` argument or a single-quoted word, or Base64 for PowerShell.
 */
export class ExecUploadBackend implements UploadBackend {
	readonly transport = "exec";

	constructor(
		private readonly client: SshClient,
		readonly style: PathStyle,
		private readonly isLost: () => boolean,
		private readonly browse: ExecFileBackend,
	) {}

	get lost(): boolean {
		return this.isLost();
	}

	list(dir: string): Promise<FileEntry[]> {
		return this.browse.list(dir, true);
	}

	stat(path: string): Promise<FileEntry> {
		return this.browse.stat(path);
	}

	freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		return this.browse.freeSpace(dir);
	}

	async mkdirs(paths: readonly string[]): Promise<FolderResult[]> {
		const results: FolderResult[] = [];
		for (let at = 0; at < paths.length; at += MKDIR_BATCH) {
			const batch = paths.slice(at, at + MKDIR_BATCH);
			const result =
				this.style === "windows"
					? await this.run(windowsMkdirScriptCommand(), "The folders could not be created", () =>
							Readable.from(
								Buffer.from(
									`${batch.map((path) => Buffer.from(path, "utf8").toString("base64")).join("\n")}\n`,
								),
							),
						)
					: await this.run("sh -s", "The folders could not be created", () =>
							Readable.from(Buffer.from(posixMkdirScript(batch), "utf8")),
						);
			const reply = replyOf(result);
			if (reply?.status !== "OK")
				throw this.scriptFailure(result, "The folders could not be created");
			batch.forEach((_, index) => {
				const letter = reply.lines[index];
				if (letter === "C") results.push({ kind: "created" });
				else if (letter === "E") results.push({ kind: "merged" });
				else if (letter === "F") results.push({ kind: "clash", existing: null });
				else {
					results.push({
						kind: "failed",
						error: new FileAccessError("FILE_ACCESS_FAILED", "The folder could not be created"),
					});
				}
			});
		}
		return results;
	}

	async open(path: string, options: OpenOptions): Promise<UploadSink> {
		const command =
			this.style === "windows"
				? encodedPowerShell(windowsWriteScript(path, options))
				: posixWriteCommand(path, options);
		let streamed: StreamedCommand;
		try {
			streamed = await streamCommand(this.client, command);
		} catch (error) {
			throw this.interrupted(error);
		}
		return new ExecSink(this, streamed, options);
	}

	async place(temp: string, target: string, replace: boolean): Promise<PlaceResult> {
		const what = "The file could not be put in place";
		let result: { stdout: string | Buffer; stderr: string; exitCode: number | null };
		if (this.style === "windows") {
			const aside = `${target}.${randomBytes(8).toString("hex")}.old`;
			try {
				result = await sshExec(
					this.client,
					encodedPowerShell(windowsPlaceScript(temp, target, replace, aside)),
					WINDOWS_TIMEOUT_MS,
				);
			} catch (error) {
				throw this.interrupted(error);
			}
		} else {
			result = await this.run("sh -s", what, () =>
				Readable.from(Buffer.from(posixPlaceScript(temp, target, replace), "utf8")),
			);
		}
		const reply = replyOf(result);
		switch (reply?.status) {
			case "OK":
				return { kind: "placed" };
			case "EXISTS":
				return { kind: "exists", existing: await this.browse.stat(target).catch(() => null) };
			case "IS_DIRECTORY":
				throw new FileAccessError("ALREADY_EXISTS", `${what}: a folder has that name`);
			case "NOT_FOUND":
				throw new FileAccessError("NOT_FOUND", `${what}: its temporary is gone`);
			case "PERMISSION_DENIED":
				throw new FileAccessError("PERMISSION_DENIED", `${what}: ${REASONS.PERMISSION_DENIED}`);
			default:
				throw this.scriptFailure(result, what);
		}
	}

	async remove(path: string): Promise<void> {
		try {
			if (this.style === "windows") {
				await sshExec(
					this.client,
					encodedPowerShell(windowsRemoveScript(path)),
					WINDOWS_TIMEOUT_MS,
				);
			} else {
				await this.run("sh -s", "The file could not be removed", () =>
					Readable.from(Buffer.from(posixRemoveScript(path), "utf8")),
				);
			}
		} catch {
			// Left behind: nothing else can be done about it here.
		}
	}

	async placement(): Promise<"temp"> {
		return "temp";
	}

	release(): void {}

	/** Why a file's command ended without writing it, as the upload reads it. */
	writeFailure(result: StdinExecResult, cause?: unknown): Error {
		const reply = replyOf(result);
		const what = "The file could not be written";
		switch (reply?.status) {
			case "EXISTS":
				return new TargetExists(null);
			case "NOT_FOUND":
				return new FileAccessError("NOT_FOUND", `${what}: ${REASONS.PARENT_NOT_FOUND}`);
			case "PERMISSION_DENIED":
				return new FileAccessError("PERMISSION_DENIED", `${what}: ${REASONS.PERMISSION_DENIED}`);
		}
		if (reply === null && result.exitCode === null) return this.interrupted(cause);
		return this.scriptFailure(result, what);
	}

	interrupted(cause?: unknown): Error {
		if (this.lost) {
			return new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost", {
				cause,
			});
		}
		if (cause instanceof UploadInterrupted || cause instanceof FileAccessError) return cause;
		return new UploadInterrupted(`The command on the host stopped: ${describeError(cause)}`, {
			cause,
		});
	}

	private scriptFailure(
		result: { stdout: string | Buffer; stderr: string; exitCode: number | null },
		what: string,
	): Error {
		if (result.exitCode === null && replyOf(result) === null) return this.interrupted();
		const said = readableStderr(result.stderr);
		if (sayFullDisk(said)) return new FileAccessError("NO_SPACE", `${what}: ${REASONS.NO_SPACE}`);
		const reason =
			replyOf(result)?.status === "FAILED"
				? said || "the host gave no reason"
				: exitFailure(result.exitCode, result.stderr).message;
		return new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${reason}`);
	}

	private async run(
		command: string,
		what: string,
		input: () => Readable,
	): Promise<StdinExecResult> {
		try {
			return await execWithStdin(this.client, command, input, SCRIPT_STALL_MS, what.toLowerCase());
		} catch (error) {
			throw this.interrupted(error);
		}
	}
}

function windowsMkdirScriptCommand(): string {
	return encodedPowerShell(windowsMkdirScript());
}
