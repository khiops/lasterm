import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	chmod,
	copyFile,
	copyFileSync,
	existsSync,
	linkSync,
	mkdir,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	unlink,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameReader, type ProtocolMessage } from "@lasterm/shared";
import type { ClientChannel, SFTPWrapper, Client as SshClient } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { DeployOptions, SftpSupport } from "./agent-deployer.js";
import {
	AgentBinaryDecisionNeeded,
	checkRemoteAgent,
	DeployError,
	deployAgentIfNeeded,
	detectRemoteOsArch,
	getBinaryCacheDir,
	getLocalSha256,
	getRemoteSha256,
	posixUploadCommand,
	probeSftp,
	readRemoteSystem,
	SFTP_PROBE_TIMEOUT_MS,
	STALE_UPLOAD_MINUTES,
	uploadAgentBinary,
	WINDOWS_ARCH_COMMANDS,
	WINDOWS_REPLY_MARKER,
	windowsFindAgentScript,
	windowsKnownFolderCommand,
	windowsLaunchCommand,
	windowsReplaceScript,
	windowsUploadCommand,
} from "./agent-deployer.js";
import { type FetchAgentBinaryOptions, FetchError } from "./agent-fetch.js";
import { HelloSeeker } from "./hello-seeker.js";
import { SHELL_START_CEILING_MS, shellStartAllowance, sshExec } from "./ssh-exec.js";

/** What cmd.exe answers, then what asks PowerShell, for a Windows host's architecture (#714). */
const [ECHO_ARCH, POWERSHELL_ARCH] = WINDOWS_ARCH_COMMANDS as [string, string];

// ---------- Mock SSH helpers --------------------------------------------------

interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

class MockSshStream extends EventEmitter {
	readonly stderr = new EventEmitter();
}

type SshExecCallback = (err: Error | undefined, stream: MockSshStream) => void;

/**
 * Create a mock SshClient whose ssh-exec calls respond via a lookup map.
 * Commands not in the map return exitCode=1 with empty output.
 */
function makeMockClient(
	responses: Record<string, ExecResult>,
	sftpImpl?: (cb: (err: Error | undefined, sftp: SFTPWrapper) => void) => void,
): SshClient {
	const sshExecImpl = vi.fn((command: string, cb: SshExecCallback) => {
		let result: ExecResult = { stdout: "", stderr: "", exitCode: 1 };
		for (const [pattern, resp] of Object.entries(responses)) {
			if (command === pattern || command.startsWith(pattern)) {
				result = resp;
				break;
			}
		}
		const stream = new MockSshStream();
		cb(undefined, stream);
		setImmediate(() => {
			if (result.stdout) stream.emit("data", Buffer.from(result.stdout));
			if (result.stderr) stream.stderr.emit("data", Buffer.from(result.stderr));
			stream.emit("close", result.exitCode);
		});
	});

	return {
		exec: sshExecImpl,
		sftp: sftpImpl ?? vi.fn(),
	} as unknown as SshClient;
}

function folderCommand(folder: "LocalApplicationData" | "ProgramFiles"): string {
	return windowsKnownFolderCommand(folder);
}

/**
 * What a Windows command prints: its answer after the marker (#749), behind
 * whatever the account's shell printed first.
 */
function reply(answer: string, prelude = ""): string {
	return `${prelude}${WINDOWS_REPLY_MARKER}\n${answer}`;
}

/** Paths as a Windows command answers them: Base64 of their UTF-8 bytes, one per line. */
function base64Lines(...paths: string[]): string {
	return paths.map((path) => `${Buffer.from(path, "utf8").toString("base64")}\n`).join("");
}

/** A known folder's lookup, or the agent lookup, answering `paths`. */
function folderOutput(...paths: string[]): ExecResult {
	return { stdout: reply(base64Lines(...paths)), stderr: "", exitCode: 0 };
}

/** The command that looks for the agent on PATH and in the known folders (#714, #749). */
function findAgentCommand(): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(windowsFindAgentScript(), "utf16le").toString("base64")}`;
}

/** What a noisy PowerShell profile prints before every command's own output (#749). */
const PROFILE_NOISE =
	"Loading personal and system profiles took 6012ms.\r\n" +
	`\u001b]0;posh\u0007Welcome, ${WINDOWS_REPLY_MARKER} is not the answer\r\n` +
	"QUJD\r\n1234\r\n";

// ---------- Mock SFTP helpers -------------------------------------------------

/** A file on the mock remote: what was written there, and its mode. */
interface RemoteFile {
	content: string;
	mode: number;
	/** Minutes since it was last written, by the remote's clock. Unset: just now. */
	ageMinutes?: number;
}

interface MockSftpOptions {
	mkdirError?: Error;
	directories?: Set<string>;
	/** Fails the upload after part of the file was written, as a dropped transfer does. */
	fastPutError?: Error;
	chmodError?: Error;
	/** Whether the server offers `posix-rename@openssh.com`. It does unless this is false. */
	posixRename?: boolean;
	/** Fails `posix-rename@openssh.com` on the server's side. */
	renameError?: Error;
	/** The remote files by path, which every call below acts on. */
	files?: Map<string, RemoteFile>;
	/**
	 * Paths a running process executes from. Linux refuses to open them for
	 * writing (ETXTBSY), and SFTP reports that only as "Failure" (#555).
	 */
	busy?: ReadonlySet<string>;
}

/** rename(2) on the mock remote: the source takes the target's place, whatever was there. */
function moveRemoteFile(files: Map<string, RemoteFile>, from: string, to: string): boolean {
	const file = files.get(from);
	if (file === undefined) return false;
	files.delete(from);
	files.set(to, file);
	return true;
}

function makeMockSftp(opts: MockSftpOptions = {}): SFTPWrapper {
	const files = opts.files ?? new Map<string, RemoteFile>();
	const directories = opts.directories ?? new Set<string>();
	return Object.assign(new EventEmitter(), {
		stat: vi.fn(
			(
				path: string,
				cb: (err: Error | undefined, attrs?: { isDirectory: () => boolean }) => void,
			) => {
				cb(directories.has(path) ? undefined : new Error("No such file"), {
					isDirectory: () => directories.has(path),
				});
			},
		),
		mkdir: vi.fn((path: string, cb: (err: Error | undefined) => void) => {
			if (!opts.mkdirError) directories.add(path);
			cb(opts.mkdirError);
		}),
		fastPut: vi.fn((local: string, remote: string, cb: (err: Error | undefined) => void) => {
			if (opts.busy?.has(remote)) {
				cb(new Error("Failure"));
				return;
			}
			if (opts.fastPutError) {
				files.set(remote, { content: `part of ${local}`, mode: 0o644 });
				cb(opts.fastPutError);
				return;
			}
			files.set(remote, { content: local, mode: 0o644 });
			cb(undefined);
		}),
		chmod: vi.fn((path: string, mode: number, cb: (err: Error | undefined) => void) => {
			if (opts.chmodError) {
				cb(opts.chmodError);
				return;
			}
			const file = files.get(path);
			if (file) file.mode = mode;
			cb(undefined);
		}),
		// ssh2 throws before sending anything when the server lacks the extension.
		ext_openssh_rename: vi.fn((from: string, to: string, cb: (err: Error | undefined) => void) => {
			if (opts.posixRename === false) {
				throw new Error("Server does not support this extended request");
			}
			if (opts.renameError) {
				cb(opts.renameError);
				return;
			}
			cb(moveRemoteFile(files, from, to) ? undefined : new Error("No such file"));
		}),
		unlink: vi.fn((path: string, cb: (err: Error | undefined) => void) => {
			cb(files.delete(path) ? undefined : new Error("No such file"));
		}),
		end: vi.fn(),
	}) as unknown as SFTPWrapper;
}

/**
 * A client that only opens SFTP. Its exec answers through `onExec`, and fails
 * whatever `onExec` does not answer rather than hanging until a timeout.
 */
function makeSftpClient(
	sftp: SFTPWrapper,
	sftpError?: Error,
	onExec?: (command: string) => ExecResult,
): SshClient {
	return {
		exec: vi.fn((command: string, cb: SshExecCallback) => {
			const result = onExec?.(command) ?? { stdout: "", stderr: "", exitCode: 1 };
			const stream = new MockSshStream();
			cb(undefined, stream);
			setImmediate(() => {
				if (result.stderr) stream.stderr.emit("data", Buffer.from(result.stderr));
				stream.emit("close", result.exitCode);
			});
		}),
		sftp: vi.fn((cb: (err: Error | undefined, sftp: SFTPWrapper) => void) => {
			cb(sftpError, sftp);
		}),
	} as unknown as SshClient;
}

/**
 * A client whose every command ends once its shell has started, `shellMs` in,
 * and whose SFTP answers `sftpMs` in, or never when null (#764).
 */
function slowShell(shellMs: number, sftpMs: number | null): SshClient {
	return {
		exec: vi.fn((_command: string, cb: SshExecCallback) => {
			const stream = new MockSshStream();
			cb(undefined, stream);
			const end = (): void => {
				stream.emit("close", 0);
			};
			if (shellMs === 0) end();
			else setTimeout(end, shellMs);
		}),
		sftp: vi.fn((cb: (err: Error | undefined, sftp: SFTPWrapper) => void) => {
			if (sftpMs !== null) setTimeout(() => cb(undefined, makeMockSftp()), sftpMs);
		}),
	} as unknown as SshClient;
}

const ENCODED_POWERSHELL = "powershell -NoProfile -NonInteractive -EncodedCommand ";

/**
 * The Windows hash script, written out: the path as Base64 data, then .NET's
 * SHA256, with no module to autoload (#722).
 */
function expectedHashScript(encodedPath: string): string {
	return (
		"$ErrorActionPreference='Stop';" +
		`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));` +
		"$s=[IO.File]::OpenRead($p);" +
		"try{$h=[Security.Cryptography.SHA256]::Create().ComputeHash($s)}finally{$s.Dispose()};" +
		`[Console]::Out.Write('${WINDOWS_REPLY_MARKER}'+[char]10+([BitConverter]::ToString($h).Replace('-','').ToLower()))`
	);
}

/** The PowerShell script inside an encoded command line. */
function decodePowerShell(command: string): string {
	return Buffer.from(command.slice(ENCODED_POWERSHELL.length), "base64").toString("utf16le");
}

/** Whether a command is the one the agent's bytes are streamed to, on either kind of host (#722). */
function isUploadCommand(command: string): boolean {
	return (
		command.includes(" && cat > ") ||
		(command.startsWith(ENCODED_POWERSHELL) &&
			decodePowerShell(command).includes("OpenStandardInput"))
	);
}

/**
 * An exec channel that takes stdin, as the upload over the SSH command channel
 * needs (#722): it answers once its input has ended, with what `answer` makes
 * of that input.
 */
class MockExecChannel extends Duplex {
	readonly stderr = new PassThrough();
	private readonly input: Buffer[] = [];
	private shutDown = false;

	constructor(private readonly answer: (input: Buffer) => ExecResult) {
		super({ emitClose: false });
	}

	override _read(): void {}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
		this.input.push(chunk);
		callback();
	}

	override _final(callback: () => void): void {
		callback();
		const result = this.answer(Buffer.concat(this.input));
		setImmediate(() => {
			if (result.stdout) this.push(Buffer.from(result.stdout));
			if (result.stderr) this.stderr.write(result.stderr);
			this.emit("exit", result.exitCode);
			this.push(null);
			this.shut(result.exitCode);
		});
	}

	/** The channel's close, once. */
	shut(code: number | null): void {
		if (this.shutDown) return;
		this.shutDown = true;
		setImmediate(() => this.emit("close", code));
	}

	close(): void {
		this.shut(null);
	}
}

/**
 * A client whose SFTP cannot be opened, and whose exec answers through
 * `onExec`, or, for the upload command, through `onUpload` with the bytes
 * streamed on its stdin.
 */
function makeExecClient(
	onExec: (command: string) => ExecResult,
	onUpload: (command: string, input: Buffer) => ExecResult,
	sftpError: Error = new Error("Unable to start subsystem: sftp"),
): SshClient {
	return {
		exec: vi.fn((command: string, cb: (err: Error | undefined, stream: unknown) => void) => {
			if (isUploadCommand(command)) {
				cb(undefined, new MockExecChannel((input) => onUpload(command, input)));
				return;
			}
			const result = onExec(command);
			const stream = new MockSshStream();
			cb(undefined, stream);
			setImmediate(() => {
				if (result.stdout) stream.emit("data", Buffer.from(result.stdout));
				if (result.stderr) stream.stderr.emit("data", Buffer.from(result.stderr));
				stream.emit("close", result.exitCode);
			});
		}),
		sftp: vi.fn((cb: (err: Error | undefined) => void) => cb(sftpError)),
	} as unknown as SshClient;
}

/**
 * A POSIX remote reached over exec alone: the upload command stores what
 * arrived under its temporary name, and `sha256sum`, `chmod`, `mv`, `rm` and
 * the sweep act on those files. `transform` alters what is stored, as a
 * transfer that lost or changed bytes would.
 */
function posixExecRemote(
	files: Map<string, RemoteFile & { bytes?: Buffer }>,
	transform: (input: Buffer) => Buffer = (input) => input,
): {
	onExec: (command: string) => ExecResult;
	onUpload: (command: string, input: Buffer) => ExecResult;
} {
	const moving = shellMoving(files);
	const sweeping = shellSweeping(files);
	return {
		onUpload: (command, input) => {
			const temp = unquotePosix(/ && cat > ('(?:[^']|'\\'')*'|\S+) && /.exec(command)?.[1] ?? "");
			const stored = transform(input);
			files.set(temp, { content: stored.toString("latin1"), bytes: stored, mode: 0o600 });
			return { stdout: `${stored.length}\n`, stderr: "", exitCode: 0 };
		},
		onExec: (command) => {
			const hash = /^sha256sum ('(?:[^']|'\\'')*')$/.exec(command);
			if (hash !== null) {
				const path = unquotePosix(hash[1] ?? "");
				const bytes = files.get(path)?.bytes;
				if (bytes === undefined) return { stdout: "", stderr: "No such file", exitCode: 1 };
				const sha = createHash("sha256").update(bytes).digest("hex");
				return { stdout: `${sha}  ${path}\n`, stderr: "", exitCode: 0 };
			}
			const mode = /^chmod 755 -- (\S+)$/.exec(command);
			if (mode !== null) {
				const file = files.get(unquotePosix(mode[1] ?? ""));
				if (file === undefined) return { stdout: "", stderr: "No such file", exitCode: 1 };
				file.mode = 0o755;
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			const remove = /^rm -f -- (\S+)$/.exec(command);
			if (remove !== null) {
				files.delete(unquotePosix(remove[1] ?? ""));
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			if (command.startsWith("find ")) return sweeping(command);
			return moving(command);
		},
	};
}

/** The remote's shell running the deployer's `mv` fallback on the mock remote's files. */
function shellMoving(
	files: Map<string, RemoteFile>,
	exitCode = 0,
): (command: string) => ExecResult {
	return (command) => {
		const mv = /^test ! -d (\S+) && mv -f -- (\S+) (\S+)$/.exec(command);
		if (mv === null || exitCode !== 0) {
			return { stdout: "", stderr: "mv: cannot move", exitCode: exitCode || 1 };
		}
		moveRemoteFile(files, mv[2] ?? "", mv[3] ?? "");
		return { stdout: "", stderr: "", exitCode: 0 };
	};
}

/** Undo `quotePosix`: what the remote's shell hands the command. */
function unquotePosix(word: string): string {
	if (!word.startsWith("'")) return word;
	return word.slice(1, -1).replace(/'\\''/g, "'");
}

/** A `find -name` glob as a regular expression: `\x`, `[...]`, `*` and `?`. */
function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i] ?? "";
		if (c === "\\") {
			i++;
			source += (glob[i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		} else if (c === "[") {
			const end = glob.indexOf("]", i + 1);
			source += glob.slice(i, end + 1);
			i = end;
		} else if (c === "*") source += ".*";
		else if (c === "?") source += ".";
		else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/**
 * The remote's `find` sweeping stale uploads off the mock remote's files: in
 * that directory only, the names the glob matches, older than `-mmin` says.
 * Anything else is answered as a failure.
 */
function shellSweeping(files: Map<string, RemoteFile>): (command: string) => ExecResult {
	return (command) => {
		const word = "('(?:[^']|'\\\\'')*'|\\S+)";
		const find = new RegExp(
			`^find ${word} -maxdepth 1 -type f -name ${word} -mmin \\+(\\d+) -exec rm -f -- \\{\\} \\\\;$`,
		).exec(command);
		if (find === null) return { stdout: "", stderr: "not a sweep", exitCode: 1 };
		const dir = unquotePosix(find[1] ?? "");
		const name = globToRegExp(unquotePosix(find[2] ?? ""));
		const minutes = Number(find[3]);
		for (const [path, file] of [...files]) {
			const cut = path.lastIndexOf("/");
			if (path.slice(0, cut) !== dir || !name.test(path.slice(cut + 1))) continue;
			if ((file.ageMinutes ?? 0) > minutes) files.delete(path);
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
}

/** The paths a Windows replace script names (#725), or null for any other command. */
function replacePaths(command: string): { target: string; temp: string; aside: string } | null {
	if (!command.startsWith(ENCODED_POWERSHELL)) return null;
	const script = decodePowerShell(command);
	if (!script.includes("[IO.File]::Move")) return null;
	const path = (name: string): string => {
		const encoded = new RegExp(
			`\\$${name}=\\[Text\\.Encoding\\]::UTF8\\.GetString\\(\\[Convert\\]::FromBase64String\\('([^']*)'\\)\\)`,
		).exec(script)?.[1];
		if (encoded === undefined) throw new Error(`no $${name} in the replace script`);
		return Buffer.from(encoded, "base64").toString("utf8");
	};
	return { target: path("p"), temp: path("t"), aside: path("o") };
}

