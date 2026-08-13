import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cmdAgentFetch,
	cmdAgentImport,
	cmdAgentStatus,
	cmdQuit,
	cmdStatus,
	cmdStop,
	deleteRuntime,
	getConfigDir,
	getStateDir,
	isPidAlive,
	loadRuntime,
	type ParsedArgs,
	parseArgs,
	persistRuntime,
	runtimeMatches,
	waitForHubQuit,
} from "./cli.js";
import { describePreviousInstallation } from "./previous-installation.js";
import {
	AGENT_TARGET_TRIPLES,
	type FetchAgentBinaryOptions,
	FetchError,
} from "./session/agent-fetch.js";
import { computeTargetStatus, type HubPlatform } from "./session/agent-status.js";

const TEST_VERSION = "0.4.1";
const HUB_PLATFORM = { os: "linux", arch: "x64" } as const satisfies HubPlatform;

type AgentTargetEntry = {
	readonly triple: string | null;
	readonly ext: "" | ".exe";
	readonly built: boolean;
};

const AGENT_TARGET_TABLE = AGENT_TARGET_TRIPLES as Record<
	string,
	Record<string, AgentTargetEntry> | undefined
>;

let tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("parseArgs", () => {
	describe("start", () => {
		it("parses bare start", () => {
			const r = parseArgs(["start"]);
			expect(r).not.toBeNull();
			expect(r?.command).toBe("start");
			expect(r?.port).toBeUndefined();
			expect(r?.daemon).toBeUndefined();
		});

		it("parses start --port 4200", () => {
			const r = parseArgs(["start", "--port", "4200"]);
			expect(r?.command).toBe("start");
			expect(r?.port).toBe(4200);
		});

		it("parses start --daemon", () => {
			const r = parseArgs(["start", "--daemon"]);
			expect(r?.command).toBe("start");
			expect(r?.daemon).toBe(true);
		});

		it("parses start --port 4200 --daemon", () => {
			const r = parseArgs(["start", "--port", "4200", "--daemon"]);
			expect(r?.command).toBe("start");
			expect(r?.port).toBe(4200);
			expect(r?.daemon).toBe(true);
		});
	});

	describe("stop / status", () => {
		it("parses stop", () => {
			const r = parseArgs(["stop"]);
			expect(r?.command).toBe("stop");
		});

		it("parses status", () => {
			const r = parseArgs(["status"]);
			expect(r?.command).toBe("status");
		});

		it("parses status --json", () => {
			const r = parseArgs(["status", "--json"]);
			expect(r?.command).toBe("status");
			expect(r?.json).toBe(true);
		});
	});

	it("parses quit", () => {
		const r = parseArgs(["quit"]);
		expect(r?.command).toBe("quit");
	});

	describe("host add", () => {
		it("parses host add --label prod --host 10.0.0.1", () => {
			const r = parseArgs(["host", "add", "--label", "prod", "--host", "10.0.0.1"]);
			expect(r?.command).toBe("host-add");
			expect(r?.label).toBe("prod");
			expect(r?.host).toBe("10.0.0.1");
		});

		it("parses host add with all flags", () => {
			const r = parseArgs([
				"host",
				"add",
				"--label",
				"staging",
				"--host",
				"192.168.1.5",
				"--ssh-port",
				"2222",
				"--user",
				"deploy",
				"--auth",
				"key",
			]);
			expect(r?.command).toBe("host-add");
			expect(r?.label).toBe("staging");
			expect(r?.host).toBe("192.168.1.5");
			expect(r?.sshPort).toBe(2222);
			expect(r?.user).toBe("deploy");
			expect(r?.authMethod).toBe("key");
		});

		it("parses host list", () => {
			const r = parseArgs(["host", "list"]);
			expect(r?.command).toBe("host-list");
		});

		it("parses host list --json", () => {
			const r = parseArgs(["host", "list", "--json"]);
			expect(r?.command).toBe("host-list");
			expect(r?.json).toBe(true);
		});

		it("parses host remove <label>", () => {
			const r = parseArgs(["host", "remove", "old-server"]);
			expect(r?.command).toBe("host-remove");
			expect(r?.label).toBe("old-server");
		});
	});

	describe("agent fetch", () => {
		it("parses agent fetch <os-arch>", () => {
			const r = parseArgs(["agent", "fetch", "linux-arm64"]);
			expect(r?.command).toBe("agent-fetch");
			expect(r?.target).toBe("linux-arm64");
			expect(r?.all).toBeUndefined();
		});

		it("parses agent fetch --all", () => {
			const r = parseArgs(["agent", "fetch", "--all"]);
			expect(r?.command).toBe("agent-fetch");
			expect(r?.all).toBe(true);
			expect(r?.target).toBeUndefined();
		});

		it("parses agent fetch --version and --prune", () => {
			const r = parseArgs(["agent", "fetch", "linux-arm64", "--version", TEST_VERSION, "--prune"]);
			expect(r?.command).toBe("agent-fetch");
			expect(r?.target).toBe("linux-arm64");
			expect(r?.version).toBe(TEST_VERSION);
			expect(r?.prune).toBe(true);
		});

		it("does not clobber existing flag parsing or add -V handling", () => {
			const r = parseArgs(["start", "--port", "4200", "--version", TEST_VERSION]);
			expect(r?.command).toBe("start");
			expect(r?.port).toBe(4200);
			expect(r?.version).toBe(TEST_VERSION);
			expect(parseArgs(["-V"])).toBeNull();
		});
	});

	describe("agent status", () => {
		it("parses agent status", () => {
			const r = parseArgs(["agent", "status"]);
			expect(r?.command).toBe("agent-status");
		});
	});

	describe("agent import", () => {
		it("parses agent import paths and required flags", () => {
			const r = parseArgs([
				"agent",
				"import",
				"/tmp/agent",
				"/tmp/SHA256SUMS",
				"--os",
				"windows",
				"--arch",
				"x64",
				"--version",
				TEST_VERSION,
				"--attest",
				"--force",
			]);
			expect(r?.command).toBe("agent-import");
			expect(r?.binaryPath).toBe("/tmp/agent");
			expect(r?.manifestPath).toBe("/tmp/SHA256SUMS");
			expect(r?.agentOs).toBe("windows");
			expect(r?.agentArch).toBe("x64");
			expect(r?.version).toBe(TEST_VERSION);
			expect(r?.attest).toBe(true);
			expect(r?.force).toBe(true);
		});
	});

	describe("session", () => {
		it("parses session list", () => {
			const r = parseArgs(["session", "list"]);
			expect(r?.command).toBe("session-list");
		});

		it("parses session list --json", () => {
			const r = parseArgs(["session", "list", "--json"]);
			expect(r?.command).toBe("session-list");
			expect(r?.json).toBe(true);
		});
	});

	describe("pair", () => {
		it("parses bare pair (generate mode)", () => {
			const r = parseArgs(["pair"]);
			expect(r?.command).toBe("pair");
			expect(r?.code).toBeUndefined();
		});

		it("parses pair --code 123456", () => {
			const r = parseArgs(["pair", "--code", "123456"]);
			expect(r?.command).toBe("pair");
			expect(r?.code).toBe("123456");
		});
	});

	describe("config edit", () => {
		it("parses config edit", () => {
			const r = parseArgs(["config", "edit"]);
			expect(r?.command).toBe("config-edit");
		});
	});

	describe("unknown commands", () => {
		it("returns null for empty argv", () => {
			expect(parseArgs([])).toBeNull();
		});

		it("returns null for unknown top-level command", () => {
			expect(parseArgs(["foobar"])).toBeNull();
		});

		it("returns null for 'host' with no sub-command", () => {
			expect(parseArgs(["host"])).toBeNull();
		});

		it("returns null for 'host bogus'", () => {
			expect(parseArgs(["host", "bogus"])).toBeNull();
		});

		it("returns null for 'session' with no sub-command", () => {
			expect(parseArgs(["session"])).toBeNull();
		});

		it("returns null for 'config' with no sub-command", () => {
			expect(parseArgs(["config"])).toBeNull();
		});
	});

	describe("flag ordering", () => {
		it("handles flags before positional args", () => {
			const r = parseArgs(["--label", "prod", "host", "add", "--host", "1.2.3.4"]);
			expect(r?.command).toBe("host-add");
			expect(r?.label).toBe("prod");
			expect(r?.host).toBe("1.2.3.4");
		});
	});
});

