import { useToastStore } from "../stores/toast.js";

/**
 * Why the hub refused a request, as it said it (#703): its code when it gave
 * one, and its message, or the status when it sent none.
 */
export interface HubRefusal {
	readonly ok: false;
	readonly status: number;
	readonly code: string | null;
	readonly message: string;
}

/** What the hub answered a request that hands nothing back: done, or its refusal (#734). */
export type HubAnswer = { readonly ok: true } | HubRefusal;

/** Read the hub's `{ error: { code, message } }` from a refused answer. */
export async function hubRefusal(res: Response): Promise<HubRefusal> {
	let error: { code?: unknown; message?: unknown } | undefined;
	try {
		error = ((await res.json()) as { error?: { code?: unknown; message?: unknown } }).error;
	} catch {
		// No body, or not JSON: the status says it.
	}
	return {
		ok: false,
		status: res.status,
		code: typeof error?.code === "string" ? error.code : null,
		message:
			typeof error?.message === "string" && error.message !== ""
				? error.message
				: `The hub answered ${res.status}.`,
	};
}

/** What to say when a request got no answer at all: the hub is gone, or the network. */
export function hubUnreachable(error: unknown): string {
	return `Could not reach the hub: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Wait for the hub's answer to an action, and say why it did not go through
 * (#734): the hub's reason, or that it did not answer. Null when it went
 * through. For a dialog, which shows it beside its buttons and stays open.
 */
export async function whyRefused(answer: Promise<HubAnswer>): Promise<string | null> {
	try {
		const settled = await answer;
		return settled.ok ? null : settled.message;
	} catch (error) {
		return hubUnreachable(error);
	}
}

/**
 * The same for an action taken from a menu, the rail or a drag, which has no
 * place of its own to say it: a toast says why (#734). True when it went through.
 */
export async function toastRefusal(answer: Promise<HubAnswer>): Promise<boolean> {
	const why = await whyRefused(answer);
	if (why !== null) useToastStore().show("error", why);
	return why === null;
}
