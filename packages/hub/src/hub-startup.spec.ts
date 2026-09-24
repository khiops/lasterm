import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createToken,
	sweepNonPrimaryTokens,
	upsertPrimaryToken,
	validateTokenRecord,
} from "./auth.js";
import { getStateDir, loadRuntime } from "./cli.js";
import { STARTUP_UNWIND_TIMEOUT_MS, startHub } from "./hub-startup.js";
import { SecurityLog } from "./logging/security-log.js";
import { usePlatformDirs } from "./platform-dirs.fixture.js";
import { PreviousInstallationError } from "./previous-installation.js";
import { openTestDatabases } from "./storage/db.js";
import { makeTempDir, removeTempDir } from "./temp-dir.fixture.js";

const TEST_TLS_IDENTITY = {
	tls: { cert: "certificate", key: "key" },
	certificate: "certificate",
	spki: "test-spki",
};

// The refusal has to belong to the operation that constructs a hub, not to the
// `start` command handler: the daemon child re-enters through the CLI, `pnpm dev`
// enters through `main.ts`, and both would otherwise take the new lock and serve
// alongside a Termora hub that knows nothing about it.
describe("startHub refuses beside a previous installation", () => {
	it("throws instead of constructing, and takes no authority on the way out", async () => {
		const acquireHubLock = vi.fn();
		const getStateDir = vi.fn(() => "/nonexistent/state");
		const openDatabases = vi.fn();
		const createServer = vi.fn();

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => "Found a Termora installation.",
					acquireHubLock,
					getStateDir,
					openDatabases,
					createServer,
				},
			),
		).rejects.toThrow(PreviousInstallationError);

		// The whole point of the ordering: nothing was claimed, opened or created.
		// If the check ever moves below the lock, this is what notices.
		expect(acquireHubLock).not.toHaveBeenCalled();
		expect(getStateDir).not.toHaveBeenCalled();
		expect(openDatabases).not.toHaveBeenCalled();
		expect(createServer).not.toHaveBeenCalled();
	});

	it("carries the description as the error message, since that text is the diagnosis", async () => {
		const description = "Found a Termora installation. Lasterm will not run beside it:\n  /x/y";
		await expect(
			startHub({ port: 4100 }, { describePreviousInstallation: () => description }),
		).rejects.toThrow(description);
	});

	it("consults the probe before anything else on every call", async () => {
		const describePreviousInstallation = vi.fn(() => "Found a Termora installation.");
		await expect(startHub({ port: 4100 }, { describePreviousInstallation })).rejects.toThrow(
			PreviousInstallationError,
		);
		expect(describePreviousInstallation).toHaveBeenCalledTimes(1);
	});
});

