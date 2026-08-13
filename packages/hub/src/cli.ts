/**
 * lasterm CLI
 *
 * Parses process.argv and dispatches to hub commands.
 * No heavy deps — manual argv parsing only.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fchmodSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	buildDaemonSpawnPlan,
	type ChildExitState,
	type DaemonReadyResult,
	openDaemonLog,
	readDaemonLogTail,
	waitForDaemonReady,
} from "./daemon-launch.js";
import { createHubTlsAgent } from "./hub-transport.js";
import { detectSea } from "./sea-addon-loader.js";
import {
	AGENT_FETCH_MANIFEST_MAX_BYTES,
	AGENT_FETCH_MAX_BYTES,
	AGENT_TARGET_TRIPLES,
	createUniqueTempPath,
	ensureCacheDir,
	FetchError,
	isCacheDirSecure,
	isTrustedCacheBinary,
	pruneAgentBinaryCache,
	removeFileIfPresent,
	resolveTarget,
	validateAgentVersion,
	verifyAndPlace,
} from "./session/agent-cache.js";
import { type FetchAgentBinaryOptions, fetchAgentBinary } from "./session/agent-fetch.js";
import {
	type AgentTargetStatusSnapshot,
	type AgentVersionReader,
	type ComputeTargetStatusOptions,
	computeTargetStatus,
	getHubPlatform,
} from "./session/agent-status.js";

// ─── Platform paths ────────────────────────────────────────────────────────────

export function getStateDir(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA ?? "", "lasterm");
	}
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "lasterm");
}

export function getConfigDir(): string {
	if (process.platform === "win32") {
		return join(process.env.APPDATA ?? "", "lasterm");
	}
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "lasterm");
}

// ─── Runtime state ─────────────────────────────────────────────────────────────

export interface RuntimeInfo {
	pid: number;
	port: number;
	started_at: string;
	/** Unique per hub process; prevents a quit waiter mistaking a replacement for its target. */
	instanceId?: string;
	ownerToken?: string;
	/** Base64 DER SubjectPublicKeyInfo for the TLS identity serving this port. */
	spki?: string;
}

const HUB_QUIT_OBSERVE_TIMEOUT_MS = 15_000;
const HUB_QUIT_OBSERVE_POLL_MS = 50;

export type RuntimeLoadResult =
	| { kind: "absent" }
	| { kind: "present"; runtime: RuntimeInfo }
	| { kind: "unreadable"; error: unknown };

/** Read absence is distinct from every failure to read or parse the record. */
export function loadRuntime(): RuntimeLoadResult {
	const p = join(getStateDir(), "runtime.json");
	try {
		return { kind: "present", runtime: JSON.parse(readFileSync(p, "utf-8")) as RuntimeInfo };
	} catch (error) {
		if (isFileNotFound(error)) return { kind: "absent" };
		return { kind: "unreadable", error };
	}
}

export function persistRuntime(info: RuntimeInfo): void {
	const stateDir = getStateDir();
	mkdirSync(stateDir, { recursive: true });
	const runtimePath = join(stateDir, "runtime.json");
	const tempPath = createRuntimeTempPath(runtimePath);
	let fd: number | null = openSync(tempPath, "wx", 0o600);
	let renamed = false;
	try {
		writeFileSync(fd, JSON.stringify(info, null, 2), { encoding: "utf8" });
		fchmodSync(fd, 0o600);
		closeSync(fd);
		fd = null;
		renameSync(tempPath, runtimePath);
		renamed = true;
	} finally {
		if (fd !== null) closeSync(fd);
		if (!renamed) rmSync(tempPath, { force: true });
	}
}

function createRuntimeTempPath(runtimePath: string): string {
	for (let attempt = 0; attempt < 32; attempt++) {
		const tempPath = `${runtimePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
		if (!existsSync(tempPath)) return tempPath;
	}
	throw new Error(`Could not allocate a unique temp file beside ${runtimePath}`);
}

/**
 * Legacy records have no instanceId. They match only another legacy record with
 * every persisted identity field equal; a modern replacement can never match it.
 */
export function runtimeMatches(expected: RuntimeInfo, current: RuntimeInfo): boolean {
	if (expected.instanceId !== undefined) return current.instanceId === expected.instanceId;
	return (
		current.instanceId === undefined &&
		current.pid === expected.pid &&
		current.port === expected.port &&
		current.started_at === expected.started_at &&
		current.ownerToken === expected.ownerToken
	);
}

/** Remove the record only if a fresh read still identifies this runtime. */
export function deleteRuntime(expected: RuntimeInfo): boolean {
	const p = join(getStateDir(), "runtime.json");
	const current = loadRuntime();
	if (current.kind !== "present" || !runtimeMatches(expected, current.runtime)) return false;
	rmSync(p);
	return true;
}

function isFileNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function describeRuntimeReadFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH is the only definite absence. EPERM proves the process exists;
		// every other failure is ambiguous and must fail closed as live.
		return !(
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			(err as { code?: unknown }).code === "ESRCH"
		);
	}
}

function assertHubProcessIdentity(pid: number): void {
	const command = readProcessCommandLine(pid);
	if (command !== null && commandLooksLikeLastermHub(command)) return;

	const detail =
		command === null ? "process command line could not be read" : summarizeCommand(command);
	throw new Error(`Refusing to signal pid ${pid}: ${detail}`);
}

function readProcessCommandLine(pid: number): string | null {
	if (process.platform === "linux") {
		try {
			const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
			if (command.length > 0) return command;
		} catch {
			// Fall back to ps below.
		}
	}

	try {
		if (process.platform === "win32") {
			const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`;
			const command = execFileSync(
				"powershell",
				["-NoProfile", "-NonInteractive", "-Command", script],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			).trim();
			return command.length > 0 ? command : null;
		}

		const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return command.length > 0 ? command : null;
	} catch {
		return null;
	}
}

