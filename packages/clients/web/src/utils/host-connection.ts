/**
 * A host's Reconnect and Disconnect, as its menu asks for them (#648).
 *
 * Closing a connection that runs its terminals ends them. The hub says so,
 * and how many, and does nothing; the question goes to the person, and only
 * a yes sends the request again with `force`. A host whose daemon keeps its
 * terminals is never asked about: nothing ends.
 */

import { ErrorCode } from "@lasterm/shared";
import type { HostConnectionAnswer } from "../stores/hosts.js";

/** The two gestures that close a connection. */
export type HostConnectionAction = "reconnect" | "disconnect";

/** What the confirmation shows. */
export interface HostConnectionQuestion {
	readonly title: string;
	readonly message: string;
	readonly confirmLabel: string;
}

export interface HostConnectionDeps {
	/** POST the action, with `force` or without. */
	readonly post: (force: boolean) => Promise<HostConnectionAnswer>;
	/** Ask the person; true only on an explicit yes. */
	readonly confirm: (question: HostConnectionQuestion) => boolean | Promise<boolean>;
}

/** How it went: done, declined at the question, or refused, with the hub's reason. */
export type HostConnectionResult =
	| { readonly kind: "done" }
	| { readonly kind: "declined" }
	| { readonly kind: "failed"; readonly message: string };

/** "1 terminal", "3 terminals". */
function terminals(count: number): string {
	return count === 1 ? "1 terminal" : `${count} terminals`;
}

/** The question asked before closing a connection that ends `count` terminals. */
export function terminalsEndQuestion(
	action: HostConnectionAction,
	hostLabel: string,
	count: number,
): HostConnectionQuestion {
	const verb = action === "reconnect" ? "Reconnect" : "Disconnect";
	return {
		title: `${verb} ${hostLabel}?`,
		message: `${terminals(count)} on ${hostLabel} will end.`,
		confirmLabel: verb,
	};
}

/** The hub's reason for refusing, as a sentence to show. */
export function hostConnectionFailure(answer: HostConnectionAnswer): string {
	return answer.body.error?.message ?? `The hub answered ${answer.status}.`;
}

/** Ask for the action, and for its forced form only after a yes. */
export async function closeConnectionWithConsent(
	action: HostConnectionAction,
	hostLabel: string,
	deps: HostConnectionDeps,
): Promise<HostConnectionResult> {
	const first = await deps.post(false);
	if (first.ok) return { kind: "done" };
	const refusal = first.body.error;
	if (first.status !== 409 || refusal?.code !== ErrorCode.TERMINALS_WOULD_END) {
		return { kind: "failed", message: hostConnectionFailure(first) };
	}
	const question = terminalsEndQuestion(action, hostLabel, refusal.terminals ?? 0);
	if (!(await deps.confirm(question))) return { kind: "declined" };
	const forced = await deps.post(true);
	return forced.ok ? { kind: "done" } : { kind: "failed", message: hostConnectionFailure(forced) };
}