describe("startHub token restart sweep", () => {
	it("leaves no readable runtime record when publication fails after TLS bind", async () => {
		const stateRoot = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);
		const restoreStateRoot = usePlatformDirs({ state: stateRoot });
		const dbs = openTestDatabases();
		try {
			await expect(
				startHub(
					{},
					{
						describePreviousInstallation: () => undefined,
						getStateDir,
						getConfigDir: () => getStateDir(),
						acquireHubLock: () => null as never,
						initAuth: () => randomBytes(32).toString("hex"),
						createOwnerToken: () => "owner-token",
						openDatabases: () => dbs,
						createServer: async () => ({ close: async () => undefined }) as never,
						startServer: async () => "https://127.0.0.1:4321",
						addStartupCorsOrigins: () => 4321,
						persistRuntime: () => {
							throw new Error("injected failure between bind and publish");
						},
					},
				),
			).rejects.toThrow("injected failure between bind and publish");

			expect(loadRuntime()).toEqual({ kind: "absent" });
			expect(existsSync(join(getStateDir(), "runtime.json"))).toBe(false);
		} finally {
			dbs.close();
			await removeTempDir(stateRoot);
			restoreStateRoot();
		}
	});

	it("commits the sweep before constructing or binding the server", async () => {
		const dbs = openTestDatabases();
		const primaryToken = randomBytes(32).toString("hex");
		upsertPrimaryToken(dbs.meta, primaryToken);
		const pairing = createToken(dbs.meta, { label: "browser", expiresAt: null });
		const steps: string[] = [];
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);

		await startHub(
			{ port: 4100 },
			{
				describePreviousInstallation: () => undefined,
				getStateDir: () => stateDir,
				getConfigDir: () => stateDir,
				acquireHubLock: () => null as never,
				initAuth: () => primaryToken,
				createOwnerToken: () => "owner-token",
				resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
				openDatabases: () => dbs,
				sweepNonPrimaryTokens: (db) => {
					steps.push("sweep");
					sweepNonPrimaryTokens(db);
				},
				createServer: async () => {
					steps.push("create-server");
					return {} as never;
				},
				startServer: async () => {
					steps.push("listen");
					expect(validateTokenRecord(dbs.meta, pairing.token)).toEqual({
						status: "invalid",
						reason: "swept",
					});
					return "http://127.0.0.1:4100";
				},
				addStartupCorsOrigins: () => 4100,
				persistRuntime: () => undefined,
				deleteRuntime: () => false,
			},
		);

		expect(steps).toEqual(["sweep", "create-server", "listen"]);
		dbs.close();
	});

	it("announces the same SPKI that it published for the TLS listener", async () => {
		const dbs = openTestDatabases();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);
		let announced: { address: string; port: number; spki: string } | undefined;

		await startHub(
			{
				port: 4100,
				announce: (details) => {
					announced = details;
				},
			},
			{
				describePreviousInstallation: () => undefined,
				getStateDir: () => stateDir,
				getConfigDir: () => stateDir,
				acquireHubLock: () => null as never,
				initAuth: () => randomBytes(32).toString("hex"),
				createOwnerToken: () => "owner-token",
				resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
				openDatabases: () => dbs,
				createServer: async () => ({}) as never,
				startServer: async () => "https://127.0.0.1:4100",
				addStartupCorsOrigins: () => 4100,
				persistRuntime: () => undefined,
				deleteRuntime: () => false,
			},
		);

		expect(announced).toMatchObject({
			address: "https://127.0.0.1:4100",
			port: 4100,
			spki: TEST_TLS_IDENTITY.spki,
		});
		dbs.close();
	});

	it("shuts down gracefully when the launcher's stdin closes (#188)", async () => {
		const dbs = openTestDatabases();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);
		const stdin = new PassThrough();
		const close = vi.fn(async () => undefined);
		const deleteRuntime = vi.fn(() => true);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		try {
			await startHub(
				{ port: 4100, shutdownWhenClosed: stdin },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => null as never,
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => dbs,
					createServer: async () => ({ close, log: { error: vi.fn() } }) as never,
					startServer: async () => "https://127.0.0.1:4100",
					addStartupCorsOrigins: () => 4100,
					persistRuntime: () => undefined,
					deleteRuntime,
				},
			);
			expect(close).not.toHaveBeenCalled();

			stdin.end();

			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
			expect(close).toHaveBeenCalledTimes(1);
			expect(deleteRuntime).toHaveBeenCalledTimes(1);
		} finally {
			exit.mockRestore();
		}
	});

	it("refuses startup before server construction when the sweep column is missing", async () => {
		const meta = new Database(":memory:");
		meta.exec(`CREATE TABLE auth_tokens (
			id TEXT PRIMARY KEY,
			token_hash TEXT NOT NULL UNIQUE,
			label TEXT NOT NULL,
			created_at TEXT NOT NULL,
			expires_at TEXT,
			revoked_at TEXT,
			last_used_at TEXT
		)`);
		const spool = new Database(":memory:");
		const createServer = vi.fn();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => null as never,
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => ({
						meta,
						spool,
						close: () => {
							meta.close();
							spool.close();
						},
					}),
					createServer,
				},
			),
		).rejects.toMatchObject({ code: "AUTH_TOKEN_SWEEP_FAILED" });

		expect(createServer).not.toHaveBeenCalled();
	});

	it("refuses startup before server construction when the database is unreadable", async () => {
		const dbs = openTestDatabases();
		dbs.meta.close();
		const createServer = vi.fn();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => null as never,
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => dbs,
					createServer,
				},
			),
		).rejects.toMatchObject({ code: "AUTH_TOKEN_SWEEP_FAILED" });

		expect(createServer).not.toHaveBeenCalled();
	});
});

