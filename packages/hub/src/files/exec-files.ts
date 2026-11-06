import { Readable } from "node:stream";
import type { Client as SshClient } from "ssh2";
import { quotePosix } from "../session/remote-daemon.js";
import { sshExec } from "../session/ssh-exec.js";
import {
	describeError,
	encodedPowerShell,
	execWithStdin,
	exitFailure,
	powerShellPathVariable,
	readableStderr,
	WINDOWS_REPLY_MARKER,
	windowsReply,
} from "../session/ssh-file-transport.js";
import {
	entryFromMode,
	FileAccessError,
	type FileBackend,
	type FileEntry,
	type FileErrorCode,
	isoFromSeconds,
	type LinkKind,
	linkKindOfMode,
	REASONS,
} from "./host-files.js";
import { baseNameOf, normaliseHostPath, type PathStyle, parentOf } from "./host-paths.js";

/**
 * A host's files over SSH commands, for a server that offers no SFTP (#722,
 * #723) or whose SFTP failed: a POSIX `sh` script, or an encoded PowerShell on
 * a Windows host. Every path reaches the host as data — single-quoted for `sh`,
 * Base64 for PowerShell (#714) — and every name comes back as Base64 of its
 * bytes, so nothing in a name is read by a shell, and any byte survives.
 *
 * The answer follows `WINDOWS_REPLY_MARKER`, on POSIX hosts too: whatever the
 * account's shell prints first (#749) comes before it. Its first line is `OK`
 * or what went wrong, by its error code.
 */

/** How long a POSIX script may go without a byte moving before it is given up. */
const POSIX_STALL_MS = 30_000;

/** How long a PowerShell command may take, on top of the shell's start-up (`sshExec`). */
const WINDOWS_TIMEOUT_MS = 30_000;

/** The codes a script may answer instead of `OK`. */
const SCRIPT_CODES: ReadonlySet<string> = new Set<FileErrorCode>([
	"NOT_FOUND",
	"NOT_A_DIRECTORY",
	"ALREADY_EXISTS",
	"PERMISSION_DENIED",
]);

function decodeBase64(text: string): Buffer {
	return Buffer.from(text.replace(/\s+/g, ""), "base64");
}

/** Bytes a host printed for a name, as text: UTF-8, as SFTP reads names too. */
function decodeName(bytes: Buffer): string {
	return new TextDecoder("utf-8").decode(bytes);
}

// ─── POSIX ────────────────────────────────────────────────────────────────────

/**
 * The shell's prelude: `r` prints the marker and an answer, and ends the
 * script. The script reads nothing on its stdin, which carries the script
 * itself (`sh -s`).
 */
const POSIX_PRELUDE = `M=${WINDOWS_REPLY_MARKER}
r() { printf '%s\\n%s\\n' "$M" "$1"; exit 0; }
`;

export function posixScript(body: string): string {
	return `{\n${POSIX_PRELUDE}${body}\n} </dev/null\n`;
}

/**
 * Prints, for the names a glob gave (none when it matched nothing): `S` then
 * `stat -c '%f %s %Y'` per name (raw mode in hexadecimal, size, mtime), `- - -`
 * for one gone meanwhile; `N` then every name, each followed by `/` (the one
 * byte no name holds), as Base64; `L` then, per link, its index, the followed
 * mode (`-` when it leads nowhere) and its target as Base64; then `E`.
 * `stat -c` is GNU coreutils' and BusyBox's alike. One `stat` for the whole
 * group, unless one name fails it.
 */
const POSIX_GROUP = `g() {
	[ "$#" -gt 1 ] || [ -e "$1" ] || [ -L "$1" ] || return 0
	echo S
	if s=$(stat -c '%f %s %Y' -- "$@" 2>/dev/null); then printf '%s\\n' "$s"
	else for f do stat -c '%f %s %Y' -- "$f" 2>/dev/null || echo '- - -'; done
	fi
	echo N
	printf '%s/' "$@" | base64
	echo L
	i=0
	for f do
		i=$((i+1))
		[ -L "$f" ] || continue
		k=$(stat -L -c %f -- "$f" 2>/dev/null) || k=-
		printf '%s %s ' "$i" "$k"
		readlink -- "$f" | base64 | tr -d '\\n'
		echo
	done
	echo E
}
`;

