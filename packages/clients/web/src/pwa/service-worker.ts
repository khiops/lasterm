/**
 * The installable PWA's service worker, from the page's side (#561).
 *
 * It adds nothing to how a page learns of an update: that stays with the hub
 * update watcher (`composables/useHubUpdate.ts`, #560), and this module plugs
 * the worker's lifecycle into it.
 * - A new worker that installs while an older one controls the page is one more
 *   "an update is available": `signalUpdate()`. A worker of the build this page
 *   already runs is let in without a word, since there is nothing to reload.
 * - `reload()` is how the watcher applies an update: the waiting worker is asked
 *   to take over, the page waits for it to (`controllerchange`), then reloads.
 * - `update()` asks the hub for its worker, which the watcher does before
 *   signalling a build mismatch, so the reload that follows finds it waiting.
 *
 * It registers only where a worker can work:
 * - never under the desktop runtime, whose UI comes with the app;
 * - never under the Vite dev server, which reloads the page itself;
 * - only in a secure context, and only in a browser that has service workers.
 *
 * A browser can still refuse, and the usual reason is the hub's certificate: a
 * page reached through an exception for a certificate the browser does not
 * trust gets no worker. That refusal is expected, so it is logged once at debug
 * and the app runs exactly as it does without one.
 */

import { pageBuild, sameBuild } from "../utils/page-build.js";
import { isTauriRuntime } from "../utils/tauri-runtime.js";
import { BUILD_QUERY_MESSAGE, SKIP_WAITING_MESSAGE } from "./worker-routing.js";

/** Where the hub serves the worker: its root, so the worker's scope is all the hub serves. */
export const SERVICE_WORKER_URL = "/sw.js";
export const SERVICE_WORKER_SCOPE = "/";

export interface PageServiceWorkerOptions {
	/** Defaults to `navigator.serviceWorker`, absent where the browser has none. */
	container?: ServiceWorkerContainer | null;
	/** Whether the Vite dev server serves this page. Defaults to `import.meta.env.DEV`. */
	devServer?: boolean;
	/** Defaults to `window.isSecureContext`. */
	secureContext?: boolean;
	/** Defaults to `VITE_BUILD_HASH`. */
	pageBuild?: string;
	/** Defaults to `location.reload()`. */
	reloadPage?: () => void;
	/** How long a reload waits for the new worker to take over. */
	activationTimeoutMs?: number;
	/** How long a waiting worker has to say which build it is. */
	replyTimeoutMs?: number;
	/** How long an update check may hold back the news of a mismatch. */
	updateTimeoutMs?: number;
}

export interface PageServiceWorker {
	/** Register the worker where it can work, and watch for the next one. Never rejects. */
	register(signalUpdate: () => void): Promise<void>;
	/** Ask the hub for its current worker. Never rejects, and gives up after a while. */
	update(): Promise<void>;
	/** Apply the update: let a waiting worker take over, then reload the page. */
	reload(): void;
}