// The key that names this hub to its agent daemons lives in the directory it
// locked, and has to reach the server that hands it to them (#127).
describe("startHub carries the hub key", () => {
	// A start that completes listens for SIGTERM and SIGINT on the process; the
	// ones these starts add are taken away again, so the file stays under Node's
	// listener warning.
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
	let before = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();
	beforeEach(() => {
		before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
	});
	afterEach(() => {
		for (const signal of signals) {
			for (const listener of process.listeners(signal)) {
				if (!before.get(signal)?.includes(listener)) process.off(signal, listener);
			}
		}
	});

	function startWith(stateDir: string, createServer: (options: { hubKey?: string }) => unknown) {
		const dbs = openTestDatabases();
		return startHub(
			{ port: 4100, logging: true },
			{
				describePreviousInstallation: () => undefined,
				getStateDir: () => stateDir,
				getConfigDir: () => stateDir,
				acquireHubLock: () => null as never,
				initAuth: () => randomBytes(32).toString("hex"),
				createOwnerToken: () => "owner-token",
				resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
				openDatabases: () => dbs,
				createServer: async (options) => createServer(options) as never,
				startServer: async () => "https://127.0.0.1:4100",
				addStartupCorsOrigins: () => 4100,
				persistRuntime: () => undefined,
				deleteRuntime: () => false,
			},
		).finally(() => dbs.close());
	}

	it("reads it from the directory it locked, hands it to the server, and keeps it across restarts", async () => {
		const stateDir = makeTempDir("lasterm-startup-key-");
		try {
			const handed: (string | undefined)[] = [];
			const createServer = (options: { hubKey?: string }) => {
				handed.push(options.hubKey);
				return {};
			};

			await startWith(stateDir, createServer);
			await startWith(stateDir, createServer);

			const stored = readFileSync(join(stateDir, "hub-key"), "utf8");
			expect(stored).toMatch(/^[0-9a-f]{64}$/);
			expect(handed).toEqual([stored, stored]);
			// Written nowhere a log is kept.
			const hubLog = readFileSync(join(stateDir, "logs", "hub.jsonl"), "utf8");
			expect(hubLog).toContain("hub started");
			expect(hubLog).not.toContain(stored);
		} finally {
			await removeTempDir(stateDir);
		}
	});

	it("refuses to start on a malformed key, naming the file, before any server exists", async () => {
		const stateDir = makeTempDir("lasterm-startup-key-");
		try {
			const keyPath = join(stateDir, "hub-key");
			writeFileSync(keyPath, "garbage");
			const createServer = vi.fn(() => ({}));

			await expect(startWith(stateDir, createServer)).rejects.toThrow(keyPath);

			expect(createServer).not.toHaveBeenCalled();
			expect(readFileSync(keyPath, "utf8")).toBe("garbage");
		} finally {
			await removeTempDir(stateDir);
		}
	});
});