function commandLooksLikeLastermHub(command: string): boolean {
	const normalized = command.toLowerCase();
	return (
		normalized.includes("lasterm-hub") ||
		normalized.includes("lasterm_hub") ||
		normalized.includes("@lasterm/hub") ||
		normalized.includes("packages/hub/src") ||
		normalized.includes("packages\\hub\\src")
	);
}

function summarizeCommand(command: string): string {
	return command.length > 160 ? `${command.slice(0, 157)}...` : command;
}

// ─── Auth helpers ──────────────────────────────────────────────────────────────

function loadAuthToken(): string | null {
	const p = join(getConfigDir(), "auth.json");
	if (!existsSync(p)) return null;
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8")) as { token?: string };
		return parsed.token ?? null;
	} catch {
		return null;
	}
}

// ─── HTTP client ───────────────────────────────────────────────────────────────

async function apiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
	const runtimeResult = loadRuntime();
	if (runtimeResult.kind === "absent") {
		throw new Error("Hub is not running (no runtime.json found)");
	}
	if (runtimeResult.kind === "unreadable") {
		throw new Error(
			`Cannot read hub runtime record: ${describeRuntimeReadFailure(runtimeResult.error)}`,
		);
	}
	const { runtime } = runtimeResult;

	const token = loadAuthToken();
	const headers: Record<string, string> = {};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await requestHub(runtime, path, {
		method,
		headers,
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`HTTP ${res.status}: ${text}`);
	}

	const ct = res.headers.get("content-type") ?? "";
	if (ct.includes("application/json")) {
		return res.json();
	}
	return res.text();
}

type HubRequestInit = {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
};

function hubUrl(runtime: RuntimeInfo, path: string): URL {
	return new URL(path, `https://127.0.0.1:${runtime.port}`);
}

/** The sole local-hub transport. Credentials are added only after TLS pinning. */
export async function requestHub(
	runtime: RuntimeInfo,
	path: string,
	init: HubRequestInit = {},
): Promise<Response> {
	const agent = createHubTlsAgent(runtime);
	const url = hubUrl(runtime, path);
	return new Promise<Response>((resolve, reject) => {
		const request = httpsRequest(
			url,
			{
				method: init.method ?? "GET",
				headers: init.headers,
				agent,
				signal: init.signal,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("error", reject);
				response.on("end", () => {
					const status = response.statusCode ?? 500;
					// Fetch requires a null body for these statuses and for HEAD,
					// even when Node gave us an empty Buffer.
					const responseBody =
						init.method === "HEAD" || status === 204 || status === 205 || status === 304
							? null
							: Buffer.concat(chunks);
					resolve(
						new Response(responseBody, {
							status,
							headers: response.headers as Record<string, string>,
						}),
					);
				});
			},
		);
		request.on("error", reject);
		request.end(init.body);
	});
}

// ─── Argument parser ───────────────────────────────────────────────────────────

export interface ParsedArgs {
	command: string;
	// start
	port?: number;
	daemon?: boolean;
	// host add
	label?: string;
	host?: string;
	sshPort?: number;
	user?: string;
	authMethod?: string;
	keyPath?: string;
	// pair verify
	code?: string;
	// agent fetch
	target?: string;
	version?: string;
	all?: boolean;
	prune?: boolean;
	// agent import
	binaryPath?: string;
	manifestPath?: string;
	agentOs?: string;
	agentArch?: string;
	attest?: boolean;
	force?: boolean;
	// json output flag
	json?: boolean;
	// auto-open browser after start
	open?: boolean;
}

/**
 * Parse a flat argv array into a structured ParsedArgs.
 * Returns null if no command could be determined.
 */
export function parseArgs(argv: string[]): ParsedArgs | null {
	if (argv.length === 0) return null;

	const args = [...argv];
	const result: ParsedArgs = { command: "" };

	// Helper: consume a flag value (removes both flag and value from args)
	function flagValue(flag: string): string | undefined {
		const idx = args.indexOf(flag);
		if (idx === -1) return undefined;
		const val = args[idx + 1];
		args.splice(idx, 2);
		return val;
	}

	function hasFlag(flag: string): boolean {
		const idx = args.indexOf(flag);
		if (idx === -1) return false;
		args.splice(idx, 1);
		return true;
	}

	// Consume named flags first (order-independent)
	const portStr = flagValue("--port");
	if (portStr !== undefined) result.port = Number.parseInt(portStr, 10);

	const labelVal = flagValue("--label");
	if (labelVal !== undefined) result.label = labelVal;

	const hostVal = flagValue("--host");
	if (hostVal !== undefined) result.host = hostVal;

	const sshPortStr = flagValue("--ssh-port");
	if (sshPortStr !== undefined) result.sshPort = Number.parseInt(sshPortStr, 10);

	const userVal = flagValue("--user");
	if (userVal !== undefined) result.user = userVal;

	const authVal = flagValue("--auth");
	if (authVal !== undefined) result.authMethod = authVal;

	const keyPathVal = flagValue("--key-path");
	if (keyPathVal !== undefined) result.keyPath = keyPathVal;

	const codeVal = flagValue("--code");
	if (codeVal !== undefined) result.code = codeVal;

	const versionVal = flagValue("--version");
	if (versionVal !== undefined) result.version = versionVal;

	const agentOsVal = flagValue("--os");
	if (agentOsVal !== undefined) result.agentOs = agentOsVal;

	const agentArchVal = flagValue("--arch");
	if (agentArchVal !== undefined) result.agentArch = agentArchVal;

	if (hasFlag("--daemon")) result.daemon = true;
	if (hasFlag("--json")) result.json = true;
	if (hasFlag("--open")) result.open = true;
	if (hasFlag("--all")) result.all = true;
	if (hasFlag("--prune")) result.prune = true;
	if (hasFlag("--attest")) result.attest = true;
	if (hasFlag("--force")) result.force = true;

	// Positional: remaining args after flag removal
	const positional = args.filter((a) => !a.startsWith("-"));

	const sub0 = positional[0];
	const sub1 = positional[1];
	const sub2 = positional[2];
	const sub3 = positional[3];

	if (!sub0) return null;

	if (sub0 === "start") {
		result.command = "start";
	} else if (sub0 === "stop") {
		result.command = "stop";
	} else if (sub0 === "quit") {
		result.command = "quit";
	} else if (sub0 === "status") {
		result.command = "status";
	} else if (sub0 === "host") {
		if (sub1 === "add") {
			result.command = "host-add";
		} else if (sub1 === "list") {
			result.command = "host-list";
		} else if (sub1 === "remove") {
			result.command = "host-remove";
			if (!result.label && sub2) result.label = sub2;
		} else {
			return null;
		}
	} else if (sub0 === "agent") {
		if (sub1 === "fetch") {
			result.command = "agent-fetch";
			if (sub2) result.target = sub2;
		} else if (sub1 === "status") {
			result.command = "agent-status";
		} else if (sub1 === "import") {
			result.command = "agent-import";
			if (sub2) result.binaryPath = sub2;
			if (sub3) result.manifestPath = sub3;
		} else {
			return null;
		}
	} else if (sub0 === "session") {
		if (sub1 === "list") {
			result.command = "session-list";
		} else {
			return null;
		}
	} else if (sub0 === "pair") {
		result.command = "pair";
	} else if (sub0 === "config") {
		if (sub1 === "edit") {
			result.command = "config-edit";
		} else {
			return null;
		}
	} else {
		return null;
	}

	return result;
}

