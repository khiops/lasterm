import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { nextTick, ref } from "vue";
import { FakeContainer } from "../pwa/service-worker.fixture.js";
import { createPageServiceWorker } from "../pwa/service-worker.js";
import { createHubUpdate, type HubUpdateOptions, RELOADED_FROM_KEY } from "./useHubUpdate.js";

const PAGE_BUILD = "aaaaaaa";
const NEWER_BUILD = "bbbbbbb";

function setHidden(hidden: boolean): void {
	Object.defineProperty(document, "hidden", { value: hidden, writable: true, configurable: true });
}

function hide(): void {
	setHidden(true);
	document.dispatchEvent(new Event("visibilitychange"));
}

/** Let a connection's watcher run, and the health request it started settle. */
async function settle(): Promise<void> {
	await nextTick();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function preloadError(): Event {
	return Object.assign(new Event("vite:preloadError", { cancelable: true }), {
		payload: new Error("Failed to fetch dynamically imported module"),
	});
}

const stops: Array<() => void> = [];

/** A page running `clientBuild`, against a hub that reports `hubBuild`, already connected. */
function page(
	hubBuild: string | null,
	options: Omit<HubUpdateOptions, "fetchHubBuild" | "reload"> = {},
) {
	const reload = vi.fn();
	const fetchHubBuild = vi.fn(async () => hubBuild);
	const hubUpdate = createHubUpdate({
		clientBuild: PAGE_BUILD,
		...options,
		fetchHubBuild,
		reload,
	});
	const connected = ref(true);
	stops.push(hubUpdate.start(connected));
	return { hubUpdate, reload, fetchHubBuild, connected };
}

beforeEach(() => {
	sessionStorage.clear();
	setHidden(false);
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
	setHidden(false);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a tab that outlived a hub upgrade (#560)", () => {
	it("does nothing while the hub serves this page's build", async () => {
		setHidden(true);
		const { hubUpdate, reload, fetchHubBuild } = page(PAGE_BUILD);
		await settle();

		expect(fetchHubBuild).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();
		expect(hubUpdate.bannerVisible.value).toBe(false);
	});

	it("reads a longer hash of the same commit as the same build", async () => {
		setHidden(true);
		const { reload } = page("abc12345", { clientBuild: "abc1234" });
		await settle();

		expect(reload).not.toHaveBeenCalled();
	});

	it("reloads a hidden tab at once when the hub's build differs", async () => {
		setHidden(true);
		const { hubUpdate, reload } = page(NEWER_BUILD);
		await settle();

		expect(reload).toHaveBeenCalledTimes(1);
		expect(hubUpdate.bannerVisible.value).toBe(false);
	});

	it("shows a visible tab the banner instead, and reloads it once hidden", async () => {
		const { hubUpdate, reload } = page(NEWER_BUILD);
		await settle();

		expect(reload).not.toHaveBeenCalled();
		expect(hubUpdate.bannerVisible.value).toBe(true);

		hide();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("reloads when the banner's button is pressed", async () => {
		const { hubUpdate, reload } = page(NEWER_BUILD);
		await settle();

		hubUpdate.applyUpdate();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("checks again on every reconnection", async () => {
		const { fetchHubBuild, connected } = page(PAGE_BUILD);
		await settle();
		expect(fetchHubBuild).toHaveBeenCalledTimes(1);

		connected.value = false;
		await settle();
		expect(fetchHubBuild).toHaveBeenCalledTimes(1);

		connected.value = true;
		await settle();
		expect(fetchHubBuild).toHaveBeenCalledTimes(2);
	});

	it("does nothing when the hub cannot be asked", async () => {
		setHidden(true);
		const { hubUpdate, reload } = page(null);
		await settle();

		expect(reload).not.toHaveBeenCalled();
		expect(hubUpdate.bannerVisible.value).toBe(false);
	});

	it("reads the hub's build from /api/health", async () => {
		setHidden(true);
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ status: "ok", version: "0.12.0", build: NEWER_BUILD })),
		);
		vi.stubGlobal("fetch", fetch);
		const reload = vi.fn();
		stops.push(createHubUpdate({ clientBuild: PAGE_BUILD, reload }).start(ref(true)));
		await settle();

		expect(fetch).toHaveBeenCalledWith("/api/health", undefined);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	describe("a dev build never triggers", () => {
		it("on the page's side", async () => {
			setHidden(true);
			const { hubUpdate, reload, fetchHubBuild } = page(NEWER_BUILD, { clientBuild: "dev" });
			await settle();
			const event = preloadError();
			window.dispatchEvent(event);

			expect(fetchHubBuild).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
			expect(reload).not.toHaveBeenCalled();
			expect(hubUpdate.bannerVisible.value).toBe(false);
		});

		it("on the hub's side", async () => {
			setHidden(true);
			const { hubUpdate, reload } = page("dev");
			await settle();

			expect(reload).not.toHaveBeenCalled();
			expect(hubUpdate.bannerVisible.value).toBe(false);
		});
	});

	it("does nothing under the desktop runtime, whose UI comes with the app", async () => {
		(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
		setHidden(true);
		const { hubUpdate, reload, fetchHubBuild } = page(NEWER_BUILD);
		await settle();
		const event = preloadError();
		window.dispatchEvent(event);
		hubUpdate.signalUpdate();

		expect(fetchHubBuild).not.toHaveBeenCalled();
		// Left to Vite, which throws it to the import that failed, as before.
		expect(event.defaultPrevented).toBe(false);
		expect(reload).not.toHaveBeenCalled();
		expect(hubUpdate.bannerVisible.value).toBe(false);
	});

	describe("a chunk that fails to load", () => {
		it("reloads a hidden tab, and keeps Vite from throwing the error", () => {
			setHidden(true);
			const { reload } = page(null);
			const event = preloadError();
			window.dispatchEvent(event);

			expect(event.defaultPrevented).toBe(true);
			expect(reload).toHaveBeenCalledTimes(1);
		});

		it("shows a visible tab the banner", () => {
			const { hubUpdate, reload } = page(null);
			window.dispatchEvent(preloadError());

			expect(reload).not.toHaveBeenCalled();
			expect(hubUpdate.bannerVisible.value).toBe(true);
		});
	});

	describe("never a reload loop", () => {
		it("a page that came back with the same build shows the banner instead of reloading again", async () => {
			setHidden(true);
			const first = page(NEWER_BUILD);
			await settle();
			expect(first.reload).toHaveBeenCalledTimes(1);

			// The reload served the same UI again: an index.html from a cache.
			const second = page(NEWER_BUILD);
			await settle();
			hide();

			expect(second.reload).not.toHaveBeenCalled();
			expect(second.hubUpdate.bannerVisible.value).toBe(true);
		});

		it("the banner's button still reloads", async () => {
			sessionStorage.setItem(RELOADED_FROM_KEY, PAGE_BUILD);
			const { hubUpdate, reload } = page(NEWER_BUILD);
			await settle();

			hubUpdate.applyUpdate();
			expect(reload).toHaveBeenCalledTimes(1);
		});

		it("a page that reached the hub's build forgets the reload, so the next upgrade reloads it", async () => {
			sessionStorage.setItem(RELOADED_FROM_KEY, PAGE_BUILD);
			page(PAGE_BUILD);
			await settle();
			expect(sessionStorage.getItem(RELOADED_FROM_KEY)).toBeNull();

			setHidden(true);
			const { reload } = page(NEWER_BUILD);
			await settle();
			expect(reload).toHaveBeenCalledTimes(1);
		});

		it("a tab that cannot record the reload does not reload by itself", async () => {
			const setItem = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
				throw new Error("storage refused");
			});
			// vi.restoreAllMocks() leaves a spy on happy-dom's Storage in place.
			onTestFinished(() => setItem.mockRestore());
			setHidden(true);
			const { hubUpdate, reload } = page(NEWER_BUILD);
			await settle();

			expect(reload).not.toHaveBeenCalled();
			expect(hubUpdate.bannerVisible.value).toBe(true);
		});
	});
});

describe("with the PWA's service worker in the path (#561)", () => {
	it("asks for the hub's worker before it acts on a mismatch", async () => {
		setHidden(true);
		let finishCheck: () => void = () => {};
		const updateWorker = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishCheck = resolve;
				}),
		);
		const reload = vi.fn();
		stops.push(
			createHubUpdate({
				clientBuild: PAGE_BUILD,
				fetchHubBuild: async () => NEWER_BUILD,
				reload,
				updateWorker,
			}).start(ref(true)),
		);
		await settle();

		expect(updateWorker).toHaveBeenCalledTimes(1);
		expect(reload).not.toHaveBeenCalled();

		finishCheck();
		await settle();
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does not ask for a worker while the hub serves this page's build, or cannot be asked", async () => {
		const updateWorker = vi.fn(async () => {});
		for (const hubBuild of [PAGE_BUILD, null]) {
			stops.push(
				createHubUpdate({
					clientBuild: PAGE_BUILD,
					fetchHubBuild: async () => hubBuild,
					reload: vi.fn(),
					updateWorker,
				}).start(ref(true)),
			);
		}
		await settle();

		expect(updateWorker).not.toHaveBeenCalled();
	});

	/** A page of `PAGE_BUILD`, its worker and its watcher wired as `useHubUpdate()` wires them. */
	function pwaPage(container: FakeContainer) {
		const reloadPage = vi.fn();
		const serviceWorker = createPageServiceWorker({
			container: container.asContainer(),
			devServer: false,
			secureContext: true,
			pageBuild: PAGE_BUILD,
			reloadPage,
		});
		const hubUpdate = createHubUpdate({
			clientBuild: PAGE_BUILD,
			fetchHubBuild: async () => NEWER_BUILD,
			reload: () => serviceWorker.reload(),
			updateWorker: () => serviceWorker.update(),
		});
		const workerSignal = vi.fn(() => hubUpdate.signalUpdate());
		return { reloadPage, serviceWorker, hubUpdate, workerSignal };
	}

	it("a hidden tab fetches the hub's worker, lets it take over, then reloads", async () => {
		setHidden(true);
		const container = new FakeContainer();
		container.controlledBy(PAGE_BUILD);
		// The update check finds the hub's new worker, and leaves it installing.
		container.registration.update.mockImplementation(async () => {
			container.registration.findNewWorker(NEWER_BUILD);
		});
		const { reloadPage, serviceWorker, hubUpdate, workerSignal } = pwaPage(container);
		await serviceWorker.register(workerSignal);
		stops.push(hubUpdate.start(ref(true)));

		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
		expect(container.registration.update).toHaveBeenCalledTimes(1);
		expect(container.controller?.build).toBe(NEWER_BUILD);
	});

	it("still never loops: a page that came back unchanged shows the banner, worker or not", async () => {
		setHidden(true);
		const first = new FakeContainer();
		first.controlledBy(PAGE_BUILD);
		first.withWaiting(NEWER_BUILD);
		const firstPage = pwaPage(first);
		await firstPage.serviceWorker.register(firstPage.workerSignal);
		stops.push(firstPage.hubUpdate.start(ref(true)));
		await vi.waitFor(() => expect(firstPage.reloadPage).toHaveBeenCalledTimes(1));

		// The reload brought the same UI back, and a worker of the hub's build is
		// waiting again: both the worker and the hub say there is an update.
		const second = new FakeContainer();
		second.controlledBy(PAGE_BUILD);
		second.withWaiting(NEWER_BUILD);
		const secondPage = pwaPage(second);
		await secondPage.serviceWorker.register(secondPage.workerSignal);
		stops.push(secondPage.hubUpdate.start(ref(true)));
		await vi.waitFor(() => expect(secondPage.workerSignal).toHaveBeenCalledTimes(1));
		await settle();
		hide();
		await settle();

		expect(secondPage.reloadPage).not.toHaveBeenCalled();
		expect(secondPage.hubUpdate.bannerVisible.value).toBe(true);

		// The banner's button still applies it.
		secondPage.hubUpdate.applyUpdate();
		await vi.waitFor(() => expect(secondPage.reloadPage).toHaveBeenCalledTimes(1));
	});
});
