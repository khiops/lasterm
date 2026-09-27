import type { ChannelEndReason } from "@lasterm/shared";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, nextTick, ref } from "vue";
import { useConfigStore } from "../stores/config.js";
import {
	type AlwaysChoice,
	type EndHold,
	type OverlayAction,
	SETTING_READ_GRACE_MS,
	type WhenEnded,
} from "../utils/exit-action.js";
import { useWaitingAnswer, type WaitingAnswerHandle } from "./useWaitingAnswer.js";

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
		endReason: ref<ChannelEndReason | undefined>(undefined),
		settingKnown: ref(true),
		focused: ref(true),
	};
	const acted: OverlayAction[] = [];
	let handle: WaitingAnswerHandle | null = null;
	const app = createApp(
		defineComponent({
			setup() {
				handle = useWaitingAnswer({ ...sources, act: (action) => acted.push(action) });
				return {};
			},
			template: "<div />",
		}),
	);
	const pinia = createPinia();
	setActivePinia(pinia);
	app.use(pinia);
	app.mount(document.createElement("div"));
	const mounted = (): WaitingAnswerHandle => {
		if (handle === null) throw new Error("not mounted");
		return handle;
	};
	const endFound = (endReason?: ChannelEndReason): void => {
		mounted().endFound(endReason);
	};
	return {
		...sources,
		acted,
		endFound,
		/** The end found the setting has still to answer, as the pane reads it. */
		found: () => mounted().found.value,
		settingOverdue: () => mounted().settingOverdue.value,
		unmount: () => app.unmount(),
	};
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

