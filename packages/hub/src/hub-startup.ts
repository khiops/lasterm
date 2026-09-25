import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
	checkConfigDirectoryPermissions,
	createOwnerOnlyDirectory,
	initAuth,
	sweepNonPrimaryTokens,
} from "./auth.js";
import {
	deleteRuntime,
	getConfigDir,
	getStateDir,
	persistRuntime,
	type RuntimeInfo,
} from "./cli.js";
import { ConfigResolver, loadTlsConfig } from "./config.js";
import { loadHubKey } from "./hub-key.js";
import { acquireHubLock } from "./hub-lock.js";
import { boundDaemonLog } from "./logging/daemon-log.js";
import { HubLogger } from "./logging/hub-logger.js";
import { runLogGc } from "./logging/log-gc.js";
import { SecurityLog } from "./logging/security-log.js";
import { openBrowser } from "./open-browser.js";
import { shutdownWhenStdinCloses } from "./parent-stdin.js";
import {
	describePreviousInstallation,
	PreviousInstallationError,
} from "./previous-installation.js";
import { addStartupCorsOrigins, createServer, startServer } from "./server.js";
import { createOwnerToken, createQuitLifecycle } from "./shutdown.js";
import { forgetStartEnvironment } from "./start-port.js";
import { ensurePrivateStateDirectory } from "./state-dir.js";
import { openDatabases } from "./storage/db.js";
import { resolveHubTlsIdentity } from "./tls-identity.js";

export interface HubStartupOptions {
	readonly port?: number;
	readonly openBrowser?: boolean;
	readonly logging?: boolean;
	/** Stop once this stream ends: the desktop's stdin pipe, for `start --exit-with-stdin`. */
	readonly shutdownWhenClosed?: NodeJS.ReadableStream;
	readonly announce?: (details: {
		address: string;
		port: number;
		/** Base64 DER SubjectPublicKeyInfo for the listener just announced. */
		spki: string;
		configDir: string;
		stateDir: string;
	}) => void;
}

type HubServer = Awaited<ReturnType<typeof createServer>>;
type HubDatabases = ReturnType<typeof openDatabases>;

/**
 * How long a failed start waits for its server to close before unwinding past
 * it: the budget a graceful shutdown gives its whole teardown.
 */
export const STARTUP_UNWIND_TIMEOUT_MS = 10_000;

/** `process.stdout`, looked up on each line, so that the line is checked against the daemon log's limit. */
const STANDARD_OUTPUT = {
	write(line: string): void {
		process.stdout.write(line);
	},
};

/** Injectable only to make the acquisition-to-cleanup boundary observable. */
export interface HubStartupDependencies {
	readonly getStateDir: typeof getStateDir;
	readonly getConfigDir: typeof getConfigDir;
	readonly describePreviousInstallation: typeof describePreviousInstallation;
	readonly acquireHubLock: typeof acquireHubLock;
	/** Returns whether the process's output is now checked against the daemon log's limit. */
	readonly boundDaemonLog: () => boolean;
	readonly initAuth: typeof initAuth;
	readonly loadHubKey: typeof loadHubKey;
	readonly createOwnerToken: typeof createOwnerToken;
	readonly openDatabases: typeof openDatabases;
	readonly sweepNonPrimaryTokens: typeof sweepNonPrimaryTokens;
	readonly loadTlsConfig: typeof loadTlsConfig;
	readonly resolveHubTlsIdentity: typeof resolveHubTlsIdentity;
	readonly createServer: typeof createServer;
	readonly startServer: typeof startServer;
	readonly addStartupCorsOrigins: typeof addStartupCorsOrigins;
	// Declared with the directory required, where the defaults leave it optional:
	// startup always says which directory it locked.
	readonly persistRuntime: (runtime: RuntimeInfo, stateDir: string) => void;
	readonly deleteRuntime: (runtime: RuntimeInfo, stateDir: string) => boolean;
}

const defaultDependencies: HubStartupDependencies = {
	getStateDir,
	getConfigDir,
	describePreviousInstallation,
	acquireHubLock,
	boundDaemonLog: () => boundDaemonLog() !== undefined,
	initAuth,
	loadHubKey,
	createOwnerToken,
	openDatabases,
	sweepNonPrimaryTokens,
	loadTlsConfig,
	resolveHubTlsIdentity,
	createServer,
	startServer,
	addStartupCorsOrigins,
	persistRuntime,
	deleteRuntime,
};

/**
 * How every shipped entry point constructs a hub: the launcher, the daemon child
 * and `main.ts` all arrive here, and none of them can skip the two authority
 * checks below, which is what makes them uniform.
 *
 * Not a security boundary, and the difference is worth being exact about. The
 * dependency table is injectable, so in-repository code can pass a probe that
 * says "no previous installation" or a lock that takes nothing; a caller inside
 * this process can therefore construct a hub without either check. That costs
 * nothing to concede: such a caller already runs at this process's privilege
 * and has cheaper ways to do anything the checks prevent. What the checks buy
 * is that no *shipped path* reaches a serving hub without them, and that a new
 * one added later inherits both by default rather than by memory.
 *
 * The server primitives are held to that by lint rather than by memory: outside
 * the tests this is the only module that may import `server.ts`, and a spec
 * builds its server through `server.fixture.ts` (biome.json,
 * `noRestrictedImports`). A module that wants a listening hub is sent here.
 */
