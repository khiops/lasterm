import type { ChannelEndReason } from "@lasterm/shared";
import { onScopeDispose, type Ref, watch } from "vue";
import { useConfigStore } from "../stores/config.js";
import {
	type AlwaysChoice,
	answerFoundEnd,
	answerWaiting,
	type EndHold,
	type FoundEnd,
	type OverlayAction,
	type WaitingOverlay,
	type WhenEnded,
} from "../utils/exit-action.js";

/** What a pane knows that decides whether its overlay follows a choice. */
export interface WaitingAnswerSources {
	/** Its overlay is up over a terminal that ended, waiting for an answer. */
	waiting: Readonly<Ref<boolean>>;
	channelId: Readonly<Ref<string | null>>;
	hostId: Readonly<Ref<string | null | undefined>>;
	hold: Readonly<Ref<EndHold | null>>;
	directProcess: Readonly<Ref<boolean>>;
	whenEnded: Readonly<Ref<WhenEnded>>;
	inView: Readonly<Ref<boolean>>;
	/** Why the hub says its terminal ended, when it ended it on purpose (#580). */
	endReason: Readonly<Ref<ChannelEndReason | undefined>>;
	/** `whenEnded` was read for its terminal, and is no longer the default. */
	settingKnown: Readonly<Ref<boolean>>;
	/** Its window has the focus. */
	focused: Readonly<Ref<boolean>>;
	/** Do what the overlay's button for `action` does. */
	act: (action: OverlayAction) => void;
}

/** What the pane tells its waiting overlay. */
export interface WaitingAnswerHandle {
	/**
	 * Its terminal was found ended, and this is the first it hears of that end
	 * (#592): the setting answers it, once, as `answerFoundEnd` says.
	 * `endReason` is what the hub said of it then, if anything.
	 */
	endFound(endReason?: ChannelEndReason): void;
}

/**
 * An overlay waiting for an answer takes one, once, when it is on screen:
 *
 * - the one "Always do this" gave on another overlay of this window (#586), as
 *   `answerWaiting` says. Only an overlay up when the choice is told follows
 *   it: one that comes up afterwards follows the setting, as any end does;
 * - the setting itself, over an end its pane found rather than saw (#592), as
 *   `answerFoundEnd` says.
 *
 * It stops waiting when it acts, when it leaves the screen without having
 * acted (for a choice), when its overlay goes, and when the pane is handed
 * another terminal. Of the two, whichever acts first answers for both.
 */
export function useWaitingAnswer(sources: WaitingAnswerSources): WaitingAnswerHandle {
	const configStore = useConfigStore();

	/** The choice this overlay waits to follow, and whether it has been on screen since. */
	let followed: { choice: AlwaysChoice; wasInView: boolean } | null = null;
	/** An end found, waiting on the setting, and why the hub said it ended when it was found. */
	let found: { endReason: ChannelEndReason | undefined } | null = null;

	function overlay(wasInView: boolean): WaitingOverlay {
		return {
			channelId: sources.channelId.value,
			hostId: sources.hostId.value ?? null,
			hold: sources.hold.value,
			directProcess: sources.directProcess.value,
			whenEnded: sources.whenEnded.value,
			inView: sources.inView.value,
			wasInView,
		};
	}

	/** Act, keep waiting, or stop: what the followed choice says now. */
	function answer(): void {
		const current = followed;
		if (current === null) return;
		const verdict = answerWaiting(current.choice, overlay(current.wasInView));
		if (verdict === "wait") {
			if (sources.inView.value) current.wasInView = true;
			return;
		}
		followed = null;
		if (verdict !== "act") return;
		found = null;
		sources.act(current.choice.action);
	}

	function foundEnd(endReason: ChannelEndReason | undefined): FoundEnd {
		return {
			hold: sources.hold.value,
			directProcess: sources.directProcess.value,
			// Either says it was meant: the one heard when it was found, or the one
			// the hub has said since.
			endReason: endReason ?? sources.endReason.value,
			whenEnded: sources.whenEnded.value,
			settingKnown: sources.settingKnown.value,
			inView: sources.inView.value,
			focused: sources.focused.value,
		};
	}

	/** Act, keep waiting, or stop: what the setting says now of the end found. */
	function answerFound(): void {
		const current = found;
		if (current === null) return;
		const verdict = answerFoundEnd(foundEnd(current.endReason));
		if (verdict === "wait") return;
		found = null;
		const action = sources.whenEnded.value;
		if (verdict !== "act" || action === "ask") return;
		followed = null;
		sources.act(action);
	}

	const stopHearing = configStore.onAlwaysChoice((choice) => {
		if (!sources.waiting.value) return;
		// Told out of order: the later click holds.
		if (followed !== null && followed.choice.at > choice.at) return;
		// Not for this overlay: whatever it followed before still holds.
		if (answerWaiting(choice, overlay(false)) === "ask") return;
		followed = { choice, wasInView: false };
		answer();
	});

	// First, so that an overlay gone or a terminal replaced is never answered.
	watch([sources.waiting, sources.channelId], ([waiting, channelId], [, channelBefore]) => {
		if (!waiting || channelId !== channelBefore) {
			followed = null;
			found = null;
		}
	});
	watch(
		[
			sources.inView,
			sources.whenEnded,
			sources.hold,
			sources.directProcess,
			sources.hostId,
			sources.endReason,
			sources.settingKnown,
			sources.focused,
		],
		() => {
			answer();
			answerFound();
		},
	);

	onScopeDispose(stopHearing);

	return {
		endFound(endReason) {
			// Only over an overlay up and waiting: not one restarting.
			if (!sources.waiting.value) return;
			found = { endReason };
			answerFound();
		},
	};
}