// ─── Agent fetch helpers ──────────────────────────────────────────────────────

type AgentFetchTarget = {
	readonly os: string;
	readonly arch: string;
};

type AgentBinaryFetcher = (options: FetchAgentBinaryOptions) => Promise<string>;

export interface AgentFetchCommandDeps {
	readonly fetchAgentBinary?: AgentBinaryFetcher;
	readonly getBinaryCacheDir?: () => string | Promise<string>;
	readonly hubVersion?: string;
	readonly writeLine?: (line: string) => void;
	readonly writeError?: (line: string) => void;
}

export interface AgentStatusCommandDeps {
	readonly getBinaryCacheDir?: () => string | Promise<string>;
	readonly hubVersion?: string;
	readonly versionReader?: AgentVersionReader;
	readonly resolveAgentBinaryPath?: () => string | null;
	readonly hubPlatform?: ComputeTargetStatusOptions["hubPlatform"];
	readonly writeLine?: (line: string) => void;
}

export interface AgentImportCommandDeps {
	readonly getBinaryCacheDir?: () => string | Promise<string>;
	readonly hubPlatform?: ComputeTargetStatusOptions["hubPlatform"];
	readonly writeLine?: (line: string) => void;
	readonly writeError?: (line: string) => void;
}

async function defaultHubVersion(): Promise<string> {
	const { HUB_VERSION } = await import("./build-version.js");
	return HUB_VERSION;
}

async function defaultBinaryCacheDir(): Promise<string> {
	const { getBinaryCacheDir } = await import("./session/agent-deployer.js");
	return getBinaryCacheDir();
}

function builtAgentTargets(): AgentFetchTarget[] {
	const targets: AgentFetchTarget[] = [];
	for (const [os, arches] of Object.entries(AGENT_TARGET_TRIPLES)) {
		if (!arches) continue;
		for (const [arch, target] of Object.entries(arches)) {
			if (target.built && target.triple) targets.push({ os, arch });
		}
	}
	return targets;
}

function parseAgentTargetId(value: string): AgentFetchTarget | null {
	const parts = value.split("-");
	if (parts.length !== 2) return null;
	const [os, arch] = parts;
	if (!os || !arch) return null;
	return { os, arch };
}

function resolveAgentFetchTargets(args: ParsedArgs): AgentFetchTarget[] | string {
	if (args.all && args.target) {
		return "Choose either an agent target or --all, not both.";
	}
	if (args.all) return builtAgentTargets();
	if (!args.target) {
		return "Usage: lasterm agent fetch <os-arch>|--all [--version <x.y.z>] [--prune]";
	}
	const target = parseAgentTargetId(args.target);
	if (!target) {
		return `Invalid agent target "${args.target}". Use <os-arch>, for example linux-arm64.`;
	}
	return [target];
}

function cachePathForBuiltTarget(
	cacheDir: string,
	target: AgentFetchTarget,
	version: string,
): string | null {
	const entry = resolveTarget(target.os, target.arch);
	if (!entry) return null;
	return join(cacheDir, `lasterm-agent-${target.os}-${target.arch}-${version}${entry.ext}`);
}

export async function cmdAgentFetch(
	args: ParsedArgs,
	deps: AgentFetchCommandDeps = {},
): Promise<number> {
	const writeLine = deps.writeLine ?? ((line: string) => console.log(line));
	const writeError = deps.writeError ?? ((line: string) => console.error(line));
	const targets = resolveAgentFetchTargets(args);
	if (typeof targets === "string") {
		writeError(targets);
		return 1;
	}

	const version = args.version ?? deps.hubVersion ?? (await defaultHubVersion());
	try {
		validateAgentVersion(version);
	} catch (error) {
		if (!(error instanceof FetchError)) throw error;
		writeError(error.message);
		return 1;
	}

	const cacheDir = await (deps.getBinaryCacheDir ?? defaultBinaryCacheDir)();
	const fetcher = deps.fetchAgentBinary ?? fetchAgentBinary;
	let failed = false;

	for (const target of targets) {
		const existing = cachePathForBuiltTarget(cacheDir, target, version);
		// Only report "already cached" for an entry the deployer would actually
		// trust: a regular file (not a dir/symlink/tampered entry) owned by us, in a
		// secure cache dir. Anything else falls through to a fresh, checksum-verified
		// fetch that atomically replaces it.
		if (existing && isCacheDirSecure(cacheDir) && isTrustedCacheBinary(existing)) {
			writeLine(`already cached ${existing}`);
			continue;
		}

		try {
			const path = await fetcher({
				os: target.os,
				arch: target.arch,
				version,
				cacheDir,
			});
			writeLine(path);
		} catch (error) {
			failed = true;
			const message = error instanceof Error ? error.message : String(error);
			writeLine(message);
		}
	}

	if (args.prune) pruneAgentBinaryCache(cacheDir, version);
	return failed ? 1 : 0;
}

