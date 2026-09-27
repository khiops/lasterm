import type { SessionStatus } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";
import type { RestartFailure } from "../stores/channels.js";
import { useHostsStore } from "../stores/hosts.js";
import { useWaitForHost, type WaitForHostHandle } from "./useWaitForHost.js";

// A restart that fails because its host is away waits for that host, and
// restarts the terminal once when it is back (#605). Which failures wait is
// afterRestartFailure's to say (exit-action.spec.ts); these follow panes
// through their host going and coming back, as the hub reports it.

/** The Pi, away: what the hub answers a restart of one of its terminals. */
const piAway: RestartFailure = {
	reason: "raspberrypi cannot be reached right now.",
	hostAway: { hostId: "pi" },
};

/** What the hub says of a host's session, as a SESSION_STATE would. */
function hostIs(hostId: string, status: SessionStatus): void {
	useHostsStore().updateSessionStatus(hostId, status);
}

/** A pane over an ended terminal of the Pi. */
function pane(channelId = "pi-shell") {
	const sources = {
		ended: ref(true),
		channelId: ref<string | null>(channelId),
	};
	let restarts = 0;
	let handle: WaitForHostHandle | null = null;
	const app = createApp(
		defineComponent({
			setup() {
				handle = useWaitForHost({ ...sources, restart: () => restarts++ });
				return {};
			},
			template: "<div />",
		}),
	);
	app.mount(document.createElement("div"));
	const mounted = (): WaitForHostHandle => {
		if (handle === null) throw new Error("not mounted");
		return handle;
	};
	return {
		...sources,
		restarts: () => restarts,
		failed: (failure: RestartFailure | undefined, automatic = false) =>
			mounted().restartFailed(failure, automatic),
		starting: () => mounted().restartStarting(),
		cancel: () => mounted().cancel(),
		waitingFor: () => mounted().waitingFor.value,
		unmount: () => app.unmount(),
	};
}

describe("useWaitForHost", () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		hostIs("pi", "disconnected");
		hostIs("local", "active");
	});

	it("restarts once when its host is connected again, and not when another host is", async () => {
		const p = pane();
		p.failed(piAway);
		expect(p.waitingFor()).toBe("pi");
		expect(p.restarts()).toBe(0);

		// Another host coming back is not this one's.
		hostIs("nas", "active");
		hostIs("local", "disconnected");
		hostIs("local", "active");
		await nextTick();
		expect(p.restarts()).toBe(0);
		expect(p.waitingFor()).toBe("pi");

		hostIs("pi", "active");
		await nextTick();
		expect(p.restarts()).toBe(1);
		expect(p.waitingFor()).toBeNull();

		// Once: the host going and coming back again restarts nothing more.
		hostIs("pi", "disconnected");
		await nextTick();
		hostIs("pi", "active");
		await nextTick();
		expect(p.restarts()).toBe(1);
	});

	// A local agent being restarted is `disconnected` until the hub has it back.
	it("waits for a local host as for a remote one", async () => {
		hostIs("local", "disconnected");
		const p = pane("local-shell");
		p.failed({
			reason: "This machine cannot be reached right now.",
			hostAway: { hostId: "local" },
		});
		expect(p.waitingFor()).toBe("local");

		hostIs("local", "active");
		await nextTick();
		expect(p.restarts()).toBe(1);
	});

	// Each restarts its own terminal, once; the hub's claim keeps two starts of
	// one terminal apart (#593).
	it("restarts each pane waiting on the host once", async () => {
		const a = pane("pi-a");
		const b = pane("pi-b");
		a.failed(piAway);
		b.failed(piAway);

		hostIs("pi", "active");
		await nextTick();

		expect([a.restarts(), b.restarts()]).toEqual([1, 1]);
	});

	it("stops waiting on Cancel: the host's return restarts nothing", async () => {
		const p = pane();
		p.failed(piAway);
		p.cancel();
		expect(p.waitingFor()).toBeNull();

		hostIs("pi", "active");
		await nextTick();
		expect(p.restarts()).toBe(0);
	});

	it("does not wait over any other failure", async () => {
		const p = pane();
		p.failed({ reason: "The remote agent daemon did not answer." });
		p.failed(undefined);
		expect(p.waitingFor()).toBeNull();

		hostIs("pi", "active");
		await nextTick();
		expect(p.restarts()).toBe(0);
	});

	// The refusal crossed the host's return.
	it("tries again at once when the host is back already, and only once", () => {
		hostIs("pi", "active");
		const p = pane();
		p.failed(piAway);
		expect(p.restarts()).toBe(1);
		expect(p.waitingFor()).toBeNull();

		// That retry met the same refusal, the host still said to be connected.
		p.failed(piAway, true);
		expect(p.restarts()).toBe(1);
		expect(p.waitingFor()).toBeNull();
	});

	// Brought back from elsewhere, or handed another terminal: the wait was
	// for the terminal that ended, and a restart now would restart a live one.
	it("stops waiting once its terminal no longer shows ended, or is another one", async () => {
		const broughtBack = pane();
		broughtBack.failed(piAway);
		broughtBack.ended.value = false;
		await nextTick();
		expect(broughtBack.waitingFor()).toBeNull();

		const handedAnother = pane();
		handedAnother.failed(piAway);
		handedAnother.channelId.value = "another";
		await nextTick();
		expect(handedAnother.waitingFor()).toBeNull();

		hostIs("pi", "active");
		await nextTick();
		expect([broughtBack.restarts(), handedAnother.restarts()]).toEqual([0, 0]);
	});

	// Whatever another restart meets decides afresh.
	it("stops waiting when another restart starts", async () => {
		const p = pane();
		p.failed(piAway);
		p.starting();
		expect(p.waitingFor()).toBeNull();

		hostIs("pi", "active");
		await nextTick();
		expect(p.restarts()).toBe(0);
	});

	it("restarts nothing once its pane is gone", async () => {
		const p = pane();
		p.failed(piAway);
		p.unmount();

		hostIs("pi", "active");
		await nextTick();
		expect(p.restarts()).toBe(0);
	});
});
