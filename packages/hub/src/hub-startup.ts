import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { initAuth } from "./auth.js";
import {
	deleteRuntime,
	getConfigDir,
	getStateDir,
	persistRuntime,
	type RuntimeInfo,
} from "./cli.js";
import { ConfigResolver } from "./config.js";
import { acquireHubLock } from "./hub-lock.js";
import { HubLogger } from "./logging/hub-logger.js";
import { runLogGc } from "./logging/log-gc.js";
import { openBrowser } from "./open-browser.js";
import {
	describePreviousInstallation,
	PreviousInstallationError,
} from "./previous-installation.js";
import { addStartupCorsOrigins, createServer, startServer } from "./server.js";
import { createOwnerToken, createQuitLifecycle } from "./shutdown.js";
import { openDatabases } from "./storage/db.js";

export interface HubStartupOptions {
	readonly port: number;
	readonly openBrowser?: boolean;
	readonly logging?: boolean;
	readonly announce?: (details: {
		address: string;
		port: number;
		configDir: string;
		stateDir: string;
	}) => void;
}

type HubServer = Awaited<ReturnType<typeof createServer>>;
type HubDatabases = ReturnType<typeof openDatabases>;

/** Injectable only to make the acquisition-to-cleanup boundary observable. */
export interface HubStartupDependencies {
	readonly getStateDir: typeof getStateDir;
	readonly getConfigDir: typeof getConfigDir;
	readonly describePreviousInstallation: typeof describePreviousInstallation;
	readonly acquireHubLock: typeof acquireHubLock;
	readonly initAuth: typeof initAuth;
	readonly createOwnerToken: typeof createOwnerToken;
	readonly openDatabases: typeof openDatabases;
	readonly createServer: typeof createServer;
	readonly startServer: typeof startServer;
	readonly addStartupCorsOrigins: typeof addStartupCorsOrigins;
	readonly persistRuntime: typeof persistRuntime;
	readonly deleteRuntime: typeof deleteRuntime;
}

const defaultDependencies: HubStartupDependencies = {
	getStateDir,
	getConfigDir,
	describePreviousInstallation,
	acquireHubLock,
	initAuth,
	createOwnerToken,
	openDatabases,
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
 * says "no previous installation" and `createServer` remains exported; a caller
 * inside this process can therefore construct a hub without either check. That
 * costs nothing to concede: such a caller already runs at this process's
 * privilege and has cheaper ways to do anything the checks prevent. What the
 * checks buy is that no *shipped path* reaches a serving hub without them, and
 * that a new one added later inherits both by default rather than by memory.
 */
export async function startHub(
	options: HubStartupOptions,
	overrides: Partial<HubStartupDependencies> = {},
): Promise<void> {
	const dependencies = { ...defaultDependencies, ...overrides };
	// Before a directory is created, a port is bound or the lock is taken. The two
	// generations share no lock, so this is the only thing standing between them.
	const previous = dependencies.describePreviousInstallation();
	if (previous !== undefined) throw new PreviousInstallationError(previous);

	const stateDir = dependencies.getStateDir();
	dependencies.acquireHubLock(stateDir);

	const configDir = dependencies.getConfigDir();
	mkdirSync(configDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });

	let hubLogger: HubLogger | undefined;
	let logConfig: ConfigResolver | undefined;
	let logsDir: string | undefined;
	if (options.logging) {
		logsDir = path.join(stateDir, "logs");
		mkdirSync(path.join(logsDir, "channels"), { recursive: true });
		logConfig = new ConfigResolver(null as never);
		logConfig.loadFromFile(configDir);
		hubLogger = new HubLogger(logsDir, logConfig.logConfig);
	}

	let dbManager: HubDatabases | undefined;
	let server: HubServer | undefined;
	let runtime: RuntimeInfo | undefined;
	let runtimePublished = false;
	try {
		const authToken = dependencies.initAuth(configDir);
		const ownerToken = dependencies.createOwnerToken();
		const databases = dependencies.openDatabases(stateDir);
		dbManager = databases;
		const quit = createQuitLifecycle(() => {
			if (!server || !runtime) throw new Error("hub shutdown requested before startup completed");
			return { server, dbManager: databases, runtime, deleteRuntime: dependencies.deleteRuntime };
		});
		server = await dependencies.createServer({
			port: options.port,
			authToken,
			ownerToken,
			dbManager: databases,
			...(hubLogger ? { hubLogger } : {}),
			...(logsDir ? { logsDir } : {}),
			onShutdown: () => quit.shutdown(),
			onQuit: quit.onQuit,
			onQuitDelivered: quit.onQuitDelivered,
		});
		const address = await dependencies.startServer(server, { port: options.port });
		const actualPort = dependencies.addStartupCorsOrigins(address, options.port);
		runtime = {
			pid: process.pid,
			port: actualPort,
			started_at: new Date().toISOString(),
			instanceId: randomUUID(),
			ownerToken,
		};
		dependencies.persistRuntime(runtime);
		runtimePublished = true;

		hubLogger?.log("info", "hub started", { port: actualPort, address, configDir });
		if (logConfig && logsDir) {
			runLogGc(logsDir, logConfig.logConfig.maxAgeDays, new Set<string>()).catch((err) => {
				hubLogger?.log("warn", "log GC failed", {
					err: err instanceof Error ? err.message : String(err),
				});
			});
		}

		options.announce?.({ address, port: actualPort, configDir, stateDir });
		if (options.openBrowser) openBrowser(`http://127.0.0.1:${actualPort}`);

		const shutdown = () => quit.shutdown();
		process.on("SIGTERM", () => {
			void shutdown();
		});
		process.on("SIGINT", () => {
			void shutdown();
		});
	} catch (error) {
		// Same order as a graceful shutdown, and for the same reason: the record is
		// what tells the world this hub exists, so it must not be withdrawn while the
		// socket and the databases are still live. Removing it first would make
		// `status` report stopped with a hub still serving.
		if (server) {
			try {
				await server.close();
			} catch {
				// Preserve the startup error; database cleanup still has to run.
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
				dependencies.deleteRuntime(runtime);
			} catch {
				// Preserve the startup error; the lock still prevents a second hub.
			}
		}
		throw error;
	}
}
