import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RuntimeInfo } from "./cli.js";
import type { AgentStopResult } from "./session/agent-launcher.js";
import type { DatabaseManager } from "./storage/db.js";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

let shutdownPromise: Promise<void> | null = null;

export interface GracefulShutdownOptions {
	readonly server: Pick<FastifyInstance, "close" | "log">;
	readonly dbManager: Pick<DatabaseManager, "close">;
	/** The record this hub published; deletion must prove it still owns the path. */
	readonly runtime: RuntimeInfo;
	readonly deleteRuntime: (runtime: RuntimeInfo) => boolean;
	readonly exit?: (code: number) => void;
	readonly timeoutMs?: number;
	readonly setTimeout?: typeof setTimeout;
	readonly clearTimeout?: typeof clearTimeout;
	/** Exit status after teardown; defaults to zero for ordinary `termora stop`. */
	readonly exitCode?: number;
}

export interface QuitSessionController {
	beginQuit(): void;
	stopLocalAgent(): Promise<AgentStopResult>;
}

export interface QuitResult {
	readonly ok: boolean;
	readonly message: string;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * The only construction point for a quit-capable server lifecycle.  Startup
 * code receives its request and post-response callbacks as an inseparable
 * value, so foreground and daemon startup cannot wire only one half.
 */
export interface QuitLifecycle {
	readonly onQuit: (sessionManager: QuitSessionController | null) => Promise<QuitResult>;
	readonly onQuitDelivered: () => Promise<void>;
	shutdown(): Promise<void>;
}

export function createQuitLifecycle(shutdownOptions: () => GracefulShutdownOptions): QuitLifecycle {
	let coordinator: QuitCoordinator | null = null;
	return {
		onQuit: async (sessionManager) => {
			if (!sessionManager) {
				return { ok: false, message: "Quit is unavailable", stdout: "", stderr: "" };
			}
			coordinator ??= new QuitCoordinator(sessionManager, shutdownOptions());
			return coordinator.beginQuit();
		},
		onQuitDelivered: () => coordinator?.finishQuit() ?? Promise.resolve(),
		shutdown: () => coordinator?.shutdown() ?? gracefulShutdown(shutdownOptions()),
	};
}

/**
 * Owns the one-way quit sequence. The session layer owns the meaning of its
 * two calls; this coordinator owns their ordering and ensures signals/ordinary
 * shutdown requests join an in-progress quit rather than run another teardown.
 */
export class QuitCoordinator {
	private stopPromise: Promise<QuitResult> | null = null;
	private teardownPromise: Promise<void> | null = null;
	private resolveQuitCompletion!: () => void;
	private readonly quitCompletion = new Promise<void>((resolve) => {
		this.resolveQuitCompletion = resolve;
	});

	constructor(
		private readonly session: QuitSessionController,
		private readonly shutdownOptions: GracefulShutdownOptions,
	) {}

	private observeTeardown(teardown: Promise<void>): Promise<void> {
		void teardown.finally(() => this.resolveQuitCompletion());
		return teardown;
	}

	beginQuit(): Promise<QuitResult> {
		if (this.stopPromise) return this.stopPromise;
		this.session.beginQuit();
		let stopper: Promise<AgentStopResult>;
		try {
			stopper = this.session.stopLocalAgent();
		} catch (err) {
			stopper = Promise.reject(err);
		}
		this.stopPromise = stopper.then(
			(result) => ({
				ok: result.stopped,
				message: result.diagnostic,
				stdout: result.stdout,
				stderr: result.stderr,
			}),
			(err) => ({
				ok: false,
				message: `Agent stop was not confirmed: ${err instanceof Error ? err.message : String(err)}`,
				stdout: "",
				stderr: "",
			}),
		);
		return this.stopPromise;
	}

	/** Call only after /api/quit has sent its bounded stopper result. */
	finishQuit(): Promise<void> {
		if (this.teardownPromise) return this.teardownPromise;
		this.teardownPromise = this.observeTeardown(
			this.beginQuit().then((result) =>
				gracefulShutdown({ ...this.shutdownOptions, exitCode: result.ok ? 0 : 1 }),
			),
		);
		return this.teardownPromise;
	}

	/** Ordinary stop/signal joins a pending quit; otherwise retains hub-only semantics. */
	shutdown(): Promise<void> {
		// /api/quit owns the response-before-close boundary. A concurrent ordinary
		// stop or signal joins that operation instead of closing the socket early.
		if (this.stopPromise) return this.quitCompletion;
		if (this.teardownPromise) return this.teardownPromise;
		this.teardownPromise = this.observeTeardown(gracefulShutdown(this.shutdownOptions));
		return this.teardownPromise;
	}
}

class ShutdownTimeoutError extends Error {
	constructor(readonly phase: string) {
		super(`Shutdown timed out during ${phase}`);
		this.name = "ShutdownTimeoutError";
	}
}

export function createOwnerToken(): string {
	return randomBytes(32).toString("hex");
}

export function resetGracefulShutdownForTests(): void {
	shutdownPromise = null;
}

export function gracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
	if (shutdownPromise) return shutdownPromise;

	shutdownPromise = runGracefulShutdown(options);
	return shutdownPromise;
}

async function runGracefulShutdown(options: GracefulShutdownOptions): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	const setTimeoutFn = options.setTimeout ?? setTimeout;
	const clearTimeoutFn = options.clearTimeout ?? clearTimeout;
	const exit = options.exit ?? ((code: number) => process.exit(code));

	let phase = "server.close";
	let runtimeDeleted = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	const teardown = (async () => {
		phase = "server.close";
		await options.server.close();

		phase = "db.close";
		options.dbManager.close();

		phase = "runtime.delete";
		options.deleteRuntime(options.runtime);
		runtimeDeleted = true;

		phase = "exit";
		exit(options.exitCode ?? 0);
	})();

	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeoutFn(() => {
			reject(new ShutdownTimeoutError(phase));
		}, timeoutMs);
	});

	try {
		await Promise.race([teardown, timeout]);
	} catch (err) {
		const timedOut = err instanceof ShutdownTimeoutError;
		options.server.log?.error(
			{
				err,
				phase: timedOut ? err.phase : phase,
			},
			timedOut ? "graceful shutdown timed out" : "graceful shutdown failed",
		);
		if (!runtimeDeleted) {
			try {
				options.deleteRuntime(options.runtime);
				runtimeDeleted = true;
			} catch (deleteErr) {
				options.server.log?.error({ err: deleteErr }, "failed to delete runtime.json");
			}
		}
		exit(1);
	} finally {
		if (timeoutId !== undefined) clearTimeoutFn(timeoutId);
	}
}
