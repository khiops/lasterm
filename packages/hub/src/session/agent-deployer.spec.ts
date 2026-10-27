import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import type { ClientChannel, SFTPWrapper, Client as SshClient } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUB_VERSION } from "../build-version.js";
import { makeTempDir, removeTempDir } from "../temp-dir.fixture.js";
import type { DeployOptions } from "./agent-deployer.js";
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
	STALE_UPLOAD_MINUTES,
	uploadAgentBinary,
	windowsUploadCommand,
} from "./agent-deployer.js";
import { type FetchAgentBinaryOptions, FetchError } from "./agent-fetch.js";

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
	return `powershell -NoProfile -NonInteractive -Command "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('${folder}')))"`;
}

function folderOutput(path: string): ExecResult {
	return { stdout: Buffer.from(path, "utf8").toString("base64"), stderr: "", exitCode: 0 };
}

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
		"[BitConverter]::ToString($h).Replace('-','').ToLower()"
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
			"where lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
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

	it("returns path when where succeeds (Windows)", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			"where lasterm-agent": {
				stdout: "C:\\Users\\user\\AppData\\Local\\lasterm\\lasterm-agent.exe\n",
				stderr: "",
				exitCode: 0,
			},
		});
		const result = await checkRemoteAgent(client, "windows");
		expect(result).toBe("C:\\Users\\user\\AppData\\Local\\lasterm\\lasterm-agent.exe");
	});

	it("falls through to common Unix paths when which/where fail", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			"where lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
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
	it("E5 accepts the first where line with brackets", async () => {
		const path = "C:\\Profiles[1]\\lasterm-agent.exe";
		const client = makeMockClient({
			"where lasterm-agent": {
				stdout: `${path}\r\nC:\\ok\\lasterm-agent.exe\r\n`,
				stderr: "",
				exitCode: 0,
			},
		});
		expect(await checkRemoteAgent(client, "windows")).toBe(path);
	});

	it.each(["C:\\a!b\\lasterm-agent.exe"])(
		"E5 skips refused where line %s without known-folder probes",
		async (unsafe) => {
			const client = makeMockClient({
				"where lasterm-agent": {
					stdout: `${unsafe}\r\n  C:\\ok\\lasterm-agent.exe  \r\n`,
					stderr: "",
					exitCode: 0,
				},
			});
			expect(await checkRemoteAgent(client, "windows")).toBe("C:\\ok\\lasterm-agent.exe");
			expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
				"where lasterm-agent",
			]);
		},
	);

	it.each(["C:\\%TEMP%\\agent.exe", "C:\\!TEMP!\\agent.exe", "/c/Users/u/agent.exe"])(
		"E5 probes known folders when every where line is refused: %s",
		async (unsafe) => {
			const path = "C:\\Program Files\\lasterm\\lasterm-agent.exe";
			const client = makeMockClient({
				"where lasterm-agent": {
					stdout: `${unsafe}\r\n  C:\\also!refused.exe  \r\n`,
					stderr: "",
					exitCode: 0,
				},
				[folderCommand("ProgramFiles")]: folderOutput("C:\\Program Files"),
				[`if exist "${path}" echo ok`]: { stdout: "ok", stderr: "", exitCode: 0 },
			});
			expect(await checkRemoteAgent(client, "windows")).toBe(path);
			expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
				"where lasterm-agent",
				folderCommand("LocalApplicationData"),
				folderCommand("ProgramFiles"),
				`if exist "${path}" echo ok`,
			]);
		},
	);

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
			"echo %PROCESSOR_ARCHITECTURE%": { stdout: "AMD64\n", stderr: "", exitCode: 0 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toEqual({ os: "windows", arch: "x64" });
	});

	it("falls back to PROCESSOR_ARCHITECTURE for Windows arm64", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "", stderr: "", exitCode: 1 },
			"echo %PROCESSOR_ARCHITECTURE%": { stdout: "ARM64\n", stderr: "", exitCode: 0 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toEqual({ os: "windows", arch: "arm64" });
	});

	it("returns null when both detection methods fail", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "", stderr: "", exitCode: 1 },
			"echo %PROCESSOR_ARCHITECTURE%": { stdout: "", stderr: "", exitCode: 1 },
		});
		const result = await detectRemoteOsArch(client);
		expect(result).toBeNull();
	});

	it("keeps the name of a system no agent is built for (#401)", async () => {
		const client = makeMockClient({
			"uname -sm": { stdout: "Linux armv7l\n", stderr: "", exitCode: 0 },
			"echo %PROCESSOR_ARCHITECTURE%": {
				stdout: "%PROCESSOR_ARCHITECTURE%\n",
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
			"echo %PROCESSOR_ARCHITECTURE%": { stdout: "", stderr: "", exitCode: 1 },
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
			const sftp = makeMockSftp({
				mkdirError: new Error("Permission denied"),
				...(failed ? { fastPutError: transferError } : {}),
			});
			const upload = uploadAgentBinary(makeSftpClient(sftp), "local", target, os);
			if (!failed) await expect(upload).resolves.toBe("sftp");
			else if (os === "windows") await expect(upload).rejects.toBe(transferError);
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

	// A Windows agent runs on stdio and exits with its connection, so nothing
	// runs from the file; and Windows would refuse to rename over a running
	// executable anyway. It is written in place, as it always was.
	it("writes a Windows agent in place, with no temporary and no rename", async () => {
		const windowsTarget = "%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe";
		const files = new Map([[windowsTarget, { content: "old agent", mode: 0o644 }]]);
		const sftp = makeMockSftp({ files });
		const client = makeSftpClient(sftp);

		await uploadAgentBinary(client, "C:\\local\\lasterm-agent.exe", windowsTarget, "windows");

		expect(vi.mocked(sftp.fastPut).mock.calls).toEqual([
			["C:\\local\\lasterm-agent.exe", windowsTarget, expect.any(Function)],
		]);
		expect(sftp.chmod).toHaveBeenCalledWith(windowsTarget, 0o755, expect.any(Function));
		expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
		expect(client.exec).not.toHaveBeenCalled();
		expect([...files]).toEqual([
			[windowsTarget, { content: "C:\\local\\lasterm-agent.exe", mode: 0o755 }],
		]);
	});

	it("calls sftp.end() even when a Windows upload fails", async () => {
		const sftp = makeMockSftp({ fastPutError: new Error("disk full") });
		const client = makeSftpClient(sftp);

		await expect(
			uploadAgentBinary(client, "C:\\local\\agent.exe", "C:\\lasterm\\agent.exe", "windows"),
		).rejects.toThrow("disk full");

		expect(sftp.end).toHaveBeenCalled();
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

	close(): void {
		this.child.kill();
	}
}

/**
 * A client whose exec runs commands on this Windows machine the way
 * Win32-OpenSSH does: through cmd.exe by default, or through a PowerShell
 * `DefaultShell` (#714), and which offers no SFTP.
 */
function localWindowsClient(
	shell: "cmd.exe" | "powershell.exe",
	env: NodeJS.ProcessEnv = process.env,
): SshClient {
	return {
		exec: vi.fn((command: string, cb: (err: Error | undefined, stream: unknown) => void) => {
			const child =
				shell === "cmd.exe"
					? spawn("cmd.exe", ["/c", command], { windowsVerbatimArguments: true, env })
					: spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-c", command], { env });
			cb(undefined, new ChildChannel(child));
		}),
		sftp: vi.fn((cb: (err: Error) => void) => cb(new Error("Unable to start subsystem: sftp"))),
	} as unknown as SshClient;
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

	it("writes a Windows agent in place, then checks its SHA-256, without SFTP", async () => {
		const agent = localAgent();
		const windowsTarget = "C:\\Users\\u\\AppData\\Local\\lasterm\\lasterm-agent.exe";
		let stored: Buffer | undefined;
		const hashCommand = (() => {
			const recorder = makeMockClient({});
			void getRemoteSha256(recorder, windowsTarget, "windows");
			return vi.mocked(recorder.exec).mock.calls[0]?.[0] ?? "";
		})();
		const client = makeExecClient(
			(command) =>
				command === hashCommand && stored !== undefined
					? {
							stdout: `${createHash("sha256").update(stored).digest("hex").toUpperCase()}\r\n`,
							stderr: "",
							exitCode: 0,
						}
					: { stdout: "", stderr: "", exitCode: 1 },
			(command, input) => {
				expect(command).toBe(windowsUploadCommand(windowsTarget));
				stored = input;
				return { stdout: String(input.length), stderr: "", exitCode: 0 };
			},
		);

		expect(await uploadAgentBinary(client, agent.path, windowsTarget, "windows", refused)).toBe(
			"exec",
		);

		expect(stored?.equals(agent.bytes)).toBe(true);
		expect(client.sftp).not.toHaveBeenCalled();
		expect(vi.mocked(client.exec).mock.calls.map(([command]) => command)).toEqual([
			windowsUploadCommand(windowsTarget),
			hashCommand,
		]);
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
			'Could not upload the agent to C:\\Program Files\\lasterm\\a.exe: exit 1: Exception calling "Create" with "1" argument(s): "Access to the path is denied." At line:1 char:1',
		);
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
				"[Console]::Out.Write($n)",
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

		expect(await probeSftp(client, 20)).toEqual({
			offered: false,
			reason: "no answer within 0.02 s",
		});
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
				"where lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
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
			"where lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
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
			"echo %PROCESSOR_ARCHITECTURE%": { stdout: "", stderr: "", exitCode: 1 },
		});

		await expect(
			deployAgentIfNeeded(client, { os: null, arch: null }, makeOptions()),
		).rejects.toThrow("Cannot detect remote OS/arch");
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
			"uname -sm",
			"echo %PROCESSOR_ARCHITECTURE%",
		]);
		expect(client.sftp).not.toHaveBeenCalled();
	});

	it("names a system no agent is built for instead of calling it undetectable (#401)", async () => {
		const client = makeMockClient({
			"which lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
			"where lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
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
			"echo %PROCESSOR_ARCHITECTURE%": { stdout: "", stderr: "", exitCode: 1 },
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
		...["‘", "’", "‚", "‛", "[", "]", "`"].map((character) => [
			`literal profile ${character}`,
			`C:\\Users\\a${character}b\\AppData\\Local`,
		]),
	])("%s", async (_edge, folder) => {
		const local = writeCachedAgentBinary("windows", "x64");
		const sftp = makeMockSftp();
		const client = makeMockClient(
			{
				[folderCommand("LocalApplicationData")]: folderOutput(folder),
			},
			(cb) => cb(undefined, sftp),
		);
		const result = await deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions());
		const path = `${folder.endsWith("\\") ? folder : `${folder}\\`}lasterm\\lasterm-agent.exe`;
		expect(result.remotePath).toBe(path);
		expect(result.deployed).toBe(true);
		expect(sftp.mkdir).toHaveBeenCalledExactlyOnceWith(
			path.slice(0, path.lastIndexOf("\\")),
			expect.any(Function),
		);
		expect(sftp.fastPut).toHaveBeenCalledExactlyOnceWith(local, path, expect.any(Function));
		expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
			"where lasterm-agent",
			folderCommand("LocalApplicationData"),
			`if exist "${path}" echo ok`,
			folderCommand("ProgramFiles"),
		]);
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
					{ stdout, stderr: "", exitCode: 0 },
					"unexpected output",
				] as const,
		),
		...["", "C:\\a\nb", "C:\\a\u007fb"].map(
			(path) =>
				[`invalid path ${JSON.stringify(path)}`, folderOutput(path), "unexpected output"] as const,
		),
		...(
			[
				["C:\\Users\\a%[\\AppData\\Local", "contains a character cmd.exe expands"],
				["C:\\Users\\a!’\\AppData\\Local", "contains a character cmd.exe expands"],
				['C:\\Users\\a"[\\AppData\\Local', "contains a double quote"],
				["%LOCALAPPDATA%", "contains a character cmd.exe expands"],
				["C:\\!TEMP!", "contains a character cmd.exe expands"],
				["C:\\%TEMP%", "contains a character cmd.exe expands"],
				["C:\\Users\\a!b\\AppData\\Local", "contains a character cmd.exe expands"],
				["C:\\Users\\a%b\\AppData\\Local", "contains a character cmd.exe expands"],
				['C:\\a"b', "contains a double quote"],
				["C:/Users/u/AppData/Local", "not a drive path with backslashes"],
				["Users\\u", "not a drive path with backslashes"],
				["relative", "not a drive path with backslashes"],
				['relative%"', "contains a character cmd.exe expands"],
				['relative"', "contains a double quote"],
				['C:\\Users\\a%"\\AppData\\Local', "contains a character cmd.exe expands"],
				["\\\\server\\share", "not a drive path with backslashes"],
				["\\\\server\\share\\u", "not a drive path with backslashes"],
			] as const
		).map(
			([path, why]) =>
				[
					`unsupported path ${path}`,
					folderOutput(path),
					`unsupported path ${path} (${why})`,
				] as const,
		),
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
			"where lasterm-agent",
			folderCommand("LocalApplicationData"),
			folderCommand("ProgramFiles"),
			folderCommand("LocalApplicationData"),
		]);
	});

	it.each([true, false])(
		"retries a failed LocalAppData lookup once (second succeeds: %s)",
		async (succeeds) => {
			const local = writeCachedAgentBinary("windows", "x64");
			const folder = "C:\\Users\\u\\AppData\\Local";
			const path = `${folder}\\lasterm\\lasterm-agent.exe`;
			const responses = {
				[folderCommand("LocalApplicationData")]: { stdout: "", stderr: "first", exitCode: 1 },
			};
			const sftp = makeMockSftp();
			const openSftp = vi.fn((cb: (err: Error | undefined, sftp: SFTPWrapper) => void) =>
				cb(undefined, sftp),
			);
			const client = makeMockClient(responses, openSftp);
			const exec = vi.mocked(client.exec).getMockImplementation();
			if (!exec) throw new Error("Missing mock exec implementation");
			let lookups = 0;
			vi.mocked(client.exec).mockImplementation((cmd, cb) => {
				if (cmd === folderCommand("LocalApplicationData") && ++lookups === 2) {
					responses[cmd] = succeeds
						? folderOutput(folder)
						: { stdout: "", stderr: "second", exitCode: 2 };
				}
				return exec(cmd, cb);
			});
			const deployment = deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions());
			if (succeeds) {
				expect((await deployment).remotePath).toBe(path);
				expect(sftp.fastPut).toHaveBeenCalledExactlyOnceWith(local, path, expect.any(Function));
			} else {
				const error = await deployment.catch((error: unknown) => error);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe(
					"Could not determine the LocalAppData directory of the Windows host: exit 2: second",
				);
				expect(openSftp).not.toHaveBeenCalled();
			}
			expect(lookups).toBe(2);
		},
	);

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
				`LocalAppData directory of the Windows host: SSH exec timed out after 10000ms: ${folderCommand("LocalApplicationData")}`,
			);
			await vi.advanceTimersByTimeAsync(20000);
			await rejection;
			expect(client.sftp).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it.each(["Rémi", "O'Brien", "a`b[1]\\O’Brien'x"])(
		"E4 hashes the agent at the resolved LocalAppData candidate for %s",
		async (profile) => {
			const folder = `C:\\Users\\${profile}\\AppData\\Local\\`;
			const path = `${folder}lasterm\\lasterm-agent.exe`;
			const hash = "a".repeat(64);
			const encodedPath = Buffer.from(path, "utf8").toString("base64");
			const script = expectedHashScript(encodedPath);
			const hashCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
			const client = makeMockClient({
				[folderCommand("LocalApplicationData")]: folderOutput(folder),
				[`if exist "${path}" echo ok`]: { stdout: "ok\r\n", stderr: "", exitCode: 0 },
				[hashCommand]: { stdout: hash, stderr: "", exitCode: 0 },
			});
			const result = await deployAgentIfNeeded(
				client,
				{ os: "windows", arch: "x64" },
				makeOptions({ pinnedSha256: hash }),
			);
			expect(result.remotePath).toBe(path);
			expect(vi.mocked(client.exec).mock.calls[3]?.[0]).toBe(hashCommand);
			expect(client.sftp).not.toHaveBeenCalled();
			expect(vi.mocked(client.exec).mock.calls.map(([cmd]) => cmd)).toEqual([
				"where lasterm-agent",
				folderCommand("LocalApplicationData"),
				`if exist "${path}" echo ok`,
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
			[command]: { stdout: `${hash.toUpperCase()} trailing output\r\n`, stderr: "", exitCode: 0 },
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
				"where lasterm-agent": { stdout: "", stderr: "", exitCode: 1 },
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