export async function cmdAgentStatus(
	args: ParsedArgs,
	deps: AgentStatusCommandDeps = {},
): Promise<number> {
	const writeLine = deps.writeLine ?? ((line: string) => console.log(line));
	const cacheDir = await (deps.getBinaryCacheDir ?? defaultBinaryCacheDir)();
	const snapshot = await computeTargetStatus({
		cacheDir,
		...(deps.hubVersion !== undefined && { hubVersion: deps.hubVersion }),
		...(deps.versionReader !== undefined && { versionReader: deps.versionReader }),
		...(deps.resolveAgentBinaryPath !== undefined && {
			resolveAgentBinaryPath: deps.resolveAgentBinaryPath,
		}),
		...(deps.hubPlatform !== undefined && { hubPlatform: deps.hubPlatform }),
	});

	if (args.json) {
		writeLine(JSON.stringify(snapshot));
		return 0;
	}

	printAgentStatusTable(snapshot, writeLine);
	return 0;
}

export async function cmdAgentImport(
	args: ParsedArgs,
	deps: AgentImportCommandDeps = {},
): Promise<number> {
	const writeLine = deps.writeLine ?? ((line: string) => console.log(line));
	const writeError = deps.writeError ?? ((line: string) => console.error(line));
	const usage =
		"Usage: lasterm agent import <binary> <manifest> --os <os> --arch <arch> --version <x.y.z> --attest [--force]";

	if (!args.binaryPath || !args.manifestPath || !args.agentOs || !args.agentArch || !args.version) {
		writeError(usage);
		return 1;
	}
	if (!args.attest) {
		writeError("agent import requires --attest after operator verification of the source.");
		return 1;
	}

	const target = resolveTarget(args.agentOs, args.agentArch);
	if (!target) {
		writeError(`No Lasterm agent release is built for ${args.agentOs}/${args.agentArch}.`);
		return 1;
	}

	try {
		validateAgentVersion(args.version);
	} catch (error) {
		if (!(error instanceof FetchError)) throw error;
		writeError(error.message);
		return 1;
	}

	const hubPlatform =
		deps.hubPlatform === undefined
			? getHubPlatform(process.platform, process.arch)
			: deps.hubPlatform;
	if (hubPlatform?.os === args.agentOs && hubPlatform.arch === args.agentArch) {
		writeError(
			`The hub platform target ${args.agentOs}/${args.agentArch} is served by the bundled agent and is not imported into the cache.`,
		);
		return 1;
	}

	const binarySize = statSync(args.binaryPath).size;
	if (binarySize > AGENT_FETCH_MAX_BYTES) {
		writeError("Agent binary exceeds the 64 MiB Lasterm agent limit.");
		return 1;
	}
	const manifestSize = statSync(args.manifestPath).size;
	if (manifestSize > AGENT_FETCH_MANIFEST_MAX_BYTES) {
		writeError(`Checksum manifest exceeds the ${AGENT_FETCH_MANIFEST_MAX_BYTES} byte limit.`);
		return 1;
	}

	const cacheDir = await (deps.getBinaryCacheDir ?? defaultBinaryCacheDir)();
	const finalPath = join(
		cacheDir,
		`lasterm-agent-${args.agentOs}-${args.agentArch}-${args.version}${target.ext}`,
	);
	let tempPath: string | null = null;
	try {
		ensureCacheDir(cacheDir);
		tempPath = createUniqueTempPath(finalPath);
		copyFileSync(args.binaryPath, tempPath);
		const placed = verifyAndPlace(
			tempPath,
			`lasterm-agent-${target.triple}-${args.version}${target.ext}`,
			readFileSync(args.manifestPath, "utf8"),
			cacheDir,
			{ force: args.force === true },
		);
		tempPath = null;
		writeLine(placed);
		return 0;
	} catch (error) {
		if (tempPath) removeFileIfPresent(tempPath);
		const message = error instanceof Error ? error.message : String(error);
		writeError(message);
		return 1;
	}
}

function printAgentStatusTable(
	snapshot: AgentTargetStatusSnapshot,
	writeLine: (line: string) => void,
): void {
	const pad = (value: string, width: number) => value.padEnd(width);
	writeLine(`Hub version: ${snapshot.hub_version}`);
	writeLine(`${pad("TARGET", 16)}  ${pad("STATUS", 11)}  ${pad("VERSION", 12)}  EXPECTED`);
	writeLine(`${"-".repeat(16)}  ${"-".repeat(11)}  ${"-".repeat(12)}  ${"-".repeat(8)}`);
	for (const target of snapshot.targets) {
		writeLine(
			`${pad(`${target.os}/${target.arch}`, 16)}  ${pad(target.status, 11)}  ${pad(target.version ?? "-", 12)}  ${target.expected_version}`,
		);
	}
}

// ─── Command handlers ──────────────────────────────────────────────────────────

