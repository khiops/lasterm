import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";
import { useConfigStore } from "../stores/config.js";
import type { AlwaysChoice, EndHold, OverlayAction, WhenEnded } from "../utils/exit-action.js";
import { useWaitingAnswer } from "./useWaitingAnswer.js";

// "Always do this" on one overlay also answers the overlays already waiting
// in this window, in its scope, each as it comes into view (#586). What each
// does is answerWaiting's to say (exit-action.spec.ts); these follow one pane
// through the choice reaching it.

/** A pane over a terminal that ended on host h1, in a tab not shown. */
function pane() {
	const sources = {
		waiting: ref(true),
		channelId: ref<string | null>("waiting-one"),
		hostId: ref<string | null | undefined>("h1"),
		hold: ref<EndHold | null>(null),
		directProcess: ref(false),
		whenEnded: ref<WhenEnded>("ask"),
		inView: ref(false),
	};
	const acted: OverlayAction[] = [];
	const app = createApp(
		defineComponent({
			setup() {
				useWaitingAnswer({ ...sources, act: (action) => acted.push(action) });
				return {};
			},
			template: "<div />",
		}),
	);
	const pinia = createPinia();
	setActivePinia(pinia);
	app.use(pinia);
	app.mount(document.createElement("div"));
	return { ...sources, acted, unmount: () => app.unmount() };
}

/** "Always do this" clicked on another terminal of h1, once written. */
function choose(choice: Partial<AlwaysChoice> = {}): void {
	useConfigStore().announceAlwaysChoice({
		action: "restart",
		scope: "host",
		hostId: "h1",
		channelId: "clicked",
		at: 1,
		...choice,
	});
}

describe("useWaitingAnswer", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("acts once its tab is shown, with its setting saying so", async () => {
		const p = pane();
		choose();
		p.whenEnded.value = "restart";
		await nextTick();
		// In a tab nobody is looking at: nothing.
		expect(p.acted).toEqual([]);

		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);

		// Once: showing it again, or the setting read again, does nothing more.
		p.inView.value = false;
		await nextTick();
		p.inView.value = true;
		p.whenEnded.value = "ask";
		await nextTick();
		p.whenEnded.value = "restart";
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	it("acts at once when it is already on screen, beside the one clicked", async () => {
		const p = pane();
		p.inView.value = true;
		p.whenEnded.value = "close";
		await nextTick();
		choose({ action: "close" });
		expect(p.acted).toEqual(["close"]);
		p.unmount();
	});

	// The write is announced by the hub, and the setting read again after it.
	it("on screen before its setting was read again, acts when it is", async () => {
		const p = pane();
		p.inView.value = true;
		await nextTick();
		choose();
		expect(p.acted).toEqual([]);

		p.whenEnded.value = "restart";
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	// An override of its own says otherwise: it had its turn.
	it("keeps asking once it left the screen without its setting agreeing", async () => {
		const p = pane();
		choose();
		p.inView.value = true;
		await nextTick();
		p.inView.value = false;
		await nextTick();

		p.whenEnded.value = "restart";
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	it("an overlay that comes up after the choice does not follow it", async () => {
		const p = pane();
		p.waiting.value = false;
		await nextTick();
		choose();

		p.waiting.value = true;
		p.whenEnded.value = "restart";
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	it("stops waiting when its overlay goes", async () => {
		const p = pane();
		choose();
		p.waiting.value = false;
		await nextTick();

		p.waiting.value = true;
		p.whenEnded.value = "restart";
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	it("stops waiting when the pane is handed another terminal", async () => {
		const p = pane();
		choose();
		p.channelId.value = "another";
		await nextTick();

		p.whenEnded.value = "restart";
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	it("does not follow a choice out of its scope, nor one it is held back from", async () => {
		const p = pane();
		p.inView.value = true;
		p.whenEnded.value = "restart";
		await nextTick();

		choose({ hostId: "h2" });
		p.hold.value = "just-started";
		await nextTick();
		choose({ at: 2 });
		p.hold.value = null;
		p.directProcess.value = true;
		await nextTick();
		choose({ at: 3 });
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	// Two clicks, told in the order their writes finished.
	it("of two choices, follows the one clicked last", async () => {
		const p = pane();
		choose({ action: "close", at: 2 });
		choose({ action: "restart", at: 1 });
		p.whenEnded.value = "restart";
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);

		p.whenEnded.value = "close";
		await nextTick();
		expect(p.acted).toEqual(["close"]);
		p.unmount();
	});

	it("a choice out of its scope leaves the one it follows standing", async () => {
		const p = pane();
		choose();
		choose({ action: "close", hostId: "h2", at: 2 });
		p.whenEnded.value = "restart";
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	it("hears nothing once the pane is gone", () => {
		const p = pane();
		p.inView.value = true;
		p.whenEnded.value = "restart";
		p.unmount();
		choose();
		expect(p.acted).toEqual([]);
	});
});