/**
 * A Windows host's PowerShell moving the upload into place on the mock
 * remote's files (#725): the target set aside, the upload renamed to it, and
 * the file set aside deleted unless an agent runs from it. Answers anything
 * else as a failure.
 */
function windowsReplacing(
	files: Map<string, RemoteFile>,
	running: ReadonlySet<string> = new Set(),
): (command: string) => ExecResult {
	return (command) => {
		const paths = replacePaths(command);
		if (paths === null) return { stdout: "", stderr: "not a replace", exitCode: 1 };
		const { target, temp, aside } = paths;
		const had = moveRemoteFile(files, target, aside);
		if (!moveRemoteFile(files, temp, target)) {
			if (had) moveRemoteFile(files, aside, target);
			return { stdout: "", stderr: "Could not find file", exitCode: 1 };
		}
		if (had && !running.has(target)) files.delete(aside);
		return { stdout: "", stderr: "", exitCode: 0 };
	};
}

/** The path the (single) upload went to, as the mock SFTP saw it. */
function uploadedTo(sftp: SFTPWrapper): string {
	const call = vi.mocked(sftp.fastPut).mock.calls[0];
	if (call === undefined) throw new Error("nothing was uploaded");
	return call[1];
}

// ---------- Test fixture: binary cache ----------------------------------------

let cacheDir: string;

beforeEach(() => {
	cacheDir = makeTempDir("lasterm-deployer-test-");
});

afterEach(async () => {
	await removeTempDir(cacheDir);
});

// ---------- Helpers for deploy tests ------------------------------------------

/** The fake SHA256 used as the "local" hash in tests. */
const LOCAL_SHA = "a".repeat(64);

/** A different SHA256 representing a remote binary that differs from local. */
const REMOTE_SHA_DIFFERENT = "b".repeat(64);
const TEST_HUB_VERSION = "0.3.4";

function agentCacheName(
	os: "linux" | "windows" | "darwin",
	arch: "x64" | "arm64",
	version = HUB_VERSION,
): string {
	const ext = os === "windows" ? ".exe" : "";
	return `lasterm-agent-${os}-${arch}-${version}${ext}`;
}

function writeCachedAgentBinary(
	os: "linux" | "windows" | "darwin",
	arch: "x64" | "arm64",
	content: string | Buffer = "binary-content",
): string {
	const binaryName = agentCacheName(os, arch);
	const binaryPath = join(cacheDir, binaryName);
	writeFileSync(binaryPath, content);
	return binaryPath;
}

/** Build default DeployOptions with no callbacks and no trust state. */
function makeOptions(overrides: Partial<DeployOptions> = {}): DeployOptions {
	return {
		binaryCache: cacheDir,
		hostname: "myhost.example.com",
		hostId: "host-1",
		...overrides,
	};
}

/**
 * Create a mock SSH client that:
 *  - returns `existingPath` from `which lasterm-agent`
 *  - returns `remoteSha` from `sha256sum '<existingPath>'`
 *  - fails all other commands
 */
function makeAgentFoundClient(existingPath: string, remoteSha: string | null): SshClient {
	const responses: Record<string, ExecResult> = {
		"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
	};
	if (remoteSha !== null) {
		responses[`sha256sum '${existingPath}'`] = {
			stdout: `${remoteSha}  ${existingPath}\n`,
			stderr: "",
			exitCode: 0,
		};
	} else {
		// sha256sum fails
		responses[`sha256sum '${existingPath}'`] = { stdout: "", stderr: "error", exitCode: 1 };
	}
	return makeMockClient(responses);
}

/**
 * Create a mock SSH client that claims agent is NOT present (all lookups fail),
 * responds to uname, $HOME for upload flow, and attaches SFTP.
 */
function makeAgentNotFoundClient(sftp: SFTPWrapper): SshClient {
	const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
		cb(undefined, sftp);
	};
	return makeMockClient(
		{
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			'test -x "$HOME/.local/bin/lasterm-agent" && echo "$HOME/.local/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/usr/local/bin/lasterm-agent" && echo "/usr/local/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/usr/bin/lasterm-agent" && echo "/usr/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/opt/lasterm/lasterm-agent" && echo "/opt/lasterm/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			"echo $HOME": { stdout: "/home/user\n", stderr: "", exitCode: 0 },
		},
		sftpImpl,
	);
}

// ---------- checkRemoteAgent --------------------------------------------------

describe("checkRemoteAgent", () => {
	it("returns path when which succeeds", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "/usr/local/bin/lasterm-agent\n", stderr: "", exitCode: 0 },
		});
		const result = await checkRemoteAgent(client, "linux");
		expect(result).toBe("/usr/local/bin/lasterm-agent");
	});

	it("returns the path the Windows lookup names, in one command (#749)", async () => {
		const client = makeMockClient({
			[findAgentCommand()]: folderOutput(
				"C:\\Users\\user\\AppData\\Local\\lasterm\\lasterm-agent.exe",
			),
		});
		const result = await checkRemoteAgent(client, "windows");
		expect(result).toBe("C:\\Users\\user\\AppData\\Local\\lasterm\\lasterm-agent.exe");
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([findAgentCommand()]);
	});

	it("falls through to common Unix paths when which/where fail", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			'test -x "$HOME/.local/bin/lasterm-agent" && echo "$HOME/.local/bin/lasterm-agent"': {
				stdout: "/home/user/.local/bin/lasterm-agent\n",
				stderr: "",
				exitCode: 0,
			},
		});
		const result = await checkRemoteAgent(client, "linux");
		expect(result).toBe("/home/user/.local/bin/lasterm-agent");
	});

	it("returns null when agent is not found anywhere", async () => {
		const client = makeMockClient({});
		const result = await checkRemoteAgent(client, "linux");
		expect(result).toBeNull();
	});

	it("returns trimmed path (strips trailing newline)", async () => {
		const client = makeMockClient({
			"which lasterm-agent": {
				stdout: "/usr/bin/lasterm-agent\n\n",
				stderr: "",
				exitCode: 0,
			},
		});
		const result = await checkRemoteAgent(client, "linux");
		expect(result).toBe("/usr/bin/lasterm-agent");
	});
});

describe("OS-specific discovery edges", () => {
	it("E5 accepts the first path found, with brackets", async () => {
		const path = "C:\\Profiles[1]\\lasterm-agent.exe";
		const client = makeMockClient({
			[findAgentCommand()]: folderOutput(path, "C:\\ok\\lasterm-agent.exe"),
		});
		expect(await checkRemoteAgent(client, "windows")).toBe(path);
	});

	it.each([
		"/c/Users/u/agent.exe",
		"lasterm\\lasterm-agent.exe",
		"\\\\?\\C:\\lasterm\\lasterm-agent.exe",
		"\\\\.\\pipe\\lasterm-agent.exe",
		'C:\\"quoted"\\agent.exe',
		"C:\\a\u0007\\agent.exe",
	])("E5 skips a path it refuses, %s, for the next one found", async (unsafe) => {
		const client = makeMockClient({
			[findAgentCommand()]: folderOutput(unsafe, "C:\\ok\\lasterm-agent.exe"),
		});
		expect(await checkRemoteAgent(client, "windows")).toBe("C:\\ok\\lasterm-agent.exe");
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([findAgentCommand()]);
	});

	// Nothing reads these as shell text any more: the hash, the upload and the
	// launch take the path as Base64 data (#714). Nor as the console's code page:
	// where.exe printed through it, and lost what it could not represent (#749).
	it.each([
		"C:\\a!b\\lasterm-agent.exe",
		"C:\\%TEMP%\\agent.exe",
		"C:\\Users\\!x! %PATH% $y\\lasterm-agent.exe",
		"\\\\server\\share\\lasterm\\lasterm-agent.exe",
		"C:\\Users\\Zoë 日本 \u{1F600}\\bin\\lasterm-agent.exe",
	])("E5 accepts the path %s", async (path) => {
		const client = makeMockClient({ [findAgentCommand()]: folderOutput(path) });
		expect(await checkRemoteAgent(client, "windows")).toBe(path);
	});

	// A PowerShell DefaultShell runs the account's profile before every command,
	// and its output, a stray marker included, lands in front of the answer.
	it("E5 reads the answer after what the profile printed (#749)", async () => {
		const path = "C:\\Users\\u\\AppData\\Local\\lasterm\\lasterm-agent.exe";
		const client = makeMockClient({
			[findAgentCommand()]: {
				stdout: reply(base64Lines(path), PROFILE_NOISE),
				stderr: "",
				exitCode: 0,
			},
		});
		expect(await checkRemoteAgent(client, "windows")).toBe(path);
	});

	it.each([
		["nothing", { stdout: "", stderr: "", exitCode: 0 }],
		["nothing after the marker", { stdout: reply(""), stderr: "", exitCode: 0 }],
		["a failure", { stdout: "", stderr: "boom", exitCode: 1 }],
		["a path it cannot use", folderOutput("lasterm\\lasterm-agent.exe")],
		["something else", { stdout: "C:\\x\\lasterm-agent.exe", stderr: "", exitCode: 0 }],
		[
			"the profile's text alone",
			{ stdout: `Welcome!\r\n${base64Lines("C:\\x\\a.exe")}`, stderr: "", exitCode: 0 },
		],
		[
			"a path after a failure",
			{ stdout: reply(base64Lines("C:\\x\\a.exe")), stderr: "", exitCode: 1 },
		],
	] as const)("E5 finds no agent when the lookup answers %s", async (_name, answer) => {
		const client = makeMockClient({ [findAgentCommand()]: answer });
		expect(await checkRemoteAgent(client, "windows")).toBeNull();
	});

	it("E5 searches as where.exe did, then the known folders, LocalAppData first, with .NET alone and no path as text", () => {
		const script = windowsFindAgentScript();
		const at = (text: string): number => {
			const index = script.indexOf(text);
			expect(index, text).toBeGreaterThan(-1);
			return index;
		};
		// where.exe: the current directory, then PATH, each with every PATHEXT extension.
		expect(at("GetCurrentDirectory()")).toBeLessThan(at("GetEnvironmentVariable('PATH')"));
		expect(at("GetEnvironmentVariable('PATHEXT')")).toBeLessThan(at("'lasterm-agent'+$e"));
		expect(at("GetEnvironmentVariable('PATH')")).toBeLessThan(
			at("GetFolderPath('LocalApplicationData')"),
		);
		expect(at("GetFolderPath('LocalApplicationData')")).toBeLessThan(
			at("GetFolderPath('ProgramFiles')"),
		);
		expect(at(`'${WINDOWS_REPLY_MARKER}'`)).toBeGreaterThan(at("GetFolderPath('ProgramFiles')"));
		expect(script).toMatch(/;exit 0$/);
		expect(script).not.toMatch(/where|Get-ChildItem|Test-Path|Join-Path|Get-Item|Write-/);
	});

	it.each(["linux", "darwin"] as const)("E6 probes only POSIX paths on %s", async (os) => {
		const client = makeMockClient({});
		expect(await checkRemoteAgent(client, os)).toBeNull();
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
			"which lasterm-agent",
			...[
				"$HOME/.local/bin/lasterm-agent",
				"/usr/local/bin/lasterm-agent",
				"/usr/bin/lasterm-agent",
				"/opt/lasterm/lasterm-agent",
			].map((path) => `test -x "${path}" && echo "${path}"`),
		]);
	});
});

// ---------- detectRemoteOsArch ------------------------------------------------

describe("detectRemoteOsArch", () => {
	it("detects Linux x64 via uname -sm", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "Linux x86_64\n", stderr: "", exitCode: 0 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toEqual({ os: "linux", arch: "x64" });
	});

	it("detects Darwin arm64 via uname -sm", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "Darwin arm64\n", stderr: "", exitCode: 0 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toEqual({ os: "darwin", arch: "arm64" });
	});

	it("falls back to PROCESSOR_ARCHITECTURE for Windows x64", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "", stderr: "not found", exitCode: 1 },
			[ECHO_ARCH]: { stdout: `${WINDOWS_REPLY_MARKER}AMD64\r\n`, stderr: "", exitCode: 0 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toEqual({ os: "windows", arch: "x64" });
	});

	it("falls back to PROCESSOR_ARCHITECTURE for Windows arm64", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "", stderr: "", exitCode: 1 },
			[ECHO_ARCH]: { stdout: `${WINDOWS_REPLY_MARKER}ARM64\r\n`, stderr: "", exitCode: 0 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toEqual({ os: "windows", arch: "arm64" });
	});

	it("asks PowerShell when the shell is PowerShell, which echoes %PROCESSOR_ARCHITECTURE% as it is (#714)", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "", stderr: "not recognized", exitCode: 1 },
			[ECHO_ARCH]: {
				stdout: `${WINDOWS_REPLY_MARKER}%PROCESSOR_ARCHITECTURE%\r\n`,
				stderr: "",
				exitCode: 0,
			},
			[POWERSHELL_ARCH]: { stdout: reply("AMD64"), stderr: "", exitCode: 0 },
		});
		expect(await readRemoteSystem(client)).toEqual({
			system: "Windows AMD64",
			parsed: { os: "windows", arch: "x64" },
		});
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
			"uname -sm",
			`echo ${WINDOWS_REPLY_MARKER}%PROCESSOR_ARCHITECTURE%`,
			POWERSHELL_ARCH,
		]);
		expect(POWERSHELL_ARCH).toMatch(
			/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/]+={0,2}$/,
		);
	});

	// What the account's shell prints first lands in front of every answer: a
	// PowerShell profile, or cmd.exe's AutoRun ("Active code page: 65001").
	it.each([
		["cmd.exe's AutoRun", "Active code page: 65001\r\n", "AMD64\r\n", null],
		["a PowerShell profile", PROFILE_NOISE, "%PROCESSOR_ARCHITECTURE%\r\n", "ARM64"],
	] as const)(
		"reads the architecture after what %s printed (#749)",
		async (_shell, noise, echoed, asked) => {
			const client = makeMockClient({
				"uname -sm": { stdout: noise, stderr: "uname: not recognized", exitCode: 1 },
				[ECHO_ARCH]: {
					stdout: `${noise}${WINDOWS_REPLY_MARKER}${echoed}`,
					stderr: "",
					exitCode: 0,
				},
				...(asked === null
					? {}
					: { [POWERSHELL_ARCH]: { stdout: reply(asked, noise), stderr: "", exitCode: 0 } }),
			});
			const arch = asked ?? echoed.trim();
			expect(await readRemoteSystem(client)).toEqual({
				system: `Windows ${arch}`,
				parsed: { os: "windows", arch: arch === "AMD64" ? "x64" : "arm64" },
			});
		},
	);

	it.each([
		["no marker", "AMD64"],
		["text after the marker", reply("AMD64 x")],
	])("does not take an answer with %s for an architecture", async (_name, stdout) => {
		const client = makeMockClient({
			[ECHO_ARCH]: { stdout, stderr: "", exitCode: 0 },
			[POWERSHELL_ARCH]: { stdout, stderr: "", exitCode: 0 },
		});
		expect(await readRemoteSystem(client)).toBeNull();
	});

	it("returns null when both detection methods fail", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "", stderr: "", exitCode: 1 },
			[ECHO_ARCH]: { stdout: "", stderr: "", exitCode: 1 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toBeNull();
	});

	it("keeps the name of a system no agent is built for (#401)", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "Linux armv7l\n", stderr: "", exitCode: 0 },
			[ECHO_ARCH]: {
				stdout: `${WINDOWS_REPLY_MARKER}%PROCESSOR_ARCHITECTURE%\n`,
				stderr: "",
				exitCode: 0,
			},
		});
		expect(await readRemoteSystem(client)).toEqual({ system: "Linux armv7l", parsed: null });
		expect(await detectRemoteOsArch(client)).toBeNull();
	});

	it("returns null when uname output is unrecognized", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "FreeBSD amd64\n", stderr: "", exitCode: 0 },
			[ECHO_ARCH]: { stdout: "", stderr: "", exitCode: 1 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toBeNull();
	});
});

// ---------- uploadAgentBinary -------------------------------------------------

