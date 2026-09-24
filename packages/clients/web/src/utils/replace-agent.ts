/**
 * Replacing the agent that serves a host, as the host dialog asks for it.
 *
 * An agent other Lasterm hubs also use refuses while they hold terminals
 * there, and says how many (#127). Ending those is a second decision, taken
 * by a person who has been told, so the refusal becomes a question and only a
 * yes sends the request again with `force`.
 */

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
		};
	};
}

export interface ReplaceAgentDeps {
	/** POST /api/hosts/:id/agent/replace with `{ force }`. */
	readonly post: (force: boolean) => Promise<ReplaceAgentResponse>;
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

/** Ask for the replacement, and for the forced one only after a yes. Resolves to what to show. */
export async function replaceAgentWithConsent(deps: ReplaceAgentDeps): Promise<string> {
	const first = await deps.post(false);
	if (first.ok) return first.body.message ?? "The agent was stopped.";
	if (first.status !== 409 || first.body.error?.code !== "OTHER_HUBS_HOLD_CHANNELS") {
		return first.body.error?.message ?? `The hub answered ${first.status}.`;
	}

	if (!(await deps.confirm(otherHubsQuestion(first.body.error.other_owner_channels)))) {
		return "Nothing was replaced: the terminals other hubs opened are still running.";
	}
	const forced = await deps.post(true);
	if (forced.ok) return forced.body.message ?? "The agent was stopped.";
	return forced.body.error?.message ?? `The hub answered ${forced.status}.`;
}
