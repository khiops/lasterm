import { randomBytes } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import type { ClientChannel, Client as SshClient } from "ssh2";
import { quotePosix } from "../session/remote-daemon.js";
import { sshExec } from "../session/ssh-exec.js";
import {
	describeError,
	encodedPowerShell,
	execWithStdin,
	powerShellPathVariable,
	readableStderr,
	windowsReply,
} from "../session/ssh-file-transport.js";
import { posixScript, windowsScript } from "./exec-files.js";
import { FileAccessError, REASONS } from "./host-files.js";
import type { PathStyle } from "./host-paths.js";
import {
	type FileLook,
	fileChanged,
	linkNotFollowed,
	notAFile,
	type OpenedFile,
	type ReadBackend,
	sameLook,
} from "./read-backend.js";

/**
 * A host's files over SSH commands, for a download (#840): a POSIX `sh`
 * script, or PowerShell calling .NET only, no cmdlet (`exec-files.ts`). The
 * path reaches the host as data. A read's bytes follow a marker line the hub
 * chose for that read and a `size mtime` line taken on the opened file: the
 * hub looks for the marker in at most the first `PRELUDE_LIMIT` bytes, so
 * whatever the account's shell prints first is passed over, and it never
 * searches the body. After exactly the bytes it was asked for, the script
 * prints a second look on a line of its own.
 *
 * A link is what the host's style lets a script tell: `[ -L ]` on POSIX; on
 * Windows, a folder that is a reparse point. A Windows file that is a reparse
 * point is read as a file: telling a link from a cloud placeholder needs the
 * reparse tag, which .NET Framework does not give (as the listing,
 * `exec-files.ts`).
 */

/** How far into a read's output the marker may come. */
export const PRELUDE_LIMIT = 64 * 1024;

/** How long a look may take, on top of the shell's start-up (`sshExec`). */
const LOOK_TIMEOUT_MS = 30_000;

const WHAT = "The file could not be read";

/** Exit codes of a read script that refused before printing its marker. */
const EXIT_LINK = 3;
const EXIT_MISSING = 4;
const EXIT_NOT_A_FILE = 5;

const LOOK_LINE = /^(\d+) (\d+)$/;

// ─── Scripts ──────────────────────────────────────────────────────────────────

const POSIX_LOOK = `l() { stat -L -c '%s %Y' -- "$p" 2>/dev/null || stat -L -f '%z %m' "$p"; }`;

/** The look: `OK` and `size mtime`, or `LINK`, `NOT_FOUND`, `NOT_A_FILE`. */
export function posixLookScript(path: string): string {
	return posixScript(
		[
			`p=${quotePosix(path)}`,
			POSIX_LOOK,
			`[ -L "$p" ] && r LINK`,
			`[ -e "$p" ] || r NOT_FOUND`,
			`[ -f "$p" ] || r NOT_A_FILE`,
			`s=$(l) || r FAILED`,
			`r "OK
$s"`,
		].join("\n"),
	);
}

/** The read: the marker, a look on the opened file, `length` bytes from `start`, then a look on stderr. */
export function posixReadScript(
	path: string,
	marker: string,
	start: number,
	length: number,
): string {
	return [
		"{",
		`p=${quotePosix(path)}`,
		POSIX_LOOK,
		`if [ -L "$p" ]; then exit ${EXIT_LINK}; fi`,
		`[ -e "$p" ] || exit ${EXIT_MISSING}`,
		`[ -f "$p" ] || exit ${EXIT_NOT_A_FILE}`,
		`exec 3<"$p" || exit 6`,
		`printf '%s\\n' '${marker}'`,
		"l || exit 7",
		`tail -c +${start + 1} <&3 | head -c ${length}`,
		"printf '\\n'",
		"l",
		"} </dev/null",
		"",
	].join("\n");
}