// The lock, the databases and the runtime record name one directory. A record
// published wherever the resolver points after startup's asynchronous work would
// advertise a hub in a directory whose lock it does not hold, and `stop` or the
// launcher reading that directory would find a hub that is not there.
describe("startHub carries the directory it locked", () => {
	it("publishes and withdraws the record where it took the lock, whatever the environment says later", async () => {
		const root = join(tmpdir(), `lasterm-carry-${randomBytes(8).toString("hex")}`);
		const restoreFirst = usePlatformDirs({ state: join(root, "first") });
		let restoreSecond: (() => void) | undefined;
		const lockedDir = getStateDir();
		const dbs = openTestDatabases();
		const failure = new Error("injected failure after runtime publication");
		const locked: string[] = [];
		let publishedIn: string[] = [];
		const serverOptions: { configDir?: string; logsDir?: string }[] = [];
		const recordIn = (dir: string) => existsSync(join(dir, "runtime.json"));
		try {
			await expect(
				startHub(
					{
						port: 4100,
						announce: () => {
							publishedIn = [lockedDir, getStateDir()].filter(recordIn);
							throw failure;
						},
					},
					{
						describePreviousInstallation: () => undefined,
						getConfigDir: () => join(root, "config"),
						acquireHubLock: (dir) => {
							locked.push(dir);
							return null as never;
						},
						initAuth: () => randomBytes(32).toString("hex"),
						createOwnerToken: () => "owner-token",
						resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
						openDatabases: () => dbs,
						createServer: async (options) => {
							serverOptions.push(options);
							// The environment moves while startup is awaiting.
							restoreSecond = usePlatformDirs({ state: join(root, "second") });
							return { close: async () => undefined } as never;
						},
						startServer: async () => "https://127.0.0.1:4100",
						addStartupCorsOrigins: () => 4100,
					},
				),
			).rejects.toThrow(failure);

			expect(getStateDir()).not.toBe(lockedDir);
			expect(locked).toEqual([lockedDir]);
			expect(publishedIn).toEqual([lockedDir]);
			// Withdrawn from the directory it was published in, on the way out.
			expect(recordIn(lockedDir)).toBe(false);
			// The server reads its configuration and logs from the same places.
			expect(serverOptions).toEqual([
				expect.objectContaining({
					configDir: join(root, "config"),
					logsDir: join(lockedDir, "logs"),
				}),
			]);
		} finally {
			restoreSecond?.();
			restoreFirst();
			dbs.close();
			await removeTempDir(root);
		}
	});

	// A relative directory means whatever the working directory is at each use; the
	// lock resolved it once already, and everything else has to mean the same place.
	it("resolves a relative directory once, before anything uses it", async () => {
		const dbs = openTestDatabases();
		const name = `lasterm-relative-${randomBytes(8).toString("hex")}`;
		const cwd = process.cwd();
		const seen: string[] = [];
		process.chdir(tmpdir());
		const absolute = resolve(name);
		try {
			await startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => name,
					getConfigDir: () => name,
					acquireHubLock: (dir) => {
						seen.push(dir);
						return null as never;
					},
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: (dir) => {
						seen.push(dir);
						return TEST_TLS_IDENTITY;
					},
					openDatabases: (dir) => {
						seen.push(dir);
						return dbs;
					},
					createServer: async () => ({}) as never,
					startServer: async () => "https://127.0.0.1:4100",
					addStartupCorsOrigins: () => 4100,
					persistRuntime: (_runtime, dir) => {
						seen.push(dir);
					},
					deleteRuntime: () => false,
				},
			);

			expect(seen).toEqual([absolute, absolute, absolute, absolute]);
		} finally {
			process.chdir(cwd);
			dbs.close();
			await removeTempDir(absolute);
		}
	});
});

// Both entry points exit once startHub rejects, and that exit is what releases
// the lock. A server whose close never settles must therefore not hold the unwind:
// without a bound, the databases stay open, the error is never reported and the
// process keeps the lock for as long as the close hangs.
describe("startHub bounds the unwind of a failed start", () => {
	it("closes the databases and rethrows when the server never finishes closing", async () => {
		const dbs = openTestDatabases();
		const stateDir = join(tmpdir(), `lasterm-startup-${randomBytes(8).toString("hex")}`);
		const failure = new Error("injected failure after runtime publication");
		const order: string[] = [];
		const close = vi.fn(() => {
			order.push("server");
			return new Promise<never>(() => undefined);
		});
		const databases = {
			...dbs,
			close: () => {
				order.push("databases");
				dbs.close();
			},
		};
		let settled = false;
		let outcome: unknown;

		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			void startHub(
				{
					port: 4100,
					announce: () => {
						throw failure;
					},
				},
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => null as never,
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => databases,
					createServer: async () => ({ close }) as never,
					startServer: async () => "https://127.0.0.1:4100",
					addStartupCorsOrigins: () => 4100,
					persistRuntime: () => undefined,
					deleteRuntime: () => {
						order.push("record");
						return true;
					},
				},
			).then(
				() => {
					settled = true;
				},
				(error: unknown) => {
					settled = true;
					outcome = error;
				},
			);

			// Within the bound the unwind still waits: nothing is closed underneath a
			// server that may yet finish, and the record still names a live hub.
			await vi.advanceTimersByTimeAsync(STARTUP_UNWIND_TIMEOUT_MS - 1);
			expect(close).toHaveBeenCalledTimes(1);
			expect(settled).toBe(false);
			expect(order).toEqual(["server"]);

			await vi.advanceTimersByTimeAsync(1);
			expect(settled).toBe(true);
			expect(outcome).toBe(failure);
			expect(order).toEqual(["server", "databases", "record"]);
		} finally {
			vi.useRealTimers();
			await removeTempDir(stateDir);
		}
	});
});