export async function startHub(
	options: HubStartupOptions,
	overrides: Partial<HubStartupDependencies> = {},
): Promise<void> {
	const dependencies = { ...defaultDependencies, ...overrides };
	// The entry point has read the port and the browser flag into `options` by
	// now. Left in the environment, they would reach the agent this hub spawns,
	// and every shell after it (#540).
	forgetStartEnvironment(process.env);
	// Before a directory is created, a port is bound or the lock is taken. The two
	// generations share no lock, so this is the only thing standing between them.
	const previous = dependencies.describePreviousInstallation();
	if (previous !== undefined) throw new PreviousInstallationError(previous);

	// Resolved once and carried from here on: the lock, the databases, the TLS
	// identity and the runtime record must all be in the directory locked, and a
	// second lookup after the awaits below could land elsewhere — a relative path
	// under another working directory, or an environment changed meanwhile —
	// publishing this hub where it holds no lock.
	const stateDir = path.resolve(dependencies.getStateDir());
	dependencies.acquireHubLock(stateDir);
	// Created owner-only, and judged, once the lock is held — a start that loses
	// to a running hub changes nothing there (#133) — and before anything else is
	// written into it: a log, the TLS key or a database (SECURITY.md § 2.2, item
	// 3). One an earlier version made is tightened; another account's is refused.
	createOwnerOnlyDirectory(stateDir);
	ensurePrivateStateDirectory(stateDir);
	// A daemon's log is the running hub's evidence: a start that loses the lock
	// only appends to it (#133). The hub that holds the lock is the only one that
	// moves it aside at its size limit (#525).
	const daemonLogBounded = dependencies.boundDaemonLog();

	const configDir = path.resolve(dependencies.getConfigDir());
	// Owner-only, and exactly: a umask of 002 would otherwise give 0775 and the
	// validator below refuses that, while a umask carrying owner bits would give
	// mode 000 and the validator would accept a directory the hub cannot use.
	createOwnerOnlyDirectory(configDir);
	// Validate here, not only inside initAuth: the logging and TLS configuration
	// below are read from this directory, and initAuth runs after both. A group
	// member could otherwise have the hub consume a FIFO, a malformed file or
	// attacker-chosen TLS paths from a directory the later check would refuse.
	// initAuth keeps its own call for direct callers and to shorten the window.
	checkConfigDirectoryPermissions(configDir);

	// Every hub writes `logs/hub.jsonl`, because the security events of SECURITY.md
	// § 7.1 go there whichever entry point started it. What else the hub logs there
	// stays with the entry points that ask for it: only `main.ts` passes `logging`,
	// and `lasterm start` — the command the desktop runs and the single executable
	// serves — never did, so a shipped hub used to write no file at all and its
	// security events would have gone nowhere. Turning the whole log on there would
	// have changed far more than these events; this changes only them.
	const logsDir = path.join(stateDir, "logs");
	const hubLogConfig = new ConfigResolver(null as never);
	hubLogConfig.loadFromFile(configDir);
	const hubLog = new HubLogger(logsDir, hubLogConfig.logConfig);
	const securityLog = new SecurityLog((msg, fields) => hubLog.logAlways("info", msg, fields));

	let hubLogger: HubLogger | undefined;
	let logConfig: ConfigResolver | undefined;
	if (options.logging) {
		mkdirSync(path.join(logsDir, "channels"), { recursive: true });
		logConfig = hubLogConfig;
		hubLogger = hubLog;
	}

	let dbManager: HubDatabases | undefined;
	let server: HubServer | undefined;
	let runtime: RuntimeInfo | undefined;
	let runtimePublished = false;
	try {
		// The identity exists before token revocation, binding or publication. No
		// observable endpoint can therefore precede the key that answers for it.
		const tlsIdentity = dependencies.resolveHubTlsIdentity(
			stateDir,
			dependencies.loadTlsConfig(configDir),
		);
		const authToken = dependencies.initAuth(configDir);
		// From the directory just locked: the key names this hub to its agent
		// daemons, so it belongs to the state this lock guards (#127).
		const hubKey = dependencies.loadHubKey(stateDir);
		const ownerToken = dependencies.createOwnerToken();
		const databases = dependencies.openDatabases(stateDir);
		dbManager = databases;
		// This must commit before createServer() can construct a listener, so a
		// browser token from the previous hub run is never valid while serving.
		dependencies.sweepNonPrimaryTokens(databases.meta);
		const quit = createQuitLifecycle(() => {
			if (!server || !runtime) throw new Error("hub shutdown requested before startup completed");
			return {
				server,
				dbManager: databases,
				runtime,
				deleteRuntime: (published) => dependencies.deleteRuntime(published, stateDir),
			};
		});
		server = await dependencies.createServer({
			...(options.port !== undefined ? { port: options.port } : {}),
			// Fastify's log writes to descriptor 1 itself unless given a stream,
			// and those lines would then not be checked against the daemon log's
			// limit.
			...(daemonLogBounded ? { logger: { destination: STANDARD_OUTPUT } } : {}),
			tls: tlsIdentity.tls,
			authToken,
			hubKey,
			ownerToken,
			dbManager: databases,
			securityLog,
			// Otherwise the server looks both up again for itself.
			configDir,
			logsDir,
			...(hubLogger ? { hubLogger } : {}),
			onShutdown: () => quit.shutdown(),
			onQuit: quit.onQuit,
			onQuitDelivered: quit.onQuitDelivered,
		});
		const address = await dependencies.startServer(server, {
			...(options.port !== undefined ? { port: options.port } : {}),
		});
		const actualPort = dependencies.addStartupCorsOrigins(address, options.port);
		runtime = {
			pid: process.pid,
			port: actualPort,
			started_at: new Date().toISOString(),
			instanceId: randomUUID(),
			ownerToken,
			spki: tlsIdentity.spki,
		};
		dependencies.persistRuntime(runtime, stateDir);
		runtimePublished = true;

		securityLog.hubStarted({
			bindAddress: listenHost(address),
			port: actualPort,
			// A hub that got this far passed the permission checks above, or ran on
			// Windows, where each returns before looking (SECURITY.md § 2.2).
			permissionsCheck: process.platform === "win32" ? "not_checked_on_windows" : "passed",
		});
		hubLogger?.log("info", "hub started", { port: actualPort, address, configDir });
		if (logConfig) {
			runLogGc(logsDir, logConfig.logConfig.maxAgeDays, new Set<string>()).catch((err) => {
				hubLogger?.log("warn", "log GC failed", {
					err: err instanceof Error ? err.message : String(err),
				});
			});
		}

		options.announce?.({ address, port: actualPort, spki: tlsIdentity.spki, configDir, stateDir });
		if (options.openBrowser) openBrowser(`https://127.0.0.1:${actualPort}`);

		const shutdown = () => quit.shutdown();
		process.on("SIGTERM", () => {
			void shutdown();
		});
		process.on("SIGINT", () => {
			void shutdown();
		});
		if (options.shutdownWhenClosed) {
			shutdownWhenStdinCloses(options.shutdownWhenClosed, () => {
				void shutdown();
			});
		}
	} catch (error) {
		// Same order as a graceful shutdown, and for the same reason: the record is
		// what tells the world this hub exists, so it must not be withdrawn while the
		// socket and the databases are still live. Removing it first would make
		// `status` report stopped with a hub still serving.
		if (server && !(await closeWithinBound(server))) {
			try {
				hubLogger?.log("warn", "server did not close while unwinding a failed start", {
					timeoutMs: STARTUP_UNWIND_TIMEOUT_MS,
				});
			} catch {
				// Preserve the startup error; the log line only explains the delay.
			}
		}
		if (dbManager) {
			try {
				dbManager.close();
			} catch {
				// Preserve the original startup error.
			}
		}
		if (runtimePublished && runtime) {
			try {
				dependencies.deleteRuntime(runtime, stateDir);
			} catch {
				// Preserve the startup error; the lock still prevents a second hub.
			}
		}
		throw error;
	}
}

/** The host part of the URL Fastify reports it listens on, without IPv6 brackets. */
function listenHost(address: string): string {
	try {
		return new URL(address).hostname.replace(/^\[(.*)\]$/, "$1");
	} catch {
		// The security log withholds what is not an address; startup goes on.
		return address;
	}
}

/**
 * Wait for the server to close, but not forever. Both entry points exit once
 * `startHub` rejects, and that exit is what releases the lock. A close that never
 * settles — an `onClose` hook waiting on something that will not come — would
 * otherwise keep the process alive holding the databases and the lock, with the
 * startup error never reported. Past the bound the unwind goes on regardless, as
 * a graceful shutdown does past its own.
 *
 * Resolves true when the close finished, false when the bound ran out first.
 */
async function closeWithinBound(server: Pick<HubServer, "close">): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), STARTUP_UNWIND_TIMEOUT_MS);
	});
	// A failed close counts as finished: the startup error is the one worth
	// reporting, and a rejection arriving after the bound must not surface as an
	// unhandled one while the process exits.
	const closed = Promise.resolve()
		.then(() => server.close())
		.then(
			() => true as const,
			() => true as const,
		);
	try {
		return await Promise.race([closed, expired]);
	} finally {
		clearTimeout(timer);
	}
}