/** The script that lists `dir`, its hidden entries too when `hidden` (see `POSIX_GROUP`). */
export function posixListScript(dir: string, hidden: boolean): string {
	return posixScript(
		[
			`d=${quotePosix(dir)}`,
			`[ -e "$d" ] || [ -L "$d" ] || r NOT_FOUND`,
			`[ -d "$d" ] || r NOT_A_DIRECTORY`,
			`cd -- "$d" 2>/dev/null && [ -r . ] || r PERMISSION_DENIED`,
			`printf '%s\\nOK\\n' "$M"`,
			POSIX_GROUP,
			...(hidden ? ["g .[!.]*", "g ..?*"] : []),
			"g *",
		].join("\n"),
	);
}

/** The script that says what `path` is, as one group of `POSIX_GROUP`. */
export function posixStatScript(path: string): string {
	return posixScript(
		[
			`p=${quotePosix(path)}`,
			`[ -e "$p" ] || [ -L "$p" ] || r NOT_FOUND`,
			`stat -c %f -- "$p" >/dev/null 2>&1 || r PERMISSION_DENIED`,
			`printf '%s\\nOK\\n' "$M"`,
			POSIX_GROUP,
			`g "$p"`,
		].join("\n"),
	);
}

/** The script that prints `df -Pk` for `dir`. */
export function posixFreeSpaceScript(dir: string): string {
	return posixScript(
		[
			`d=${quotePosix(dir)}`,
			`[ -e "$d" ] || r NOT_FOUND`,
			`o=$(df -Pk -- "$d") || r FAILED`,
			`printf '%s\\nOK\\n%s\\n' "$M" "$o"`,
		].join("\n"),
	);
}

/** The script that creates the folder `path` in `parent`, and only that one. */
export function posixMkdirScript(path: string, parent: string): string {
	return posixScript(
		[
			`p=${quotePosix(path)}`,
			`q=${quotePosix(parent)}`,
			`[ -e "$p" ] || [ -L "$p" ] && r ALREADY_EXISTS`,
			`if e=$(mkdir -- "$p" 2>&1); then r OK; fi`,
			`[ -e "$p" ] && r ALREADY_EXISTS`,
			`[ -e "$q" ] || r NOT_FOUND`,
			`[ -d "$q" ] || r NOT_A_DIRECTORY`,
			`[ -w "$q" ] && [ -x "$q" ] || r PERMISSION_DENIED`,
			`printf '%s\\n' "$e" >&2`,
			"r FAILED",
		].join("\n"),
	);
}

/** The script that prints the account's home folder as Base64. */
export function posixHomeScript(): string {
	return posixScript(
		[
			`[ -n "\${HOME:-}" ] || r NOT_FOUND`,
			`printf '%s\\nOK\\n' "$M"`,
			`printf '%s' "$HOME" | base64 | tr -d '\\n'`,
			"echo",
		].join("\n"),
	);
}

/** One entry of a POSIX group, before its name is known. */
interface PosixStat {
	mode: number;
	size: number;
	mtime: number;
}

/**
 * The entries of the groups `POSIX_GROUP` printed, named by `names` when given
 * (a stat names its one entry itself). An entry gone meanwhile is left out.
 */
export function parsePosixGroups(lines: readonly string[], name?: string): FileEntry[] {
	const entries: FileEntry[] = [];
	let at = 0;
	const next = (): string => lines[at++] ?? "";
	while (at < lines.length) {
		const line = next();
		if (line === "") continue;
		if (line !== "S") throw new Error(`unexpected line in the listing: ${line.slice(0, 20)}`);
		const stats: (PosixStat | null)[] = [];
		for (let row = next(); row !== "N"; row = next()) {
			if (at > lines.length) throw new Error("the listing ended early");
			const match = /^([0-9a-fA-F]+) (\d+) (-?\d+)$/.exec(row);
			stats.push(
				match
					? {
							mode: Number.parseInt(match[1] ?? "", 16),
							size: Number(match[2]),
							mtime: Number(match[3]),
						}
					: null,
			);
		}
		let encoded = "";
		for (let row = next(); row !== "L"; row = next()) {
			if (at > lines.length) throw new Error("the listing ended early");
			encoded += row;
		}
		const bytes = decodeBase64(encoded);
		const names: string[] = [];
		let start = 0;
		for (let i = 0; i < bytes.length; i++) {
			if (bytes[i] !== 0x2f) continue;
			names.push(decodeName(bytes.subarray(start, i)));
			start = i + 1;
		}
		if (name === undefined && names.length !== stats.length) {
			throw new Error(`the listing named ${names.length} entries for ${stats.length}`);
		}
		const links = new Map<number, { linkKind: LinkKind; linkTarget?: string }>();
		for (let row = next(); row !== "E"; row = next()) {
			if (at > lines.length) throw new Error("the listing ended early");
			const match = /^(\d+) ([0-9a-fA-F]+|-) ?(\S*)$/.exec(row);
			if (!match) continue;
			const target = decodeName(decodeBase64(match[3] ?? "")).replace(/\n$/, "");
			links.set(Number(match[1]), {
				linkKind:
					match[2] === "-" ? "missing" : linkKindOfMode(Number.parseInt(match[2] ?? "", 16)),
				...(target !== "" ? { linkTarget: target } : {}),
			});
		}
		stats.forEach((stat, index) => {
			if (stat === null) return;
			const entry = entryFromMode(name ?? names[index] ?? "", stat.mode, stat.size, stat.mtime);
			const link = entry.kind === "symlink" ? links.get(index + 1) : undefined;
			entries.push(link ? { ...entry, ...link } : entry);
		});
	}
	return entries;
}