export async function cmdStart(args: ParsedArgs): Promise<void> {
	// A previous installation is refused by `startHub`, not here: the check belongs
	// to the operation that constructs a hub, so the daemon child and `pnpm dev`
	// cannot reach it by another door. This handler only renders the refusal.
	const port = args.port;

	if (args.daemon) {
		const stateDir = getStateDir();
		mkdirSync(stateDir, { recursive: true });
		const logPath = join(stateDir, "hub-daemon.log");
		const logFd = openDaemonLog(logPath);
		const plan = buildDaemonSpawnPlan({
			sea: detectSea(),
			...(port !== undefined ? { port } : {}),
			...(args.open ? { open: true } : {}),
			moduleUrl: import.meta.url,
		});
		let childExit: ChildExitState = { exited: false };
		const child = spawn(process.execPath, plan.args, {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: {
				...process.env,
				...plan.env,
			},
		});
		child.on("exit", (code, signal) => {
			childExit = { exited: true, code, signal };
		});
		child.on("error", (err) => {
			childExit = { exited: true, code: null, signal: null, errorMessage: err.message };
		});
		child.unref();
		if (child.pid === undefined) {
			console.error("Failed to start daemon process: child pid was not reported");
			closeSync(logFd);
			process.exit(1);
		}
		const childPid = child.pid;

		// Single source of truth for both probe bounds (socket abort + race).
		const healthTimeoutMs = 2000;
		let result: DaemonReadyResult;
		try {
			result = await waitForDaemonReady({
				childPid,
				loadRuntime,
				fetchHealth: async (runtimePort) => {
					// Abort a stalled probe so the socket is not left hanging open.
					const current = loadRuntime();
					if (current.kind !== "present" || current.runtime.port !== runtimePort) {
						throw new Error("Hub runtime changed before its health check");
					}
					const res = await requestHub(current.runtime, "/api/health", {
						signal: AbortSignal.timeout(healthTimeoutMs),
					});
					if (!res.ok) {
						throw new Error(`Health check failed with HTTP ${res.status}`);
					}
					return res.json();
				},
				getChildExit: () => childExit,
				readLogTail: () => readDaemonLogTail(logPath),
				// Kill via the ChildProcess handle: a raw process.kill(pid) could
				// hit an unrelated process if the OS reused the pid.
				killChild: () => {
					child.kill("SIGTERM");
				},
				now: () => Date.now(),
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				healthTimeoutMs,
			});
		} catch (err) {
			closeSync(logFd);
			throw err;
		}

		closeSync(logFd);
		if (result.ok) {
			console.log(`Hub daemon ready (pid ${result.pid} on port ${result.port})`);
			process.exit(0);
		}

		console.error(result.message);
		process.exit(result.reason === "already-running" ? 73 : 1);
	}

	// Foreground — the shared startup function owns the lock and the complete
	// server lifecycle, so this path cannot diverge from daemon startup.
	const { startHub } = await import("./hub-startup.js");
	const { BUILD_HASH } = await import("./build-version.js");
	const { PreviousInstallationError } = await import("./previous-installation.js");
	try {
		await startHub({
			...(port !== undefined ? { port } : {}),
			openBrowser: args.open === true || process.env.LASTERM_OPEN === "1",
			announce: ({ address, spki, configDir, stateDir }) => {
				// This line is consumed by the desktop parent from the child's stdout.
				// Unlike runtime.json, another process cannot replace that pipe, so it is
				// the first-use anchor for the desktop's hub SPKI pin.
				console.log(`lasterm hub listening on ${address} (spki: ${spki}) (build: ${BUILD_HASH})`);
				console.log(`Config dir : ${configDir}`);
				console.log(`State dir  : ${stateDir}`);
			},
		});
	} catch (err) {
		// A refusal is a diagnosis, not a crash: print what it found, not a stack.
		if (err instanceof PreviousInstallationError) {
			console.error(err.message);
			process.exitCode = 1;
			return;
		}
		throw err;
	}
}

