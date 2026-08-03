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
 * The sole server-construction path. It takes the kernel lock before any port
 * bind or database open, so foreground, daemon, and future callers cannot
 * construct a serving hub without the same authority check.
 */
export async function startHub(
	options: HubStartupOptions,
	overrides: Partial<HubStartupDependencies> = {},
): Promise<void> {
	const dependencies = { ...defaultDependencies, ...overrides };
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