/** What `df -Pk` printed, in bytes; null when it printed no line it can be read from. */
export function parseDfOutput(
	lines: readonly string[],
): { available: number; total: number } | null {
	for (const line of [...lines].reverse()) {
		const match = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s/.exec(line);
		if (match) return { total: Number(match[1]) * 1024, available: Number(match[3]) * 1024 };
	}
	return null;
}

// ─── Windows ──────────────────────────────────────────────────────────────────

/**
 * What every Windows script starts with: `Ans` prints the marker and an answer
 * and exits 0, `B64` is Base64 of a text's UTF-8 bytes. Not one-letter names:
 * an alias comes before a function, and `r` is `Invoke-History`. Only .NET is
 * called, no cmdlet: under a pwsh parent, Windows PowerShell may not load its
 * own modules (#722), so `Get-ChildItem -Force` is
 * `DirectoryInfo.GetFileSystemInfos`, which lists hidden and system entries
 * alike.
 */
export function windowsScript(path: string | null, ...body: string[]): string {
	return [
		"$ErrorActionPreference='Stop'",
		...(path === null ? [] : [powerShellPathVariable(path)]),
		`function Ans($s){[Console]::Out.Write('${WINDOWS_REPLY_MARKER}'+[char]10+$s);exit 0}`,
		"function B64($s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))}",
		...body,
	].join(";");
}

/**
 * `Ent` prints an entry's line: `d` for a folder, `l` for a folder that is a
 * reparse point (a junction or a link to a folder), `f` otherwise; its size
 * (`-` for a folder), its mtime in seconds, and its name as Base64. A file that
 * is a reparse point stays a file: telling a link from a cloud placeholder
 * needs the reparse tag, which .NET Framework does not give.
 */
const WINDOWS_ENTRY =
	"function Ent($e){$a=[int]$e.Attributes;$d=($a -band 16) -ne 0;$k=if($d){if(($a -band 1024) -ne 0){'l'}else{'d'}}else{'f'};$s=if($d){'-'}else{$e.Length};$t=[DateTimeOffset]::new($e.LastWriteTimeUtc).ToUnixTimeSeconds();$k+' '+$s+' '+$t+' '+(B64 $e.Name)+[char]10}";

/** `$p` missing or a file is said; anything else goes on. */
const WINDOWS_FOLDER_CHECK =
	"if(-not [IO.Directory]::Exists($p)){if([IO.File]::Exists($p)){Ans 'NOT_A_DIRECTORY'};Ans 'NOT_FOUND'}";

/** An access refused is said; anything else ends the script with its error. */
function windowsDenied(statement: string): string {
	return `try{${statement}}catch{if($_.Exception.GetBaseException() -is [UnauthorizedAccessException]){Ans 'PERMISSION_DENIED'};throw}`;
}

/** The script that lists `dir`, or the drives for `/` (see `WINDOWS_ENTRY`). */
export function windowsListScript(dir: string): string {
	return windowsScript(
		dir,
		WINDOWS_ENTRY,
		"$o=[Text.StringBuilder]::new()",
		"if($p -eq '/'){foreach($v in [IO.DriveInfo]::GetDrives()){[void]$o.Append('d - - '+(B64 $v.Name.TrimEnd('\\'))+[char]10)};Ans ('OK'+[char]10+$o)}",
		WINDOWS_FOLDER_CHECK,
		windowsDenied("$i=[IO.DirectoryInfo]::new($p).GetFileSystemInfos()"),
		"foreach($e in $i){[void]$o.Append((Ent $e))}",
		"Ans ('OK'+[char]10+$o)",
	);
}