// An end found at a launch, a reload or an attach follows "When a terminal
// ends" once its pane is on screen, in the window with the focus (#592). What
// it does is answerFoundEnd's to say (exit-action.spec.ts); these follow one
// pane through it.
describe("useWaitingAnswer, over an end found (#592)", () => {
	it("follows the setting once its tab is shown, and only once", async () => {
		const p = pane();
		p.whenEnded.value = "restart";
		await nextTick();
		p.endFound();
		// In a tab nobody is looking at: nothing.
		expect(p.acted).toEqual([]);

		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);

		p.inView.value = false;
		await nextTick();
		p.inView.value = true;
		p.focused.value = false;
		await nextTick();
		p.focused.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	it("acts at once when it is on screen already, and closes as Close does", async () => {
		const p = pane();
		p.whenEnded.value = "close";
		p.inView.value = true;
		await nextTick();
		p.endFound();
		expect(p.acted).toEqual(["close"]);
		p.unmount();
	});

	// Two windows over the same terminal: the one with the focus acts.
	it("waits for its window to have the focus", async () => {
		const p = pane();
		p.whenEnded.value = "restart";
		p.inView.value = true;
		p.focused.value = false;
		await nextTick();
		p.endFound();
		expect(p.acted).toEqual([]);

		p.focused.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	// Before its profile is read, every terminal says "ask".
	it("waits for its setting to be read, rather than take the default for an answer", async () => {
		const p = pane();
		p.settingKnown.value = false;
		p.inView.value = true;
		await nextTick();
		p.endFound();
		expect(p.acted).toEqual([]);

		p.whenEnded.value = "restart";
		p.settingKnown.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	it("keeps asking when the setting asks, whatever it says afterwards", async () => {
		const p = pane();
		p.inView.value = true;
		await nextTick();
		p.endFound();

		p.whenEnded.value = "restart";
		await nextTick();
		p.inView.value = false;
		await nextTick();
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	// Killed from elsewhere, or its session closed (#580).
	it("keeps asking over a kill, told with it or afterwards", async () => {
		const told = pane();
		told.whenEnded.value = "restart";
		told.inView.value = true;
		await nextTick();
		told.endFound("killed");
		expect(told.acted).toEqual([]);
		told.unmount();

		const later = pane();
		later.whenEnded.value = "restart";
		await nextTick();
		later.endFound();
		later.endReason.value = "killed";
		await nextTick();
		later.inView.value = true;
		await nextTick();
		expect(later.acted).toEqual([]);
		later.unmount();
	});

	// Its agent replaced, or the hub quit: found at the next launch, it follows
	// the setting once seen.
	it("follows the setting over a terminal stopped with its agent or its hub", async () => {
		const p = pane();
		p.whenEnded.value = "restart";
		p.endReason.value = "stopped";
		await nextTick();
		p.endFound("stopped");
		expect(p.acted).toEqual([]);

		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});

	it("keeps asking over a command, and over a restart from here that ended at once", async () => {
		for (const hold of [false, true]) {
			const p = pane();
			p.whenEnded.value = "restart";
			p.inView.value = true;
			if (hold) p.hold.value = "just-started";
			else p.directProcess.value = true;
			await nextTick();
			p.endFound();
			expect(p.acted, hold ? "just-started" : "command").toEqual([]);
			p.unmount();
		}
	});

	it("stops waiting when its overlay goes, or the pane is handed another terminal", async () => {
		for (const leave of ["overlay", "terminal"] as const) {
			const p = pane();
			p.whenEnded.value = "restart";
			await nextTick();
			p.endFound();
			if (leave === "overlay") p.waiting.value = false;
			else p.channelId.value = "another";
			await nextTick();
			p.waiting.value = true;
			p.inView.value = true;
			await nextTick();
			expect(p.acted, leave).toEqual([]);
			p.unmount();
		}
	});

	// A restart under way, say: its own answer will speak.
	it("takes nothing over an overlay that is not waiting", async () => {
		const p = pane();
		p.whenEnded.value = "restart";
		p.waiting.value = false;
		await nextTick();
		p.endFound();
		p.waiting.value = true;
		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual([]);
		p.unmount();
	});

	// What the pane shows in place of its card meanwhile is endedPaneShows's to
	// say (exit-action.spec.ts): it reads the end found here (#595).
	it("tells the pane the end its setting has still to answer, until it does", async () => {
		const p = pane();
		p.settingKnown.value = false;
		await nextTick();
		expect(p.found()).toBeNull();

		p.endFound();
		expect(p.found()).toMatchObject({ settingKnown: false, inView: false });

		// As it stands: read now, and its tab not shown.
		p.whenEnded.value = "restart";
		p.settingKnown.value = true;
		await nextTick();
		expect(p.found()).toMatchObject({ whenEnded: "restart", settingKnown: true, inView: false });

		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		expect(p.found()).toBeNull();
		p.unmount();
	});

	it("tells it nothing once the setting asks", async () => {
		const p = pane();
		p.settingKnown.value = false;
		await nextTick();
		p.endFound();
		expect(p.found()).not.toBeNull();

		p.settingKnown.value = true;
		await nextTick();
		expect(p.found()).toBeNull();
		p.unmount();
	});

	// A setting that cannot be read must not leave the pane with nothing to click.
	it("says when its setting has been too long in coming, and forgets it with the end", async () => {
		vi.useFakeTimers();
		try {
			const p = pane();
			p.settingKnown.value = false;
			p.inView.value = true;
			await nextTick();
			p.endFound();
			vi.advanceTimersByTime(SETTING_READ_GRACE_MS - 1);
			expect(p.settingOverdue()).toBe(false);
			vi.advanceTimersByTime(1);
			expect(p.settingOverdue()).toBe(true);

			// Read after all, it still answers.
			p.whenEnded.value = "restart";
			p.settingKnown.value = true;
			await nextTick();
			expect(p.acted).toEqual(["restart"]);
			expect(p.settingOverdue()).toBe(false);
			p.unmount();
		} finally {
			vi.useRealTimers();
		}
	});

	// "Always do this" on another overlay and the setting, both waiting.
	it("acts once for a choice and the setting that say the same", async () => {
		const p = pane();
		p.whenEnded.value = "restart";
		await nextTick();
		p.endFound();
		choose();

		p.inView.value = true;
		await nextTick();
		expect(p.acted).toEqual(["restart"]);
		p.unmount();
	});
});