describe("uploadAgentBinary", () => {
	const target = "/remote/.local/bin/lasterm-agent";

	it.each(["end", "close"] as const)("E7 skips chmod and cleanup after %s", async (event) => {
		const sftp = makeMockSftp();
		vi.mocked(sftp.fastPut).mockImplementation((_local, _remote, callback) => {
			callback(undefined);
			sftp.emit(event);
		});
		await expect(
			uploadAgentBinary(makeSftpClient(sftp), "/local/binary", target, "linux"),
		).rejects.toThrow(/Could not make .* executable: .*SFTP channel closed/);
		expect(sftp.chmod).not.toHaveBeenCalled();
		expect(sftp.unlink).not.toHaveBeenCalled();
		expect(sftp.end).toHaveBeenCalledOnce();
	});

	it.each(["C:\\agent\\binary.exe", "relative/agent.exe"])(
		"E7 skips parent mkdir and fastPut when already closed: %s",
		async (path) => {
			const sftp = makeMockSftp();
			const client = makeSftpClient(sftp);
			vi.mocked(client.sftp).mockImplementation((callback) => {
				callback(undefined, sftp);
				sftp.emit("close");
				return client;
			});
			await expect(uploadAgentBinary(client, "/local/binary", path, "windows")).rejects.toThrow(
				/Could not create the directory .*SFTP channel closed/,
			);
			expect(sftp.mkdir).not.toHaveBeenCalled();
			expect(sftp.fastPut).not.toHaveBeenCalled();
		},
	);

	it("E7 skips rename when chmod closes the session", async () => {
		const sftp = makeMockSftp();
		vi.mocked(sftp.chmod).mockImplementation((_path, _mode, callback) => {
			callback(undefined);
			sftp.emit("close");
		});
		await expect(
			uploadAgentBinary(makeSftpClient(sftp), "/local/binary", target, "linux"),
		).rejects.toThrow(/Could not move the agent into place.*SFTP channel closed/);
		expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
	});

	it("E8 settles an unanswered rename on close", async () => {
		const files = remoteWithOldAgent();
		const sftp = makeMockSftp({ files });
		vi.mocked(sftp.ext_openssh_rename).mockImplementation(() => {
			queueMicrotask(() => sftp.emit("close"));
		});
		await expect(
			uploadAgentBinary(makeSftpClient(sftp), "/local/binary", target, "linux"),
		).rejects.toThrow(/Could not move the agent into place.*SFTP channel closed/);
		expect(sftp.unlink).not.toHaveBeenCalled();
		expect(files.get(target)?.content).toBe("old agent");
	});

	it("E9 completes the exec rename after the SFTP channel closes", async () => {
		const sftp = makeMockSftp({ posixRename: false });
		const client = makeSftpClient(sftp);
		const originalExec = vi.mocked(client.exec).getMockImplementation();
		let renamed = false;
		vi.mocked(client.exec).mockImplementation((command, callback) => {
			if (!command.includes("mv -f")) return originalExec?.(command, callback) ?? client;
			const stream = new MockSshStream();
			callback(undefined, stream as unknown as ClientChannel);
			sftp.emit("close");
			setImmediate(() => {
				renamed = true;
				stream.emit("close", 0);
			});
			return client;
		});
		expect(await uploadAgentBinary(client, "/local/binary", target, "linux")).toBe("sftp");
		expect(renamed).toBe(true);
	});

	it("X1 keeps the exec rename error after the SFTP channel closes", async () => {
		const sftp = makeMockSftp({ posixRename: false });
		const client = makeSftpClient(sftp);
		const originalExec = vi.mocked(client.exec).getMockImplementation();
		vi.mocked(client.exec).mockImplementation((command, callback) => {
			if (!command.includes("mv -f")) return originalExec?.(command, callback) ?? client;
			const stream = new MockSshStream();
			callback(undefined, stream as unknown as ClientChannel);
			sftp.emit("close");
			setImmediate(() => {
				stream.stderr.emit("data", Buffer.from("mv: cannot move"));
				stream.emit("close", 1);
			});
			return client;
		});
		const upload = uploadAgentBinary(client, "/local/binary", target, "linux");
		await expect(upload).rejects.toThrow(/Could not move the agent into place.*mv: cannot move/);
		await expect(upload).rejects.not.toThrow("SFTP channel closed");
	});

	/** A remote with an agent already at the target, as an upgrade finds it. */
	function remoteWithOldAgent(): Map<string, RemoteFile> {
		return new Map([[target, { content: "old agent", mode: 0o755 }]]);
	}

	// A daemon may be running from the target, and Linux will not open a running
	// executable for writing (#555). The upload goes beside it, and only a whole,
	// executable file ever takes the target's name.
	it("uploads beside the target, makes it executable, then renames it over the target", async () => {
		const files = remoteWithOldAgent();
		const sftp = makeMockSftp({ files });
		const client = makeSftpClient(sftp);

		await uploadAgentBinary(client, "/local/binary", target, "linux");

		expect(sftp.mkdir).toHaveBeenCalledWith("/remote/.local/bin", expect.any(Function));
		const temp = uploadedTo(sftp);
		expect(temp).toMatch(/^\/remote\/\.local\/bin\/\.lasterm-agent\.[0-9a-f]{16}\.partial$/);
		expect(sftp.chmod).toHaveBeenCalledWith(temp, 0o755, expect.any(Function));
		expect(sftp.ext_openssh_rename).toHaveBeenCalledWith(temp, target, expect.any(Function));
		const [put] = vi.mocked(sftp.fastPut).mock.invocationCallOrder;
		const [chmod] = vi.mocked(sftp.chmod).mock.invocationCallOrder;
		const [rename] = vi.mocked(sftp.ext_openssh_rename).mock.invocationCallOrder;
		expect(put).toBeLessThan(chmod ?? 0);
		expect(chmod).toBeLessThan(rename ?? 0);
		// The target is the upload, executable, and nothing is left beside it.
		expect([...files]).toEqual([[target, { content: "/local/binary", mode: 0o755 }]]);
		expect(sftp.end).toHaveBeenCalled();
	});

	it("names a different temporary on every upload", async () => {
		const sftp = makeMockSftp();
		const client = makeSftpClient(sftp);

		await uploadAgentBinary(client, "/local/binary", target, "linux");
		await uploadAgentBinary(client, "/local/binary", target, "linux");

		const [first, second] = vi.mocked(sftp.fastPut).mock.calls.map((call) => call[1]);
		expect(first).not.toBe(second);
	});

	it("renames with posix-rename@openssh.com when the server offers it, and runs no mv", async () => {
		const sftp = makeMockSftp({ files: remoteWithOldAgent() });
		const commands: string[] = [];
		const client = makeSftpClient(sftp, undefined, (command) => {
			commands.push(command);
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		await uploadAgentBinary(client, "/local/binary", target, "linux");

		expect(sftp.ext_openssh_rename).toHaveBeenCalledTimes(1);
		expect(commands.filter((command) => command.includes("mv "))).toEqual([]);
	});

	it("falls back to mv -f over exec when the server lacks the extension", async () => {
		const files = remoteWithOldAgent();
		const sftp = makeMockSftp({ files, posixRename: false });
		const client = makeSftpClient(sftp, undefined, shellMoving(files));

		await uploadAgentBinary(client, "/local/binary", target, "linux");

		const temp = uploadedTo(sftp);
		expect(client.exec).toHaveBeenCalledWith(
			`test ! -d ${target} && mv -f -- ${temp} ${target}`,
			expect.any(Function),
		);
		expect([...files]).toEqual([[target, { content: "/local/binary", mode: 0o755 }]]);
	});

	it("quotes both paths for the remote shell in the mv fallback", async () => {
		const awkward = "/home/o'brien/my bin/lasterm-agent";
		const sftp = makeMockSftp({ posixRename: false });
		const commands: string[] = [];
		const client = makeSftpClient(sftp, undefined, (command) => {
			commands.push(command);
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		await uploadAgentBinary(client, "/local/binary", awkward, "linux");

		const quoted = (path: string): string => `'${path.replace(/'/g, "'\\''")}'`;
		const temp = uploadedTo(sftp);
		expect(temp.startsWith("/home/o'brien/my bin/.lasterm-agent.")).toBe(true);
		expect(commands.filter((command) => command.includes("mv "))).toEqual([
			`test ! -d ${quoted(awkward)} && mv -f -- ${quoted(temp)} ${quoted(awkward)}`,
		]);
	});

	// A crash mid-upload leaves its temporary beside the agent. The next upload
	// to that directory removes it, and only it: another hub may be uploading
	// there right now (#127), so a temporary is only removed once it is old
	// enough that nobody can still be writing it, by the remote's clock (#559).
	it("removes what a crashed upload left an hour ago, and nothing else", async () => {
		const stale = "/remote/.local/bin/.lasterm-agent.0123456789abcdef.partial";
		const beingWritten = "/remote/.local/bin/.lasterm-agent.fedcba9876543210.partial";
		const lookalikes = [
			"/remote/.local/bin/.lasterm-agent.not-an-upload.partial",
			"/remote/.local/bin/.other-agent.0123456789abcdef.partial",
			"/remote/.local/bin/lasterm-agent.0123456789abcdef.partial",
			"/remote/.local/bin/nested/.lasterm-agent.0123456789abcdef.partial",
			"/remote/.lasterm-agent.0123456789abcdef.partial",
		];
		const files = remoteWithOldAgent();
		files.set(stale, {
			content: "half an agent",
			mode: 0o644,
			ageMinutes: STALE_UPLOAD_MINUTES + 1,
		});
		files.set(beingWritten, {
			content: "another hub's upload",
			mode: 0o644,
			ageMinutes: STALE_UPLOAD_MINUTES - 1,
		});
		for (const path of lookalikes) {
			files.set(path, { content: "not ours", mode: 0o644, ageMinutes: 24 * 60 });
		}
		const sftp = makeMockSftp({ files });
		const client = makeSftpClient(sftp, undefined, shellSweeping(files));

		await uploadAgentBinary(client, "/local/binary", target, "linux");

		expect(files.has(stale)).toBe(false);
		expect(files.get(beingWritten)?.content).toBe("another hub's upload");
		for (const path of lookalikes) {
			expect(files.has(path), `${path} was removed`).toBe(true);
		}
		expect(files.get(target)).toEqual({ content: "/local/binary", mode: 0o755 });
	});

	it("asks the remote's own clock, with both the directory and the name quoted", async () => {
		const awkward = "/home/o'brien/my bin/lasterm-agent";
		const commands: string[] = [];
		const client = makeSftpClient(makeMockSftp(), undefined, (command) => {
			commands.push(command);
			return { stdout: "", stderr: "", exitCode: 0 };
		});

		await uploadAgentBinary(client, "/local/binary", awkward, "linux");

		const hex = "[0-9a-f]".repeat(16);
		expect(commands).toContain(
			`find '/home/o'\\''brien/my bin' -maxdepth 1 -type f -name '.lasterm-agent.${hex}.partial' ` +
				`-mmin +${STALE_UPLOAD_MINUTES} -exec rm -f -- {} \\;`,
		);
	});

	// Whatever step fails, the temporary goes and the target stays exactly what
	// it was: a running daemon's binary is never left half-written or replaced
	// by a file that cannot run.
	it.each([
		{
			step: "the upload",
			sftpOptions: { fastPutError: new Error("disk full") },
			said: "disk full",
		},
		{ step: "the chmod", sftpOptions: { chmodError: new Error("EPERM") }, said: "EPERM" },
		{
			step: "posix-rename",
			sftpOptions: { renameError: new Error("Permission denied") },
			said: "Permission denied",
		},
		{
			step: "the mv fallback",
			sftpOptions: { posixRename: false },
			mvExitCode: 1,
			said: "exit 1: mv: cannot move",
		},
	])(
		"a failure in $step removes the temporary and leaves the target untouched",
		async ({ sftpOptions, mvExitCode, said }) => {
			const files = remoteWithOldAgent();
			const sftp = makeMockSftp({ files, ...sftpOptions });
			const client = makeSftpClient(sftp, undefined, shellMoving(files, mvExitCode));

			await expect(uploadAgentBinary(client, "/local/binary", target, "linux")).rejects.toThrow(
				said,
			);

			expect(sftp.unlink).toHaveBeenCalledWith(uploadedTo(sftp), expect.any(Function));
			expect([...files]).toEqual([[target, { content: "old agent", mode: 0o755 }]]);
			expect(sftp.end).toHaveBeenCalled();
		},
	);

	it("names both attempts when SFTP cannot be opened and the exec channel fails too", async () => {
		const local = join(cacheDir, "binary");
		writeFileSync(local, "agent");
		const client = makeExecClient(
			() => ({ stdout: "", stderr: "", exitCode: 0 }),
			() => ({ stdout: "", stderr: "cat: write error: No space left on device\n", exitCode: 1 }),
			new Error("SFTP not available"),
		);

		await expect(
			uploadAgentBinary(client, local, "/remote/lasterm-agent", "linux"),
		).rejects.toThrow(
			"Could not upload the agent: SFTP could not be opened (SFTP not available), and the upload " +
				"over the SSH command channel failed too: Could not upload the agent to /remote/" +
				".lasterm-agent.",
		);
		await expect(
			uploadAgentBinary(client, local, "/remote/lasterm-agent", "linux"),
		).rejects.toThrow(/\.partial: exit 1: cat: write error: No space left on device$/);
	});

	it("continues when another writer creates the directory after mkdir fails", async () => {
		const directories = new Set<string>();
		const sftp = makeMockSftp({ directories });
		vi.mocked(sftp.mkdir).mockImplementation((path, cb) => {
			directories.add(path);
			cb(new Error("Failure"));
		});
		await expect(
			uploadAgentBinary(makeSftpClient(sftp), "/local/binary", "/remote/.local/bin/agent", "linux"),
		).resolves.toBe("sftp");
		expect(
			vi.mocked(sftp.stat).mock.calls.filter(([path]) => path === "/remote/.local/bin"),
		).toHaveLength(2);
	});

	it.each([new Error("Transfer refused"), "transfer rejected"])(
		"preserves both directory and transfer failures: %s",
		async (transferError) => {
			const mkdirError = new Error("Permission denied");
			const sftp = makeMockSftp({ directories: new Set(["/remote"]), mkdirError });
			vi.mocked(sftp.fastPut).mockImplementation((_local, _remote, cb) => {
				Reflect.apply(cb, undefined, [transferError]);
			});
			const failure = await uploadAgentBinary(
				makeSftpClient(sftp),
				"local",
				"/remote/bin/agent",
				"linux",
			).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(Error);
			const combined = (failure as Error).cause as Error;
			const walkMessage = "Could not create the directory /remote/bin: Permission denied";
			const transferMessage =
				transferError instanceof Error ? transferError.message : String(transferError);
			expect(combined.message).toBe(`${walkMessage}; the transfer also failed: ${transferMessage}`);
			expect((failure as Error).message).toContain(combined.message);
			expect((failure as Error).message).toMatch(/^Could not upload the agent to /);
			expect(combined.cause).toBeInstanceOf(AggregateError);
			const aggregate = combined.cause as AggregateError;
			expect(aggregate.message).toBe("Directory creation and transfer both failed");
			expect(aggregate.errors).toHaveLength(2);
			expect(aggregate.errors[0]).toMatchObject({ message: walkMessage, cause: mkdirError });
			expect(aggregate.errors[1]).toBe(transferError);
			expect(sftp.fastPut).toHaveBeenCalledOnce();
			expect(sftp.unlink).toHaveBeenCalledExactlyOnceWith(uploadedTo(sftp), expect.any(Function));
			expect(vi.mocked(sftp.stat).mock.calls.map(([path]) => path)).toEqual([
				"/remote/bin",
				"/remote",
				"/remote/bin",
			]);
			expect(vi.mocked(sftp.mkdir).mock.calls).toEqual([["/remote/bin", expect.any(Function)]]);
		},
	);

	it("completes a POSIX transfer despite a directory walk failure", async () => {
		const sftp = makeMockSftp({ mkdirError: new Error("Permission denied") });
		await expect(
			uploadAgentBinary(makeSftpClient(sftp), "local", "/remote/bin/agent", "linux"),
		).resolves.toBe("sftp");
		expect(sftp.fastPut).toHaveBeenCalledOnce();
	});

	it.each([
		["/a//b/agent", ["/a", "/a//b"], "linux"],
		["//host/x/agent", ["//host", "//host/x"], "linux"],
		["/a\\b/c/agent", ["/a\\b", "/a\\b/c"], "linux"],
		[
			"/Users/alice/.local/bin/agent",
			["/Users", "/Users/alice", "/Users/alice/.local", "/Users/alice/.local/bin"],
			"darwin",
		],
	] as const)("walks literal prefixes of %s", async (target, levels, os) => {
		const sftp = makeMockSftp();
		await uploadAgentBinary(makeSftpClient(sftp), "local", target, os);
		expect(vi.mocked(sftp.mkdir).mock.calls).toEqual(
			levels.map((level) => [level, expect.any(Function)]),
		);
		expect(vi.mocked(sftp.stat).mock.calls.map(([path]) => path)).toEqual([...levels].reverse());
	});

	it.each([
		["~/.local/bin/agent", "~/.local/bin", "linux"],
		["a//b/agent", "a//b", "linux"],
		["a/b//agent", "a/b/", "linux"],
		["bin/agent", "bin", "linux"],
		["%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe", "%LOCALAPPDATA%\\lasterm", "windows"],
		["C:\\lasterm-agent.exe", "C:", "windows"],
		["\\\\?\\C:\\lasterm-agent.exe", "\\\\?\\C:", "windows"],
		["\\\\server\\share\\dir\\agent.exe", "\\\\server\\share\\dir", "windows"],
		["/remote/bin/agent.exe", "/remote/bin", "windows"],
	] as const)("sends only one advisory mkdir for %s", async (target, parent, os) => {
		for (const failed of [false, true]) {
			const transferError = new Error("Transfer refused");
			const files = new Map<string, RemoteFile>();
			const sftp = makeMockSftp({
				files,
				mkdirError: new Error("Permission denied"),
				...(failed ? { fastPutError: transferError } : {}),
			});
			const client = makeSftpClient(sftp, undefined, windowsReplacing(files));
			const upload = uploadAgentBinary(client, "local", target, os);
			if (!failed) await expect(upload).resolves.toBe("sftp");
			else await expect(upload).rejects.toMatchObject({ cause: transferError });
			expect(sftp.stat).not.toHaveBeenCalled();
			expect(vi.mocked(sftp.mkdir).mock.calls).toEqual([[parent, expect.any(Function)]]);
			expect(sftp.fastPut).toHaveBeenCalledOnce();
		}
	});

	it("reports every refused level including the deeper permission blocker", async () => {
		const levels = ["/home", "/home/alice", "/home/alice/.local", "/home/alice/.local/bin"];
		const errors = ["Failure", "Failure", "Permission denied", "No such file"].map(
			(message) => new Error(message),
		);
		const sftp = makeMockSftp({ fastPutError: new Error("Failure") });
		vi.mocked(sftp.mkdir).mockImplementation((path, cb) => cb(errors[levels.indexOf(path)]));
		await expect(
			uploadAgentBinary(makeSftpClient(sftp), "local", `${levels[3]}/agent`, "linux"),
		).rejects.toMatchObject({
			message: expect.stringContaining("/home/alice/.local: Permission denied"),
			cause: {
				message: `${levels
					.map((level, i) => `Could not create the directory ${level}: ${errors[i]?.message}`)
					.join("; ")}; the transfer also failed: Failure`,
				cause: expect.objectContaining({
					errors: [
						expect.objectContaining({ cause: expect.any(AggregateError) }),
						expect.any(Error),
					],
				}),
			},
		});
		expect(vi.mocked(sftp.mkdir).mock.calls).toEqual(
			levels.map((level) => [level, expect.any(Function)]),
		);
		expect(vi.mocked(sftp.stat).mock.calls.map(([path]) => path)).toEqual(
			[...levels].reverse().concat(levels),
		);
		expect(sftp.fastPut).toHaveBeenCalledOnce();
	});

	it("stats only the parent when every level exists", async () => {
		const sftp = makeMockSftp({ directories: new Set(["/remote/bin"]) });
		await uploadAgentBinary(makeSftpClient(sftp), "local", "/remote/bin/agent", "linux");
		expect(sftp.stat).toHaveBeenCalledExactlyOnceWith("/remote/bin", expect.any(Function));
		expect(sftp.mkdir).not.toHaveBeenCalled();
	});

	// A Windows agent runs on stdio and lives as long as its connection, so
	// another hub's session on the same account may be running it. Windows will
	// not open it for writing (SFTP says only "Failure"), but lets it be renamed:
	// the upload goes beside it, and PowerShell sets the running file aside and
	// moves the upload into place (#725).
	it("uploads a Windows agent beside the target, then moves it into place with the running one set aside", async () => {
		const windowsTarget = "C:\\Users\\u\\AppData\\Local\\lasterm\\lasterm-agent.exe";
		const files = new Map([[windowsTarget, { content: "old agent", mode: 0o644 }]]);
		const busy = new Set([windowsTarget]);
		const sftp = makeMockSftp({ files, busy });
		const client = makeSftpClient(sftp, undefined, windowsReplacing(files, busy));

		expect(
			await uploadAgentBinary(client, "C:\\local\\lasterm-agent.exe", windowsTarget, "windows"),
		).toBe("sftp");

		const temp = uploadedTo(sftp);
		expect(temp).toMatch(
			/^C:\\Users\\u\\AppData\\Local\\lasterm\\\.lasterm-agent\.exe\.[0-9a-f]{16}\.partial$/,
		);
		expect(sftp.chmod).toHaveBeenCalledWith(temp, 0o755, expect.any(Function));
		expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
		const commands = vi.mocked(client.exec).mock.calls.map(([command]) => command);
		expect(commands).toHaveLength(1);
		const paths = replacePaths(commands[0] ?? "");
		expect(paths?.target).toBe(windowsTarget);
		expect(paths?.temp).toBe(temp);
		expect(paths?.aside).toMatch(/^C:\\Users\\.*\\lasterm-agent\.exe\.old-[0-9a-f]{16}$/);
		// The upload is the target; the running agent's file, set aside, stays.
		expect([...files]).toEqual([
			[paths?.aside, { content: "old agent", mode: 0o644 }],
			[windowsTarget, { content: "C:\\local\\lasterm-agent.exe", mode: 0o755 }],
		]);
		expect(sftp.end).toHaveBeenCalled();
	});

	it("says what PowerShell said when a Windows agent cannot be moved into place, and removes the upload", async () => {
		const windowsTarget = "C:\\lasterm\\lasterm-agent.exe";
		const files = new Map([[windowsTarget, { content: "old agent", mode: 0o755 }]]);
		const sftp = makeMockSftp({ files });
		const client = makeSftpClient(sftp, undefined, () => ({
			stdout: "",
			stderr:
				'#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
				'<S S="Error">Exception calling "Move" with "2" argument(s): "Access to the path is denied."_x000D__x000A_</S></Objs>',
			exitCode: 1,
		}));

		await expect(
			uploadAgentBinary(client, "C:\\local\\agent.exe", windowsTarget, "windows"),
		).rejects.toThrow(
			'Could not move the agent into place at C:\\lasterm\\lasterm-agent.exe: exit 1: Exception calling "Move" with "2" argument(s): "Access to the path is denied."',
		);

		expect(sftp.unlink).toHaveBeenCalledWith(uploadedTo(sftp), expect.any(Function));
		expect([...files]).toEqual([[windowsTarget, { content: "old agent", mode: 0o755 }]]);
	});

	it("calls sftp.end() even when a Windows upload fails", async () => {
		const sftp = makeMockSftp({ fastPutError: new Error("disk full") });
		const client = makeSftpClient(sftp);

		await expect(
			uploadAgentBinary(client, "C:\\local\\agent.exe", "C:\\lasterm\\agent.exe", "windows"),
		).rejects.toThrow("disk full");

		expect(sftp.unlink).toHaveBeenCalledWith(uploadedTo(sftp), expect.any(Function));
		expect(client.exec).not.toHaveBeenCalled();
		expect(sftp.end).toHaveBeenCalled();
	});

	it.each([
		"C:\\Users\\Jean Dupont\\AppData\\Local\\lasterm\\lasterm-agent.exe",
		'C:\\Users\\O\'Brien "x"\\AppData\\Local\\lasterm\\lasterm-agent.exe',
		"C:\\Users\\$env:USERNAME`$(whoami)\\lasterm\\lasterm-agent.exe",
		"C:\\Users\\Zoë 日本\\AppData\\Local\\lasterm\\lasterm-agent.exe",
	])("passes the Windows path %s to the replace script as Base64 data", (path) => {
		const temp = `${path.slice(0, path.lastIndexOf("\\") + 1)}.lasterm-agent.exe.0123456789abcdef.partial`;
		const aside = `${path}.old-fedcba9876543210`;
		const command = `${ENCODED_POWERSHELL}${Buffer.from(windowsReplaceScript(temp, path, aside), "utf16le").toString("base64")}`;
		expect(replacePaths(command)).toEqual({ target: path, temp, aside });
		const script = windowsReplaceScript(temp, path, aside);
		for (const literal of [path, temp, aside]) expect(script).not.toContain(literal);
		// No cmdlet: under a pwsh parent, Windows PowerShell may not load its utility module (#722).
		expect(script).not.toMatch(/Start-Sleep|Get-ChildItem|Remove-Item|Move-Item/);
	});
});

// ---------- uploadAgentBinary — without SFTP (#722) ---------------------------

/**
 * An exec channel over a local child process, as Win32-OpenSSH runs a
 * command: its stdin, stdout, stderr and exit code, nothing else.
 */
class ChildChannel extends Duplex {
	readonly stderr: NodeJS.ReadableStream;

	constructor(private readonly child: ReturnType<typeof spawn>) {
		super({ emitClose: false });
		if (!child.stdin || !child.stdout || !child.stderr) throw new Error("no pipes");
		this.stderr = child.stderr;
		child.stdin.on("error", () => {});
		child.stdout.on("data", (chunk: Buffer) => this.push(chunk));
		child.on("close", (code) => {
			this.emit("exit", code);
			this.push(null);
			setImmediate(() => this.emit("close", code));
		});
	}

	override _read(): void {}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
		this.child.stdin?.write(chunk, callback);
	}

	override _final(callback: () => void): void {
		this.child.stdin?.end();
		callback();
	}

	/** Ends the shell and what it started, as sshd's job object does. */
	close(): void {
		killTree(this.child);
	}
}

/**
 * End `child` and every process it started, while it still runs: a child's
 * kill alone leaves what it started running, with the test's pipes open.
 */
function killTree(child: ReturnType<typeof spawn>): void {
	if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
	spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
		stdio: "ignore",
		windowsHide: true,
	});
}

/**
 * What the account's shell does before every command (#749): a PowerShell
 * profile, or cmd.exe's AutoRun, printing, then taking `sleepMs` more.
 */
interface ShellPrelude {
	readonly sleepMs: number;
}

/**
 * What a chatty PowerShell profile prints (#749): PowerShell's own timing
 * line, a prompt module's escapes, non-ASCII, a stray marker, text that reads
 * as Base64 or digits, and bytes that look like the start of a frame: a whole
 * frame that is no HELLO, and a length that runs into the agent's real one.
 */
const PROFILE_PRELUDE_BYTES = Buffer.concat([
	Buffer.from(PROFILE_NOISE),
	Buffer.from("\u001b[32mZoë 日本\u001b[0m\r\n", "utf8"),
	Buffer.from(encodeFrame({ type: "HEARTBEAT", ts: "profile" })),
	Buffer.from([0x40, 0, 0, 0, 0x81]),
]);

/** What a cmd.exe AutoRun of `chcp 65001` prints (#749). */
const AUTORUN_PRELUDE = "Active code page: 65001";

/** Every shell the harness started, for the test to end whatever outlived it. */
const harnessChildren = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
	for (const child of harnessChildren) killTree(child);
	harnessChildren.clear();
});

