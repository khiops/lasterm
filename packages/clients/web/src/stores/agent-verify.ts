import type { AgentBinaryVerifyMessage } from "@lasterm/shared";
import { defineStore } from "pinia";
import { ref } from "vue";
import { usePromptQueue } from "../composables/usePromptQueue.js";
import type { IWsClient } from "../services/ws-client.js";

/**
 * Agent-verify store — receives AGENT_BINARY_VERIFY from the hub,
 * surfaces the AgentBinaryVerify dialog to the user, and sends back
 * AGENT_BINARY_VERIFY_RESPONSE (trust_permanent, trust_once, or reject).
 * Also surfaces AGENT_NOT_AVAILABLE deploy errors.
 */

export interface AgentVerifyRequest extends AgentBinaryVerifyMessage {}

export const useAgentVerifyStore = defineStore("agentVerify", () => {
	const { currentPrompt, enqueue, handlePromptCancel, resolveHead, withHeadPrompt } =
		usePromptQueue<AgentVerifyRequest>({
			stalePromptWarning: "[agent-verify] ignoring stale prompt action",
		});
	const deployError = ref<{ message: string; hostId?: string } | null>(null);
	let _wsClient: IWsClient | null = null;

	function setWsClient(client: IWsClient): void {
		_wsClient = client;
	}

	function handleAgentVerify(msg: AgentBinaryVerifyMessage): void {
		enqueue({ ...msg });
	}

	function handleDeployError(message: string, hostId?: string): void {
		deployError.value = { message, ...(hostId !== undefined ? { hostId } : {}) };
	}

	function clearDeployError(): void {
		deployError.value = null;
	}

	function respond(action: "trust_permanent" | "trust_once" | "reject", promptId?: string): void {
		withHeadPrompt(
			promptId,
			(req) => {
				_wsClient?.send({
					type: "AGENT_BINARY_VERIFY_RESPONSE",
					promptId: req.promptId,
					action,
				});
				resolveHead();
			},
			action,
		);
	}

	function trustPermanently(promptId?: string): void {
		respond("trust_permanent", promptId);
	}

	function trustOnce(promptId?: string): void {
		respond("trust_once", promptId);
	}

	function reject(promptId?: string): void {
		respond("reject", promptId);
	}

	function dismiss(promptId?: string): void {
		withHeadPrompt(
			promptId,
			() => {
				resolveHead();
			},
			"dismiss",
		);
	}

	return {
		currentPrompt,
		deployError,
		setWsClient,
		handleAgentVerify,
		handlePromptCancel,
		handleDeployError,
		clearDeployError,
		respond,
		trustPermanently,
		trustOnce,
		reject,
		dismiss,
	};
});
