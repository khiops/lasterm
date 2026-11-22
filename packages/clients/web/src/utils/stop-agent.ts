import type { StopKeepingAgentResponse } from "@lasterm/shared";
import type { StopKeepingAgentAnswer, StopKeepingAgentBody } from "../stores/hosts.js";
import { type HostConnectionQuestion, transfersText } from "./host-connection.js";

export interface StopAgentDeps {
	readonly post: (body: StopKeepingAgentBody) => Promise<StopKeepingAgentAnswer>;
	readonly confirm: (question: HostConnectionQuestion) => boolean | Promise<boolean>;
}

export type StopAgentResult =
	| { readonly kind: "done"; readonly outcome: StopKeepingAgentResponse }
	| { readonly kind: "declined" }
	| { readonly kind: "failed"; readonly message: string };

/** "1 upload", "3 uploads", or "Uploads" when the hub gave no count. */
export function uploadsPhrase(count: number | undefined): string {
	if (count === undefined) return "Uploads";
	return `${count} upload${count === 1 ? "" : "s"}`;
}

/** "4 uploads to this host stop.", or with downloads "1 upload and 1 download on this host stop." (#840). */
function transfersStopMessage(
	transfers: number | undefined,
	downloads: number | undefined,
): string {
	if (downloads === undefined || downloads === 0)
		return `${uploadsPhrase(transfers)} to this host stop.`;
	const uploads = (transfers ?? downloads) - downloads;
	return `${transfersText({ uploads, downloads })} on this host stop.`;
}

export async function stopAgentWithConsent(
	hostLabel: string,
	deps: StopAgentDeps,
): Promise<StopAgentResult> {
	let body: StopKeepingAgentBody = {};
	while (true) {
		const answer = await deps.post(body);
		if (answer.ok && answer.body.host && answer.body.outcome) {
			return {
				kind: "done",
				outcome: { ...answer.body, host: answer.body.host, outcome: answer.body.outcome },
			};
		}
		const error = answer.body.error;
		let message: string;
		let consent: StopKeepingAgentBody;
		if (answer.status === 409 && error?.code === "TERMINALS_WOULD_END" && !body.end_terminals) {
			const count = error.terminals ?? 0;
			message = `Its ${count} terminal${count === 1 ? "" : "s"} here end.`;
			consent = { end_terminals: true };
		} else if (
			answer.status === 409 &&
			error?.code === "TRANSFERS_WOULD_STOP" &&
			!body.stop_transfers
		) {
			message = transfersStopMessage(error.transfers, error.downloads);
			consent = { stop_transfers: true };
		} else if (answer.status === 409 && error?.code === "OTHER_HUBS_HOLD_CHANNELS" && !body.force) {
			const count = error.other_owner_channels;
			message = `${count ?? "Unknown"} terminal${count === 1 ? "" : "s"} opened by other Lasterm hubs would end too.`;
			consent = { force: true };
		} else {
			return { kind: "failed", message: error?.message ?? `The hub answered ${answer.status}.` };
		}
		if (
			!(await deps.confirm({
				title: `Stop the agent on ${hostLabel}?`,
				message,
				confirmLabel: "Stop agent",
			}))
		) {
			return { kind: "declined" };
		}
		body = { ...body, ...consent };
	}
}
