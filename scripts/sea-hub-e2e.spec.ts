/**
 * sea-hub-e2e.spec.ts
 *
 * Runs the built hub executable, dist/sea/lasterm-hub (lasterm-hub.exe on
 * Windows), and checks what "it works" means: a command exits 0 and prints the
 * output it should, and a started hub serves, then stops cleanly (#147).
 *
 * Where the executable was not built, every case here is skipped, under a name
 * that says so. A job that builds it before running this file sets
 * LASTERM_SEA_EXPECTED=1, and there a missing executable fails instead: a run
 * meant to test the artefact must not pass because the artefact is absent.
 *
 * Every run of the executable gets fresh state, config and cache roots, so it
 * never reads or writes the profile of whoever runs the suite, nor the
 * runtime.json of a hub they have running. No case opens a terminal: the local
 * agent's address is per user, not per profile (a named pipe on Windows), so a
 * terminal would reach the user's own agent.
 *
 * Build the executable with scripts/build-hub.sh, or scripts/build-hub.ps1.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RuntimeInfo, requestHub } from "../packages/hub/src/cli.js";
import { HUB_LOCK_ADDON } from "../packages/hub/src/hub-lock.js";
import { platformDirEnv } from "../packages/hub/src/platform-dirs.fixture.js";
import {
	beforeBaselineRefusal,
	createMetaDbBeforeBaseline,
} from "../packages/hub/src/storage/open-databases.fixture.js";
import { TLS_IDENTITY_ADDON } from "../packages/hub/src/tls-identity.js";
import {
	ADDON_MANIFEST_ASSET,
	addonDigest,
	parseAddonManifest,
} from "../packages/shared/src/installed-addon.js";
import { lastermDir } from "../packages/shared/src/platform-dirs.js";

// ─── The artefact ─────────────────────────────────────────────────────────────

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SEA_BINARY = join(
	ROOT,
	"dist",
	"sea",
	process.platform === "win32" ? "lasterm-hub.exe" : "lasterm-hub",
);
const SEA_NAME = relative(ROOT, SEA_BINARY).replaceAll("\\", "/");

/**
 * Whether this run must have the executable. Only "1" says yes: any other value
 * is refused rather than read as no, because a misspelt flag would otherwise
 * turn the failure this exists for back into a skip.
 */
function seaExpected(): boolean {
	const value = process.env.LASTERM_SEA_EXPECTED;
	if (value === undefined || value === "") return false;
	if (value === "1") return true;
	throw new Error(`LASTERM_SEA_EXPECTED must be 1 or unset, not ${JSON.stringify(value)}`);
}

const EXPECTED = seaExpected();
const PRESENT = existsSync(SEA_BINARY);

/**
 * Digits and dots, with an optional pre-release and build: version-shaped, and
 * checked against nothing. Whether the version is the right one is release.yml's
 * check against the tag; here the question is whether the executable reached its
 * entry point and reported.
 */
const VERSION_SHAPE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * What `lasterm start` prints once it serves: the line the desktop parses, then
 * the two directories it uses.
 */
const ANNOUNCEMENT = new RegExp(
	[
		String.raw`^lasterm hub listening on https://127\.0\.0\.1:(\d+) \(spki: ([A-Za-z0-9+/]+={0,2})\) \(build: ([^\s)]+)\)\r?\n`,
		String.raw`Config dir : (.+?)\r?\n`,
		String.raw`State dir  : (.+?)\r?\n`,
	].join(""),
	"m",
);

/** From spawn to that line, including first-run addon extraction and key generation. */
const READY_TIMEOUT_MS = 60_000;
/** A graceful shutdown gives its teardown 10 s; this leaves room for the exit. */
const STOP_TIMEOUT_MS = 20_000;

// ─── An isolated profile ──────────────────────────────────────────────────────

interface Sandbox {
	readonly root: string;
	readonly env: NodeJS.ProcessEnv;
	/** Where the executable must put its state, config and cache: `<root>/…/lasterm`. */
	readonly stateDir: string;
	readonly configDir: string;
	readonly cacheDir: string;
}

function createSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "lasterm-sea-e2e-"));
	const overrides: Record<string, string> = {
		...platformDirEnv({
			state: join(root, "state"),
			config: join(root, "config"),
			cache: join(root, "cache"),
		}),
		NO_COLOR: "1",
	};
	// Names that must not come from the parent. Windows compares environment names
	// without case, so an inherited `AppData` beside the `APPDATA` set here would
	// give the child two answers; LASTERM_PORT and LASTERM_OPEN are meant for the
	// user's own hub.
	const withheld = new Set(
		[...Object.keys(overrides), "LASTERM_PORT", "LASTERM_OPEN"].map((name) => name.toUpperCase()),
	);
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!withheld.has(name.toUpperCase())) env[name] = value;
	}
	Object.assign(env, overrides);
	const context = { platform: process.platform, env, homedir };
	return {
		root,
		env,
		stateDir: lastermDir("state", context),
		configDir: lastermDir("config", context),
		cacheDir: lastermDir("cache", context),
	};
}

function removeSandbox(sandbox: Sandbox): void {
	try {
		rmSync(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch {
		// Windows can hold a handle on a file of a process that just exited; a
		// leftover directory in the system temp folder is not a test failure.
	}
}

// ─── Its addons ───────────────────────────────────────────────────────────────

/** The addons the executable loads from its own directory, checked against its manifest (#889). */
const ADDONS = [HUB_LOCK_ADDON, TLS_IDENTITY_ADDON] as const;
const SEA_DIR = dirname(SEA_BINARY);
const PLATFORM = `${process.platform}-${process.arch}`;

/** The version the executable carries, which names its directory in the old addon cache. */
function hubVersion(): string {
	const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "hub", "package.json"), "utf8")) as {
		version: string;
	};
	return pkg.version;
}

/**
 * The executable and its addons in a directory of the sandbox: the executable
 * linked where the volume allows, else copied, and the addons copied, so a
 * case can change them without touching the build.
 */
function installCopy(sandbox: Sandbox): string {
	const dir = join(sandbox.root, "install");
	mkdirSync(dir);
	const executable = join(dir, basename(SEA_BINARY));
	try {
		linkSync(SEA_BINARY, executable);
	} catch {
		copyFileSync(SEA_BINARY, executable);
	}
	for (const addon of ADDONS) copyFileSync(join(SEA_DIR, addon), join(dir, addon));
	return dir;
}

/** `start --exit-with-stdin` with its stdin closed at once: a hub that starts anyway stops, exit 0. */
function startClosed(executable: string, sandbox: Sandbox) {
	const result = spawnSync(executable, ["start", "--exit-with-stdin"], {
		env: sandbox.env,
		input: "",
		encoding: "utf8",
		timeout: READY_TIMEOUT_MS,
		windowsHide: true,
	});
	return { ...result, said: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}` };
}

// ─── A started hub ────────────────────────────────────────────────────────────

interface Exit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

interface StartedHub {
	readonly pid: number;
	readonly port: number;
	/** Base64 DER SubjectPublicKeyInfo the hub announced. */
	readonly spki: string;
	readonly build: string;
	/** The directories it announced it uses. */
	readonly configDir: string;
	readonly stateDir: string;
	output(): string;
	/** Close its stdin, which `--exit-with-stdin` turns into a graceful shutdown. */
	stop(): Promise<Exit>;
	/** Whatever state it is in, make sure it is gone. */
	kill(): Promise<void>;
}

/** Settle with `promise`, or fail after `ms` with the message `failure` gives then. */
function withTimeout<T>(promise: Promise<T>, ms: number, failure: () => string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${failure()} (after ${ms} ms)`)), ms);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * `lasterm start --exit-with-stdin`, as the desktop runs it: it serves on a port
 * the OS assigns and announces it on stdout. Anything short of that
 * announcement kills the process and rejects with what it printed.
 */