/**
 * A client whose exec runs commands on this Windows machine the way
 * Win32-OpenSSH does: `cmd.exe /c "<command>"` by default, or
 * `powershell.exe -c <command>` for a PowerShell `DefaultShell` (#714), and
 * which offers no SFTP. Hidden: a shell started from a process without a
 * console would otherwise open a window for itself and what it starts.
 *
 * `"powershell.exe -NoProfile"` is a PowerShell `DefaultShell` with
 * `DefaultShellCommandOption` set to `-NoProfile`: sshd passes the option as
 * one argument, quoted if it holds a space, in place of `-c`.
 *
 * With a `prelude`, the shell prints and waits before each command, as the
 * account's profile or AutoRun does (#749). The account's own profile never
 * runs: the harness passes `-NoProfile` and plays the profile itself.
 */
function localWindowsClient(
	shell: "cmd.exe" | "powershell.exe" | "powershell.exe -NoProfile",
	env: NodeJS.ProcessEnv = process.env,
	sftp?: SFTPWrapper,
	prelude?: ShellPrelude,
): SshClient {
	const sleep = prelude?.sleepMs ?? 0;
	const powerShellPrelude =
		prelude === undefined
			? ""
			: `$b=[Convert]::FromBase64String('${PROFILE_PRELUDE_BYTES.toString("base64")}');` +
				"$o=[Console]::OpenStandardOutput();$o.Write($b,0,$b.Length);$o.Flush();" +
				"[Console]::Error.Write('WARNING: profile');" +
				`[Threading.Thread]::Sleep(${sleep});`;
	return {
		exec: vi.fn((command: string, cb: (err: Error | undefined, stream: unknown) => void) => {
			const child =
				shell === "cmd.exe"
					? spawn(
							"cmd.exe",
							[
								"/c",
								prelude === undefined
									? `"${command}"`
									: `"echo ${AUTORUN_PRELUDE}&ping -n ${1 + Math.ceil(sleep / 1000)} 127.0.0.1 >nul&${command}"`,
							],
							{ windowsVerbatimArguments: true, windowsHide: true, env },
						)
					: shell === "powershell.exe"
						? spawn(
								"powershell.exe",
								["-NoProfile", "-NonInteractive", "-c", `${powerShellPrelude}${command}`],
								{ windowsHide: true, env },
							)
						: spawn("powershell.exe", ["-NoProfile", command], { windowsHide: true, env });
			harnessChildren.add(child);
			child.once("close", () => harnessChildren.delete(child));
			cb(undefined, new ChildChannel(child));
		}),
		sftp: vi.fn((cb: (err: Error | undefined, sftp?: SFTPWrapper) => void) =>
			sftp === undefined ? cb(new Error("Unable to start subsystem: sftp")) : cb(undefined, sftp),
		),
	} as unknown as SshClient;
}

/** An SFTP session on this machine's files, as Win32-OpenSSH's sftp-server serves them. */
function localSftp(): SFTPWrapper {
	const done =
		(cb: (err: Error | undefined) => void) =>
		(err: NodeJS.ErrnoException | null): void =>
			cb(err ?? undefined);
	return Object.assign(new EventEmitter(), {
		mkdir: vi.fn((path: string, cb: (err: Error | undefined) => void) => mkdir(path, done(cb))),
		fastPut: vi.fn((local: string, remote: string, cb: (err: Error | undefined) => void) =>
			copyFile(local, remote, done(cb)),
		),
		chmod: vi.fn((path: string, mode: number, cb: (err: Error | undefined) => void) =>
			chmod(path, mode, done(cb)),
		),
		unlink: vi.fn((path: string, cb: (err: Error | undefined) => void) => unlink(path, done(cb))),
		end: vi.fn(),
	}) as unknown as SFTPWrapper;
}

/**
 * A running agent's file on this Windows machine: a copy of PING.EXE at
 * `path`, run from there until the test kills it. Windows treats it as it
 * treats a running agent: no write, no delete, no rename over it.
 */
