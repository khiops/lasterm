/**
 * A host's Reconnect and Disconnect, as its menu asks for them (#648).
 *
 * Closing a connection ends the terminals it runs, and stops the uploads and
 * downloads it carries (#833, #840). The hub says so, and how many, and does
 * nothing; the question goes to the person, and only a yes sends the request
 * again with `force`. A host whose daemon keeps its terminals, with nothing
 * being transferred, is never asked about: nothing ends.
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

/** The uploads to a host and the downloads from it that would stop (#840). */
export interface StoppingTransfers {
	readonly uploads: number;
	readonly downloads: number;
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

/** "1 upload", "2 downloads", "1 upload and 2 downloads" (#840). */
export function transfersText({ uploads, downloads }: StoppingTransfers): string {
	const words: string[] = [];
	if (uploads > 0 || downloads === 0) words.push(uploads === 1 ? "1 upload" : `${uploads} uploads`);
	if (downloads > 0) words.push(downloads === 1 ? "1 download" : `${downloads} downloads`);
	return words.join(" and ");
}

/** "2 uploads to pi", "1 download on pi", "1 upload and 1 download on pi", as the hub says them. */
function transfersAt(transfers: StoppingTransfers, place: string): string {
	return `${transfersText(transfers)} ${transfers.downloads > 0 ? "on" : "to"} ${place}`;
}

/**
 * The question asked before closing a connection that ends `count` terminals,
 * and stops `transfers` with them when any.
 */
export function terminalsEndQuestion(
	action: HostConnectionAction,
	hostLabel: string,
	count: number,
	transfers?: StoppingTransfers,
): HostConnectionQuestion {
	const verb = action === "reconnect" ? "Reconnect" : "Disconnect";
	const ending = `${terminals(count)} on ${hostLabel} will end`;
	return {
		title: `${verb} ${hostLabel}?`,
		message:
			transfers === undefined
				? `${ending}.`
				: `${ending}, and ${transfersAt(transfers, "it")} will stop.`,
		confirmLabel: verb,
	};
}

/** The question asked before closing a connection that stops transfers and ends no terminal (#840). */
function transfersStopQuestion(
	action: HostConnectionAction,
	hostLabel: string,
	transfers: StoppingTransfers,
): HostConnectionQuestion {
	const verb = action === "reconnect" ? "Reconnect" : "Disconnect";
	return {
		title: `${verb} ${hostLabel}?`,
		message: `${transfersAt(transfers, hostLabel)} will stop.`,
		confirmLabel: verb,
	};
}

/** What a refusal counts as transferring: the hub's `transfers` holds its `downloads`. */
function stoppingTransfers(refusal: {
	readonly transfers?: number;
	readonly downloads?: number;
}): StoppingTransfers | undefined {
	if (refusal.transfers === undefined) return undefined;
	const downloads = refusal.downloads ?? 0;
	return { uploads: refusal.transfers - downloads, downloads };
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
	let question: HostConnectionQuestion;
	if (first.status === 409 && refusal?.code === ErrorCode.TERMINALS_WOULD_END) {
		question = terminalsEndQuestion(
			action,
			hostLabel,
			refusal.terminals ?? 0,
			stoppingTransfers(refusal),
		);
	} else if (first.status === 409 && refusal?.code === ErrorCode.TRANSFERS_WOULD_STOP) {
		question = transfersStopQuestion(
			action,
			hostLabel,
			stoppingTransfers(refusal) ?? { uploads: 0, downloads: 0 },
		);
	} else {
		return { kind: "failed", message: hostConnectionFailure(first) };
	}
	if (!(await deps.confirm(question))) return { kind: "declined" };
	const forced = await deps.post(true);
	return forced.ok ? { kind: "done" } : { kind: "failed", message: hostConnectionFailure(forced) };
}
