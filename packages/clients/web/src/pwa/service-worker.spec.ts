import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeContainer } from "./service-worker.fixture.js";
import {
	createPageServiceWorker,
	type PageServiceWorkerOptions,
	SERVICE_WORKER_SCOPE,
	SERVICE_WORKER_URL,
} from "./service-worker.js";

const PAGE_BUILD = "aaaaaaa";
const NEWER_BUILD = "bbbbbbb";

/** A page of `PAGE_BUILD` in a browser where a worker can register. */
function page(options: Omit<PageServiceWorkerOptions, "container" | "reloadPage"> = {}) {
	const container = new FakeContainer();
	const reloadPage = vi.fn();
	const signalUpdate = vi.fn();
	const serviceWorker = createPageServiceWorker({
		container: container.asContainer(),
		devServer: false,
		secureContext: true,
		pageBuild: PAGE_BUILD,
		reloadPage,
		...options,
	});
	return { container, reloadPage, signalUpdate, serviceWorker };
}

/** Let a message port deliver, and the timers of a few tasks run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	debug = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("where the worker registers (#561)", () => {
	it("registers /sw.js at the hub's root, in a secure browser page", async () => {
		const { container, serviceWorker, signalUpdate } = page();

		await serviceWorker.register(signalUpdate);

		expect(container.register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
			scope: SERVICE_WORKER_SCOPE,
		});
		expect(SERVICE_WORKER_URL).toBe("/sw.js");
		expect(SERVICE_WORKER_SCOPE).toBe("/");
	});

	it("never under the desktop runtime, whose UI comes with the app", async () => {
		(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
		const { container, serviceWorker, signalUpdate } = page();

		await serviceWorker.register(signalUpdate);

		expect(container.register).not.toHaveBeenCalled();
	});

	it("never under the Vite dev server", async () => {
		const { container, serviceWorker, signalUpdate } = page({ devServer: true });

		await serviceWorker.register(signalUpdate);

		expect(container.register).not.toHaveBeenCalled();
	});

	it("never outside a secure context", async () => {
		const { container, serviceWorker, signalUpdate } = page({ secureContext: false });

		await serviceWorker.register(signalUpdate);

		expect(container.register).not.toHaveBeenCalled();
	});

	it("never in a browser without service workers, and says so once, at debug", async () => {
		const serviceWorker = createPageServiceWorker({
			container: null,
			devServer: false,
			secureContext: true,
		});

		await expect(serviceWorker.register(vi.fn())).resolves.toBeUndefined();
		expect(debug).toHaveBeenCalledTimes(1);
	});
});

describe("a browser that refuses the worker", () => {
	it("is taken quietly: one line at debug, and the page works as it would without one", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { container, serviceWorker, signalUpdate, reloadPage } = page();
		container.register.mockRejectedValue(
			new DOMException(
				"Failed to register a ServiceWorker: An SSL certificate error occurred when fetching the script.",
				"SecurityError",
			),
		);

		await expect(serviceWorker.register(signalUpdate)).resolves.toBeUndefined();
		expect(debug).toHaveBeenCalledTimes(1);
		expect(String(debug.mock.calls[0]?.[0])).toContain("SecurityError");
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();

		// Nothing to update, and a reload is a plain reload.
		await expect(serviceWorker.update()).resolves.toBeUndefined();
		serviceWorker.reload();
		await settle();
		expect(reloadPage).toHaveBeenCalledTimes(1);
		expect(signalUpdate).not.toHaveBeenCalled();
	});
});

describe("a new worker is an update (#560)", () => {
	it("one that installs while an older worker controls the page signals the update", async () => {
		const { container, serviceWorker, signalUpdate } = page();
		container.controlledBy(PAGE_BUILD);
		await serviceWorker.register(signalUpdate);

		container.registration.findNewWorker(NEWER_BUILD);
		await settle();
		expect(signalUpdate).not.toHaveBeenCalled();

		container.registration.finishInstalling();
		await vi.waitFor(() => expect(signalUpdate).toHaveBeenCalledTimes(1));
	});

	it("one the browser found while the page loaded, already waiting, signals it too", async () => {
		const { container, serviceWorker, signalUpdate } = page();
		container.controlledBy(PAGE_BUILD);
		container.withWaiting(NEWER_BUILD);

		await serviceWorker.register(signalUpdate);

		await vi.waitFor(() => expect(signalUpdate).toHaveBeenCalledTimes(1));
	});

	it("the first worker replaces nothing, and signals nothing", async () => {
		const { container, serviceWorker, signalUpdate } = page();
		await serviceWorker.register(signalUpdate);

		const worker = container.registration.findNewWorker(PAGE_BUILD);
		container.registration.finishInstalling();
		await settle();

		expect(signalUpdate).not.toHaveBeenCalled();
		expect(worker.askedToTakeOver).toBe(false);
	});

	it("one of the build this page already runs just takes over: there is nothing to reload", async () => {
		const { container, serviceWorker, signalUpdate, reloadPage } = page();
		container.controlledBy("0ld0000");
		await serviceWorker.register(signalUpdate);

		const worker = container.registration.findNewWorker(PAGE_BUILD);
		container.registration.finishInstalling();

		await vi.waitFor(() => expect(worker.askedToTakeOver).toBe(true));
		await settle();
		expect(signalUpdate).not.toHaveBeenCalled();
		expect(reloadPage).not.toHaveBeenCalled();
	});

	it("one that does not say which build it is signals the update, to be safe", async () => {
		const { container, serviceWorker, signalUpdate } = page({ replyTimeoutMs: 10 });
		container.controlledBy(PAGE_BUILD);
		const worker = container.withWaiting(PAGE_BUILD);
		worker.answers = false;

		await serviceWorker.register(signalUpdate);

		await vi.waitFor(() => expect(signalUpdate).toHaveBeenCalledTimes(1));
	});
});

describe("applying the update", () => {
	it("asks the waiting worker to take over, waits until it has, then reloads", async () => {
		const { container, serviceWorker, signalUpdate, reloadPage } = page();
		container.controlledBy(PAGE_BUILD);
		const waiting = container.withWaiting(NEWER_BUILD);
		await serviceWorker.register(signalUpdate);
		const order: string[] = [];
		container.addEventListener("controllerchange", () => order.push("controllerchange"));
		reloadPage.mockImplementation(() => order.push("reload"));

		serviceWorker.reload();
		expect(waiting.askedToTakeOver).toBe(true);
		expect(reloadPage).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
		expect(order).toEqual(["controllerchange", "reload"]);
		expect(container.controller).toBe(waiting);
	});

	it("activates a worker still installing, as the update check leaves it", async () => {
		const { container, serviceWorker, signalUpdate, reloadPage } = page();
		container.controlledBy(PAGE_BUILD);
		await serviceWorker.register(signalUpdate);
		const installing = container.registration.findNewWorker(NEWER_BUILD);

		serviceWorker.reload();

		expect(installing.askedToTakeOver).toBe(true);
		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
	});

	it("reloads at once when no worker is waiting", async () => {
		const { container, serviceWorker, signalUpdate, reloadPage } = page();
		container.controlledBy(PAGE_BUILD);
		await serviceWorker.register(signalUpdate);

		serviceWorker.reload();
		await settle();

		expect(reloadPage).toHaveBeenCalledTimes(1);
	});

	it("still reloads when the worker never takes over", async () => {
		const { container, serviceWorker, signalUpdate, reloadPage } = page({
			activationTimeoutMs: 300,
		});
		container.controlledBy(PAGE_BUILD);
		container.withWaiting(NEWER_BUILD).takesOver = false;
		await serviceWorker.register(signalUpdate);

		serviceWorker.reload();
		await settle();
		expect(reloadPage).not.toHaveBeenCalled();

		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
	});

	it("reloads once, however many times it is asked", async () => {
		const { container, serviceWorker, signalUpdate, reloadPage } = page();
		container.controlledBy(PAGE_BUILD);
		container.withWaiting(NEWER_BUILD);
		await serviceWorker.register(signalUpdate);

		serviceWorker.reload();
		serviceWorker.reload();
		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
		await settle();

		expect(reloadPage).toHaveBeenCalledTimes(1);
	});
});

describe("asking the hub for its worker", () => {
	it("asks the registration for an update", async () => {
		const { container, serviceWorker, signalUpdate } = page();
		await serviceWorker.register(signalUpdate);

		await serviceWorker.update();

		expect(container.registration.update).toHaveBeenCalledTimes(1);
	});

	it("gives up on a check that does not end, rather than hold back the news", async () => {
		const { container, serviceWorker, signalUpdate } = page({ updateTimeoutMs: 10 });
		await serviceWorker.register(signalUpdate);
		container.registration.update.mockImplementation(() => new Promise(() => {}));

		await expect(serviceWorker.update()).resolves.toBeUndefined();
	});

	it("takes a failed check quietly", async () => {
		const { container, serviceWorker, signalUpdate } = page();
		await serviceWorker.register(signalUpdate);
		container.registration.update.mockRejectedValue(new TypeError("Failed to update"));

		await expect(serviceWorker.update()).resolves.toBeUndefined();
	});
});