async function runningExecutable(path: string): Promise<ReturnType<typeof spawn>> {
	copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"), path);
	const child = spawn(path, ["-n", "120", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	return child;
}

async function stop(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill();
	await exited;
}

describe("uploadAgentBinary over the SSH command channel (#722)", () => {
	const refused = { offered: false, reason: "Unable to start subsystem: sftp" } as const;
	const target = "/home/u/.local/bin/lasterm-agent";

	function localAgent(bytes: Buffer = randomBytes(64 * 1024)): { path: string; bytes: Buffer } {
		const path = join(cacheDir, "agent-binary");
		writeFileSync(path, bytes);
		return { path, bytes };
	}

	function posixRemote(transform?: (input: Buffer) => Buffer) {
		const files = new Map<string, RemoteFile & { bytes?: Buffer }>([
			[target, { content: "old agent", bytes: Buffer.from("old agent"), mode: 0o755 }],
		]);
		const remote = posixExecRemote(files, transform);
		const client = makeExecClient(remote.onExec, remote.onUpload);
		const commands = () => vi.mocked(client.exec).mock.calls.map(([command]) => command);
		return { files, client, commands };
	}

	it("sends a POSIX agent when the probe found no SFTP: checked, made executable, renamed into place", async () => {
		const agent = localAgent();
		const { files, client, commands } = posixRemote();

		expect(await uploadAgentBinary(client, agent.path, target, "linux", refused)).toBe("exec");

		expect([...files.keys()]).toEqual([target]);
		expect(files.get(target)?.bytes?.equals(agent.bytes)).toBe(true);
		expect(files.get(target)?.mode).toBe(0o755);
		expect(client.sftp).not.toHaveBeenCalled();
		const sent = commands();
		const temp = /&& cat > (\S+) &&/.exec(sent[1] ?? "")?.[1] ?? "";
		expect(temp).toMatch(/^\/home\/u\/\.local\/bin\/\.lasterm-agent\.[0-9a-f]{16}\.partial$/);
		expect(sent).toEqual([
			expect.stringMatching(/^find \/home\/u\/\.local\/bin -maxdepth 1 /),
			posixUploadCommand(temp),
			`sha256sum '${temp}'`,
			`chmod 755 -- ${temp}`,
			`test ! -d ${target} && mv -f -- ${temp} ${target}`,
		]);
	});

	it("waits for a probe still running", async () => {
		const agent = localAgent();
		const { files, client } = posixRemote();
		let answer: (support: typeof refused) => void = () => {};
		const probe = new Promise<typeof refused>((resolve) => {
			answer = resolve;
		});

		const upload = uploadAgentBinary(client, agent.path, target, "linux", probe);
		await new Promise((resolve) => setImmediate(resolve));
		expect(client.exec).not.toHaveBeenCalled();
		answer(refused);

		expect(await upload).toBe("exec");
		expect(files.get(target)?.bytes?.equals(agent.bytes)).toBe(true);
		expect(client.sftp).not.toHaveBeenCalled();
	});

	it("tries SFTP first when nobody probed, and falls back when it cannot be opened", async () => {
		const agent = localAgent();
		const { files, client } = posixRemote();

		expect(await uploadAgentBinary(client, agent.path, target, "linux")).toBe("exec");

		expect(client.sftp).toHaveBeenCalledTimes(1);
		expect(files.get(target)?.bytes?.equals(agent.bytes)).toBe(true);
	});

	it.each([
		[
			"bytes that did not all arrive",
			(input: Buffer) => input.subarray(0, input.length - 1),
			`${64 * 1024 - 1} of ${64 * 1024} bytes arrived`,
		],
		[
			"bytes whose SHA-256 is not the local binary's",
			(input: Buffer) => Buffer.concat([input.subarray(1), Buffer.from([(input[0] ?? 0) ^ 1])]),
			"its SHA-256 is not the local binary's",
		],
	] as const)(
		"refuses %s, removes them, and leaves the agent as it was",
		async (_name, transform, said) => {
			const agent = localAgent();
			const { files, client, commands } = posixRemote(transform);

			const error = await uploadAgentBinary(client, agent.path, target, "linux", refused).catch(
				(error: unknown) => error,
			);

			expect((error as Error).message).toMatch(
				new RegExp(
					"^Could not upload the agent: the server does not offer SFTP \\(Unable to start subsystem: sftp\\), " +
						"and the upload over the SSH command channel failed too: Could not upload the agent to " +
						`\\S+\\.partial: ${said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
				),
			);
			expect([...files]).toEqual([
				[target, { content: "old agent", bytes: Buffer.from("old agent"), mode: 0o755 }],
			]);
			expect(commands().some((command) => command.startsWith("rm -f -- "))).toBe(true);
			expect(commands().some((command) => command.includes(" mv -f "))).toBe(false);
		},
	);

	it("refuses bytes it cannot check", async () => {
		const agent = localAgent();
		const files = new Map<string, RemoteFile & { bytes?: Buffer }>();
		const remote = posixExecRemote(files);
		const client = makeExecClient(
			(command) =>
				command.startsWith("sha256sum ")
					? { stdout: "", stderr: "sha256sum: not found", exitCode: 127 }
					: remote.onExec(command),
			remote.onUpload,
		);

		await expect(uploadAgentBinary(client, agent.path, target, "linux", refused)).rejects.toThrow(
			/\.partial: its SHA-256 could not be computed there: exit 127: sha256sum: not found$/,
		);
		expect([...files.keys()]).toEqual([]);
	});

	it("keeps SFTP where the probe found it offered", async () => {
		const files = new Map<string, RemoteFile>();
		const sftp = makeMockSftp({ files });
		const client = makeSftpClient(sftp);

		expect(
			await uploadAgentBinary(client, "/local/binary", target, "linux", { offered: true }),
		).toBe("sftp");

		expect(sftp.fastPut).toHaveBeenCalledTimes(1);
		expect([...files]).toEqual([[target, { content: "/local/binary", mode: 0o755 }]]);
	});

	it("writes a Windows agent beside the target, checks its SHA-256, then moves it into place, without SFTP", async () => {
		const agent = localAgent();
		const windowsTarget = "C:\\Users\\u\\AppData\\Local\\lasterm\\lasterm-agent.exe";
		const files = new Map<string, RemoteFile>([
			[windowsTarget, { content: "old agent", mode: 0o755 }],
		]);
		const replacing = windowsReplacing(files);
		let stored: Buffer | undefined;
		let temp = "";
		const hashCommand = (path: string): string => {
			const recorder = makeMockClient({});
			void getRemoteSha256(recorder, path, "windows");
			return vi.mocked(recorder.exec).mock.calls[0]?.[0] ?? "";
		};
		const client = makeExecClient(
			(command) => {
				if (command === hashCommand(temp) && stored !== undefined) {
					// Behind what the profile printed (#749).
					return {
						stdout: reply(
							`${createHash("sha256").update(stored).digest("hex").toUpperCase()}\r\n`,
							PROFILE_NOISE,
						),
						stderr: "",
						exitCode: 0,
					};
				}
				return replacing(command);
			},
			(command, input) => {
				temp = Buffer.from(
					decodePowerShell(command).match(/FromBase64String\('([^']*)'\)/)?.[1] ?? "",
					"base64",
				).toString("utf8");
				expect(command).toBe(windowsUploadCommand(temp));
				stored = input;
				files.set(temp, { content: "new agent", mode: 0o644 });
				return { stdout: reply(String(input.length), PROFILE_NOISE), stderr: "", exitCode: 0 };
			},
		);

		expect(await uploadAgentBinary(client, agent.path, windowsTarget, "windows", refused)).toBe(
			"exec",
		);

		expect(temp).toMatch(
			/^C:\\Users\\u\\AppData\\Local\\lasterm\\\.lasterm-agent\.exe\.[0-9a-f]{16}\.partial$/,
		);
		expect(stored?.equals(agent.bytes)).toBe(true);
		expect(client.sftp).not.toHaveBeenCalled();
		const commands = vi.mocked(client.exec).mock.calls.map(([command]) => command);
		expect(commands.slice(0, 2)).toEqual([windowsUploadCommand(temp), hashCommand(temp)]);
		expect(commands).toHaveLength(3);
		expect(replacePaths(commands[2] ?? "")).toMatchObject({ target: windowsTarget, temp });
		expect([...files]).toEqual([[windowsTarget, { content: "new agent", mode: 0o644 }]]);
	});

	it("says what PowerShell said when the Windows write fails, without its CLIXML", async () => {
		const agent = localAgent();
		const client = makeExecClient(
			() => ({ stdout: "", stderr: "", exitCode: 1 }),
			() => ({
				stdout: "",
				stderr:
					'#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
					'<S S="Error">Exception calling "Create" with "1" argument(s): "Access to the path is denied."_x000D__x000A_</S>' +
					'<S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>',
				exitCode: 1,
			}),
		);

		await expect(
			uploadAgentBinary(
				client,
				agent.path,
				"C:\\Program Files\\lasterm\\a.exe",
				"windows",
				refused,
			),
		).rejects.toThrow(
			/^Could not upload the agent: .* failed too: Could not upload the agent to C:\\Program Files\\lasterm\\\.a\.exe\.[0-9a-f]{16}\.partial: exit 1: Exception calling "Create" with "1" argument\(s\): "Access to the path is denied\." At line:1 char:1$/,
		);
		// The upload, whatever it left, is deleted, by PowerShell.
		const commands = vi.mocked(client.exec).mock.calls.map(([command]) => command);
		expect(commands).toHaveLength(2);
		expect(decodePowerShell(commands[1] ?? "")).toMatch(/\[IO\.File\]::Delete\(\$p\)$/);
	});

	it.each([
		"C:\\Users\\Jean Dupont\\AppData\\Local\\lasterm\\lasterm-agent.exe",
		'C:\\Users\\O\'Brien "x"\\AppData\\Local\\lasterm\\lasterm-agent.exe',
		"C:\\Users\\a%PATH%b\\AppData\\Local\\lasterm\\lasterm-agent.exe",
		"C:\\Users\\$env:USERNAME`$(whoami)\\lasterm\\lasterm-agent.exe",
		"C:\\Users\\Zoë 日本\\AppData\\Local\\lasterm\\lasterm-agent.exe",
	])("passes the Windows path %s to the write script as Base64 data", (path) => {
		const command = windowsUploadCommand(path);
		expect(command.startsWith(ENCODED_POWERSHELL)).toBe(true);
		// Nothing cmd.exe or PowerShell would read as anything but a word.
		expect(command.slice(ENCODED_POWERSHELL.length)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
		const encodedPath = Buffer.from(path, "utf8").toString("base64");
		expect(decodePowerShell(command)).toBe(
			[
				"$ErrorActionPreference='Stop'",
				`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
				"$d=[IO.Path]::GetDirectoryName($p)",
				"if($d){[void][IO.Directory]::CreateDirectory($d)}",
				"$i=[Console]::OpenStandardInput()",
				"$o=[IO.File]::Create($p)",
				"try{$i.CopyTo($o);$n=$o.Length}finally{$o.Dispose()}",
				`[Console]::Out.Write('${WINDOWS_REPLY_MARKER}'+[char]10+($n))`,
			].join(";"),
		);
		const inner = decodePowerShell(command).match(/FromBase64String\('([^']*)'\)/)?.[1] ?? "";
		expect(Buffer.from(inner, "base64").toString("utf8")).toBe(path);
	});

	it("quotes the POSIX temporary path for the shell", () => {
		expect(
			posixUploadCommand("/home/Jean Dupont/.local/bin/.lasterm-agent.0123456789abcdef.partial"),
		).toBe(
			"mkdir -p -- '/home/Jean Dupont/.local/bin' && umask 077 && " +
				"cat > '/home/Jean Dupont/.local/bin/.lasterm-agent.0123456789abcdef.partial' && " +
				"wc -c < '/home/Jean Dupont/.local/bin/.lasterm-agent.0123456789abcdef.partial'",
		);
		expect(posixUploadCommand("/home/o'b/.x.partial")).toBe(
			"mkdir -p -- '/home/o'\\''b' && umask 077 && cat > '/home/o'\\''b/.x.partial' && wc -c < '/home/o'\\''b/.x.partial'",
		);
	});

	/** PowerShell 7's own modules, when it is installed: what a pwsh parent puts first on PSModulePath. */
	function powerShell7Modules(): string | null {
		const home = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$PSHOME"], {
			encoding: "utf8",
			windowsHide: true,
		});
		if (home.status !== 0) return null;
		const modules = join(home.stdout.trim(), "Modules");
		return existsSync(join(modules, "Microsoft.PowerShell.Utility")) ? modules : null;
	}

	// The command as a Windows host runs it: through cmd.exe, Win32-OpenSSH's
	// default, and through a PowerShell DefaultShell (#714). A temporary
	// directory with spaces, a quote, `%`, `$`, braces and non-ASCII in its name,
	// and a level that does not exist yet.
	it.runIf(process.platform === "win32").each(["cmd.exe", "powershell.exe"] as const)(
		"writes and checks a Windows agent through %s",
		{ timeout: 60_000 },
		async (shell) => {
			const agent = localAgent(
				Buffer.concat([Buffer.from([...Array(256).keys()]), randomBytes(3 * 1024 * 1024)]),
			);
			const dir = join(cacheDir, "Zoë O'Brien %PATH% $x {y} 日本");
			const windowsTarget = join(dir, "lasterm", "lasterm-agent.exe");
			mkdirSync(dir);
			const client = localWindowsClient(shell);

			expect(await uploadAgentBinary(client, agent.path, windowsTarget, "windows", refused)).toBe(
				"exec",
			);

			expect(readFileSync(windowsTarget).equals(agent.bytes)).toBe(true);
			expect(client.sftp).not.toHaveBeenCalled();
		},
	);

	// Started from PowerShell 7, as under a pwsh DefaultShell (#714), Windows
	// PowerShell finds 7's Microsoft.PowerShell.Utility first and does not know
	// Get-FileHash: the check must not need it.
	it.runIf(process.platform === "win32")(
		"checks a Windows agent with PowerShell 7's modules first on PSModulePath",
		{ timeout: 60_000 },
		async (context) => {
			const modules = powerShell7Modules();
			if (modules === null) context.skip();
			const env: NodeJS.ProcessEnv = {};
			for (const [name, value] of Object.entries(process.env)) {
				if (name.toLowerCase() !== "psmodulepath") env[name] = value;
			}
			env.PSModulePath = `${modules};${process.env.PSModulePath ?? ""}`;
			const agent = localAgent();
			const windowsTarget = join(cacheDir, "pwsh parent", "lasterm-agent.exe");
			const client = localWindowsClient("cmd.exe", env);

			expect(await uploadAgentBinary(client, agent.path, windowsTarget, "windows", refused)).toBe(
				"exec",
			);

			expect(readFileSync(windowsTarget).equals(agent.bytes)).toBe(true);
		},
	);

	// The usual case, and the one a domain controller found: one running agent,
	// nothing else beside it. The sweep's last act is the deletion of the file
	// set aside, which fails while it runs; PowerShell exits 1 after such a
	// caught failure unless told otherwise, and the deploy was reported failed
	// though the upload was in place (#725).
	it.runIf(process.platform === "win32").each(["exec", "sftp"] as const)(
		"replaces a running Windows agent alone in its directory over %s, and says it succeeded",
		{ timeout: 60_000 },
		async (transport) => {
			const dir = join(cacheDir, "lasterm");
			mkdirSync(dir);
			const windowsTarget = join(dir, "lasterm-agent.exe");
			const running = await runningExecutable(windowsTarget);
			try {
				const client = localWindowsClient(
					"cmd.exe",
					process.env,
					transport === "sftp" ? localSftp() : undefined,
				);
				const support = transport === "sftp" ? { offered: true as const } : refused;
				const agent = localAgent();

				expect(await uploadAgentBinary(client, agent.path, windowsTarget, "windows", support)).toBe(
					transport,
				);

				expect(readFileSync(windowsTarget).equals(agent.bytes)).toBe(true);
				expect(running.exitCode).toBeNull();
				expect(readdirSync(dir)).toEqual([
					"lasterm-agent.exe",
					expect.stringMatching(/^lasterm-agent\.exe\.old-[0-9a-f]{16}$/),
				]);
			} finally {
				await stop(running);
			}
		},
	);

	// Another hub's session on the same account runs the agent from the target
	// (#725). Over SFTP and over the command channel alike, the upload takes the
	// target's name, the running agent keeps going from the file set aside, and
	// a later upload deletes that file once nothing runs it. What earlier
	// uploads left goes too, and only that.
	it.runIf(process.platform === "win32").each([
		["cmd.exe", "exec"],
		["powershell.exe", "exec"],
		["cmd.exe", "sftp"],
	] as const)(
		"replaces a running Windows agent through %s over %s, and sweeps what earlier uploads left",
		{ timeout: 60_000 },
		async (shell, transport) => {
			const dir = join(cacheDir, "Zoë O'Brien %PATH% $x {y} 日本", "lasterm");
			mkdirSync(dir, { recursive: true });
			const windowsTarget = join(dir, "lasterm-agent.exe");
			const leftover = (name: string, ageMinutes: number): string => {
				const path = join(dir, name);
				writeFileSync(path, "left over");
				const when = new Date(Date.now() - ageMinutes * 60_000);
				utimesSync(path, when, when);
				return path;
			};
			const setAsideEarlier = leftover("lasterm-agent.exe.old-0123456789abcdef", 0);
			const crashedUpload = leftover(
				".lasterm-agent.exe.0123456789abcdef.partial",
				STALE_UPLOAD_MINUTES + 5,
			);
			const kept = [
				leftover(".lasterm-agent.exe.fedcba9876543210.partial", STALE_UPLOAD_MINUTES - 5),
				leftover("lasterm-agent.exe.old-not-hex", 24 * 60),
				leftover("other-agent.exe.old-0123456789abcdef", 24 * 60),
				leftover(".lasterm-agent.exe.0123456789abcdef.partial.keep", 24 * 60),
			];
			const running = await runningExecutable(windowsTarget);
			try {
				const client = localWindowsClient(
					shell,
					process.env,
					transport === "sftp" ? localSftp() : undefined,
				);
				const support = transport === "sftp" ? { offered: true as const } : refused;

				const first = localAgent();
				expect(await uploadAgentBinary(client, first.path, windowsTarget, "windows", support)).toBe(
					transport,
				);

				expect(readFileSync(windowsTarget).equals(first.bytes)).toBe(true);
				expect(running.exitCode).toBeNull();
				const setAside = readdirSync(dir).filter((name) =>
					/^lasterm-agent\.exe\.old-[0-9a-f]{16}$/.test(name),
				);
				expect(setAside).toHaveLength(1);
				expect(existsSync(setAsideEarlier)).toBe(false);
				expect(existsSync(crashedUpload)).toBe(false);
				for (const path of kept) expect(existsSync(path), `${path} was removed`).toBe(true);

				await stop(running);
				const second = localAgent();
				await uploadAgentBinary(client, second.path, windowsTarget, "windows", support);

				expect(readFileSync(windowsTarget).equals(second.bytes)).toBe(true);
				expect(readdirSync(dir).sort()).toEqual(
					["lasterm-agent.exe", ...kept.map((path) => path.slice(dir.length + 1))].sort(),
				);
			} finally {
				await stop(running);
			}
		},
	);
});

// ---------- Windows hosts, under cmd.exe or a PowerShell DefaultShell (#714) --

/** A profile folder name nothing on the way may read as anything but a name. */
const AWKWARD_NAME = "Zoë O'Brien %PATH% !x! $x {y} [1] & ^ ; 日本";

/** The repository this spec belongs to. */
const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * The agent this checkout built (`scripts/build-agent.ps1`), or the one
 * LASTERM_TEST_AGENT_BINARY names; null when there is none, and the specs that
 * need it skip. It is copied before it runs, never run where it was built.
 */
function builtWindowsAgent(): string | null {
	const named = process.env.LASTERM_TEST_AGENT_BINARY;
	if (named) return named;
	const built = join(REPOSITORY, "dist", "sea", "lasterm-agent.exe");
	return existsSync(built) ? built : null;
}

/**
 * This environment, with `profile` as USERPROFILE, which LocalAppData follows,
 * and a PATH of Windows' own folders, where no lasterm-agent is.
 */
function windowsProfileEnv(profile: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!/^(path|userprofile)$/i.test(name)) env[name] = value;
	}
	const root = process.env.SystemRoot ?? "C:\\Windows";
	env.Path = [
		join(root, "System32"),
		root,
		join(root, "System32", "WindowsPowerShell", "v1.0"),
	].join(";");
	env.USERPROFILE = profile;
	return env;
}

/** Run `command` through the client's shell, and hand back its channel. */
function execChannel(client: SshClient, command: string): ChildChannel {
	let channel: ChildChannel | undefined;
	client.exec(command, (err, stream) => {
		if (err) throw err;
		channel = stream as unknown as ChildChannel;
	});
	if (channel === undefined) throw new Error("no channel");
	return channel;
}

/** What a channel says on stdout, as it arrives, and how it ended. */
function listen(channel: ChildChannel): {
	bytes: () => Buffer;
	until: (enough: (bytes: Buffer) => boolean, ms: number) => Promise<Buffer>;
	exited: Promise<number | null>;
} {
	const chunks: Buffer[] = [];
	const waiting = new Set<() => void>();
	channel.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
		for (const wake of [...waiting]) wake();
	});
	const exited = new Promise<number | null>((resolve) => {
		channel.once("exit", (code: number | null) => resolve(code));
	});
	const bytes = () => Buffer.concat(chunks);
	const until = (enough: (bytes: Buffer) => boolean, ms: number) =>
		new Promise<Buffer>((resolve, reject) => {
			const wake = () => {
				if (!enough(bytes())) return;
				waiting.delete(wake);
				clearTimeout(timer);
				resolve(bytes());
			};
			const timer = setTimeout(() => {
				waiting.delete(wake);
				reject(new Error(`not enough after ${ms} ms: ${bytes().length} bytes`));
			}, ms);
			waiting.add(wake);
			wake();
		});
	return { bytes, until, exited };
}

/** Within `ms`, or the promise's rejection says it did not. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(() => reject(new Error(`${what}: over ${ms} ms`)), ms),
		),
	]);
}

/**
 * A HEARTBEAT whose `ts` the agent echoes, built to carry what a text layer
 * would change: CR, LF, CR LF, ^Z, NUL and every byte from 0x80 up, in its
 * payload and, padded to `payloadLength`, in its length prefix too.
 */
function awkwardHeartbeat(payloadLength?: number): { ts: string; frame: Buffer } {
	let ts = "\r\n\u001a\u0000\r\r\n\n";
	for (let c = 0x80; c <= 0xff; c++) ts += String.fromCharCode(c);
	ts += "日本\u{1F600}";
	if (payloadLength !== undefined) {
		let pad = 0;
		for (let i = 0; i < 6; i++) {
			pad +=
				payloadLength - (encodeFrame({ type: "HEARTBEAT", ts: ts + "x".repeat(pad) }).length - 4);
		}
		ts += "x".repeat(pad);
	}
	return { ts, frame: Buffer.from(encodeFrame({ type: "HEARTBEAT", ts })) };
}

describe("Windows hosts under cmd.exe and a PowerShell DefaultShell (#714)", () => {
	const shells = ["cmd.exe", "powershell.exe"] as const;
	const programFilesAgent = join(
		process.env.ProgramFiles ?? "C:\\Program Files",
		"lasterm",
		"lasterm-agent.exe",
	);

	it.runIf(process.platform === "win32").each(shells)(
		"detects the system through %s",
		{ timeout: 60_000 },
		async (shell) => {
			const client = localWindowsClient(shell, windowsProfileEnv(cacheDir));

			const read = await readRemoteSystem(client);

			expect(read?.parsed?.os).toBe("windows");
			expect(["x64", "arm64"]).toContain(read?.parsed?.arch);
			expect(read?.system).toMatch(/^Windows (AMD64|ARM64)$/);
		},
	);

	// The reopen condition of #714, on this machine: the platform detected, the
	// agent deployed, found again, and started, with a profile whose name holds
	// what cmd.exe and PowerShell would expand, through either shell. Not where
	// an agent is installed in Program Files: the known-folder search would find
	// it, and the deploy replace it.
	it.runIf(process.platform === "win32" && !existsSync(programFilesAgent)).each(shells)(
		"deploys the agent into a profile named like variables through %s, finds it there, and starts it",
		{ timeout: 120_000 },
		async (shell) => {
			const agentBinary = builtWindowsAgent();
			const bytes =
				agentBinary === null
					? Buffer.concat([Buffer.from([...Array(256).keys()]), randomBytes(64 * 1024)])
					: readFileSync(agentBinary);
			const local = writeCachedAgentBinary("windows", "x64", bytes);
			const profile = join(cacheDir, AWKWARD_NAME);
			mkdirSync(join(profile, "AppData", "Local"), { recursive: true });
			const client = localWindowsClient(shell, windowsProfileEnv(profile));
			const host = { os: "windows", arch: "x64" } as const;
			const options = makeOptions({ sftp: { offered: false, reason: "none here" } });
			const target = join(profile, "AppData", "Local", "lasterm", "lasterm-agent.exe");

			const deployed = await deployAgentIfNeeded(client, host, options);

			expect(deployed.deployed).toBe(true);
			// The same file, however the folder was spelt (a short 8.3 TEMP, say).
			expect(realpathSync.native(deployed.remotePath)).toBe(realpathSync.native(target));
			expect(readFileSync(target).equals(readFileSync(local))).toBe(true);

			const found = await deployAgentIfNeeded(client, host, options);

			expect(found).toMatchObject({
				deployed: false,
				remoteMatchesHubVersionCache: true,
				remotePath: deployed.remotePath,
			});

			if (agentBinary === null) return;
			const channel = execChannel(client, windowsLaunchCommand(found.remotePath, ["--stdio"]));
			try {
				// Decoded before `listen` looks at what arrived.
				const reader = new FrameReader();
				const frames: ProtocolMessage[] = [];
				channel.on("data", (chunk: Buffer) => {
					for (const message of reader.push(chunk)) frames.push(message);
				});
				const out = listen(channel);
				await out.until(() => frames.length > 0, 30_000);
				expect(frames.shift()?.type).toBe("HELLO");

				for (const payloadLength of [undefined, 0x0a0d, 0x0d0a1a, 0x8080, 0xff0a]) {
					const { ts, frame } = awkwardHeartbeat(payloadLength);
					channel.write(frame);
					await out.until(() => frames.length > 0, 15_000);
					expect(frames.shift()).toEqual({ type: "HEARTBEAT_ACK", ts });
				}

				channel.end();
				expect(await within(out.exited, 15_000, "the agent's exit")).toBe(0);
			} finally {
				channel.close();
			}
		},
	);

	// Without the agent, which CI's TypeScript job does not build: a program
	// that prints its arguments, then copies stdin to stdout, from a folder with
	// an awkward name. What PowerShell starts gets every argument as it was
	// given and every byte as it was sent, both ways.
	it.runIf(process.platform === "win32").each(shells)(
		"hands a program its arguments and every byte both ways through %s",
		{ timeout: 60_000 },
		async (shell) => {
			const dir = join(cacheDir, AWKWARD_NAME);
			mkdirSync(dir, { recursive: true });
			const program = join(dir, "echo.exe");
			try {
				linkSync(process.execPath, program);
			} catch {
				copyFileSync(process.execPath, program);
			}
			const echo =
				'process.stdout.write(JSON.stringify(process.argv.slice(1))+"\\n");process.stdin.pipe(process.stdout)';
			const given = [
				"--stdio",
				"two words",
				'a "quoted" one',
				"trailing\\",
				'back\\"slash',
				"%PATH% !x! $x `y` 'z' & | < > ^",
				"Zoë 日本",
				"",
			];
			const sent = Buffer.concat([
				Buffer.from("\r\n\n\r\u001a\u0000"),
				Buffer.from([...Array(256).keys()]),
				randomBytes(512 * 1024),
				Buffer.from([0x0d]),
			]);
			const channel = execChannel(
				localWindowsClient(shell),
				windowsLaunchCommand(program, ["-e", echo, "--", ...given]),
			);
			try {
				const out = listen(channel);
				const firstLine = (bytes: Buffer) => bytes.indexOf(0x0a);
				const head = await out.until((bytes) => firstLine(bytes) !== -1, 30_000);
				expect(JSON.parse(head.subarray(0, firstLine(head)).toString("utf8"))).toEqual(given);

				channel.end(sent);
				expect(await within(out.exited, 30_000, "the program's exit")).toBe(0);
				const echoed = out.bytes().subarray(firstLine(out.bytes()) + 1);
				expect(echoed.length).toBe(sent.length);
				expect(echoed.equals(sent)).toBe(true);
			} finally {
				channel.close();
			}
		},
	);
});

// ---------- Windows hosts whose shell prints and dawdles first (#749) ---------

describe("Windows hosts whose shell prints and takes its time before every command (#749)", () => {
	const programFilesAgent = join(
		process.env.ProgramFiles ?? "C:\\Program Files",
		"lasterm",
		"lasterm-agent.exe",
	);

	// The whole way, on this machine, through a shell that prints before every
	// command and takes a while: the platform detected, the agent deployed into
	// a profile with an awkward name, found again and hashed, then started, its
	// HELLO found behind what the profile printed, and frames both ways. Not
	// where an agent is installed in Program Files: the lookup would find it.
	it.runIf(process.platform === "win32" && !existsSync(programFilesAgent)).each([
		["powershell.exe", "exec"],
		["powershell.exe", "sftp"],
		["cmd.exe", "exec"],
		["powershell.exe -NoProfile", "exec"],
	] as const)(
		"detects, deploys, finds, hashes and starts the agent through %s over %s",
		{ timeout: 180_000 },
		async (shell, transport) => {
			const agentBinary = builtWindowsAgent();
			const bytes =
				agentBinary === null
					? Buffer.concat([Buffer.from([...Array(256).keys()]), randomBytes(64 * 1024)])
					: readFileSync(agentBinary);
			const local = writeCachedAgentBinary("windows", "x64", bytes);
			const profile = join(cacheDir, AWKWARD_NAME);
			mkdirSync(join(profile, "AppData", "Local"), { recursive: true });
			const client = localWindowsClient(
				shell,
				windowsProfileEnv(profile),
				transport === "sftp" ? localSftp() : undefined,
				// A DefaultShellCommandOption of -NoProfile loads no profile at all.
				shell === "powershell.exe -NoProfile" ? undefined : { sleepMs: 300 },
			);
			const options = makeOptions({
				sftp: transport === "sftp" ? { offered: true } : { offered: false, reason: "none here" },
			});
			const target = join(profile, "AppData", "Local", "lasterm", "lasterm-agent.exe");

			const deployed = await deployAgentIfNeeded(client, { os: null, arch: null }, options);

			expect(deployed).toMatchObject({ deployed: true, os: "windows" });
			expect(realpathSync.native(deployed.remotePath)).toBe(realpathSync.native(target));
			expect(readFileSync(target).equals(readFileSync(local))).toBe(true);
			if (transport === "sftp") expect(client.sftp).toHaveBeenCalled();
			else expect(client.sftp).not.toHaveBeenCalled();

			const host = { os: "windows", arch: deployed.arch } as const;
			const found = await deployAgentIfNeeded(client, host, options);

			expect(found).toMatchObject({
				deployed: false,
				remoteMatchesHubVersionCache: true,
				remotePath: deployed.remotePath,
			});
			expect(await getRemoteSha256(client, found.remotePath, "windows")).toBe(
				createHash("sha256").update(bytes).digest("hex"),
			);

			if (agentBinary === null) return;
			const channel = execChannel(client, windowsLaunchCommand(found.remotePath, ["--stdio"]));
			try {
				// What the hub does with an agent's stdio: HELLO sought first.
				const seeker = new HelloSeeker();
				const reader = new FrameReader();
				let prelude = -1;
				const frames: ProtocolMessage[] = [];
				channel.on("data", (chunk: Buffer) => {
					let bytes = chunk;
					if (prelude === -1) {
						const seek = seeker.push(chunk);
						if (!seek.found) return;
						prelude = seek.prelude;
						bytes = seek.frames;
					}
					for (const message of reader.push(bytes)) frames.push(message);
				});
				const out = listen(channel);
				await out.until(() => frames.length > 0, 60_000);
				expect(frames.shift()?.type).toBe("HELLO");
				expect(prelude).toBe(
					shell === "powershell.exe"
						? PROFILE_PRELUDE_BYTES.length
						: shell === "cmd.exe"
							? `${AUTORUN_PRELUDE}\r\n`.length
							: 0,
				);

				for (const payloadLength of [undefined, 0x0a0d, 0x8080]) {
					const { ts, frame } = awkwardHeartbeat(payloadLength);
					channel.write(frame);
					await out.until(() => frames.length > 0, 15_000);
					expect(frames.shift()).toEqual({ type: "HEARTBEAT_ACK", ts });
				}

				channel.end();
				expect(await within(out.exited, 15_000, "the agent's exit")).toBe(0);
			} finally {
				channel.close();
			}
		},
	);

	// The connection test asks with 5 s a command. A profile that alone takes
	// longer used to time every command out; the first command now measures the
	// shell's start-up, and the next ones get it on top of their bound.
	it.runIf(process.platform === "win32")(
		"detects the system through a PowerShell whose profile takes longer than a command's bound",
		{ timeout: 120_000 },
		async () => {
			const client = localWindowsClient("powershell.exe", windowsProfileEnv(cacheDir), undefined, {
				sleepMs: 5_000,
			});

			const read = await readRemoteSystem(client, 4_000);

			expect(read?.parsed?.os).toBe("windows");
			expect(read?.system).toMatch(/^Windows (AMD64|ARM64)$/);
			expect(shellStartAllowance(client)).toBeGreaterThanOrEqual(5_000);
		},
	);
});

describe("probeSftp", () => {
	it("says SFTP is offered once the subsystem answers, and closes it", async () => {
		const sftp = makeMockSftp();
		const client = makeSftpClient(sftp);
		expect(await probeSftp(client)).toEqual({ offered: true });
		expect(sftp.end).toHaveBeenCalledTimes(1);
	});

	it("says what refused it", async () => {
		const client = makeSftpClient(makeMockSftp(), new Error("Unable to start subsystem: sftp"));
		expect(await probeSftp(client)).toEqual({
			offered: false,
			reason: "Unable to start subsystem: sftp",
		});
	});

	it("takes no answer for a refusal, and closes a session that answers too late", async () => {
		const sftp = makeMockSftp();
		let late: (err: Error | undefined, session: SFTPWrapper) => void = () => {};
		const client = {
			sftp: vi.fn((cb: typeof late) => {
				late = cb;
			}),
		} as unknown as SshClient;
		// Its shell starts at once, as its first command measured.
		(client as unknown as { exec: unknown }).exec = slowShell(0, null).exec;
		await sshExec(client, "true");

		// The bound is 20 ms plus what the first command measured, a few ms on a
		// loaded runner: the message names the bound, whatever it came to.
		const support = await probeSftp(client, 20);
		expect(support.offered).toBe(false);
		expect(support.offered === false && support.reason).toMatch(/^no answer within \d+(\.\d+)? s$/);
		late(undefined, sftp);
		expect(sftp.end).toHaveBeenCalledTimes(1);
	});

	it("says why when the connection is already gone", async () => {
		const client = {
			sftp: vi.fn(() => {
				throw new Error("Not connected");
			}),
		} as unknown as SshClient;
		expect(await probeSftp(client)).toEqual({ offered: false, reason: "Not connected" });
	});

	// The server may run its SFTP through the account's shell, which takes its
	// start-up first: the probe's bound grows with it as every command's does
	// (#749), or a slow profile made the agent travel over exec beside a working
	// SFTP (#764).
	describe("the shell's start-up (#764)", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("waits past its bound for an SFTP behind a shell slower than that, as the first command measured it", async () => {
			const client = slowShell(12_000, 15_000);
			const probe = probeSftp(client);
			const first = sshExec(client, "uname -sm");

			await vi.advanceTimersByTimeAsync(15_000);

			await expect(first).resolves.toMatchObject({ exitCode: 0 });
			expect(await probe).toEqual({ offered: true });
		});

		it("gives up at its bound and the shell's start-up once the first command measured it", async () => {
			const client = slowShell(1_500, null);
			let answer: SftpSupport | undefined;
			const probe = probeSftp(client).then((support) => {
				answer = support;
				return support;
			});
			const first = sshExec(client, "uname -sm");
			await vi.advanceTimersByTimeAsync(1_500);
			await expect(first).resolves.toMatchObject({ exitCode: 0 });

			await vi.advanceTimersByTimeAsync(SFTP_PROBE_TIMEOUT_MS - 1);
			expect(answer).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);

			expect(await probe).toEqual({ offered: false, reason: "no answer within 11.5 s" });
		});

		it("waits up to the shell's ceiling while no command has measured it", async () => {
			const client = slowShell(0, null);
			let answer: SftpSupport | undefined;
			const probe = probeSftp(client).then((support) => {
				answer = support;
				return support;
			});

			await vi.advanceTimersByTimeAsync(SFTP_PROBE_TIMEOUT_MS + SHELL_START_CEILING_MS - 1);
			expect(answer).toBeUndefined();
			await vi.advanceTimersByTimeAsync(1);

			expect(await probe).toEqual({
				offered: false,
				reason: `no answer within ${(SFTP_PROBE_TIMEOUT_MS + SHELL_START_CEILING_MS) / 1000} s`,
			});
		});
	});
});

// ---------- deployAgentIfNeeded — Branch A: agent found ----------------------

describe("deployAgentIfNeeded — agent already present", () => {
	const existingPath = "/usr/local/bin/lasterm-agent";

	it("1. SHA256 match (local cache) → deployed: false, no upload", async () => {
		// Write a local binary and compute its real SHA256
		const binaryContent = Buffer.from("fake-binary-content");
		const localBinaryPath = writeCachedAgentBinary("linux", "x64", binaryContent);
		const localSha = getLocalSha256(localBinaryPath);
		if (!localSha) throw new Error("getLocalSha256 returned null for a freshly written file");

		// Remote returns the same hash
		const client = makeMockClient({
			"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
			[`sha256sum '${existingPath}'`]: {
				stdout: `${localSha}  ${existingPath}\n`,
				stderr: "",
				exitCode: 0,
			},
		});

		const result = await deployAgentIfNeeded(client, { os: "linux", arch: "x64" }, makeOptions());

		expect(result.deployed).toBe(false);
		expect(result.remoteMatchesHubVersionCache).toBe(true);
		expect(result.remotePath).toBe(existingPath);
	});

	it("2. SHA256 mismatch (local cache) → re-upload, onAgentUpdated called", async () => {
		writeCachedAgentBinary("linux", "x64", "local-binary");

		const sftp = makeMockSftp();
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const client = makeMockClient(
			{
				"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
				[`sha256sum '${existingPath}'`]: {
					stdout: `${REMOTE_SHA_DIFFERENT}  ${existingPath}\n`,
					stderr: "",
					exitCode: 0,
				},
			},
			sftpImpl,
		);

		const onAgentUpdated = vi.fn();
		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ onAgentUpdated }),
		);

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(result.remotePath).toBe(existingPath);
		expect(onAgentUpdated).toHaveBeenCalledWith("host-1");
		expect(sftp.fastPut).toHaveBeenCalled();
	});

	it("2b. SHA256 mismatch (local cache) → re-upload, onAgentPinned called with local SHA", async () => {
		const localBinaryPath = writeCachedAgentBinary("linux", "x64", "local-binary");
		const localSha = getLocalSha256(localBinaryPath);
		if (!localSha) throw new Error("getLocalSha256 returned null");

		const sftp = makeMockSftp();
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const client = makeMockClient(
			{
				"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
				[`sha256sum '${existingPath}'`]: {
					stdout: `${REMOTE_SHA_DIFFERENT}  ${existingPath}\n`,
					stderr: "",
					exitCode: 0,
				},
			},
			sftpImpl,
		);

		const onAgentPinned = vi.fn();
		await deployAgentIfNeeded(client, { os: "linux", arch: "x64" }, makeOptions({ onAgentPinned }));

		// Pin must be updated to the local (trusted) binary's hash after re-upload
		expect(onAgentPinned).toHaveBeenCalledWith("host-1", localSha);
	});

	it("3. remoteSha null + local binary → re-upload (precaution)", async () => {
		writeCachedAgentBinary("linux", "x64", "local-binary");

		const sftp = makeMockSftp();
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const client = makeMockClient(
			{
				"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
				[`sha256sum '${existingPath}'`]: { stdout: "", stderr: "error", exitCode: 1 },
			},
			sftpImpl,
		);

		const onAgentUpdated = vi.fn();
		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ onAgentUpdated }),
		);

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(sftp.fastPut).toHaveBeenCalled();
	});

	// #555: the remote daemon runs from existingPath, and Linux will not open a
	// running executable for writing. Written in place, the upgrade failed with
	// SFTP's "Failure" and the host could not be reached at all.
	it("3b. replaces the binary a running daemon executes from (ETXTBSY)", async () => {
		const localBinaryPath = writeCachedAgentBinary("linux", "x64", "local-binary");
		const localSha = getLocalSha256(localBinaryPath);
		if (!localSha) throw new Error("getLocalSha256 returned null");

		const files = new Map([[existingPath, { content: "running 0.11.0", mode: 0o755 }]]);
		const sftp = makeMockSftp({ files, busy: new Set([existingPath]) });
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const client = makeMockClient(
			{
				"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
				[`sha256sum '${existingPath}'`]: {
					stdout: `${REMOTE_SHA_DIFFERENT}  ${existingPath}\n`,
					stderr: "",
					exitCode: 0,
				},
			},
			sftpImpl,
		);

		const onAgentUpdated = vi.fn();
		const onAgentPinned = vi.fn();
		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ onAgentUpdated, onAgentPinned }),
		);

		expect(result.deployed).toBe(true);
		expect(result.remotePath).toBe(existingPath);
		// The trusted local copy now sits at the path, whole and executable; the
		// running daemon keeps the inode it started from.
		expect([...files]).toEqual([[existingPath, { content: localBinaryPath, mode: 0o755 }]]);
		expect(onAgentUpdated).toHaveBeenCalledWith("host-1");
		expect(onAgentPinned).toHaveBeenCalledWith("host-1", localSha);
	});

	// Nobody can be asked from in here: this runs over a live SSH connection, and
	// a connection held open while a person thinks is what #444 is about. What is
	// known is handed back, and the caller closes, asks, and comes again.
	it("4. No local binary, no pin → hands the decision back with what it saw", async () => {
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions(),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AgentBinaryDecisionNeeded);
		const decision = error as AgentBinaryDecisionNeeded;
		expect(decision.hostId).toBe("host-1");
		expect(decision.hostname).toBe("myhost.example.com");
		expect(decision.remotePath).toBe(existingPath);
		expect(decision.remoteSha256).toBe(REMOTE_SHA_DIFFERENT);
		expect(decision.os).toBe("linux");
		expect(decision.arch).toBe("x64");
		expect(decision.mismatch).toBe(false);
		expect(decision.pinnedSha256).toBeUndefined();
	});

	it("5. No local binary, pin matches remote → nothing to decide, deployed: false", async () => {
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ pinnedSha256: REMOTE_SHA_DIFFERENT }),
		);

		expect(result.deployed).toBe(false);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
	});

	it("6. No local binary, pin mismatches → says so in the decision it hands back", async () => {
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ pinnedSha256: "sha256-of-something-else" }),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AgentBinaryDecisionNeeded);
		expect((error as AgentBinaryDecisionNeeded).mismatch).toBe(true);
		expect((error as AgentBinaryDecisionNeeded).pinnedSha256).toBe("sha256-of-something-else");
	});

	it("7. No local binary, sessionTrusted matches remote → skip, deployed: false", async () => {
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ sessionTrustedSha256: REMOTE_SHA_DIFFERENT }),
		);

		expect(result.deployed).toBe(false);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
	});

	// The answer comes back as an approved hash, and the attempt that resumes
	// takes it — the trust itself is recorded by whoever asked.
	it("8. Resumed with the hash that was approved → proceeds", async () => {
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ approvedSha256: REMOTE_SHA_DIFFERENT }),
		);

		expect(result.deployed).toBe(false);
		expect(result.remotePath).toBe(existingPath);
	});

	// The person answered about the hash they were shown. A remote binary that
	// changed while the question was open was never the one anybody approved.
	it("9. Resumed, but the remote binary changed → asks again about what is there", async () => {
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ approvedSha256: "sha256-of-what-was-shown" }),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AgentBinaryDecisionNeeded);
		expect((error as AgentBinaryDecisionNeeded).remoteSha256).toBe(REMOTE_SHA_DIFFERENT);
	});

	it("12. Agent not found + local binary → upload, deployed: true", async () => {
		const binaryName = agentCacheName("linux", "x64");
		writeCachedAgentBinary("linux", "x64");

		const files = new Map<string, RemoteFile>();
		const sftp = makeMockSftp({ files });
		const client = makeAgentNotFoundClient(sftp);

		const result = await deployAgentIfNeeded(client, { os: "linux", arch: "x64" }, makeOptions());

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(result.remotePath).toBe("/home/user/.local/bin/lasterm-agent");
		expect(result.os).toBe("linux");
		expect(result.arch).toBe("x64");
		// A fresh deploy goes the same way as a replacement: beside, then renamed.
		expect(uploadedTo(sftp)).toMatch(/^\/home\/user\/\.local\/bin\/\.lasterm-agent\..+\.partial$/);
		expect([...files]).toEqual([
			["/home/user/.local/bin/lasterm-agent", { content: join(cacheDir, binaryName), mode: 0o755 }],
		]);
	});

	it("fetches a versioned binary on SEA cache miss, then deploys it", async () => {
		const binaryName = agentCacheName("linux", "x64", TEST_HUB_VERSION);
		const files = new Map<string, RemoteFile>();
		const sftp = makeMockSftp({ files });
		const client = makeAgentNotFoundClient(sftp);
		const fetcher = vi.fn(async (options: FetchAgentBinaryOptions): Promise<string> => {
			const fetchedPath = join(options.cacheDir, binaryName);
			writeFileSync(fetchedPath, "fetched-binary-content");
			return fetchedPath;
		});

		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({
				detectSea: () => true,
				fetchAgentBinary: fetcher,
				hubVersion: TEST_HUB_VERSION,
			}),
		);

		expect(fetcher).toHaveBeenCalledWith({
			os: "linux",
			arch: "x64",
			version: TEST_HUB_VERSION,
			cacheDir,
		});
		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect([...files]).toEqual([
			["/home/user/.local/bin/lasterm-agent", { content: join(cacheDir, binaryName), mode: 0o755 }],
		]);
	});

	it("does not fetch on source runs and keeps the existing not-available error", async () => {
		const sftp = makeMockSftp();
		const client = makeAgentNotFoundClient(sftp);
		const fetcher = vi.fn(async (): Promise<string> => {
			throw new Error("fetch should not run");
		});

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({
				detectSea: () => false,
				fetchAgentBinary: fetcher,
			}),
		).catch((e: unknown) => e);

		expect(fetcher).not.toHaveBeenCalled();
		expect(error).toBeInstanceOf(DeployError);
		expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
		expect((error as Error).message).toBe(
			`Agent binary not found in cache: ${join(cacheDir, agentCacheName("linux", "x64"))}. Build it or copy it to the binary cache (see docs/SPEC.md §3.5).`,
		);
	});

	it("maps FetchError to AGENT_NOT_AVAILABLE with the actionable fetch message", async () => {
		const sftp = makeMockSftp();
		const client = makeAgentNotFoundClient(sftp);
		const fetchMessage =
			"Download https://example.invalid/lasterm-agent and rename it into the binary cache.";
		const fetcher = vi.fn(async (): Promise<string> => {
			throw new FetchError("PRIVATE_OR_FORBIDDEN", fetchMessage);
		});

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({
				detectSea: () => true,
				fetchAgentBinary: fetcher,
				hubVersion: TEST_HUB_VERSION,
			}),
		).catch((e: unknown) => e);

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(DeployError);
		expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
		expect((error as Error).message).toBe(fetchMessage);
	});

	it("refuses a path-traversing hub version (cannot deploy a binary outside the cache)", async () => {
		// `cache` is a subdir; the malicious version resolves the lookup OUT of it.
		const cache = join(cacheDir, "cache");
		mkdirSync(cache);
		const maliciousVersion = "1.0.0/../../evil";
		// Plant a binary at the exact path the lookup would resolve to (cacheDir/evil,
		// outside `cache`). Without the strict-semver guard this file would be
		// returned as a "trusted" cache binary and deployed.
		const escaped = join(cache, `lasterm-agent-linux-x64-${maliciousVersion}`);
		writeFileSync(escaped, "evil-binary");

		const sftp = makeMockSftp();
		const client = makeAgentNotFoundClient(sftp);
		const fetcher = vi.fn(async (): Promise<string> => {
			throw new Error("fetch should not run");
		});

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({
				binaryCache: cache,
				detectSea: () => true,
				fetchAgentBinary: fetcher,
				hubVersion: maliciousVersion,
			}),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DeployError);
		expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
		expect(fetcher).not.toHaveBeenCalled();
		// The planted out-of-cache binary was never deployed.
		expect(sftp.fastPut).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"does not deploy a cached binary from a symlinked (untrusted) cache dir",
		async () => {
			const realCache = join(cacheDir, "real");
			mkdirSync(realCache, { recursive: true, mode: 0o700 });
			// A legit-named cached binary, reachable via a SYMLINKED cache path. A cache
			// hit there bypasses the fetch path's dir hardening, so it must not deploy.
			writeFileSync(join(realCache, agentCacheName("linux", "x64", TEST_HUB_VERSION)), "planted");
			const linkCache = join(cacheDir, "link");
			symlinkSync(realCache, linkCache);

			const sftp = makeMockSftp();
			const client = makeAgentNotFoundClient(sftp);
			const fetcher = vi.fn(async (): Promise<string> => {
				throw new Error("fetch should not run");
			});

			const error = await deployAgentIfNeeded(
				client,
				{ os: "linux", arch: "x64" },
				makeOptions({
					binaryCache: linkCache,
					detectSea: () => false,
					fetchAgentBinary: fetcher,
					hubVersion: TEST_HUB_VERSION,
				}),
			).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(DeployError);
			expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
			expect(fetcher).not.toHaveBeenCalled();
			expect(sftp.fastPut).not.toHaveBeenCalled();
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not deploy a cache entry that is a symlink, even in a secure cache dir",
		async () => {
			// cacheDir is a normal secure dir (real, owned, 0700), but the cache-named
			// entry is a SYMLINK, not a regular file — it must not be trusted/deployed.
			const realTarget = join(cacheDir, "elsewhere-binary");
			writeFileSync(realTarget, "planted");
			const symlinkBinary = join(cacheDir, agentCacheName("linux", "x64", TEST_HUB_VERSION));
			symlinkSync(realTarget, symlinkBinary);

			const sftp = makeMockSftp();
			const client = makeAgentNotFoundClient(sftp);
			const fetcher = vi.fn(async (): Promise<string> => {
				throw new Error("fetch should not run");
			});

			const error = await deployAgentIfNeeded(
				client,
				{ os: "linux", arch: "x64" },
				makeOptions({
					detectSea: () => false,
					fetchAgentBinary: fetcher,
					hubVersion: TEST_HUB_VERSION,
				}),
			).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(DeployError);
			expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
			expect(sftp.fastPut).not.toHaveBeenCalled();
		},
	);

	it("13. Agent not found + no local binary → throws AGENT_NOT_AVAILABLE", async () => {
		// cacheDir is empty — no binary
		const sftp = makeMockSftp();
		const client = makeAgentNotFoundClient(sftp);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions(),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DeployError);
		expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
	});

	it("E7 deploys binary when os/arch auto-detected (host record has nulls)", async () => {
		writeCachedAgentBinary("linux", "arm64");

		const sftp = makeMockSftp();
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const client = makeMockClient(
			{
				"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
				'test -x "$HOME/.local/bin/lasterm-agent" && echo "$HOME/.local/bin/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				'test -x "/usr/local/bin/lasterm-agent" && echo "/usr/local/bin/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				'test -x "/usr/bin/lasterm-agent" && echo "/usr/bin/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				'test -x "/opt/lasterm/lasterm-agent" && echo "/opt/lasterm/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				"uname -sm": { stdout: "Linux aarch64\n", stderr: "", exitCode: 0 },
				"echo $HOME": { stdout: "/home/user\n", stderr: "", exitCode: 0 },
			},
			sftpImpl,
		);

		const result = await deployAgentIfNeeded(client, { os: null, arch: null }, makeOptions());
		const commands = vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd);
		expect(commands[0]).toBe("uname -sm");
		expect(commands.filter((cmd) => cmd === "uname -sm")).toHaveLength(1);
		expect(commands[1]).toBe("which lasterm-agent");

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(result.os).toBe("linux");
		expect(result.arch).toBe("arm64");
	});

	it("E7 throws when OS/arch cannot be detected and they are unknown", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			'test -x "$HOME/.local/bin/lasterm-agent" && echo "$HOME/.local/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/usr/local/bin/lasterm-agent" && echo "/usr/local/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/usr/bin/lasterm-agent" && echo "/usr/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/opt/lasterm/lasterm-agent" && echo "/opt/lasterm/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			"uname -sm": { stdout: "", stderr: "", exitCode: 1 },
			[ECHO_ARCH]: { stdout: "", stderr: "", exitCode: 1 },
		});

		await expect(
			deployAgentIfNeeded(client, { os: null, arch: null }, makeOptions()),
		).rejects.toThrow("Cannot detect remote OS/arch");
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
			"uname -sm",
			ECHO_ARCH,
			POWERSHELL_ARCH,
		]);
		expect(client.sftp).not.toHaveBeenCalled();
	});

	it("names a system no agent is built for instead of calling it undetectable (#401)", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			'test -x "$HOME/.local/bin/lasterm-agent" && echo "$HOME/.local/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/usr/local/bin/lasterm-agent" && echo "/usr/local/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/usr/bin/lasterm-agent" && echo "/usr/bin/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			'test -x "/opt/lasterm/lasterm-agent" && echo "/opt/lasterm/lasterm-agent"': {
				stdout: "",
				stderr: "",
				exitCode: 1,
			},
			"uname -sm": { stdout: "Linux armv7l\n", stderr: "", exitCode: 0 },
			[ECHO_ARCH]: { stdout: "", stderr: "", exitCode: 1 },
		});

		await expect(
			deployAgentIfNeeded(client, { os: null, arch: null }, makeOptions()),
		).rejects.toThrow("No Lasterm agent is built for this system (Linux armv7l)");
	});

	it.each([
		["E1 fresh Windows install", "C:\\Users\\u\\AppData\\Local"],
		["E2 non-ASCII profile", "C:\\Users\\Rémi\\AppData\\Local"],
		["E8 drive-root folder", "C:\\"],
		["ASCII apostrophe profile", "C:\\Users\\O'Brien\\AppData\\Local"],
		...["‘", "’", "‚", "‛", "[", "]", "`", "%", "!", "$", "^", "&"].map((character) => [
			`literal profile ${character}`,
			`C:\\Users\\a${character}b\\AppData\\Local`,
		]),
		// Accepted since #714: nothing expands them any more.
		["profile named like a variable", "C:\\Users\\%USERNAME%!x!\\AppData\\Local"],
		["folder redirected to a share", "\\\\server\\share\\u\\AppData\\Local"],
		["share root", "\\\\server\\share\\"],
	])("%s", async (_edge, folder) => {
		const local = writeCachedAgentBinary("windows", "x64");
		const sftp = makeMockSftp();
		const client = makeMockClient(
			{
				[folderCommand("LocalApplicationData")]: folderOutput(folder),
				[ENCODED_POWERSHELL]: { stdout: "", stderr: "", exitCode: 0 },
			},
			(cb) => cb(undefined, sftp),
		);
		const result = await deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions());
		const path = `${folder.endsWith("\\") ? folder : `${folder}\\`}lasterm\\lasterm-agent.exe`;
		const dir = path.slice(0, path.lastIndexOf("\\"));
		expect(result.remotePath).toBe(path);
		expect(result.deployed).toBe(true);
		expect(sftp.mkdir).toHaveBeenCalledExactlyOnceWith(dir, expect.any(Function));
		const temp = uploadedTo(sftp);
		expect(temp.startsWith(`${dir}\\.lasterm-agent.exe.`)).toBe(true);
		expect(sftp.fastPut).toHaveBeenCalledExactlyOnceWith(local, temp, expect.any(Function));
		const commands = vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd);
		expect(commands.slice(0, 2)).toEqual([
			findAgentCommand(),
			folderCommand("LocalApplicationData"),
		]);
		expect(commands).toHaveLength(3);
		expect(replacePaths(commands[2] ?? "")).toMatchObject({ target: path, temp });
	});

	it.each([
		["non-zero exit", { stdout: "", stderr: " denied ", exitCode: 2 }, "exit 2: denied"] as const,
		...[
			"",
			"YQ",
			"YQ==junk",
			"____",
			"//8=",
			"YR==",
			"YQ==\nYQ==",
			Buffer.from("C:\\u").toString("base64").replace(/=+$/, ""),
			Buffer.from("C:\\ÿÿ").toString("base64").replaceAll("/", "_").replaceAll("+", "-"),
			"QzpcdR==",
			`${Buffer.from("C:\\u").toString("base64")}#`,
			Buffer.concat([Buffer.from("C:\\"), Buffer.from([0xff])]).toString("base64"),
		].map(
			(stdout) =>
				[
					`invalid encoding ${stdout}`,
					{ stdout: reply(stdout), stderr: "", exitCode: 0 },
					"unexpected output",
				] as const,
		),
		...["", "C:\\a\nb", "C:\\a\u007fb"].map(
			(path) =>
				[`invalid path ${JSON.stringify(path)}`, folderOutput(path), "unexpected output"] as const,
		),
		...(
			[
				['C:\\Users\\a"[\\AppData\\Local', "contains a double quote"],
				["%LOCALAPPDATA%", "not a drive or UNC path with backslashes"],
				['C:\\a"b', "contains a double quote"],
				["C:/Users/u/AppData/Local", "not a drive or UNC path with backslashes"],
				["Users\\u", "not a drive or UNC path with backslashes"],
				["relative", "not a drive or UNC path with backslashes"],
				['relative%"', "contains a double quote"],
				['relative"', "contains a double quote"],
				['C:\\Users\\a%"\\AppData\\Local', "contains a double quote"],
				['\\\\server\\share\\a"b', "contains a double quote"],
				["\\\\server", "not a drive or UNC path with backslashes"],
				["\\\\server\\", "not a drive or UNC path with backslashes"],
				["\\\\\\server\\share", "not a drive or UNC path with backslashes"],
				["//server/share/u", "not a drive or UNC path with backslashes"],
				["\\\\?\\C:\\Users\\u", "not a drive or UNC path with backslashes"],
				["\\\\.\\C:\\Users\\u", "not a drive or UNC path with backslashes"],
			] as const
		).map(
			([path, why]) =>
				[
					`unsupported path ${path}`,
					folderOutput(path),
					`unsupported path ${path} (${why})`,
				] as const,
		),
		[
			"an answer without the marker",
			{ stdout: Buffer.from("C:\\u").toString("base64"), stderr: "", exitCode: 0 },
			"unexpected output",
		] as const,
	])("E3 rejects %s before SFTP", async (_name, output, reason) => {
		writeCachedAgentBinary("windows", "x64");
		const client = makeMockClient({ [folderCommand("LocalApplicationData")]: output });
		const error = await deployAgentIfNeeded(
			client,
			{ os: "windows", arch: "x64" },
			makeOptions(),
		).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			`Could not determine the LocalAppData directory of the Windows host: ${reason}`,
		);
		expect(client.sftp).not.toHaveBeenCalled();
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
			findAgentCommand(),
			folderCommand("LocalApplicationData"),
		]);
	});

	it("finds LocalAppData behind what the profile printed (#749)", async () => {
		writeCachedAgentBinary("windows", "x64");
		const folder = "C:\\Users\\Zoë\\AppData\\Local";
		const sftp = makeMockSftp();
		const client = makeMockClient(
			{
				[folderCommand("LocalApplicationData")]: {
					stdout: reply(base64Lines(folder), PROFILE_NOISE),
					stderr: "",
					exitCode: 0,
				},
				[ENCODED_POWERSHELL]: { stdout: PROFILE_NOISE, stderr: "", exitCode: 0 },
			},
			(cb) => cb(undefined, sftp),
		);

		const result = await deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions());

		expect(result).toMatchObject({
			deployed: true,
			remotePath: `${folder}\\lasterm\\lasterm-agent.exe`,
		});
	});

	it("deploys when the known-folder search fails, looking up LocalAppData once", async () => {
		const local = writeCachedAgentBinary("windows", "x64");
		const folder = "C:\\Users\\u\\AppData\\Local";
		const sftp = makeMockSftp();
		const client = makeMockClient(
			{
				[findAgentCommand()]: { stdout: "", stderr: "boom", exitCode: 1 },
				[folderCommand("LocalApplicationData")]: folderOutput(folder),
				[ENCODED_POWERSHELL]: { stdout: "", stderr: "", exitCode: 0 },
			},
			(cb) => cb(undefined, sftp),
		);

		const result = await deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions());

		expect(result.remotePath).toBe(`${folder}\\lasterm\\lasterm-agent.exe`);
		expect(sftp.fastPut).toHaveBeenCalledExactlyOnceWith(
			local,
			expect.stringMatching(/\\\.lasterm-agent\.exe\.[0-9a-f]{16}\.partial$/),
			expect.any(Function),
		);
		const commands = vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd);
		expect(commands.filter((cmd) => cmd === folderCommand("LocalApplicationData"))).toHaveLength(1);
	});

	it("E3 preserves an sshExec rejection before SFTP", async () => {
		writeCachedAgentBinary("windows", "x64");
		const client = makeMockClient({});
		vi.mocked(client.exec).mockImplementation((_cmd, cb) => {
			(cb as (err: Error) => void)(new Error("Connection reset"));
			return client;
		});
		await expect(
			deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions()),
		).rejects.toThrow("LocalAppData directory of the Windows host: Connection reset");
		expect(client.sftp).not.toHaveBeenCalled();
	});

	it("E3 preserves an sshExec timeout before SFTP", async () => {
		writeCachedAgentBinary("windows", "x64");
		const client = makeMockClient({});
		vi.mocked(client.exec).mockImplementation((cmd, cb) => {
			if (cmd === folderCommand("LocalApplicationData")) {
				(cb as SshExecCallback)(undefined, new MockSshStream());
			} else {
				(cb as (err: Error) => void)(new Error("unavailable"));
			}
			return client;
		});
		vi.useFakeTimers();
		try {
			const rejection = expect(
				deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions()),
			).rejects.toThrow(
				`LocalAppData directory of the Windows host: SSH exec timed out after 40000ms: ${folderCommand("LocalApplicationData")}`,
			);
			await vi.advanceTimersByTimeAsync(45000);
			await rejection;
			expect(client.sftp).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["Rémi", "O'Brien", "a`b[1]\\O’Brien'x", "%USERNAME% !x! $y", "\\\\server\\share\\u"])(
		"E4 hashes the agent found in a known folder for %s",
		async (profile) => {
			const path = `${profile.startsWith("\\\\") ? profile : `C:\\Users\\${profile}`}\\AppData\\Local\\lasterm\\lasterm-agent.exe`;
			const hash = "a".repeat(64);
			const encodedPath = Buffer.from(path, "utf8").toString("base64");
			const script = expectedHashScript(encodedPath);
			const hashCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
			const client = makeMockClient({
				[findAgentCommand()]: folderOutput(path),
				[hashCommand]: { stdout: reply(hash, PROFILE_NOISE), stderr: "", exitCode: 0 },
			});
			const result = await deployAgentIfNeeded(
				client,
				{ os: "windows", arch: "x64" },
				makeOptions({ pinnedSha256: hash }),
			);
			expect(result.remotePath).toBe(path);
			expect(client.sftp).not.toHaveBeenCalled();
			expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
				findAgentCommand(),
				hashCommand,
			]);
		},
	);
});