/** The script that says what `path` is, as one line of `WINDOWS_ENTRY`. */
export function windowsStatScript(path: string): string {
	return windowsScript(
		path,
		WINDOWS_ENTRY,
		windowsDenied(
			"if([IO.Directory]::Exists($p)){$e=[IO.DirectoryInfo]::new($p)}elseif([IO.File]::Exists($p)){$e=[IO.FileInfo]::new($p)}else{Ans 'NOT_FOUND'};$l=Ent $e",
		),
		"Ans ('OK'+[char]10+$l)",
	);
}

/** The script that prints the free and total bytes of `dir`'s drive; `- -` on a share. */
export function windowsFreeSpaceScript(dir: string): string {
	return windowsScript(
		dir,
		WINDOWS_FOLDER_CHECK,
		"$r=[IO.Path]::GetPathRoot($p)",
		"if($r.StartsWith('\\\\')){Ans ('OK'+[char]10+'- -')}",
		"$v=[IO.DriveInfo]::new($r)",
		"Ans ('OK'+[char]10+$v.AvailableFreeSpace+' '+$v.TotalSize)",
	);
}

/** The script that creates the folder `path`, and only that one: its parent must exist. */
export function windowsMkdirScript(path: string): string {
	return windowsScript(
		path,
		"if([IO.Directory]::Exists($p) -or [IO.File]::Exists($p)){Ans 'ALREADY_EXISTS'}",
		"$d=[IO.Path]::GetDirectoryName($p)",
		"if($d -and -not [IO.Directory]::Exists($d)){if([IO.File]::Exists($d)){Ans 'NOT_A_DIRECTORY'};Ans 'NOT_FOUND'}",
		windowsDenied("[void][IO.Directory]::CreateDirectory($p)"),
		"Ans 'OK'",
	);
}

/** The script that prints the account's profile folder as Base64. */
export function windowsHomeScript(): string {
	return windowsScript(
		null,
		"Ans ('OK'+[char]10+(B64 ([Environment]::GetFolderPath('UserProfile'))))",
	);
}

/** The entries of `WINDOWS_ENTRY` lines, named by `name` when given. */
export function parseWindowsEntries(lines: readonly string[], name?: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of lines) {
		const match = /^([dfl]) (\d+|-) (-?\d+|-) (\S*)$/.exec(line.trim());
		if (!match) continue;
		const [, kind, size, mtime, encoded = ""] = match;
		const entryName = name ?? decodeName(decodeBase64(encoded));
		const time = mtime === "-" ? null : isoFromSeconds(Number(mtime));
		if (kind === "l") {
			entries.push({
				name: entryName,
				kind: "symlink",
				size: null,
				mtime: time,
				linkKind: "directory",
			});
		} else {
			entries.push({
				name: entryName,
				kind: kind === "d" ? "directory" : "file",
				size: kind === "d" || size === "-" ? null : Number(size),
				mtime: time,
			});
		}
	}
	return entries;
}

// ─── The backend ──────────────────────────────────────────────────────────────

/**
 * A host's files over SSH commands, on the hub's own connection: POSIX or
 * Windows, as the host's style says.
 */
export class ExecFileBackend implements FileBackend {
	constructor(
		private readonly client: SshClient,
		private readonly style: PathStyle,
		/** Whether the connection is gone, so that a failure is said as `HOST_NOT_CONNECTED`. */
		private readonly lost: () => boolean,
	) {}

	async home(): Promise<string> {
		const what = "The home folder could not be found";
		const [line = ""] =
			this.style === "windows"
				? await this.windows(windowsHomeScript(), what)
				: await this.posix(posixHomeScript(), what);
		const home = normaliseHostPath(decodeName(decodeBase64(line)), this.style);
		if (!home.ok) {
			throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${home.reason}`);
		}
		return home.path;
	}

	async list(dir: string, hidden: boolean): Promise<FileEntry[]> {
		const what = "The folder could not be listed";
		if (this.style === "windows") {
			return parseWindowsEntries(await this.windows(windowsListScript(dir), what));
		}
		return this.parsed(what, await this.posix(posixListScript(dir, hidden), what));
	}

	async stat(path: string): Promise<FileEntry> {
		const what = "The path could not be read";
		const name = baseNameOf(path, this.style);
		if (this.style === "windows") {
			if (path === "/") return { name, kind: "directory", size: null, mtime: null };
			const [entry] = parseWindowsEntries(await this.windows(windowsStatScript(path), what), name);
			if (entry) return entry;
		} else {
			const [entry] = this.parsed(what, await this.posix(posixStatScript(path), what), name);
			if (entry) return entry;
		}
		throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: the host gave no answer`);
	}