const WINDOWS_KIND = [
	`if(-not [IO.File]::Exists($p) -and -not [IO.Directory]::Exists($p)){Ans 'NOT_FOUND'}`,
	"$a=[int][IO.File]::GetAttributes($p)",
	"if(($a -band 16) -ne 0){if(($a -band 1024) -ne 0){Ans 'LINK'};Ans 'NOT_A_FILE'}",
];

export function windowsLookScript(path: string): string {
	return windowsScript(
		path,
		...WINDOWS_KIND,
		"$i=[IO.FileInfo]::new($p)",
		"Ans ('OK'+[char]10+$i.Length+' '+$i.LastWriteTimeUtc.Ticks)",
	);
}

export function windowsReadScript(
	path: string,
	marker: string,
	start: number,
	length: number,
): string {
	return [
		"$ErrorActionPreference='Stop'",
		powerShellPathVariable(path),
		`if(-not [IO.File]::Exists($p) -and -not [IO.Directory]::Exists($p)){exit ${EXIT_MISSING}}`,
		"$a=[int][IO.File]::GetAttributes($p)",
		`if(($a -band 16) -ne 0){if(($a -band 1024) -ne 0){exit ${EXIT_LINK}};exit ${EXIT_NOT_A_FILE}}`,
		"$f=[IO.File]::Open($p,'Open','Read','ReadWrite')",
		"$o=[Console]::OpenStandardOutput()",
		`$h=[Text.Encoding]::ASCII.GetBytes('${marker}'+[char]10+$f.Length+' '+[IO.File]::GetLastWriteTimeUtc($p).Ticks+[char]10)`,
		"$o.Write($h,0,$h.Length)",
		`[void]$f.Seek(${start},'Begin')`,
		"$b=[byte[]]::new(65536)",
		`$left=[long]${length}`,
		"while($left -gt 0){$n=$f.Read($b,0,[int][Math]::Min(65536,$left));if($n -le 0){break};$o.Write($b,0,$n);$left-=$n}",
		"$o.Flush();$f.Dispose()",
		"$i=[IO.FileInfo]::new($p)",
		"$t=[Text.Encoding]::ASCII.GetBytes([string][char]10+$i.Length+' '+$i.LastWriteTimeUtc.Ticks+[char]10)",
		"$o.Write($t,0,$t.Length);$o.Flush()",
	].join(";");
}

// ─── The backend ──────────────────────────────────────────────────────────────

export class ExecReadBackend implements ReadBackend {
	constructor(
		private readonly client: SshClient,
		private readonly style: PathStyle,
		private readonly lost: () => boolean,
		/** Told the body bytes each read received from the host, for tests that bound the read-ahead. */
		readonly onRead?: (bytes: number) => void,
		/** Told when a read's channel closes, for tests. */
		readonly onClose?: () => void,
	) {}