async function startHub(sandbox: Sandbox): Promise<StartedHub> {
	const proc = spawn(SEA_BINARY, ["start", "--exit-with-stdin"], {
		env: sandbox.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	proc.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const output = () => `stdout:\n${stdout}\nstderr:\n${stderr}`;
	// "close", not "exit": it comes once stdout is drained, so an announcement
	// printed just before an exit is not lost.
	const closed = new Promise<Exit>((resolveExit) => {
		proc.once("close", (code, signal) => resolveExit({ code, signal }));
	});
	const kill = async () => {
		if (proc.exitCode === null && proc.signalCode === null) proc.kill();
		await withTimeout(closed, STOP_TIMEOUT_MS, () => "the hub did not exit when killed").catch(
			() => undefined,
		);
	};

	const announcement = new Promise<RegExpExecArray>((resolveReady, rejectReady) => {
		proc.stdout.on("data", () => {
			const match = ANNOUNCEMENT.exec(stdout);
			if (match) resolveReady(match);
		});
		proc.once("error", rejectReady);
		void closed.then(({ code, signal }) =>
			rejectReady(
				new Error(`the hub exited (code ${code}, signal ${signal}) before serving\n${output()}`),
			),
		);
	});
	let announced: RegExpExecArray;
	try {
		announced = await withTimeout(
			announcement,
			READY_TIMEOUT_MS,
			() => `the hub did not announce that it serves\n${output()}`,
		);
	} catch (error) {
		await kill();
		throw error;
	}
	const { pid } = proc;
	if (pid === undefined) {
		await kill();
		throw new Error(`the hub reports no pid\n${output()}`);
	}

	return {
		pid,
		port: Number(announced[1]),
		spki: announced[2]!,
		build: announced[3]!,
		configDir: announced[4]!,
		stateDir: announced[5]!,
		output,
		stop: async () => {
			proc.stdin.end();
			return withTimeout(closed, STOP_TIMEOUT_MS, () => `the hub did not stop\n${output()}`);
		},
		kill,
	};
}

interface HubResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: string;
	/** Bytes received, before decoding. */
	readonly length: number;
}

/**
 * A request through `requestHub`, the CLI's own transport, to the hub the
 * runtime record names: TLS whose peer must prove the recorded key, so a hub
 * serving with any other key is refused before HTTP. What passes here is what
 * the CLI gets, down to the whole of a large answer (#534).
 */
async function hubRequest(
	hub: StartedHub,
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HubResponse> {
	const runtime = JSON.parse(
		readFileSync(join(hub.stateDir, "runtime.json"), "utf8"),
	) as RuntimeInfo;
	const response = await requestHub(runtime, path, { ...init, responseTimeoutMs: 15_000 });
	const bytes = Buffer.from(await response.arrayBuffer());
	return {
		status: response.status,
		headers: response.headers,
		body: bytes.toString("utf8"),
		length: bytes.length,
	};
}

function readPrimaryToken(sandbox: Sandbox): string {
	const { token } = JSON.parse(readFileSync(join(sandbox.configDir, "auth.json"), "utf8")) as {
		token?: unknown;
	};
	expect(token).toMatch(/^[0-9a-f]{64}$/);
	return token as string;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("lasterm-hub executable", () => {
	it.runIf(EXPECTED)(`${SEA_NAME} was built, as LASTERM_SEA_EXPECTED=1 says`, () => {
		expect(
			existsSync(SEA_BINARY),
			`${SEA_BINARY} is missing: the job that set LASTERM_SEA_EXPECTED=1 did not build it`,
		).toBe(true);
	});

	describe.skipIf(!PRESENT)(
		PRESENT ? SEA_NAME : `${SEA_NAME} not built: skipped (LASTERM_SEA_EXPECTED=1 fails instead)`,
		() => {
			// Mutations caught: an SQLite bootstrap that fails, loudly (exit 1) or
			// silently (nothing extracted); a bundle that never reaches its entry
			// point (exit 0, nothing printed).
			it("runs its SQLite bootstrap and reports its version (agent status --json)", () => {
				const sandbox = createSandbox();
				try {
					const result = spawnSync(SEA_BINARY, ["agent", "status", "--json"], {
						env: sandbox.env,
						encoding: "utf8",
						timeout: 60_000,
						windowsHide: true,
					});
					const said = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
					expect(result.error, said).toBeUndefined();
					expect(result.signal, said).toBeNull();
					expect(result.status, said).toBe(0);

					let status: unknown;
					expect(() => {
						status = JSON.parse(result.stdout);
					}, `the output is not JSON\n${said}`).not.toThrow();
					expect(status).toMatchObject({
						hub_version: expect.stringMatching(VERSION_SHAPE),
						targets: expect.any(Array),
					});
					// The bootstrap extracted the SQLite addon, and into the cache it was
					// given rather than the user's. A bootstrap that failed without saying
					// so still exits 0 here, since this command opens no database.
					const addons = join(sandbox.cacheDir, "addons");
					const extracted = existsSync(addons)
						? readdirSync(addons, { recursive: true, encoding: "utf8" })
						: [];
					expect(
						extracted.some((entry) => entry.endsWith("better_sqlite3.node")),
						`better_sqlite3.node was not extracted under ${addons}`,
					).toBe(true);
				} finally {
					removeSandbox(sandbox);
				}
			});

			// Mutation caught: a build that ships other files than it recorded, or
			// records them other than the hub checks them (#889).
			it(`carries the digests of the addons installed beside it (${ADDON_MANIFEST_ASSET})`, () => {
				// The file the build embedded, left beside the executable it built.
				const manifest = parseAddonManifest(
					readFileSync(join(SEA_DIR, ADDON_MANIFEST_ASSET), "utf8"),
				);
				expect(Object.keys(manifest).sort()).toEqual([...ADDONS].sort());
				for (const addon of ADDONS) {
					const fd = openSync(join(SEA_DIR, addon), "r");
					try {
						expect([addon, addonDigest(fd, fstatSync(fd).size, manifest[addon]?.size)]).toEqual([
							addon,
							manifest[addon],
						]);
					} finally {
						closeSync(fd);
					}
				}
			});

			// Mutations caught: an executable that loads its addons unchecked, from
			// anywhere but its own directory, or still from the cache (#889).
			describe("refuses to start with an addon beside it that is not the one it was built with", () => {
				it(
					"an addon missing",
					() => {
						const sandbox = createSandbox();
						try {
							const dir = installCopy(sandbox);
							unlinkSync(join(dir, HUB_LOCK_ADDON));
							const result = startClosed(join(dir, basename(SEA_BINARY)), sandbox);
							expect(result.error, result.said).toBeUndefined();
							expect(result.status, result.said).toBe(1);
							expect(result.stderr, result.said).toContain(
								`refusing the native addon ${join(dir, HUB_LOCK_ADDON)}: it is missing`,
							);
							expect(existsSync(join(sandbox.stateDir, "runtime.json"))).toBe(false);
						} finally {
							removeSandbox(sandbox);
						}
					},
					READY_TIMEOUT_MS + 10_000,
				);

				it(
					"an addon whose bytes changed",
					() => {
						const sandbox = createSandbox();
						try {
							const dir = installCopy(sandbox);
							const addon = join(dir, TLS_IDENTITY_ADDON);
							const bytes = readFileSync(addon);
							const middle = Math.floor(bytes.length / 2);
							bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
							writeFileSync(addon, bytes);
							const result = startClosed(join(dir, basename(SEA_BINARY)), sandbox);
							expect(result.error, result.said).toBeUndefined();
							expect(result.status, result.said).toBe(1);
							expect(result.stderr, result.said).toContain(
								`refusing the native addon ${addon}: it does not hold the bytes this executable was built with`,
							);
							expect(existsSync(join(sandbox.stateDir, "runtime.json"))).toBe(false);
						} finally {
							removeSandbox(sandbox);
						}
					},
					READY_TIMEOUT_MS + 10_000,
				);
			});

			// Mutation caught: an executable that applies the migration baseline over
			// such a database, and stops on "table already exists" instead (#747).
			it(
				"refuses a meta.db from before the migration baseline, saying to move it aside",
				() => {
					const sandbox = createSandbox();
					try {
						mkdirSync(sandbox.stateDir, { recursive: true, mode: 0o700 });
						const meta = join(sandbox.stateDir, "meta.db");
						createMetaDbBeforeBaseline(meta, 20);
						// Its stdin closed at once, a hub that started anyway stops, exit 0,
						// rather than serve until the timeout.
						const result = spawnSync(SEA_BINARY, ["start", "--exit-with-stdin"], {
							env: sandbox.env,
							input: "",
							encoding: "utf8",
							timeout: READY_TIMEOUT_MS,
							windowsHide: true,
						});
						const said = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
						expect(result.error, said).toBeUndefined();
						expect(result.status, said).toBe(1);
						expect(result.stderr, said).toContain(beforeBaselineRefusal(meta, 20));
					} finally {
						removeSandbox(sandbox);
					}
				},
				READY_TIMEOUT_MS + 10_000,
			);

			// Mutations caught: all of the above, each failing the start itself, and
			// an executable missing its hub lock or TLS identity addon, which only
			// `start` loads, so `agent status` still passes without them.
			describe("started with start --exit-with-stdin", () => {
				let sandbox: Sandbox | undefined;
				let hub: StartedHub | undefined;
				// What an executable before #889 left in the cache, which the start
				// removes, and a file lasterm never wrote there, which it keeps.
				const retired = [
					`addons/0.0.1/${PLATFORM}/${HUB_LOCK_ADDON}`,
					`addons/0.0.1/${PLATFORM}/better_sqlite3.node`,
					`addons/${hubVersion()}/${PLATFORM}/${TLS_IDENTITY_ADDON}`,
				];
				const foreign = `addons/0.0.1/${PLATFORM}/notes.txt`;

				beforeAll(async () => {
					sandbox = createSandbox();
					for (const file of [...retired, foreign]) {
						const path = join(sandbox.cacheDir, ...file.split("/"));
						mkdirSync(dirname(path), { recursive: true });
						writeFileSync(path, "left by an earlier version");
					}
					// Started under the usual umask, which the child inherits: under it,
					// SQLite alone creates a database 0644, and the mode check below
					// would pass for a hub that leaves the mode to SQLite.
					const umask = process.platform === "win32" ? undefined : process.umask(0o022);
					try {
						hub = await startHub(sandbox);
					} finally {
						if (umask !== undefined) process.umask(umask);
					}
				}, READY_TIMEOUT_MS + 10_000);

				afterAll(async () => {
					await hub?.kill();
					if (sandbox) removeSandbox(sandbox);
				}, STOP_TIMEOUT_MS + 10_000);

				it("announces its listener and key, in the directories it was given", () => {
					expect(hub!.port).toBeGreaterThan(0);
					expect(hub!.port).toBeLessThan(65_536);
					expect(hub!.configDir).toBe(sandbox!.configDir);
					expect(hub!.stateDir).toBe(sandbox!.stateDir);

					const runtime = JSON.parse(
						readFileSync(join(sandbox!.stateDir, "runtime.json"), "utf8"),
					) as unknown;
					expect(runtime).toMatchObject({ pid: hub!.pid, port: hub!.port, spki: hub!.spki });
				});

				it("answers /api/health over TLS pinned to the key it announced", async () => {
					const health = await hubRequest(hub!, "/api/health");
					expect(health.status, health.body).toBe(200);
					expect(JSON.parse(health.body)).toMatchObject({
						status: "ok",
						version: expect.stringMatching(VERSION_SHAPE),
						build: hub!.build,
					});
				});

				it("refuses its API without a token, and serves it with the token it wrote", async () => {
					const refused = await hubRequest(hub!, "/api/hosts");
					expect(refused.status, refused.body).toBe(401);

					const token = readPrimaryToken(sandbox!);
					const hosts = await hubRequest(hub!, "/api/hosts", {
						headers: { Authorization: `Bearer ${token}` },
					});
					expect(hosts.status, hosts.body).toBe(200);
					expect(JSON.parse(hosts.body)).toEqual(expect.any(Array));
				});

				it("pairs a client: a code from /api/pair buys a token its API accepts", async () => {
					const token = readPrimaryToken(sandbox!);
					const pair = await hubRequest(hub!, "/api/pair", {
						method: "POST",
						headers: { Authorization: `Bearer ${token}` },
					});
					expect(pair.status, pair.body).toBe(201);
					const { code } = JSON.parse(pair.body) as { code?: unknown };
					expect(code).toMatch(/^\d{8}$/);

					const verify = await hubRequest(hub!, "/api/pair/verify", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ code }),
					});
					expect(verify.status, verify.body).toBe(200);
					const { token: paired } = JSON.parse(verify.body) as { token?: unknown };
					expect(paired).toEqual(expect.any(String));
					expect(paired).not.toBe(token);

					const hosts = await hubRequest(hub!, "/api/hosts", {
						headers: { Authorization: `Bearer ${paired as string}` },
					});
					expect(hosts.status, hosts.body).toBe(200);
				});

				it("serves the web UI embedded in it, and the script the page loads", async () => {
					const page = await hubRequest(hub!, "/");
					expect(page.status, page.body).toBe(200);
					expect(page.headers.get("content-type")).toContain("text/html");
					expect(page.body).toContain('<div id="app">');

					const script = /<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
					expect(script, `no /assets/*.js script in:\n${page.body}`).toBeDefined();
					const js = await hubRequest(hub!, script!);
					expect(js.status).toBe(200);
					expect(js.headers.get("content-type")).toContain("javascript");
					expect(js.length).toBeGreaterThan(0);
					expect(js.length).toBe(Number(js.headers.get("content-length")));
				});

				it("serves the PWA's manifest and worker, and a 404 for an asset its build lacks (#561)", async () => {
					const manifest = await hubRequest(hub!, "/manifest.webmanifest");
					expect(manifest.status, manifest.body).toBe(200);
					expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
					expect(manifest.headers.get("cache-control")).toBe("no-cache");
					expect(JSON.parse(manifest.body)).toMatchObject({
						display: "standalone",
						start_url: "/",
						scope: "/",
					});

					const worker = await hubRequest(hub!, "/sw.js");
					expect(worker.status, worker.body).toBe(200);
					expect(worker.headers.get("content-type")).toContain("javascript");
					expect(worker.headers.get("cache-control")).toBe("no-cache");

					// An older page's chunk: never the SPA page, which a cache would keep.
					const missing = await hubRequest(hub!, "/assets/index-00000000.js");
					expect(missing.status).toBe(404);
					expect(missing.headers.get("content-type") ?? "").not.toContain("text/html");
				});

				it("loads its addons from beside it, and clears what earlier versions extracted", () => {
					for (const file of retired) {
						expect([file, existsSync(join(sandbox!.cacheDir, ...file.split("/")))]).toEqual([
							file,
							false,
						]);
					}
					expect(existsSync(join(sandbox!.cacheDir, ...foreign.split("/")))).toBe(true);
					const cached = readdirSync(sandbox!.cacheDir, { recursive: true, encoding: "utf8" });
					for (const addon of ADDONS) {
						expect(cached.filter((entry) => entry.endsWith(addon))).toEqual([]);
					}
				});

				it("keeps its databases in the state directory it was given", () => {
					expect(existsSync(join(sandbox!.stateDir, "meta.db"))).toBe(true);
					expect(existsSync(join(sandbox!.stateDir, "spool.db"))).toBe(true);
				});

				// Mutation caught: an executable that opens its databases with
				// anything but storage/db.ts, as it did until #745. Windows has no such
				// mode, and relies on the profile's ACL (STORAGE.md § 2).
				it.skipIf(process.platform === "win32")(
					"creates its databases owner-only, 0600, with their WAL files (#536)",
					() => {
						const walFiles = ["meta.db", "spool.db"]
							.flatMap((name) => [`${name}-wal`, `${name}-shm`])
							.filter((name) => existsSync(join(sandbox!.stateDir, name)));
						for (const name of ["meta.db", "spool.db", ...walFiles]) {
							const mode = (statSync(join(sandbox!.stateDir, name)).mode & 0o777).toString(8);
							expect([name, mode]).toEqual([name, "600"]);
						}
					},
				);

				// Last: the cases above need it running. Mutation caught: a hub that
				// ignores --exit-with-stdin, and would outlive a desktop that quit.
				it("stops when its stdin closes: exit 0, and its runtime record withdrawn", async () => {
					const exit = await hub!.stop();
					expect(exit, hub!.output()).toEqual({ code: 0, signal: null });
					expect(existsSync(join(sandbox!.stateDir, "runtime.json"))).toBe(false);
				});
			});
		},
	);
});