describe("cmdAgentFetch", () => {
	it("populates the cache, then no-ops when the target is already cached", async () => {
		const cacheDir = makeTempDir();
		const lines: string[] = [];
		const fetcher = vi.fn(async (options: FetchAgentBinaryOptions) => {
			const binaryPath = agentCachePath(
				options.cacheDir,
				options.os,
				options.arch,
				options.version,
			);
			mkdirSync(options.cacheDir, { recursive: true });
			writeFileSync(binaryPath, "agent");
			return binaryPath;
		});
		const args = parsed(["agent", "fetch", "linux-arm64"]);
		const expectedPath = agentCachePath(cacheDir, "linux", "arm64", TEST_VERSION);

		const firstCode = await cmdAgentFetch(args, {
			fetchAgentBinary: fetcher,
			getBinaryCacheDir: () => cacheDir,
			hubVersion: TEST_VERSION,
			writeLine: (line) => lines.push(line),
		});

		expect(firstCode).toBe(0);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(existsSync(expectedPath)).toBe(true);
		expect(lines).toEqual([expectedPath]);

		lines.length = 0;
		const secondCode = await cmdAgentFetch(args, {
			fetchAgentBinary: fetcher,
			getBinaryCacheDir: () => cacheDir,
			hubVersion: TEST_VERSION,
			writeLine: (line) => lines.push(line),
		});

		expect(secondCode).toBe(0);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(lines).toEqual([`already cached ${expectedPath}`]);
	});

	it("--all attempts every built target and returns non-zero when any target fails", async () => {
		const cacheDir = makeTempDir();
		const lines: string[] = [];
		const builtTargets = builtAgentTargetIds();
		const fetcher = vi.fn(async (options: FetchAgentBinaryOptions) => {
			const id = `${options.os}-${options.arch}`;
			if (id === "linux-x64") {
				throw new FetchError("PRIVATE_OR_FORBIDDEN", `manual gesture for ${id}`);
			}
			const binaryPath = agentCachePath(
				options.cacheDir,
				options.os,
				options.arch,
				options.version,
			);
			mkdirSync(options.cacheDir, { recursive: true });
			writeFileSync(binaryPath, "agent");
			return binaryPath;
		});

		const code = await cmdAgentFetch(parsed(["agent", "fetch", "--all"]), {
			fetchAgentBinary: fetcher,
			getBinaryCacheDir: () => cacheDir,
			hubVersion: TEST_VERSION,
			writeLine: (line) => lines.push(line),
		});

		expect(code).toBe(1);
		expect(fetcher).toHaveBeenCalledTimes(builtTargets.length);
		expect(fetcher.mock.calls.map(([options]) => `${options.os}-${options.arch}`)).toEqual(
			builtTargets,
		);
		expect(lines).toHaveLength(builtTargets.length);
		expect(lines[0]).toBe("manual gesture for linux-x64");
		expect(lines.at(-1)).toContain("lasterm-agent-windows-x64");
	});

	it("prints a FetchError actionable message and returns non-zero", async () => {
		const cacheDir = makeTempDir();
		const lines: string[] = [];
		const message =
			"Lasterm could not download https://example.test/asset. Manually download it, chmod 755 it, then rename it to the cache path.";
		const fetcher = vi.fn(async () => {
			throw new FetchError("PRIVATE_OR_FORBIDDEN", message);
		});

		const code = await cmdAgentFetch(parsed(["agent", "fetch", "linux-arm64"]), {
			fetchAgentBinary: fetcher,
			getBinaryCacheDir: () => cacheDir,
			hubVersion: TEST_VERSION,
			writeLine: (line) => lines.push(line),
		});

		expect(code).toBe(1);
		expect(lines).toEqual([message]);
	});

	it("--prune removes only stale regular files with known agent cache names", async () => {
		const cacheDir = makeTempDir();
		const current = agentCachePath(cacheDir, "linux", "x64", TEST_VERSION);
		const staleLinux = agentCachePath(cacheDir, "linux", "x64", "0.3.4");
		const staleWindows = agentCachePath(cacheDir, "windows", "x64", "0.3.4");
		const checksum = path.join(cacheDir, "SHA256SUMS-0.3.4.txt");
		const backup = path.join(cacheDir, "lasterm-agent-linux-x64-0.3.4.backup");
		const matchingDirectory = path.join(cacheDir, "lasterm-agent-linux-arm64-0.3.4");
		mkdirSync(matchingDirectory, { recursive: true });
		writeFileSync(current, "current");
		writeFileSync(staleLinux, "stale");
		writeFileSync(staleWindows, "stale");
		writeFileSync(checksum, "checksum");
		writeFileSync(backup, "backup");
		const fetcher = vi.fn(async () => {
			throw new Error("unexpected fetch");
		});
		const lines: string[] = [];

		const code = await cmdAgentFetch(
			parsed(["agent", "fetch", "linux-x64", "--version", TEST_VERSION, "--prune"]),
			{
				fetchAgentBinary: fetcher,
				getBinaryCacheDir: () => cacheDir,
				writeLine: (line) => lines.push(line),
			},
		);

		expect(code).toBe(0);
		expect(fetcher).not.toHaveBeenCalled();
		expect(lines).toEqual([`already cached ${current}`]);
		expect(existsSync(current)).toBe(true);
		expect(existsSync(staleLinux)).toBe(false);
		expect(existsSync(staleWindows)).toBe(false);
		expect(existsSync(checksum)).toBe(true);
		expect(existsSync(backup)).toBe(true);
		expect(existsSync(matchingDirectory)).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"--prune never follows or deletes a symlink with an agent cache name",
		async () => {
			const cacheDir = makeTempDir();
			const current = agentCachePath(cacheDir, "linux", "x64", TEST_VERSION);
			writeFileSync(current, "current");
			// An out-of-cache file, and an agent-cache-named SYMLINK pointing at it.
			const outsideDir = makeTempDir();
			const outsideTarget = path.join(outsideDir, "outside-binary");
			writeFileSync(outsideTarget, "outside");
			const symlinkName = path.join(cacheDir, "lasterm-agent-linux-x64-0.3.5");
			symlinkSync(outsideTarget, symlinkName);
			const fetcher = vi.fn(async () => {
				throw new Error("unexpected fetch");
			});

			const code = await cmdAgentFetch(
				parsed(["agent", "fetch", "linux-x64", "--version", TEST_VERSION, "--prune"]),
				{
					fetchAgentBinary: fetcher,
					getBinaryCacheDir: () => cacheDir,
					writeLine: () => {},
				},
			);

			expect(code).toBe(0);
			// lstat (not stat) keeps prune fail-closed: the symlink is neither
			// followed nor deleted, and its out-of-cache target is untouched.
			// A stat-follow mutation would delete the link and fail this.
			expect(lstatSync(symlinkName).isSymbolicLink()).toBe(true);
			expect(existsSync(outsideTarget)).toBe(true);
			expect(readFileSync(outsideTarget, "utf8")).toBe("outside");
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not report a symlinked cache entry as already cached (re-fetches instead)",
		async () => {
			const cacheDir = makeTempDir();
			const cachePath = agentCachePath(cacheDir, "linux", "x64", TEST_VERSION);
			const outside = path.join(makeTempDir(), "outside");
			writeFileSync(outside, "outside");
			// The cache entry is a SYMLINK, not a regular file — it must not be
			// trusted as "already cached"; the command must re-fetch (refresh) it.
			symlinkSync(outside, cachePath);
			const fetcher = vi.fn(async () => cachePath);
			const lines: string[] = [];

			const code = await cmdAgentFetch(
				parsed(["agent", "fetch", "linux-x64", "--version", TEST_VERSION]),
				{
					fetchAgentBinary: fetcher,
					getBinaryCacheDir: () => cacheDir,
					writeLine: (line) => lines.push(line),
				},
			);

			expect(code).toBe(0);
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(lines).not.toContain(`already cached ${cachePath}`);
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses to prune through a symlinked cache directory",
		async () => {
			const realDir = makeTempDir();
			const stale = agentCachePath(realDir, "linux", "x64", "0.3.4");
			writeFileSync(stale, "stale");
			// The cache dir handed to the command is a SYMLINK to realDir. Pruning must
			// not readdir through it and delete the stale file in the link target.
			const linkDir = path.join(makeTempDir(), "link");
			symlinkSync(realDir, linkDir);
			const fetcher = vi.fn(async () => agentCachePath(linkDir, "linux", "x64", TEST_VERSION));

			const code = await cmdAgentFetch(
				parsed(["agent", "fetch", "linux-x64", "--version", TEST_VERSION, "--prune"]),
				{
					fetchAgentBinary: fetcher,
					getBinaryCacheDir: () => linkDir,
					writeLine: () => {},
				},
			);

			expect(code).toBe(0);
			expect(existsSync(stale)).toBe(true);
		},
	);
});

describe("cmdAgentStatus", () => {
	it("prints statuses consistent with computeTargetStatus", async () => {
		const cacheDir = makeTempDir();
		writeFileSync(agentCachePath(cacheDir, "linux", "arm64", TEST_VERSION), "agent");
		const lines: string[] = [];
		const statusDeps = {
			getBinaryCacheDir: () => cacheDir,
			hubVersion: TEST_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: () => "/tmp/lasterm-agent-cli-test",
			versionReader: () => TEST_VERSION,
		};
		const expected = await computeTargetStatus({
			cacheDir,
			hubVersion: TEST_VERSION,
			hubPlatform: HUB_PLATFORM,
			resolveAgentBinaryPath: statusDeps.resolveAgentBinaryPath,
			versionReader: statusDeps.versionReader,
		});

		const code = await cmdAgentStatus(parsed(["agent", "status"]), {
			...statusDeps,
			writeLine: (line) => lines.push(line),
		});

		expect(code).toBe(0);
		const output = lines.join("\n");
		expect(output).toContain(`Hub version: ${expected.hub_version}`);
		for (const target of expected.targets) {
			expect(output).toContain(`${target.os}/${target.arch}`);
			expect(output).toContain(target.status);
			if (target.version) expect(output).toContain(target.version);
		}
	});
});

describe("cmdAgentImport", () => {
	it("SC-29 refuses without --attest", async () => {
		const cacheDir = makeTempDir();
		const binaryPath = path.join(makeTempDir(), "lasterm-agent");
		const manifestPath = path.join(makeTempDir(), "SHA256SUMS");
		writeFileSync(binaryPath, "agent");
		writeFileSync(manifestPath, "unused");
		const errors: string[] = [];

		const code = await cmdAgentImport(
			parsed([
				"agent",
				"import",
				binaryPath,
				manifestPath,
				"--os",
				"windows",
				"--arch",
				"x64",
				"--version",
				TEST_VERSION,
			]),
			{
				getBinaryCacheDir: () => cacheDir,
				hubPlatform: HUB_PLATFORM,
				writeError: (line) => errors.push(line),
			},
		);

		expect(code).toBe(1);
		expect(errors).toEqual([
			"agent import requires --attest after operator verification of the source.",
		]);
		expect(existsSync(agentCachePath(cacheDir, "windows", "x64", TEST_VERSION))).toBe(false);
		expect(listTempFiles(cacheDir)).toEqual([]);
	});

	it("SC-29 rejects a mismatched binary and places nothing", async () => {
		const cacheDir = makeTempDir();
		const inputDir = makeTempDir();
		const binaryPath = path.join(inputDir, "lasterm-agent");
		const manifestPath = path.join(inputDir, "SHA256SUMS");
		const assetName = versionedAssetName("windows", "x64", TEST_VERSION);
		writeFileSync(binaryPath, "corrupt");
		writeFileSync(manifestPath, sums(assetName, "expected"));
		const errors: string[] = [];

		const code = await cmdAgentImport(
			parsed([
				"agent",
				"import",
				binaryPath,
				manifestPath,
				"--os",
				"windows",
				"--arch",
				"x64",
				"--version",
				TEST_VERSION,
				"--attest",
			]),
			{
				getBinaryCacheDir: () => cacheDir,
				hubPlatform: HUB_PLATFORM,
				writeError: (line) => errors.push(line),
			},
		);

		expect(code).toBe(1);
		expect(errors[0]).toContain("Checksum mismatch");
		expect(existsSync(agentCachePath(cacheDir, "windows", "x64", TEST_VERSION))).toBe(false);
		expect(readFileSync(binaryPath, "utf8")).toBe("corrupt");
		expect(listTempFiles(cacheDir)).toEqual([]);
	});

	it("SC-29 verifies and caches a matching binary", async () => {
		const cacheDir = makeTempDir();
		const inputDir = makeTempDir();
		const binaryPath = path.join(inputDir, "lasterm-agent");
		const manifestPath = path.join(inputDir, "SHA256SUMS");
		const assetName = versionedAssetName("windows", "x64", TEST_VERSION);
		writeFileSync(binaryPath, "agent");
		writeFileSync(manifestPath, sums(assetName, "agent"));
		const lines: string[] = [];
		const finalPath = agentCachePath(cacheDir, "windows", "x64", TEST_VERSION);

		const code = await cmdAgentImport(
			parsed([
				"agent",
				"import",
				binaryPath,
				manifestPath,
				"--os",
				"windows",
				"--arch",
				"x64",
				"--version",
				TEST_VERSION,
				"--attest",
			]),
			{
				getBinaryCacheDir: () => cacheDir,
				hubPlatform: HUB_PLATFORM,
				writeLine: (line) => lines.push(line),
			},
		);

		expect(code).toBe(0);
		expect(lines).toEqual([finalPath]);
		expect(readFileSync(finalPath, "utf8")).toBe("agent");
		expect(statSync(finalPath).mode & 0o777).toBe(0o755);
		expect(readFileSync(binaryPath, "utf8")).toBe("agent");
		expect(listTempFiles(cacheDir)).toEqual([]);
	});
});

describe("path helpers", () => {
	it("getStateDir returns a non-empty string", () => {
		expect(getStateDir().length).toBeGreaterThan(0);
		expect(getStateDir()).toContain("lasterm");
	});

	it("getConfigDir returns a non-empty string", () => {
		expect(getConfigDir().length).toBeGreaterThan(0);
		expect(getConfigDir()).toContain("lasterm");
	});

	it.skipIf(process.platform === "win32")("getStateDir uses XDG_STATE_HOME when set", () => {
		const orig = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = "/tmp/xdg-state";
		expect(getStateDir()).toBe("/tmp/xdg-state/lasterm");
		process.env.XDG_STATE_HOME = orig;
	});

	// The rename moved every namespace at once, so a Termora install and this one
	// cannot contend for the same lock: both hubs could serve terminals while
	// quitting one leaves the other alive. Starting must refuse, not coexist.
	describe.skipIf(process.platform === "win32")("previous-installation refusal", () => {
		let root: string;
		let origConfig: string | undefined;
		let origState: string | undefined;

		beforeEach(() => {
			root = mkdtempSync(path.join(os.tmpdir(), "lasterm-previous-"));
			origConfig = process.env.XDG_CONFIG_HOME;
			origState = process.env.XDG_STATE_HOME;
			process.env.XDG_CONFIG_HOME = path.join(root, "config");
			process.env.XDG_STATE_HOME = path.join(root, "state");
		});

		afterEach(() => {
			if (origConfig === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = origConfig;
			if (origState === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = origState;
			rmSync(root, { recursive: true, force: true });
		});

		it("says nothing when there is no previous installation", () => {
			expect(describePreviousInstallation()).toBeUndefined();
		});

		it("names a previous config directory and refuses", () => {
			mkdirSync(path.join(root, "config", "termora"), { recursive: true });
			const message = describePreviousInstallation();
			expect(message).toContain(path.join(root, "config", "termora"));
			expect(message).toContain("Refusing to start");
			expect(message).toContain("auth token");
		});

		it("names a previous state directory", () => {
			mkdirSync(path.join(root, "state", "termora"), { recursive: true });
			expect(describePreviousInstallation()).toContain(path.join(root, "state", "termora"));
		});

		it("reports the recorded pid as in use, and claims no more than that", () => {
			const stateDir = path.join(root, "state", "termora");
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(
				path.join(stateDir, "runtime.json"),
				JSON.stringify({ pid: process.pid, port: 4100 }),
			);
			const message = describePreviousInstallation();
			expect(message).toContain(`pid ${process.pid}`);
			// The record is an ordinary file in a directory the old hub owned, so a
			// stale or edited one can name any live pid. Liveness is all the probe
			// establishes, and the text must not hand the operator a signal to send.
			expect(message).not.toContain(`kill ${process.pid}`);
			expect(message).toContain("verify which process it is");
		});

		it.each([
			["a process group", 0],
			["every process the user owns", -1],
			["a fractional pid", 12.5],
		])("ignores a recorded pid naming %s", (_case, pid) => {
			const stateDir = path.join(root, "state", "termora");
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(path.join(stateDir, "runtime.json"), JSON.stringify({ pid, port: 4100 }));
			const message = describePreviousInstallation();
			expect(message).toContain(stateDir);
			// `process.kill` accepts 0 and negatives and aims at whole groups, so an
			// unvalidated record turns a liveness probe into a broadcast.
			expect(message).not.toContain("in use");
		});

		it("refuses rather than passing when a directory cannot be examined", () => {
			const configDir = path.join(root, "config", "termora");
			mkdirSync(configDir, { recursive: true });
			// Unsearchable parent: the path exists, and `existsSync` would answer false
			// for it — turning a permission error into permission to run.
			chmodSync(path.join(root, "config"), 0o000);
			try {
				const message = describePreviousInstallation();
				expect(message).toBeDefined();
				expect(message).toContain("cannot be examined");
			} finally {
				chmodSync(path.join(root, "config"), 0o755);
			}
		});

		it("does not claim a hub is running when the recorded pid is gone", () => {
			const stateDir = path.join(root, "state", "termora");
			mkdirSync(stateDir, { recursive: true });
			// A pid that cannot exist: the record is stale, so the directory is named
			// but nothing is asserted about a live process.
			writeFileSync(
				path.join(stateDir, "runtime.json"),
				JSON.stringify({ pid: 2 ** 30, port: 4100 }),
			);
			const message = describePreviousInstallation();
			expect(message).toContain(stateDir);
			expect(message).not.toContain("is running");
		});

		it("leaves the previous installation untouched", () => {
			const configDir = path.join(root, "config", "termora");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(path.join(configDir, "config.toml"), "port = 4100\n");
			describePreviousInstallation();
			expect(existsSync(path.join(configDir, "config.toml"))).toBe(true);
		});
	});

	it.skipIf(process.platform === "win32")("getConfigDir uses XDG_CONFIG_HOME when set", () => {
		const orig = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = "/tmp/xdg-cfg";
		expect(getConfigDir()).toBe("/tmp/xdg-cfg/lasterm");
		process.env.XDG_CONFIG_HOME = orig;
	});
});

describe("runtime state", () => {
	it.skipIf(process.platform === "win32")(
		"reports an unreadable runtime record as unknown instead of stopped",
		async () => {
			const originalStateRoot = process.env.XDG_STATE_HOME;
			const output: string[] = [];
			process.env.XDG_STATE_HOME = makeTempDir();
			const log = vi.spyOn(console, "log").mockImplementation((line: string) => output.push(line));
			try {
				mkdirSync(getStateDir(), { recursive: true });
				mkdirSync(path.join(getStateDir(), "runtime.json"));
				await cmdStatus(parsed(["status", "--json"]));
				expect(output).toEqual([expect.stringContaining('"running":"unknown"')]);
				await expect(cmdStop({ command: "stop" })).rejects.toThrow(
					/Cannot determine whether the hub is running/,
				);
			} finally {
				log.mockRestore();
				process.env.XDG_STATE_HOME = originalStateRoot;
			}
		},
	);

	it("does not confirm quit when the runtime record becomes unreadable", async () => {
		await expect(
			waitForHubQuit(
				{ pid: 123, instanceId: "target" },
				{
					loadRuntime: () => ({ kind: "unreadable", error: new Error("EIO") }),
					isPidAlive: () => false,
				},
			),
		).rejects.toThrow(/cannot be read/);
	});

	it.skipIf(process.platform === "win32")(
		"does not delete a replacement runtime from the stale stop path",
		async () => {
			const originalStateRoot = process.env.XDG_STATE_HOME;
			process.env.XDG_STATE_HOME = makeTempDir();
			const target = runtimeRecord({ instanceId: "target" });
			const replacement = runtimeRecord({ instanceId: "replacement" });
			try {
				persistRuntime(replacement);
				await cmdStop(
					{ command: "stop" },
					{ loadRuntime: () => ({ kind: "present", runtime: target }), isPidAlive: () => false },
				);
				expect(readRuntimeFile()).toMatchObject({ instanceId: "replacement" });
			} finally {
				deleteCurrentRuntime();
				process.env.XDG_STATE_HOME = originalStateRoot;
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not delete a replacement runtime from the stale quit path",
		async () => {
			const originalStateRoot = process.env.XDG_STATE_HOME;
			process.env.XDG_STATE_HOME = makeTempDir();
			const target = runtimeRecord({ instanceId: "target" });
			const replacement = runtimeRecord({ instanceId: "replacement" });
			try {
				persistRuntime(replacement);
				await expect(
					cmdQuit({
						loadRuntime: () => ({ kind: "present", runtime: target }),
						isPidAlive: () => false,
					}),
				).rejects.toThrow("Hub process is gone");
				expect(readRuntimeFile()).toMatchObject({ instanceId: "replacement" });
			} finally {
				deleteCurrentRuntime();
				process.env.XDG_STATE_HOME = originalStateRoot;
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"deletes a matching legacy record, whose identity is its complete legacy fields",
		() => {
			const originalStateRoot = process.env.XDG_STATE_HOME;
			process.env.XDG_STATE_HOME = makeTempDir();
			const legacy = runtimeRecord({ instanceId: undefined, ownerToken: undefined });
			try {
				persistRuntime(legacy);
				expect(runtimeMatches(legacy, legacy)).toBe(true);
				expect(deleteRuntime(legacy)).toBe(true);
				expect(loadRuntime()).toEqual({ kind: "absent" });
			} finally {
				process.env.XDG_STATE_HOME = originalStateRoot;
			}
		},
	);

	it("waitForHubQuit rejects a replacement published between its absence and liveness observations", async () => {
		let reads = 0;
		await expect(
			waitForHubQuit(
				{ pid: 123, instanceId: "target" },
				{
					loadRuntime: () => {
						reads++;
						return reads === 1
							? { kind: "absent" as const }
							: {
									kind: "present" as const,
									runtime: {
										pid: 456,
										port: 4100,
										started_at: "2026-08-03T00:00:00.000Z",
										instanceId: "replacement",
									},
								};
					},
					isPidAlive: () => false,
				},
			),
		).rejects.toThrow(/replacement hub/);
	});

	it("waitForHubQuit rejects a replacement runtime instead of mistaking it for its target", async () => {
		await expect(
			waitForHubQuit(
				{ pid: 123, instanceId: "target" },
				{
					loadRuntime: () => ({
						kind: "present",
						runtime: {
							pid: 456,
							port: 4100,
							started_at: "2026-08-03T00:00:00.000Z",
							instanceId: "replacement",
						},
					}),
					isPidAlive: () => false,
				},
			),
		).rejects.toThrow(/replacement hub/);
	});

	it("waitForHubQuit times out when teardown removes no runtime record", async () => {
		await expect(
			waitForHubQuit(
				{ pid: 123, instanceId: "target" },
				{
					loadRuntime: () => ({
						kind: "present",
						runtime: {
							pid: 123,
							port: 4100,
							started_at: "2026-08-03T00:00:00.000Z",
							instanceId: "target",
						},
					}),
					isPidAlive: () => true,
					timeoutMs: 0,
				},
			),
		).rejects.toThrow(/teardown was not confirmed/);
	});

	it("cmdQuit waits for teardown before reporting a failed agent stop", async () => {
		const observed: string[] = [];
		await expect(
			cmdQuit({
				loadRuntime: () => ({
					kind: "present",
					runtime: {
						pid: 123,
						port: 4100,
						started_at: "2026-08-03T00:00:00.000Z",
						instanceId: "target",
						ownerToken: "a".repeat(64),
					},
				}),
				isPidAlive: () => true,
				fetch: (async () => {
					observed.push("response");
					return new Response(JSON.stringify({ message: "agent stop failed" }), { status: 503 });
				}) as typeof fetch,
				waitForHubQuit: async () => {
					observed.push("waited");
				},
			}),
		).rejects.toThrow("agent stop failed");
		expect(observed).toEqual(["response", "waited"]);
	});

	// Mutation: recognise a conflict by its body rather than its status, and a
	// truncated 409 falls through to the teardown wait — fifteen seconds spent
	// observing a shutdown that a refusal never started.
	it("treats a 409 as a refusal even when its body says nothing", async () => {
		const errors: string[] = [];
		const observed: string[] = [];
		await expect(
			cmdQuit({
				loadRuntime: () => ({
					kind: "present",
					runtime: {
						pid: 123,
						port: 4100,
						started_at: "2026-08-03T00:00:00.000Z",
						instanceId: "target",
						ownerToken: "a".repeat(64),
					},
				}),
				isPidAlive: () => true,
				fetch: (async () => new Response("{trunc", { status: 409 })) as typeof fetch,
				isInteractive: () => false,
				waitForHubQuit: async () => {
					observed.push("waited");
				},
				writeError: (message) => errors.push(message),
			}),
		).rejects.toThrow("Refusing to override quit without an interactive confirmation");
		expect(observed).toEqual([]);
		expect(errors.join(" ")).toContain("did not say how many");
	});

	// Mutation: cast the parsed body to an object without checking, and a 409 whose
	// body is the valid JSON `null` throws a TypeError instead of refusing.
	it("treats a 409 whose body is valid non-object JSON as a refusal", async () => {
		const errors: string[] = [];
		await expect(
			cmdQuit({
				loadRuntime: () => ({
					kind: "present",
					runtime: {
						pid: 123,
						port: 4100,
						started_at: "2026-08-03T00:00:00.000Z",
						instanceId: "target",
						ownerToken: "a".repeat(64),
					},
				}),
				isPidAlive: () => true,
				fetch: (async () => new Response("null", { status: 409 })) as typeof fetch,
				isInteractive: () => false,
				writeError: (message) => errors.push(message),
			}),
		).rejects.toThrow("Refusing to override quit without an interactive confirmation");
		expect(errors.join(" ")).toContain("did not say how many");
	});

	// Mutation: let a transport rejection escape, and a quit the hub committed to —
	// latched, agent stopped, response lost — is reported as a failure that never
	// looked at whether the hub actually went.
	it("observes teardown when the quit response never arrives", async () => {
		const observed: string[] = [];
		await expect(
			cmdQuit({
				loadRuntime: () => ({
					kind: "present",
					runtime: {
						pid: 123,
						port: 4100,
						started_at: "2026-08-03T00:00:00.000Z",
						instanceId: "target",
						ownerToken: "a".repeat(64),
					},
				}),
				isPidAlive: () => true,
				fetch: (async () => {
					throw new Error("socket hang up");
				}) as typeof fetch,
				waitForHubQuit: async () => {
					observed.push("waited");
				},
				writeError: () => {},
			}),
		).rejects.toThrow("Quit request did not complete");
		expect(observed).toEqual(["waited"]);
	});

	it("reports connected clients and refuses to override quit when non-interactive", async () => {
		const errors: string[] = [];
		const request = vi.fn(async () => new Response(JSON.stringify({ others: 2 }), { status: 409 }));

		await expect(
			cmdQuit({
				loadRuntime: () => ({ kind: "present", runtime: runtimeRecord({ instanceId: "target" }) }),
				isPidAlive: () => true,
				fetch: request as typeof fetch,
				isInteractive: () => false,
				writeError: (message) => errors.push(message),
			}),
		).rejects.toThrow("Refusing to override quit without an interactive confirmation");

		expect(errors).toEqual([
			"Quit would end terminals for 2 connected client(s); this count is a snapshot.",
		]);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("sends the explicit quit override only after interactive confirmation", async () => {
		const urls: string[] = [];
		const output: string[] = [];
		const log = vi
			.spyOn(console, "log")
			.mockImplementation((message: string) => output.push(message));
		try {
			await cmdQuit({
				loadRuntime: () => ({ kind: "present", runtime: runtimeRecord({ instanceId: "target" }) }),
				isPidAlive: () => true,
				fetch: (async (url) => {
					urls.push(String(url));
					return urls.length === 1
						? new Response(JSON.stringify({ others: 1 }), { status: 409 })
						: new Response(
								JSON.stringify({ message: "Local agent stopped; hub is shutting down" }),
							);
				}) as typeof fetch,
				isInteractive: () => true,
				confirmQuit: async (others) => others === 1,
				writeError: () => {},
				waitForHubQuit: async () => {},
			});
		} finally {
			log.mockRestore();
		}

		expect(urls).toEqual([
			"https://127.0.0.1:456/api/quit",
			"https://127.0.0.1:456/api/quit?force=1",
		]);
		expect(output).toEqual(["Local agent stopped; hub is shutting down"]);
	});

	it("treats an unsignalable existing pid as alive", () => {
		const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
		vi.spyOn(process, "kill").mockImplementation((() => {
			throw permissionError;
		}) as never);
		expect(isPidAlive(123)).toBe(true);
		vi.restoreAllMocks();
	});

	it.skipIf(process.platform === "win32")(
		"persistRuntime writes ownerToken via a 0600 atomic replacement",
		() => {
			const orig = process.env.XDG_STATE_HOME;
			const stateRoot = makeTempDir();
			process.env.XDG_STATE_HOME = stateRoot;
			try {
				persistRuntime({
					pid: 123,
					port: 456,
					started_at: "2026-06-18T00:00:00.000Z",
					ownerToken: "b".repeat(64),
				});

				const runtimePath = path.join(getStateDir(), "runtime.json");
				const runtime = loadRuntime();
				expect(runtime.kind === "present" ? runtime.runtime.ownerToken : undefined).toBe(
					"b".repeat(64),
				);
				expect(statSync(runtimePath).mode & 0o777).toBe(0o600);
				expect(readdirSync(getStateDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
			} finally {
				deleteCurrentRuntime();
				process.env.XDG_STATE_HOME = orig;
			}
		},
	);

	it("cmdStop fails closed on owner-token shutdown errors without signaling the pid", async () => {
		const orig = process.env.XDG_STATE_HOME;
		const stateRoot = makeTempDir();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});

		process.env.XDG_STATE_HOME = stateRoot;
		try {
			if (child.pid === undefined) throw new Error("child pid missing");
			const port = await getUnusedPort();
			persistRuntime({
				pid: child.pid,
				port,
				started_at: "2026-06-18T00:00:00.000Z",
				ownerToken: "c".repeat(64),
			});

			await expect(cmdStop({ command: "stop" })).rejects.toThrow(
				/refusing SIGTERM fallback for owner-token hub/,
			);

			expect(existsSync(path.join(getStateDir(), "runtime.json"))).toBe(true);
			expect(isChildAlive(child)).toBe(true);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await waitForExit(child);
			}
			deleteCurrentRuntime();
			process.env.XDG_STATE_HOME = orig;
		}
	});

	it("cmdStop validates legacy process identity before signaling the pid", async () => {
		const orig = process.env.XDG_STATE_HOME;
		const stateRoot = makeTempDir();
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
		});

		process.env.XDG_STATE_HOME = stateRoot;
		try {
			if (child.pid === undefined) throw new Error("child pid missing");
			persistRuntime({
				pid: child.pid,
				port: await getUnusedPort(),
				started_at: "2026-06-18T00:00:00.000Z",
			});

			await expect(cmdStop({ command: "stop" })).rejects.toThrow(/Refusing to signal pid/);

			expect(existsSync(path.join(getStateDir(), "runtime.json"))).toBe(true);
			expect(isChildAlive(child)).toBe(true);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await waitForExit(child);
			}
			deleteCurrentRuntime();
			process.env.XDG_STATE_HOME = orig;
		}
	});
});

function parsed(argv: string[]): ParsedArgs {
	const result = parseArgs(argv);
	expect(result).not.toBeNull();
	return result as ParsedArgs;
}

function makeTempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "lasterm-cli-agent-fetch-"));
	tempDirs.push(dir);
	return dir;
}

function deleteCurrentRuntime(): void {
	const result = loadRuntime();
	if (result.kind === "present") deleteRuntime(result.runtime);
}

function runtimeRecord(overrides: Partial<import("./cli.js").RuntimeInfo> = {}) {
	return {
		pid: 123,
		port: 456,
		started_at: "2026-08-03T00:00:00.000Z",
		ownerToken: "a".repeat(64),
		...overrides,
	};
}

function readRuntimeFile(): unknown {
	return JSON.parse(readFileSync(path.join(getStateDir(), "runtime.json"), "utf-8"));
}

function getUnusedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				server.close();
				reject(new Error("expected TCP address"));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}

function isChildAlive(child: ReturnType<typeof spawn>): boolean {
	if (child.pid === undefined) return false;
	try {
		process.kill(child.pid, 0);
		return true;
	} catch {
		return false;
	}
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		child.once("exit", () => resolve());
	});
}

function agentCachePath(cacheDir: string, osName: string, arch: string, version: string): string {
	const target = AGENT_TARGET_TABLE[osName]?.[arch];
	if (!target) throw new Error(`unknown target ${osName}-${arch}`);
	return path.join(cacheDir, `lasterm-agent-${osName}-${arch}-${version}${target.ext}`);
}

function versionedAssetName(osName: string, arch: string, version: string): string {
	const target = AGENT_TARGET_TABLE[osName]?.[arch];
	if (!target?.triple) throw new Error(`unsupported test target ${osName}-${arch}`);
	return `lasterm-agent-${target.triple}-${version}${target.ext}`;
}

function sums(fileName: string, body: string): string {
	return `${createHash("sha256").update(body).digest("hex")}  ${fileName}\n`;
}

function listTempFiles(cacheDir: string): string[] {
	return existsSync(cacheDir)
		? readdirSync(cacheDir)
				.filter((name) => name.endsWith(".tmp"))
				.sort()
		: [];
}

function builtAgentTargetIds(): string[] {
	const ids: string[] = [];
	for (const [osName, arches] of Object.entries(AGENT_TARGET_TABLE)) {
		if (!arches) continue;
		for (const [arch, target] of Object.entries(arches)) {
			if (target.built && target.triple) ids.push(`${osName}-${arch}`);
		}
	}
	return ids;
}
