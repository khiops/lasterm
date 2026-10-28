import { defineStore } from "pinia";
import { computed } from "vue";
import { usePromptQueue } from "../composables/usePromptQueue.js";
import type { IWsClient } from "../services/ws-client.js";

export interface AuthPromptRequest {
	hostId: string;
	promptType: "password" | "passphrase" | "elevation";
	message: string;
	/** Per-prompt passphrase cache opt-in. */
	rememberSession: boolean;
	/** Correlation ID — echoed back in AUTH_PROMPT_RESPONSE. */
	promptId: string;
	/** Delivery epoch from hub — echoed back for stale-response guard. */
	deliveryEpoch: number;
}

/**
 * Auth-prompt store — receives AUTH_PROMPT from hub when SSH needs a
 * password or key passphrase, surfaces it to the UI, and sends back
 * AUTH_PROMPT_RESPONSE (secret or null for cancel).
 *
 * Prompts are queued by promptId so two concurrent prompts routed to
 * the same client do not overwrite each other. The first entry in the
 * queue is the one currently shown; responding pops it and surfaces the
 * next (if any). PROMPT_CANCEL removes a specific entry by promptId.
 */
export const useAuthPromptStore = defineStore("authPrompt", () => {
	const { currentPrompt, enqueue, handlePromptCancel, resolveHead, withHeadPrompt } =
		usePromptQueue<AuthPromptRequest>({
			stalePromptWarning: "[auth-prompt] ignoring stale prompt action",
		});
	let _wsClient: IWsClient | null = null;

	const rememberSession = computed({
		get: () => currentPrompt.value?.rememberSession ?? false,
		set: (value: boolean) => {
			if (currentPrompt.value) {
				currentPrompt.value.rememberSession = value;
			}
		},
	});

	function setWsClient(client: IWsClient): void {
		_wsClient = client;
	}

	function handleAuthPrompt(
		hostId: string,
		promptType: "password" | "passphrase" | "elevation",
		message: string,
		promptId: string,
		deliveryEpoch: number,
	): void {
		enqueue({ hostId, promptType, message, rememberSession: false, promptId, deliveryEpoch });
	}

	function respond(secret: string | null, promptId?: string): void {
		withHeadPrompt(
			promptId,
			(req) => {
				_wsClient?.send({
					type: "AUTH_PROMPT_RESPONSE",
					hostId: req.hostId,
					secret,
					rememberSession: req.rememberSession,
					promptId: req.promptId,
					deliveryEpoch: req.deliveryEpoch,
				});
				resolveHead();
			},
			secret === null ? "dismiss" : "respond",
		);
	}

	function dismiss(promptId?: string): void {
		respond(null, promptId);
	}

	return {
		currentPrompt,
		rememberSession,
		setWsClient,
		handleAuthPrompt,
		handlePromptCancel,
		respond,
		dismiss,
	};
});