export async function cmdStop(
	args: ParsedArgs = { command: "stop" },
	options: {
		loadRuntime?: () => RuntimeLoadResult;
		isPidAlive?: (pid: number) => boolean;
	} = {},
): Promise<void> {
	const readRuntime = options.loadRuntime ?? loadRuntime;
	const alive = options.isPidAlive ?? isPidAlive;
	const runtimeResult = readRuntime();
	if (runtimeResult.kind === "absent") {
		console.error("Hub is not running (no runtime.json)");
		process.exit(1);
	}
	if (runtimeResult.kind === "unreadable") {
		throw new Error(
			`Cannot determine whether the hub is running: ${describeRuntimeReadFailure(runtimeResult.error)}`,
		);
	}
	const { runtime } = runtimeResult;
	if (!alive(runtime.pid)) {
		if (deleteRuntime(runtime)) {
			console.log("Hub process is gone — cleaned up stale runtime.json");
		} else {
			console.log("Hub process is gone — runtime.json changed, leaving it alone");
		}
		return;
	}

	if (runtime.ownerToken) {
		try {
			const force = args.force === true ? "?force=1" : "";
			const res = await requestHub(runtime, `/api/shutdown${force}`, {
				method: "POST",
				headers: {
					"X-Lasterm-Owner": runtime.ownerToken,
				},
				signal: AbortSignal.timeout(2_000),
			});
			if (res.ok) {
				console.log(`Requested graceful hub shutdown (pid ${runtime.pid})`);
				return;
			}
			if (res.status === 409) {
				const body = (await res.json().catch(() => ({}))) as { others?: number };
				const others = typeof body.others === "number" ? body.others : "other";
				console.error(
					`Hub has ${others} other connected client(s); rerun with --force to stop anyway.`,
				);
				process.exit(1);
			}
			throw new Error(`HTTP ${res.status}`);
		} catch (err) {
			if (!alive(runtime.pid)) {
				console.log(`Hub process stopped before shutdown confirmation (pid ${runtime.pid})`);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Graceful shutdown request failed; refusing SIGTERM fallback for owner-token hub: ${message}`,
			);
		}
	}

	assertHubProcessIdentity(runtime.pid);
	process.kill(runtime.pid, "SIGTERM");
	console.log(`Sent SIGTERM to hub (pid ${runtime.pid})`);
}

/** Stop the validated local agent and then the hub. Unlike `stop`, sessions do not survive. */
export async function cmdQuit(
	options: {
		loadRuntime?: () => RuntimeLoadResult;
		isPidAlive?: (pid: number) => boolean;
		fetch?: typeof fetch;
		waitForHubQuit?: (target: Required<Pick<RuntimeInfo, "pid" | "instanceId">>) => Promise<void>;
		isInteractive?: () => boolean;
		/** `null` when the hub refused without saying how many clients are connected. */
		confirmQuit?: (others: number | null) => Promise<boolean>;
		writeError?: (message: string) => void;
	} = {},
): Promise<void> {
	const readRuntime = options.loadRuntime ?? loadRuntime;
	const alive = options.isPidAlive ?? isPidAlive;
	const wait = options.waitForHubQuit ?? waitForHubQuit;
	const interactive = options.isInteractive ?? (() => process.stdin.isTTY && process.stdout.isTTY);
	const confirm = options.confirmQuit ?? confirmQuit;
	const writeError = options.writeError ?? console.error;
	const runtimeResult = readRuntime();
	if (runtimeResult.kind === "absent") throw new Error("Hub is not running (no runtime.json)");
	if (runtimeResult.kind === "unreadable") {
		throw new Error(
			`Cannot determine whether the hub is running: ${describeRuntimeReadFailure(runtimeResult.error)}`,
		);
	}
	const { runtime } = runtimeResult;
	if (!alive(runtime.pid)) {
		deleteRuntime(runtime);
		throw new Error("Hub process is gone");
	}
	if (!runtime.ownerToken) {
		throw new Error("Hub runtime has no owner token; refusing unauthenticated quit");
	}
	if (!runtime.instanceId) {
		throw new Error("Hub runtime has no instance identity; refusing an unobservable quit");
	}
	const target = { pid: runtime.pid, instanceId: runtime.instanceId };

	// Sending the request commits the hub: it may latch, stop the agent and exit
	// whether or not the answer ever arrives here. So a lost or timed-out response
	// is not a failed quit, it is an unobserved one, and the only honest next move
	// is to go and look.
	const postQuit = async (query: string): Promise<QuitResponse> => {
		try {
			const init = {
				method: "POST",
				headers: { "X-Lasterm-Owner": runtime.ownerToken as string },
				signal: AbortSignal.timeout(HUB_QUIT_OBSERVE_TIMEOUT_MS),
			};
			const res = options.fetch
				? await options.fetch(hubUrl(runtime, `/api/quit${query}`), init)
				: await requestHub(runtime, `/api/quit${query}`, init);
			return { status: res.status, ok: res.ok, body: await readQuitBody(res) };
		} catch (error) {
			return { status: null, ok: false, body: {}, transportError: error };
		}
	};

	let answer = await postQuit("");
	// A 409 is a refusal whatever its body says. Reading the count is how the
	// message gets a number in it, not how the refusal is recognised — a truncated
	// body, or one that is valid JSON but not an object, must not turn a conflict
	// into something to wait out.
	if (answer.status === 409) {
		const others = quitClientCount(answer.body.others);
		writeError(
			others === null
				? "Quit would end terminals for other connected clients; the hub did not say how many."
				: `Quit would end terminals for ${others} connected client(s); this count is a snapshot.`,
		);
		if (!interactive()) {
			throw new Error("Refusing to override quit without an interactive confirmation");
		}
		if (!(await confirm(others))) {
			throw new Error("Quit cancelled");
		}
		answer = await postQuit("?force=1");
		// A refusal latches nothing, so a second refusal leaves nothing to observe.
		if (answer.status === 409) {
			throw new Error(answer.body.message ?? "Quit was refused again; nothing was stopped");
		}
	}
	const response = { ok: answer.ok, status: answer.status };
	const body = answer.body;
	if (answer.transportError !== undefined) {
		writeError(
			`Quit request did not complete: ${answer.transportError instanceof Error ? answer.transportError.message : String(answer.transportError)}. Checking whether the hub stopped anyway.`,
		);
	}
	const failure = response.ok
		? null
		: new Error(
				body.message ??
					(response.status === null
						? "Quit request did not complete"
						: `Quit failed (HTTP ${response.status})`),
			);
	// The hub schedules teardown after every stopper result, including a 503, and
	// including one whose answer never arrived. Observe that teardown before
	// reporting anything to the caller.
	try {
		await wait(target);
	} catch (err) {
		if (!failure) throw err;
	}
	if (failure) throw failure;
	console.log(body.message ?? "Local agent stopped; hub is shutting down");
}

interface QuitResponseBody {
	message?: string;
	others?: unknown;
}

interface QuitResponse {
	/** `null` when the request never produced one. */
	readonly status: number | null;
	readonly ok: boolean;
	readonly body: QuitResponseBody;
	readonly transportError?: unknown;
}

/** Valid JSON is not necessarily an object: `null`, a number and a string all parse. */
async function readQuitBody(response: Response): Promise<QuitResponseBody> {
	const parsed: unknown = await response.json().catch(() => null);
	if (typeof parsed !== "object" || parsed === null) return {};
	return parsed as QuitResponseBody;
}

/** A count the hub did not give, or gave nonsensically, names nobody rather than lying. */
function quitClientCount(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

async function confirmQuit(others: number | null): Promise<boolean> {
	const subject = others === null ? "other connected clients" : `${others} connected client(s)`;
	const prompt = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await prompt.question(`Type quit to end terminals for ${subject}: `);
		return answer.trim() === "quit";
	} finally {
		prompt.close();
	}
}

/**
 * Confirm the specific hub that accepted /api/quit has both removed its runtime
 * record (its final teardown action) and exited.  A recycled PID is never
 * sufficient: a different runtime instance is an explicit non-success.
 */
export async function waitForHubQuit(
	target: Required<Pick<RuntimeInfo, "pid" | "instanceId">>,
	options: {
		loadRuntime?: () => RuntimeLoadResult;
		isPidAlive?: (pid: number) => boolean;
		sleep?: (ms: number) => Promise<void>;
		timeoutMs?: number;
	} = {},
): Promise<void> {
	const readRuntime = options.loadRuntime ?? loadRuntime;
	const alive = options.isPidAlive ?? isPidAlive;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const timeoutMs = options.timeoutMs ?? HUB_QUIT_OBSERVE_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		let current = readRuntime();
		if (current.kind === "unreadable") {
			throw new Error(
				`Hub teardown could not be confirmed because runtime.json cannot be read: ${describeRuntimeReadFailure(current.error)}`,
			);
		}
		if (
			current.kind === "present" &&
			current.runtime.instanceId !== undefined &&
			current.runtime.instanceId !== target.instanceId
		) {
			throw new Error("Hub quit target exited, but runtime.json now belongs to a replacement hub");
		}
		if (current.kind === "absent" && !alive(target.pid)) {
			// Confirm the record after the liveness observation. Without this, an
			// absent record and a dead PID from different moments can report success
			// while a replacement has already published its own runtime record.
			current = readRuntime();
			if (current.kind === "unreadable") {
				throw new Error(
					`Hub teardown could not be confirmed because runtime.json cannot be read: ${describeRuntimeReadFailure(current.error)}`,
				);
			}
			if (
				current.kind === "present" &&
				current.runtime.instanceId !== undefined &&
				current.runtime.instanceId !== target.instanceId
			) {
				throw new Error(
					"Hub quit target exited, but runtime.json now belongs to a replacement hub",
				);
			}
			if (current.kind === "absent") return;
		}
		if (Date.now() >= deadline) {
			const detail =
				current.kind === "absent"
					? "runtime record was removed but its PID remains live"
					: "runtime record remains";
			throw new Error(`Hub teardown was not confirmed within ${timeoutMs}ms: ${detail}`);
		}
		await sleep(HUB_QUIT_OBSERVE_POLL_MS);
	}
}

export async function cmdStatus(args: ParsedArgs): Promise<void> {
	const runtimeResult = loadRuntime();
	if (runtimeResult.kind === "absent") {
		if (args.json) {
			console.log(JSON.stringify({ running: false }));
		} else {
			console.log("Hub: stopped (no runtime.json)");
		}
		return;
	}
	if (runtimeResult.kind === "unreadable") {
		const error = describeRuntimeReadFailure(runtimeResult.error);
		if (args.json) {
			console.log(
				JSON.stringify({ running: "unknown", error: `runtime.json cannot be read: ${error}` }),
			);
		} else {
			console.log(`Hub: unknown (runtime.json cannot be read: ${error})`);
		}
		return;
	}
	const { runtime } = runtimeResult;

	const alive = isPidAlive(runtime.pid);
	if (!alive) {
		if (args.json) {
			console.log(JSON.stringify({ running: false, stale: true, pid: runtime.pid }));
		} else {
			console.log(`Hub: stale (pid ${runtime.pid} no longer alive)`);
		}
		return;
	}

	let health: unknown = null;
	try {
		health = await requestHub(runtime, "/api/health").then((r) => r.json());
	} catch {
		// Not reachable yet — not fatal
	}

	if (args.json) {
		console.log(
			JSON.stringify({
				running: true,
				pid: runtime.pid,
				port: runtime.port,
				started_at: runtime.started_at,
				health,
			}),
		);
	} else {
		console.log("Hub: running");
		console.log(`  PID        : ${runtime.pid}`);
		console.log(`  Port       : ${runtime.port}`);
		console.log(`  Started at : ${runtime.started_at}`);
		if (health && typeof health === "object" && health !== null) {
			const h = health as Record<string, unknown>;
			console.log(`  Status     : ${String(h.status ?? "?")}`);
			console.log(`  Uptime     : ${Number(h.uptime ?? 0).toFixed(1)}s`);
		}
	}
}

async function cmdHostAdd(args: ParsedArgs): Promise<void> {
	if (!args.label || !args.host) {
		console.error(
			"Usage: lasterm host add --label <label> --host <user@hostname> [--ssh-port 22] [--auth agent|key] [--key-path ~/.ssh/id_ed25519]",
		);
		process.exit(1);
	}

	const body: Record<string, unknown> = {
		type: "ssh",
		label: args.label,
		ssh_host: args.host,
	};
	if (args.sshPort !== undefined) body.ssh_port = args.sshPort;
	if (args.authMethod) body.ssh_auth = args.authMethod;
	if (args.keyPath) body.ssh_key_path = args.keyPath;

	const result = await apiRequest("POST", "/api/hosts", body);
	if (args.json) {
		console.log(JSON.stringify(result));
	} else {
		const r = result as Record<string, unknown>;
		console.log(`Host added: ${String(r.label ?? args.label)} (id: ${String(r.id ?? "?")})`);
	}
}

async function cmdHostList(args: ParsedArgs): Promise<void> {
	const result = await apiRequest("GET", "/api/hosts");
	const hosts = result as Array<Record<string, unknown>>;
	if (args.json) {
		console.log(JSON.stringify(hosts));
		return;
	}
	if (!hosts.length) {
		console.log("No hosts configured.");
		return;
	}
	const pad = (s: string, n: number) => s.padEnd(n);
	console.log(`${pad("LABEL", 20)}  ${pad("HOST", 30)}  ${pad("PORT", 6)}  USER`);
	console.log(`${"-".repeat(20)}  ${"-".repeat(30)}  ${"-".repeat(6)}  ----`);
	for (const h of hosts) {
		console.log(
			`${pad(String(h.label ?? ""), 20)}  ${pad(String(h.hostname ?? ""), 30)}  ${pad(String(h.port ?? 22), 6)}  ${String(h.username ?? "")}`,
		);
	}
}

async function cmdHostRemove(args: ParsedArgs): Promise<void> {
	if (!args.label) {
		console.error("Usage: lasterm host remove <label>");
		process.exit(1);
	}

	// Resolve label → id (API uses ULID, not label)
	const hosts = (await apiRequest("GET", "/api/hosts")) as Array<Record<string, unknown>>;
	const match = hosts.find((h) => h.label === args.label);
	if (!match?.id) {
		console.error(`Host "${args.label}" not found.`);
		process.exit(1);
	}

	await apiRequest("DELETE", `/api/hosts/${encodeURIComponent(String(match.id))}`);
	console.log(`Host "${args.label}" removed.`);
}

async function cmdSessionList(args: ParsedArgs): Promise<void> {
	const result = await apiRequest("GET", "/api/sessions");
	const sessions = result as Array<Record<string, unknown>>;
	if (args.json) {
		console.log(JSON.stringify(sessions));
		return;
	}
	if (!sessions.length) {
		console.log("No active sessions.");
		return;
	}
	const pad = (s: string, n: number) => s.padEnd(n);
	console.log(`${pad("ID", 26)}  ${pad("HOST", 20)}  ${pad("STATE", 12)}  CREATED`);
	console.log(`${"-".repeat(26)}  ${"-".repeat(20)}  ${"-".repeat(12)}  -------`);
	for (const s of sessions) {
		console.log(
			`${pad(String(s.id ?? ""), 26)}  ${pad(String(s.host_label ?? s.host_id ?? ""), 20)}  ${pad(String(s.state ?? ""), 12)}  ${String(s.created_at ?? "")}`,
		);
	}
}

async function cmdPair(args: ParsedArgs): Promise<void> {
	if (args.code) {
		const result = await apiRequest("POST", "/api/pair/verify", { code: args.code });
		if (args.json) {
			console.log(JSON.stringify(result));
		} else {
			const r = result as Record<string, unknown>;
			console.log(`Pairing successful. Token: ${String(r.token ?? "")}`);
		}
	} else {
		const result = await apiRequest("POST", "/api/pair");
		if (args.json) {
			console.log(JSON.stringify(result));
		} else {
			const r = result as Record<string, unknown>;
			console.log(`Pairing code : ${String(r.code ?? "")}`);
			console.log(`Expires at   : ${String(r.expires_at ?? "")}`);
			console.log("Share this code with the client to authorise it.");
		}
	}
}

async function cmdConfigEdit(): Promise<void> {
	const configPath = join(getConfigDir(), "config.toml");
	const editor =
		process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === "win32" ? "notepad" : "vi");

	console.log(`Opening ${configPath} in ${editor}…`);
	try {
		execFileSync(editor, [configPath], { stdio: "inherit" });
	} catch (err) {
		console.error(`Failed to open editor: ${(err as Error).message}`);
		process.exit(1);
	}
}

// ─── Help ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
	console.log(`lasterm — local-first session terminal platform

Usage:
  lasterm start [--port 4100] [--daemon]       Start hub (foreground or daemon)
              [--open]                          Open browser after start
  lasterm stop                                  Stop running hub
  lasterm quit                                  Stop local agent, then hub
  lasterm status [--json]                       Show hub status

  lasterm host add --label X --host user@Y      Add an SSH host
              [--ssh-port 22] [--auth agent|key]
              [--key-path ~/.ssh/id_ed25519]
  lasterm host list [--json]                    List all hosts
  lasterm host remove <label>                   Remove a host

  lasterm agent fetch <os-arch>|--all           Populate the agent binary cache
              [--version x.y.z] [--prune]
  lasterm agent status [--json]                 Show bundled/cache status by target
  lasterm agent import <binary> <manifest>       Verify and cache an agent binary
              --os OS --arch ARCH --version x.y.z --attest [--force]

  lasterm session list [--json]                 List active sessions

  lasterm pair                                  Generate pairing code
  lasterm pair --code XXXXXX                    Verify pairing code

  lasterm config edit                           Open config.toml in $EDITOR
`);
}

// ─── Entry point ───────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return;
	}

	const parsed = parseArgs(argv);

	if (!parsed) {
		console.error(`Unknown command: ${argv.join(" ")}`);
		console.error("Run 'lasterm --help' for usage.");
		process.exit(1);
	}

	try {
		switch (parsed.command) {
			case "start":
				await cmdStart(parsed);
				break;
			case "stop":
				await cmdStop(parsed);
				break;
			case "quit":
				await cmdQuit();
				break;
			case "status":
				await cmdStatus(parsed);
				break;
			case "host-add":
				await cmdHostAdd(parsed);
				break;
			case "host-list":
				await cmdHostList(parsed);
				break;
			case "host-remove":
				await cmdHostRemove(parsed);
				break;
			case "agent-fetch": {
				const code = await cmdAgentFetch(parsed);
				if (code !== 0) process.exit(code);
				break;
			}
			case "agent-status": {
				const code = await cmdAgentStatus(parsed);
				if (code !== 0) process.exit(code);
				break;
			}
			case "agent-import": {
				const code = await cmdAgentImport(parsed);
				if (code !== 0) process.exit(code);
				break;
			}
			case "session-list":
				await cmdSessionList(parsed);
				break;
			case "pair":
				await cmdPair(parsed);
				break;
			case "config-edit":
				await cmdConfigEdit();
				break;
			default:
				console.error(`Unknown command: ${parsed.command}`);
				process.exit(1);
		}
	} catch (err) {
		console.error(`Error: ${(err as Error).message}`);
		process.exit(
			err instanceof Error && "code" in err && err.code === "LASTERM_HUB_ALREADY_RUNNING" ? 73 : 1,
		);
	}
}
