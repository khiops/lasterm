import { EventEmitter } from "node:events";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SFTPWrapper, Client as SshClient } from "ssh2";
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
	readRemoteSystem,
	uploadAgentBinary,
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

// ---------- Mock SFTP helpers -------------------------------------------------

/** A file on the mock remote: what was written there, and its mode. */
interface RemoteFile {
	content: string;
	mode: number;
}

interface MockSftpOptions {
	mkdirError?: Error;
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
	return {
		mkdir: vi.fn((_path: string, cb: (err: Error | undefined) => void) => {
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
	} as unknown as SFTPWrapper;
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
		const result = await checkRemoteAgent(client);
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
		const result = await checkRemoteAgent(client);
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
		const result = await checkRemoteAgent(client);
		expect(result).toBe("/home/user/.local/bin/lasterm-agent");
	});

	it("returns null when agent is not found anywhere", async () => {
		const client = makeMockClient({});
		const result = await checkRemoteAgent(client);
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
		const result = await checkRemoteAgent(client);
		expect(result).toBe("/usr/bin/lasterm-agent");
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

	it("renames with posix-rename@openssh.com when the server offers it, and runs nothing", async () => {
		const sftp = makeMockSftp({ files: remoteWithOldAgent() });
		const client = makeSftpClient(sftp);

		await uploadAgentBinary(client, "/local/binary", target, "linux");

		expect(sftp.ext_openssh_rename).toHaveBeenCalledTimes(1);
		expect(client.exec).not.toHaveBeenCalled();
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
		expect(commands).toEqual([
			`test ! -d ${quoted(awkward)} && mv -f -- ${quoted(temp)} ${quoted(awkward)}`,
		]);
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

	it("rejects when sftp channel open fails", async () => {
		const sftp = makeMockSftp();
		const client = makeSftpClient(sftp, new Error("SFTP not available"));

		await expect(
			uploadAgentBinary(client, "/local/binary", "/remote/lasterm-agent", "linux"),
		).rejects.toThrow("SFTP not available");
	});

	it("swallows mkdir errors (parent may already exist)", async () => {
		const sftp = makeMockSftp({ mkdirError: new Error("EEXIST") });
		const client = makeSftpClient(sftp);

		await expect(
			uploadAgentBinary(client, "/local/binary", "/remote/.local/bin/lasterm-agent", "linux"),
		).resolves.toBeUndefined();
	});

	it("handles Windows backslash paths for parent dir extraction", async () => {
		const sftp = makeMockSftp();
		const client = makeSftpClient(sftp);

		await uploadAgentBinary(
			client,
			"C:\\local\\lasterm-agent.exe",
			"%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe",
			"windows",
		);

		expect(sftp.mkdir).toHaveBeenCalledWith("%LOCALAPPDATA%\\lasterm", expect.any(Function));
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
			`Agent binary not found in cache: ${join(cacheDir, agentCacheName("linux", "x64"))}. Build it or copy it to the binary cache (see docs/MVP_ROADMAP.md).`,
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

	it("deploys binary when os/arch auto-detected (host record has nulls)", async () => {
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

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(result.os).toBe("linux");
		expect(result.arch).toBe("arm64");
	});

	it("throws when OS/arch cannot be detected and they are unknown", async () => {
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

	it("uses windows path for windows host", async () => {
		const binaryName = agentCacheName("windows", "x64");
		writeCachedAgentBinary("windows", "x64");

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
			},
			sftpImpl,
		);

		const result = await deployAgentIfNeeded(client, { os: "windows", arch: "x64" }, makeOptions());

		expect(result.deployed).toBe(true);
		expect(result.remoteMatchesHubVersionCache).toBe(false);
		expect(result.remotePath).toBe("%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe");
		expect(sftp.fastPut).toHaveBeenCalledWith(
			join(cacheDir, binaryName),
			"%LOCALAPPDATA%\\lasterm\\lasterm-agent.exe",
			expect.any(Function),
		);
	});
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

	it("parses PowerShell Get-FileHash output on Windows", async () => {
		const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		const client = makeMockClient({
			"powershell -c": {
				stdout: `${hash}\n`,
				stderr: "",
				exitCode: 0,
			},
		});
		const result = await getRemoteSha256(client, "C:\\lasterm\\lasterm-agent.exe", "windows");
		expect(result).toBe(hash);
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
