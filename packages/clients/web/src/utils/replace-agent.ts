/**
 * Replacing the agent that serves a host, as the host dialog asks for it.
 *
 * An agent other Lasterm hubs also use refuses while they hold terminals
 * there, and says how many (#127). Ending those is a second decision, taken
 * by a person who has been told, so the refusal becomes a question and only a
 * yes sends the request again with `force`.
 */

import { transfersText } from "./host-connection.js";

/** What the hub answered, reduced to what this flow reads. */
export interface ReplaceAgentResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly body: {
		readonly message?: string;
		readonly error?: {
			readonly code?: string;
			readonly message?: string;
			readonly other_owner_channels?: number;
			readonly transfers?: number;
			/** How many of `transfers` are downloads (#840). */
			readonly downloads?: number;
		};
	};
}

/** What the person agreed to so far, as the request carries it. */
export interface ReplaceAgentConsent {
	readonly force: boolean;
	readonly stop_transfers: boolean;
}

export interface ReplaceAgentDeps {
	/** POST /api/hosts/:id/agent/replace with `{ force, stop_transfers }`. */
	readonly post: (consent: ReplaceAgentConsent) => Promise<ReplaceAgentResponse>;
	/** Ask the person; true only on an explicit yes. */
	readonly confirm: (question: string) => boolean | Promise<boolean>;
}

/** The question asked before ending terminals that other hubs opened. */
export function otherHubsQuestion(count: number | undefined): string {
	const what =
		count === undefined
			? "Terminals opened by other hubs on this host"
			: count === 1
				? "1 terminal opened by another hub on this host"
				: `${count} terminals opened by other hubs on this host`;
	return `${what} will be closed. Replace anyway?`;
}

/**
 * The question asked before interrupting the uploads to the host, and the
 * downloads from it, which `count` holds and `downloads` names apart (#840).
 */
export function transfersQuestion(count: number | undefined, downloads?: number): string {
	const what =
		downloads !== undefined && downloads > 0
			? `${transfersText({ uploads: (count ?? downloads) - downloads, downloads })} on this host`
			: count === undefined
				? "Uploads to this host"
				: count === 1
					? "1 upload to this host"
					: `${count} uploads to this host`;
	return `${what} will be interrupted. Replace anyway?`;
}

/** What a no to that question leaves running: the uploads, the downloads, or both (#840). */
function transfersDeclined(count: number | undefined, downloads?: number): string {
	const what =
		downloads === undefined || downloads === 0
			? "the uploads to this host"
			: (count ?? downloads) > downloads
				? "the uploads and downloads on this host"
				: "the downloads on this host";
	return `Nothing was replaced: ${what} are still running.`;
}

/** Ask for the replacement, and for each wider one only after a yes. Resolves to what to show. */
export async function replaceAgentWithConsent(deps: ReplaceAgentDeps): Promise<string> {
	let consent: ReplaceAgentConsent = { force: false, stop_transfers: false };
	while (true) {
		const answer = await deps.post(consent);
		if (answer.ok) return answer.body.message ?? "The agent was stopped.";
		const error = answer.body.error;
		let question: string;
		let declined: string;
		let next: ReplaceAgentConsent;
		if (answer.status === 409 && error?.code === "OTHER_HUBS_HOLD_CHANNELS" && !consent.force) {
			question = otherHubsQuestion(error.other_owner_channels);
			declined = "Nothing was replaced: the terminals other hubs opened are still running.";
			next = { ...consent, force: true };
		} else if (
			answer.status === 409 &&
			error?.code === "TRANSFERS_WOULD_STOP" &&
			!consent.stop_transfers
		) {
			question = transfersQuestion(error.transfers, error.downloads);
			declined = transfersDeclined(error.transfers, error.downloads);
			next = { ...consent, stop_transfers: true };
		} else {
			return error?.message ?? `The hub answered ${answer.status}.`;
		}
		if (!(await deps.confirm(question))) return declined;
		consent = next;
	}
}
