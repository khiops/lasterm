/**
 * Test-only: a browser's service worker machinery, enough of it for the page's
 * side of the PWA (#561) to run against. happy-dom has none.
 */
import { vi } from "vitest";
import { BUILD_QUERY_MESSAGE, SKIP_WAITING_MESSAGE } from "./worker-routing.js";

/** A worker as the page sees it. It answers which build it is, and takes over when asked. */
export class FakeWorker extends EventTarget {
	state: ServiceWorkerState;
	readonly messages: unknown[] = [];
	/** Whether it takes over when asked; one whose install failed never does. */
	takesOver = true;
	/** Whether it says which build it is. */
	answers = true;

	constructor(
		readonly build: string,
		state: ServiceWorkerState,
		private readonly container: FakeContainer,
	) {
		super();
		this.state = state;
	}

	postMessage(message: unknown, transfer: Transferable[] = []): void {
		this.messages.push(message);
		const type = (message as { type?: unknown }).type;
		if (type === BUILD_QUERY_MESSAGE && this.answers) {
			(transfer[0] as MessagePort | undefined)?.postMessage({ build: this.build });
		}
		if (type === SKIP_WAITING_MESSAGE && this.takesOver) {
			// The browser activates it and moves the pages over, a task later.
			setTimeout(() => this.container.takeOver(this), 0);
		}
	}

	/** Whether the page asked this worker to take over. */
	get askedToTakeOver(): boolean {
		return this.messages.some((m) => (m as { type?: unknown }).type === SKIP_WAITING_MESSAGE);
	}

	moveTo(state: ServiceWorkerState): void {
		this.state = state;
		this.dispatchEvent(new Event("statechange"));
	}
}

export class FakeRegistration extends EventTarget {
	installing: FakeWorker | null = null;
	waiting: FakeWorker | null = null;
	active: FakeWorker | null = null;
	readonly update = vi.fn(async () => {});

	constructor(private readonly container: FakeContainer) {
		super();
	}

	/** The hub serves a new worker of `build`, and the browser installs it. */
	findNewWorker(build: string): FakeWorker {
		const worker = new FakeWorker(build, "installing", this.container);
		this.installing = worker;
		this.dispatchEvent(new Event("updatefound"));
		return worker;
	}

	/** The new worker finishes installing, and waits if a controller is there. */
	finishInstalling(): void {
		const worker = this.installing;
		if (worker === null) return;
		this.installing = null;
		this.waiting = worker;
		worker.moveTo("installed");
	}
}

export class FakeContainer extends EventTarget {
	controller: FakeWorker | null = null;
	readonly registration = new FakeRegistration(this);
	readonly register = vi.fn(
		async (_url: string, _options?: RegistrationOptions) => this.registration,
	);

	/** A page loaded under an active worker of `build`, which controls it. */
	controlledBy(build: string): FakeWorker {
		const worker = new FakeWorker(build, "activated", this);
		this.registration.active = worker;
		this.controller = worker;
		return worker;
	}

	/** A worker of `build` already waiting when the page registers. */
	withWaiting(build: string): FakeWorker {
		const worker = new FakeWorker(build, "installed", this);
		this.registration.waiting = worker;
		return worker;
	}

	takeOver(worker: FakeWorker): void {
		if (this.registration.waiting === worker) this.registration.waiting = null;
		if (this.registration.installing === worker) this.registration.installing = null;
		this.registration.active = worker;
		worker.state = "activated";
		this.controller = worker;
		this.dispatchEvent(new Event("controllerchange"));
	}

	/** As `navigator.serviceWorker`, for the code under test. */
	asContainer(): ServiceWorkerContainer {
		return this as unknown as ServiceWorkerContainer;
	}
}
