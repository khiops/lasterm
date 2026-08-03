import type { SharedSessionContext } from "./session-context.js";

declare const quitFenceBrand: unique symbol;

/**
 * Capability captured while the hub is still running.  It is deliberately
 * opaque: only captureQuitFence can create one, and every revival commit
 * consumes one immediately before it mutates visible state.
 */
export type QuitFence = number & { readonly [quitFenceBrand]: true };

/** Deterministic refusal returned by all local revival operations after quit begins. */
export class HubQuittingError extends Error {
	readonly code = "HUB_QUITTING" as const;

	constructor() {
		super("Hub is quitting; local work cannot be started or restarted");
		this.name = "HubQuittingError";
	}
}

/** Capture the hub generation at an operation boundary. */
export function captureQuitFence(
	ctx: Pick<SharedSessionContext, "quitState" | "quitEpoch">,
): QuitFence {
	if (ctx.quitState === "QUITTING") throw new HubQuittingError();
	return ctx.quitEpoch as QuitFence;
}

/** Revalidate immediately before an irreversible action or state commit. */
export function assertQuitFence(
	ctx: Pick<SharedSessionContext, "quitState" | "quitEpoch">,
	epoch: QuitFence,
): void {
	if (ctx.quitState === "QUITTING" || ctx.quitEpoch !== epoch) throw new HubQuittingError();
}

export function isQuitFenceCurrent(
	ctx: Pick<SharedSessionContext, "quitState" | "quitEpoch">,
	epoch: QuitFence,
): boolean {
	return ctx.quitState !== "QUITTING" && ctx.quitEpoch === epoch;
}
