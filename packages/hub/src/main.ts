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
import { HubLogger } from "./logging/hub-logger.js";
import { runLogGc } from "./logging/log-gc.js";
import { openBrowser } from "./open-browser.js";
import { addStartupCorsOrigins, createServer, startServer } from "./server.js";
import { createOwnerToken, createQuitLifecycle } from "./shutdown.js";
import { openDatabases } from "./storage/db.js";

async function main() {
	const envPort = process.env.TERMORA_PORT;
	if (envPort !== undefined) {
		const parsedEnvPort = Number(envPort);
		if (!Number.isInteger(parsedEnvPort) || parsedEnvPort < 1 || parsedEnvPort > 65535) {
			throw new Error(`Invalid TERMORA_PORT: ${envPort} — must be an integer between 1 and 65535`);
		}
	}
	const port = envPort !== undefined ? Number(envPort) : 4100;

	const configDir = getConfigDir();
	const stateDir = getStateDir();
	mkdirSync(configDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });

	// Ensure logs directory structure exists before creating HubLogger
	const logsDir = path.join(stateDir, "logs");
	mkdirSync(path.join(logsDir, "channels"), { recursive: true });

	// Load config.toml before creating HubLogger so logging config (level, output, etc.)
	// is respected from the start. ConfigResolver.loadFromFile() silently no-ops if the
	// file is absent, so this is always safe to call here.
	const earlyConfigResolver = new ConfigResolver(null as never);
	earlyConfigResolver.loadFromFile(configDir);

	// Initialize hub logger with config from config.toml (falls back to defaults if missing)
	const hubLogger = new HubLogger(logsDir, earlyConfigResolver.logConfig);

	const authToken = initAuth(configDir);
	const ownerToken = createOwnerToken();
	const dbManager = openDatabases(stateDir);

	let server: Awaited<ReturnType<typeof createServer>>;
	let runtime!: RuntimeInfo;
	const quit = createQuitLifecycle(() => ({ server, dbManager, runtime, deleteRuntime }));
	server = await createServer({
		port,
		authToken,
		ownerToken,
		dbManager,
		hubLogger,
		logsDir,
		onShutdown: () => quit.shutdown(),
		onQuit: quit.onQuit,
		onQuitDelivered: quit.onQuitDelivered,
	});
	const address = await startServer(server, { port });
	const actualPort = addStartupCorsOrigins(address, port);

	runtime = {
		pid: process.pid,
		port: actualPort,
		started_at: new Date().toISOString(),
		instanceId: randomUUID(),
		ownerToken,
	};
	persistRuntime(runtime);

	hubLogger.log("info", "hub started", { port: actualPort, address, configDir });

	// Run log GC after startup — active channels are recent enough to not be GC'd
	// (maxAgeDays=30 by default; any live channel log was created in this session).
	// PRE-04: GC runs with empty active set on fresh start (safe — no daemon
	// reattach on hub startup yet). When daemon reattach is implemented,
	// populate activeChannelIds from ctx.channels before running GC.
	runLogGc(logsDir, earlyConfigResolver.logConfig.maxAgeDays, new Set<string>()).catch((err) => {
		hubLogger.log("warn", "log GC failed", {
			err: err instanceof Error ? err.message : String(err),
		});
	});

	// Open browser if requested via TERMORA_OPEN env (set by CLI daemon spawner)
	if (process.env.TERMORA_OPEN === "1") {
		openBrowser(`http://127.0.0.1:${actualPort}`);
	}

	const shutdown = () => quit.shutdown();

	process.on("SIGTERM", () => {
		void shutdown();
	});
	process.on("SIGINT", () => {
		void shutdown();
	});
}

main().catch((err) => {
	process.stderr.write(`Failed to start hub: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