// ---------- getBinaryCacheDir ------------------------------------------------

describe("getBinaryCacheDir", () => {
	it.skipIf(process.platform === "win32")("returns path under XDG_STATE_HOME when set", () => {
		const orig = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = "/custom/state";
		try {
			const result = getBinaryCacheDir();
			expect(result).toBe("/custom/state/lasterm/binaries");
		} finally {
			if (orig === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = orig;
		}
	});

	it("returns path under ~/.local/state when XDG_STATE_HOME is not set", () => {
		const orig = process.env.XDG_STATE_HOME;
		delete process.env.XDG_STATE_HOME;
		try {
			const result = getBinaryCacheDir();
			expect(result).toMatch(/lasterm[/\\]binaries$/);
			if (process.platform !== "win32") {
				expect(result).toContain(".local/state");
			}
		} finally {
			if (orig !== undefined) process.env.XDG_STATE_HOME = orig;
		}
	});
});

// ---------- getRemoteSha256 --------------------------------------------------

describe("getRemoteSha256", () => {
	it("parses sha256sum output on Linux", async () => {
		const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		const client = makeMockClient({
			"sha256sum '/usr/local/bin/lasterm-agent'": {
				stdout: `${hash}  /usr/local/bin/lasterm-agent\n`,
				stderr: "",
				exitCode: 0,
			},
		});
		const result = await getRemoteSha256(client, "/usr/local/bin/lasterm-agent", "linux");
		expect(result).toBe(hash);
	});

	it("parses shasum -a 256 output on macOS (darwin)", async () => {
		const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		const client = makeMockClient({
			"shasum -a 256 '/usr/local/bin/lasterm-agent'": {
				stdout: `${hash}  /usr/local/bin/lasterm-agent\n`,
				stderr: "",
				exitCode: 0,
			},
		});
		const result = await getRemoteSha256(client, "/usr/local/bin/lasterm-agent", "darwin");
		expect(result).toBe(hash);
	});

	it("passes the Windows path as Base64 data inside an encoded literal-path hash script", async () => {
		const path = "C:\\Users\\a`b[1]\\O’Brien'x\\lasterm\\lasterm-agent.exe";
		const encodedPath = Buffer.from(path, "utf8").toString("base64");
		const script = expectedHashScript(encodedPath);
		const prefix = "powershell -NoProfile -NonInteractive -EncodedCommand ";
		const command = `${prefix}${Buffer.from(script, "utf16le").toString("base64")}`;
		const hash = "abcdef01".repeat(8);
		const client = makeMockClient({
			[command]: {
				stdout: reply(`${hash.toUpperCase()}\r\n`, PROFILE_NOISE),
				stderr: "",
				exitCode: 0,
			},
		});
		expect(await getRemoteSha256(client, path, "windows")).toBe(hash);
		const sent = vi.mocked(client.exec).mock.calls[0]?.[0] ?? "";
		expect(sent).toBe(command);
		const decodedScript = Buffer.from(sent.slice(prefix.length), "base64").toString("utf16le");
		expect(decodedScript).toBe(script);
		const inner = decodedScript.match(/FromBase64String\('([^']*)'\)/)?.[1] ?? "";
		expect(Buffer.from(inner, "base64").toString("utf8")).toBe(path);
	});

	it("returns null when command exits with non-zero", async () => {
		const client = makeMockClient({
			'sha256sum "/missing/path"': { stdout: "", stderr: "No such file", exitCode: 1 },
		});
		const result = await getRemoteSha256(client, "/missing/path", "linux");
		expect(result).toBeNull();
	});

	it("returns null when sshExec throws", async () => {
		const throwingClient = {
			exec: vi.fn((_cmd: string, cb: (err: Error) => void) => {
				cb(new Error("Connection reset"));
			}),
			sftp: vi.fn(),
		} as unknown as SshClient;
		const result = await getRemoteSha256(throwingClient, "/some/path", "linux");
		expect(result).toBeNull();
	});
});

// ---------- getLocalSha256 ---------------------------------------------------

describe("getLocalSha256", () => {
	it("computes SHA256 of a file", () => {
		const filePath = join(cacheDir, "test-file.bin");
		writeFileSync(filePath, "hello lasterm");
		// sha256("hello lasterm") = known value
		const result = getLocalSha256(filePath);
		expect(result).toMatch(/^[a-f0-9]{64}$/);
		// Verify determinism: same content → same hash
		expect(result).toBe(getLocalSha256(filePath));
	});

	it("returns null for missing file", () => {
		const result = getLocalSha256("/nonexistent/path/to/file");
		expect(result).toBeNull();
	});
});

// ---------- deploy + verify integration ---------------------------------------

describe("deploy + verify integration", () => {
	it("deploys from cache, then skips on second connect (SHA256 match)", async () => {
		// First connect: agent NOT found on remote, local binary exists → upload
		const binaryContent = Buffer.from("fake-binary-content-for-integration");
		const localBinaryPath = writeCachedAgentBinary("linux", "x64", binaryContent);

		const sftp = makeMockSftp();
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const clientFirst = makeMockClient(
			{
				"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
				'test -x "$HOME/.local/bin/lasterm-agent" && echo "$HOME/.local/bin/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				'test -x "/usr/local/bin/lasterm-agent" && echo "/usr/local/bin/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				'test -x "/usr/bin/lasterm-agent" && echo "/usr/bin/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				'test -x "/opt/lasterm/lasterm-agent" && echo "/opt/lasterm/lasterm-agent"': {
					stdout: "",
					stderr: "",
					exitCode: 1,
				},
				"echo $HOME": { stdout: "/home/user\n", stderr: "", exitCode: 0 },
			},
			sftpImpl,
		);

		const resultFirst = await deployAgentIfNeeded(
			clientFirst,
			{ os: "linux", arch: "x64" },
			makeOptions(),
		);

		expect(resultFirst.deployed).toBe(true);
		expect(resultFirst.remoteMatchesHubVersionCache).toBe(false);
		expect(resultFirst.remotePath).toBe("/home/user/.local/bin/lasterm-agent");
		expect(sftp.fastPut).toHaveBeenCalledTimes(1);

		// Second connect: agent IS found at deployed path, SHA256 matches local cache
		const deployedPath = resultFirst.remotePath;
		const localSha = getLocalSha256(localBinaryPath);
		if (!localSha) throw new Error("getLocalSha256 returned null");

		const clientSecond = makeMockClient({
			"which lasterm-agent": { stdout: `${deployedPath}\n`, stderr: "", exitCode: 0 },
			[`sha256sum '${deployedPath}'`]: {
				stdout: `${localSha}  ${deployedPath}\n`,
				stderr: "",
				exitCode: 0,
			},
		});

		const resultSecond = await deployAgentIfNeeded(
			clientSecond,
			{ os: "linux", arch: "x64" },
			makeOptions(),
		);

		expect(resultSecond.deployed).toBe(false);
		expect(resultSecond.remoteMatchesHubVersionCache).toBe(true);
		expect(resultSecond.remotePath).toBe(deployedPath);
	});

	it("re-uploads when remote SHA256 differs from local cache", async () => {
		// Local binary exists; remote agent at existingPath has a different hash
		writeCachedAgentBinary("linux", "x64", "local-binary-content");

		const sftp = makeMockSftp();
		const sftpImpl = (cb: (err: Error | undefined, sftp: SFTPWrapper) => void): void => {
			cb(undefined, sftp);
		};
		const existingPath = "/usr/local/bin/lasterm-agent";
		const client = makeMockClient(
			{
				"which lasterm-agent": { stdout: `${existingPath}\n`, stderr: "", exitCode: 0 },
				[`sha256sum '${existingPath}'`]: {
					stdout: `${REMOTE_SHA_DIFFERENT}  ${existingPath}\n`,
					stderr: "",
					exitCode: 0,
				},
			},
			sftpImpl,
		);

		const onAgentUpdated = vi.fn();
		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ onAgentUpdated }),
		);

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(sftp.fastPut).toHaveBeenCalledTimes(1);
		expect(onAgentUpdated).toHaveBeenCalledWith("host-1");
	});

	it("asks for a decision on first use (no pin, no cache)", async () => {
		const existingPath = "/usr/local/bin/lasterm-agent";
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions(),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AgentBinaryDecisionNeeded);
		expect((error as AgentBinaryDecisionNeeded).remoteSha256).toBe(REMOTE_SHA_DIFFERENT);
		expect((error as AgentBinaryDecisionNeeded).mismatch).toBe(false);
	});

	it("skips prompt when session-trusted SHA matches remote", async () => {
		// Remote agent found with hash REMOTE_SHA_DIFFERENT;
		// sessionTrustedSha256 matches → no prompt needed
		const existingPath = "/usr/local/bin/lasterm-agent";
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		// Nothing to decide: a session-trusted hash is an answer already given
		const result = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ sessionTrustedSha256: REMOTE_SHA_DIFFERENT }),
		);

		expect(result.deployed).toBe(false);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(result.remotePath).toBe(existingPath);
	});

	it("says the pin disagrees when the remote hash is not the pinned one", async () => {
		const existingPath = "/usr/local/bin/lasterm-agent";
		const client = makeAgentFoundClient(existingPath, REMOTE_SHA_DIFFERENT);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions({ pinnedSha256: LOCAL_SHA }),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(AgentBinaryDecisionNeeded);
		expect((error as AgentBinaryDecisionNeeded).mismatch).toBe(true);
		expect((error as AgentBinaryDecisionNeeded).pinnedSha256).toBe(LOCAL_SHA);
	});

	it("throws AGENT_NOT_AVAILABLE when no agent on remote and no local binary", async () => {
		// All remote lookups fail, cacheDir is empty — no binary to upload
		const sftp = makeMockSftp();
		const client = makeAgentNotFoundClient(sftp);

		const error = await deployAgentIfNeeded(
			client,
			{ os: "linux", arch: "x64" },
			makeOptions(),
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DeployError);
		expect((error as DeployError).code).toBe("AGENT_NOT_AVAILABLE");
	});
});