function describe(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function createPageServiceWorker(options: PageServiceWorkerOptions = {}): PageServiceWorker {
	const container =
		options.container !== undefined
			? options.container
			: typeof navigator !== "undefined" && "serviceWorker" in navigator
				? navigator.serviceWorker
				: null;
	const devServer = options.devServer ?? import.meta.env.DEV;
	const secureContext = options.secureContext ?? window.isSecureContext;
	const build = options.pageBuild ?? pageBuild();
	const reloadPage = options.reloadPage ?? (() => window.location.reload());
	const activationTimeoutMs = options.activationTimeoutMs ?? 3000;
	const replyTimeoutMs = options.replyTimeoutMs ?? 2000;
	const updateTimeoutMs = options.updateTimeoutMs ?? 5000;

	let registration: ServiceWorkerRegistration | null = null;
	let reloading = false;

	function unavailableBecause(): string | null {
		if (isTauriRuntime()) return "the desktop app bundles its UI";
		if (devServer) return "the Vite dev server serves this page";
		if (!secureContext) return "this page is not a secure context";
		if (container === null) return "this browser has no service workers";
		return null;
	}

	/** The build a worker was made with, or null when it does not say in time. */
	function askBuild(worker: ServiceWorker): Promise<string | null> {
		return new Promise((resolve) => {
			const channel = new MessageChannel();
			const finish = (answer: string | null): void => {
				clearTimeout(timer);
				channel.port1.close();
				resolve(answer);
			};
			const timer = setTimeout(() => finish(null), replyTimeoutMs);
			channel.port1.onmessage = (event: MessageEvent) => {
				const answer = (event.data as { build?: unknown } | null)?.build;
				finish(typeof answer === "string" ? answer : null);
			};
			try {
				worker.postMessage({ type: BUILD_QUERY_MESSAGE }, [channel.port2]);
			} catch {
				finish(null);
			}
		});
	}

	async function offer(worker: ServiceWorker, signalUpdate: () => void): Promise<void> {
		const workerBuild = await askBuild(worker);
		if (workerBuild !== null && sameBuild(workerBuild, build)) {
			// This page already runs the build the worker came with, loaded from the
			// network before the worker was: there is nothing to reload, and a banner
			// would offer nothing. It only takes over.
			worker.postMessage({ type: SKIP_WAITING_MESSAGE });
			return;
		}
		signalUpdate();
	}

	function watchForNextWorker(reg: ServiceWorkerRegistration, signalUpdate: () => void): void {
		const offered = new WeakSet<ServiceWorker>();
		const installed = (worker: ServiceWorker): void => {
			if (offered.has(worker)) return;
			offered.add(worker);
			// With no controller this is the first worker: it replaces nothing.
			if (container?.controller == null) return;
			void offer(worker, signalUpdate);
		};
		const follow = (worker: ServiceWorker | null): void => {
			if (worker === null) return;
			if (worker.state === "installed") {
				installed(worker);
				return;
			}
			worker.addEventListener("statechange", () => {
				if (worker.state === "installed") installed(worker);
			});
		};
		// A worker the browser found on its own, while this page loaded, is
		// already there by the time registration resolves.
		follow(reg.waiting);
		follow(reg.installing);
		reg.addEventListener("updatefound", () => follow(reg.installing));
	}

	async function register(signalUpdate: () => void): Promise<void> {
		const reason = unavailableBecause();
		if (reason !== null || container === null) {
			console.debug(`[pwa] no service worker: ${reason}`);
			return;
		}
		try {
			registration = await container.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE });
		} catch (error) {
			// Expected wherever the browser does not trust the hub's certificate
			// (docs/SPEC.md § 3.4). The page works as it would without a worker.
			console.debug(`[pwa] the browser did not register the service worker: ${describe(error)}`);
			return;
		}
		watchForNextWorker(registration, signalUpdate);
	}

	async function update(): Promise<void> {
		const reg = registration;
		if (reg === null) return;
		const checked = reg.update().then(
			() => {},
			(error: unknown) => console.debug(`[pwa] the worker update check failed: ${describe(error)}`),
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const givenUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, updateTimeoutMs);
		});
		await Promise.race([checked, givenUp]);
		clearTimeout(timer);
	}

	/** Ask a waiting (or still installing) worker to take over, and wait until it has. */
	async function activateNextWorker(): Promise<void> {
		const worker = registration?.waiting ?? registration?.installing ?? null;
		if (worker === null || container === null) return;
		await new Promise<void>((resolve) => {
			const done = (): void => {
				clearTimeout(timer);
				container.removeEventListener("controllerchange", done);
				resolve();
			};
			// A worker that never takes over, one whose install failed say, must not
			// keep the page from reloading.
			const timer = setTimeout(done, activationTimeoutMs);
			container.addEventListener("controllerchange", done);
			try {
				worker.postMessage({ type: SKIP_WAITING_MESSAGE });
			} catch {
				done();
			}
		});
	}

	function reload(): void {
		if (reloading) return;
		reloading = true;
		void activateNextWorker().then(reloadPage, reloadPage);
	}

	return { register, update, reload };
}

let appServiceWorker: PageServiceWorker | null = null;

/** The app's one service worker, shared by the hub update watcher and the app's startup. */
export function useServiceWorker(): PageServiceWorker {
	appServiceWorker ??= createPageServiceWorker();
	return appServiceWorker;
}
