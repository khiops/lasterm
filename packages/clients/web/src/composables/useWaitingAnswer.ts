import { onScopeDispose, type Ref, watch } from "vue";
import { useConfigStore } from "../stores/config.js";
import {
	type AlwaysChoice,
	answerWaiting,
	type EndHold,
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
	/** Do what the overlay's button for `action` does. */
	act: (action: OverlayAction) => void;
}

/**
 * An overlay waiting for an answer takes the one "Always do this" gave on
 * another overlay of this window (#586), once, as `answerWaiting` says.
 *
 * Only an overlay up when the choice is told follows it: one that comes up
 * afterwards follows the setting, as any end does. It stops waiting when it
 * acts, when it leaves the screen without having acted, when its overlay goes,
 * and when the pane is handed another terminal.
 */
export function useWaitingAnswer(sources: WaitingAnswerSources): void {
	const configStore = useConfigStore();

	/** The choice this overlay waits to follow, and whether it has been on screen since. */
	let followed: { choice: AlwaysChoice; wasInView: boolean } | null = null;

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
		if (verdict === "act") sources.act(current.choice.action);
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
		if (!waiting || channelId !== channelBefore) followed = null;
	});
	watch(
		[sources.inView, sources.whenEnded, sources.hold, sources.directProcess, sources.hostId],
		answer,
	);

	onScopeDispose(stopHearing);
}