	async open(path: string): Promise<OpenedFile> {
		const unit = this.style === "windows" ? "t" : "s";
		let stdout: string;
		let stderr: string;
		let exitCode: number | null;
		try {
			const script = this.style === "windows" ? windowsLookScript(path) : posixLookScript(path);
			if (this.style === "windows") {
				({ stdout, stderr, exitCode } = await sshExec(
					this.client,
					encodedPowerShell(script),
					LOOK_TIMEOUT_MS,
				));
			} else {
				const result = await execWithStdin(
					this.client,
					"sh -s",
					() => Readable.from(Buffer.from(script, "utf8")),
					LOOK_TIMEOUT_MS,
					"the request",
				);
				stdout = result.stdout.toString("utf8");
				stderr = result.stderr;
				exitCode = result.exitCode;
			}
		} catch (error) {
			throw this.failure(error);
		}
		const reply = windowsReply(stdout);
		const [status = "", line = ""] = reply === null ? [] : reply.split(/\r?\n/);
		switch (status.trim()) {
			case "OK": {
				const match = LOOK_LINE.exec(line.trim());
				if (match) {
					const look: FileLook = { size: Number(match[1]), mtime: Number(match[2]), unit };
					return new ExecOpenedFile(this, path, look);
				}
				break;
			}
			case "LINK":
				throw linkNotFollowed(WHAT);
			case "NOT_FOUND":
				throw new FileAccessError("NOT_FOUND", `${WHAT}: ${REASONS.NOT_FOUND}`);
			case "NOT_A_FILE":
				throw notAFile(WHAT);
		}
		if (this.lost()) throw this.gone();
		const said = readableStderr(stderr) || `the host gave no answer (exit ${exitCode ?? "none"})`;
		throw new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: ${said}`);
	}

	/** Start the read command: resolves with the body once the marker and the look came. */
	stream(path: string, look: FileLook, start: number, length: number): Promise<ExecStream> {
		const marker = `lasterm-read-${randomBytes(16).toString("hex")}`;
		const windows = this.style === "windows";
		const command = windows
			? encodedPowerShell(windowsReadScript(path, marker, start, length))
			: "sh -s";
		return new Promise((resolve, reject) => {
			const onChannel = (error: Error | undefined, channel: ClientChannel): void => {
				if (error) {
					reject(this.failure(error));
					return;
				}
				new ExecStream(this, channel, marker, look, length, resolve, reject);
				if (!windows) channel.end(posixReadScript(path, marker, start, length));
			};
			try {
				this.client.exec(command, onChannel);
			} catch (error) {
				reject(this.failure(error));
			}
		});
	}

	gone(cause?: unknown): FileAccessError {
		return new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost", {
			cause,
		});
	}

	failure(error: unknown): Error {
		if (error instanceof FileAccessError) return error;
		if (this.lost()) return this.gone(error);
		return new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: ${describeError(error)}`, {
			cause: error,
		});
	}

	refusal(exitCode: number | null, stderr: string): Error {
		if (exitCode === EXIT_LINK) return linkNotFollowed(WHAT);
		if (exitCode === EXIT_MISSING) {
			return new FileAccessError("NOT_FOUND", `${WHAT}: ${REASONS.NOT_FOUND}`);
		}
		if (exitCode === EXIT_NOT_A_FILE) return notAFile(WHAT);
		if (this.lost()) return this.gone();
		const said = readableStderr(stderr) || `the host gave no answer (exit ${exitCode ?? "none"})`;
		return new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: ${said}`);
	}
}

/**
 * The output of a read command: the prelude passed over, the marker, the look
 * (checked against the open's), then the body, paced by its reader.
 */
class ExecStream {
	readonly body = new PassThrough({ highWaterMark: 64 * 1024 });
	private head = Buffer.alloc(0);
	private state: "marker" | "look" | "body" = "marker";
	private stderr = "";
	private exitCode: number | null = null;
	private settled = false;
	private received = 0;
	private closing = false;
	private tail = Buffer.alloc(0);
	readonly ended: Promise<{ exitCode: number | null; stderr: string }>;

	constructor(
		private readonly backend: ExecReadBackend,
		private readonly channel: ClientChannel,
		private readonly marker: string,
		private readonly look: FileLook,
		private readonly length: number,
		private readonly resolve: (stream: ExecStream) => void,
		private readonly reject: (error: Error) => void,
	) {
		let endedResolve!: (value: { exitCode: number | null; stderr: string }) => void;
		this.ended = new Promise((r) => {
			endedResolve = r;
		});
		channel.on("data", (chunk: Buffer) => this.onData(chunk));
		channel.stderr.on("data", (chunk: Buffer) => {
			if (this.stderr.length < PRELUDE_LIMIT) this.stderr += chunk.toString("utf8");
		});
		channel.on("exit", (code: unknown) => {
			if (typeof code === "number") this.exitCode = code;
		});
		channel.on("error", () => {});
		channel.on("close", () => {
			this.backend.onClose?.();
			endedResolve({ exitCode: this.exitCode, stderr: this.stderr });
			if (!this.settled) {
				this.settle(this.backend.refusal(this.exitCode, this.stderr));
			} else if (this.received < this.length) {
				// The host sent fewer bytes than it promised: the file ended early.
				this.body.destroy(fileChanged(WHAT));
			}
		});
		this.body.on("drain", () => channel.resume());
		// A reader that left before the last byte stops the command; one that
		// took every byte leaves it to print its second look.
		this.body.on("close", () => {
			if (this.received < this.length) this.close();
		});
	}

	/** The second look: the line the script printed after exactly `length` bytes. */
	async trailer(): Promise<FileLook | null> {
		await this.ended;
		const match = /^\r?\n(\d+) (\d+)\r?\n?$/.exec(this.tail.toString("ascii"));
		if (!match) return null;
		return { size: Number(match[1]), mtime: Number(match[2]), unit: this.look.unit };
	}

	close(): void {
		try {
			// A paused channel says it closed only once what it holds is read:
			// let it flow, into nothing, so that it closes at once.
			this.closing = true;
			this.channel.resume();
			this.channel.close();
		} catch {
			// The connection is gone, and the channel with it.
		}
	}

	private settle(error?: Error): void {
		if (this.settled) return;
		this.settled = true;
		if (error) {
			this.reject(error);
			this.close();
		} else this.resolve(this);
	}

	private onData(chunk: Buffer): void {
		if (this.state === "body") {
			this.write(chunk);
			return;
		}
		this.head = Buffer.concat([this.head, chunk]);
		if (this.state === "marker") {
			const wanted = Buffer.from(`${this.marker}\n`);
			const at = this.head.indexOf(wanted);
			if (at === -1) {
				if (this.head.length > PRELUDE_LIMIT) {
					this.settle(
						new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: the host gave no answer`),
					);
				}
				return;
			}
			this.head = this.head.subarray(at + wanted.length);
			this.state = "look";
		}
		const newline = this.head.indexOf(0x0a);
		if (newline === -1) {
			if (this.head.length > 256) {
				this.settle(new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: the host gave no answer`));
			}
			return;
		}
		const match = LOOK_LINE.exec(this.head.subarray(0, newline).toString("ascii").trim());
		const rest = this.head.subarray(newline + 1);
		this.head = Buffer.alloc(0);
		if (!match) {
			this.settle(new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: the host gave no answer`));
			return;
		}
		const look: FileLook = {
			size: Number(match[1]),
			mtime: Number(match[2]),
			unit: this.look.unit,
		};
		if (!sameLook(look, this.look)) {
			this.settle(fileChanged(WHAT));
			return;
		}
		this.state = "body";
		this.settle();
		if (rest.length > 0) this.write(rest);
		else if (this.length === 0) this.body.end();
	}

	private write(chunk: Buffer): void {
		if (this.closing) return;
		const room = this.length - this.received;
		const body = chunk.subarray(0, Math.max(0, room));
		const after = chunk.subarray(body.length);
		if (after.length > 0 && this.tail.length < 256) {
			this.tail = Buffer.concat([this.tail, after]).subarray(0, 256);
		}
		if (body.length === 0 || this.body.destroyed) return;
		this.received += body.length;
		this.backend.onRead?.(body.length);
		const more = this.body.write(body);
		if (this.received === this.length) this.body.end();
		else if (!more) this.channel.pause();
	}
}

class ExecOpenedFile implements OpenedFile {
	private running: ExecStream | null = null;

	constructor(
		private readonly backend: ExecReadBackend,
		private readonly path: string,
		readonly look: FileLook,
	) {}

	async read(start: number, length: number): Promise<Readable> {
		this.running = await this.backend.stream(this.path, this.look, start, length);
		return this.running.body;
	}

	async recheck(): Promise<FileLook> {
		// Nothing was read (an empty body): the second look is a look of its own.
		if (this.running === null) return (await this.backend.open(this.path)).look;
		const look = await this.running.trailer();
		if (look === null) {
			throw new FileAccessError("FILE_ACCESS_FAILED", `${WHAT}: the host did not say how it ended`);
		}
		return look;
	}

	async close(): Promise<void> {
		this.running?.close();
	}
}