// initAuth refuses a group-writable configuration directory, and this is the call
// that creates it. Without an explicit mode the umask decides: 002 yields 0775 and
// a first launch fails before writing auth.json. The mode is the contract between
// the two, so it is asserted here rather than left to whatever umask the host has.
describe("startHub creates the configuration directory owner-only", () => {
	it.runIf(process.platform !== "win32")(
		"creates it 0700 under a group-writable umask",
		async () => {
			const dbs = openTestDatabases();
			const root = join(tmpdir(), `lasterm-umask-${randomBytes(8).toString("hex")}`);
			const configDir = join(root, "config");
			const stateDir = join(root, "state");
			const previous = process.umask(0o002);

			try {
				await startHub(
					{ port: 4100 },
					{
						describePreviousInstallation: () => undefined,
						getStateDir: () => stateDir,
						getConfigDir: () => configDir,
						acquireHubLock: () => null as never,
						initAuth: () => randomBytes(32).toString("hex"),
						createOwnerToken: () => "owner-token",
						resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
						openDatabases: () => dbs,
						createServer: async () => ({}) as never,
						startServer: async () => "http://127.0.0.1:4100",
					},
				);

				expect(statSync(configDir).mode & 0o777).toBe(0o700);
			} finally {
				process.umask(previous);
				dbs.close();
				await removeTempDir(root);
			}
		},
	);

	it.runIf(process.platform !== "win32")(
		"refuses a group-writable directory before loading TLS configuration from it",
		async () => {
			const dbs = openTestDatabases();
			const root = join(tmpdir(), `lasterm-untrusted-${randomBytes(8).toString("hex")}`);
			const configDir = join(root, "config");
			const stateDir = join(root, "state");
			mkdirSync(configDir, { recursive: true, mode: 0o770 });
			chmodSync(configDir, 0o770);
			const loadTlsConfig = vi.fn();
			const initAuth = vi.fn();

			try {
				await expect(
					startHub(
						{ port: 4100 },
						{
							describePreviousInstallation: () => undefined,
							getStateDir: () => stateDir,
							getConfigDir: () => configDir,
							acquireHubLock: () => null as never,
							initAuth,
							loadTlsConfig,
							createOwnerToken: () => "owner-token",
							resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
							openDatabases: () => dbs,
							createServer: async () => ({}) as never,
							startServer: async () => "http://127.0.0.1:4100",
						},
					),
				).rejects.toThrow(/group- or world-writable/);

				// The point of moving the check up: nothing read the directory first.
				expect(loadTlsConfig).not.toHaveBeenCalled();
				expect(initAuth).not.toHaveBeenCalled();
			} finally {
				dbs.close();
				chmodSync(configDir, 0o700);
				await removeTempDir(root);
			}
		},
	);
});