	async freeSpace(dir: string): Promise<{ available: number | null; total: number | null }> {
		const what = "The free space could not be read";
		if (this.style === "windows") {
			const [line = ""] = await this.windows(windowsFreeSpaceScript(dir), what);
			const match = /^(\d+|-) (\d+|-)$/.exec(line.trim());
			if (!match)
				throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: the host gave no answer`);
			const [, available, total] = match;
			return {
				available: available === "-" ? null : Number(available),
				total: total === "-" ? null : Number(total),
			};
		}
		const space = parseDfOutput(await this.posix(posixFreeSpaceScript(dir), what));
		if (space === null) {
			throw new FileAccessError(
				"FILE_ACCESS_FAILED",
				`${what}: df printed nothing it can be read from`,
			);
		}
		return space;
	}

	async mkdir(path: string): Promise<void> {
		const what = "The folder could not be created";
		if (this.style === "windows") {
			await this.windows(windowsMkdirScript(path), what, true);
			return;
		}
		await this.posix(posixMkdirScript(path, parentOf(path, "posix") ?? "/"), what, true);
	}

	private parsed(what: string, lines: readonly string[], name?: string): FileEntry[] {
		try {
			return parsePosixGroups(lines, name);
		} catch (error) {
			throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${describeError(error)}`, {
				cause: error,
			});
		}
	}

	private gone(error?: unknown): FileAccessError {
		return new FileAccessError("HOST_NOT_CONNECTED", "The connection to the host was lost", {
			cause: error,
		});
	}

	/**
	 * Run a `sh` script fed on its stdin, and answer the lines after its `OK`.
	 * `parent`: a missing folder, or one that is not, is the new path's parent.
	 */
	private async posix(script: string, what: string, parent = false): Promise<string[]> {
		let result: Awaited<ReturnType<typeof execWithStdin>>;
		try {
			result = await execWithStdin(
				this.client,
				"sh -s",
				() => Readable.from(Buffer.from(script, "utf8")),
				POSIX_STALL_MS,
				"the request",
			);
		} catch (error) {
			if (this.lost()) throw this.gone(error);
			throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${describeError(error)}`, {
				cause: error,
			});
		}
		if (result.exitCode === null && this.lost()) throw this.gone();
		return this.answer(
			result.stdout.toString("utf8"),
			result.exitCode,
			result.stderr,
			what,
			parent,
		);
	}

	/** Run an encoded PowerShell, and answer the lines after its `OK` (see `posix`). */
	private async windows(script: string, what: string, parent = false): Promise<string[]> {
		let result: { stdout: string; stderr: string; exitCode: number };
		try {
			result = await sshExec(this.client, encodedPowerShell(script), WINDOWS_TIMEOUT_MS);
		} catch (error) {
			if (this.lost()) throw this.gone(error);
			throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${describeError(error)}`, {
				cause: error,
			});
		}
		return this.answer(result.stdout, result.exitCode, result.stderr, what, parent);
	}

	private answer(
		stdout: string,
		exitCode: number | null,
		stderr: string,
		what: string,
		parent: boolean,
	): string[] {
		const reply = windowsReply(stdout);
		const [status = "", ...lines] = reply === null ? [] : reply.split(/\r?\n/);
		if (status === "OK") return lines;
		if (SCRIPT_CODES.has(status)) {
			const code = status as keyof typeof REASONS & FileErrorCode;
			const reason =
				parent && code === "NOT_FOUND"
					? REASONS.PARENT_NOT_FOUND
					: parent && code === "NOT_A_DIRECTORY"
						? REASONS.PARENT_NOT_A_DIRECTORY
						: REASONS[code];
			throw new FileAccessError(code, `${what}: ${reason}`);
		}
		if (this.lost()) throw this.gone();
		// FAILED: the script ran, and the command it ran said why on stderr.
		const said =
			status === "FAILED"
				? readableStderr(stderr) || "the host gave no reason"
				: exitFailure(exitCode, stderr).message;
		throw new FileAccessError("FILE_ACCESS_FAILED", `${what}: ${said}`);
	}
}