// `lasterm start` — what the desktop runs, and the only command the single
// executable serves — never passes `logging`, and a hub started that way used to
// write no log file at all. The security events must reach one regardless, and
// the diagnostics the other entry points ask for must stay where they were.
describe("startHub records its security events whichever entry point started it", () => {
	async function start(options: { logging?: boolean }) {
		const dbs = openTestDatabases();
		const stateDir = join(tmpdir(), `lasterm-security-${randomBytes(8).toString("hex")}`);
		const createServer = vi.fn(async (_options: { securityLog?: unknown }) => ({}) as never);
		await startHub(
			{ port: 4100, ...options },
			{
				describePreviousInstallation: () => undefined,
				getStateDir: () => stateDir,
				getConfigDir: () => stateDir,
				acquireHubLock: () => null as never,
				initAuth: () => randomBytes(32).toString("hex"),
				createOwnerToken: () => "owner-token",
				resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
				openDatabases: () => dbs,
				createServer,
				startServer: async () => "https://127.0.0.1:4100",
				addStartupCorsOrigins: () => 4100,
				persistRuntime: () => undefined,
				deleteRuntime: () => false,
			},
		);
		dbs.close();
		const logFile = join(stateDir, "logs", "hub.jsonl");
		const entries = existsSync(logFile)
			? readFileSync(logFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Record<string, unknown>)
			: [];
		await removeTempDir(stateDir);
		return { entries, createServer };
	}

	it("writes the hub start to logs/hub.jsonl without `logging`, and nothing else", async () => {
		const { entries } = await start({});

		expect(entries).toEqual([
			expect.objectContaining({
				lvl: "info",
				msg: "security: hub start",
				event: "hub.start",
				bindAddress: "127.0.0.1",
				port: 4100,
				permissionsCheck: process.platform === "win32" ? "not_checked_on_windows" : "passed",
			}),
		]);
	});

	it("keeps the diagnostics for the entry points that ask for them", async () => {
		const { entries } = await start({ logging: true });

		expect(entries.map((entry) => entry.msg)).toEqual(["security: hub start", "hub started"]);
	});

	it("hands the same log to the server, so its routes record there too", async () => {
		const { createServer } = await start({});

		expect(createServer.mock.calls[0]?.[0].securityLog).toBeInstanceOf(SecurityLog);
	});
});

describe("startHub and the daemon's log (#525)", () => {
	async function start(boundDaemonLog: () => boolean) {
		const dbs = openTestDatabases();
		const stateDir = join(tmpdir(), `lasterm-daemon-log-${randomBytes(8).toString("hex")}`);
		const steps: string[] = [];
		let logger: unknown;
		try {
			await startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => stateDir,
					getConfigDir: () => stateDir,
					acquireHubLock: () => {
						steps.push("lock");
						return null as never;
					},
					boundDaemonLog: () => {
						steps.push("bound the log");
						return boundDaemonLog();
					},
					initAuth: () => randomBytes(32).toString("hex"),
					createOwnerToken: () => "owner-token",
					resolveHubTlsIdentity: () => TEST_TLS_IDENTITY,
					openDatabases: () => dbs,
					createServer: async (options) => {
						steps.push("create server");
						logger = options.logger;
						return {} as never;
					},
					startServer: async () => "https://127.0.0.1:4100",
					addStartupCorsOrigins: () => 4100,
					persistRuntime: () => undefined,
					deleteRuntime: () => false,
				},
			);
		} finally {
			dbs.close();
			await removeTempDir(stateDir);
		}
		return { steps, logger };
	}

	// Mutation: bound the log before the lock, and a start that loses to a
	// running hub moves that hub's log aside: the incumbent's evidence, which a
	// losing start must never change (#133).
	it("bounds the log only once it holds the lock", async () => {
		const boundDaemonLog = vi.fn(() => true);

		await expect(
			startHub(
				{ port: 4100 },
				{
					describePreviousInstallation: () => undefined,
					getStateDir: () => "/nonexistent/state",
					acquireHubLock: () => {
						throw Object.assign(new Error("Hub already running"), {
							code: "LASTERM_HUB_ALREADY_RUNNING",
						});
					},
					boundDaemonLog,
				},
			),
		).rejects.toThrow("Hub already running");
		expect(boundDaemonLog).not.toHaveBeenCalled();

		const { steps } = await start(() => true);
		expect(steps).toEqual(["lock", "bound the log", "create server"]);
	});

	// Mutation: leave Fastify's log on its default destination, and pino writes
	// its lines to descriptor 1 itself, unchecked. Most of what a running hub
	// prints is Fastify's log, so the file would pass its limit.
	it("sends Fastify's log through standard output once the log is bounded", async () => {
		const { logger } = await start(() => true);
		const destination = (logger as { destination?: { write(line: string): void } } | undefined)
			?.destination;
		expect(destination).toBeDefined();

		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			destination?.write('{"level":30,"msg":"a line from pino"}\n');
			expect(write).toHaveBeenCalledWith('{"level":30,"msg":"a line from pino"}\n');
		} finally {
			write.mockRestore();
		}

		// A hub the launch did not start as a daemon keeps Fastify's own destination.
		expect((await start(() => false)).logger).toBeUndefined();
	});
});
