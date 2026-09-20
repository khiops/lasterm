import { defineStore } from "pinia";
import { usePromptQueue } from "../composables/usePromptQueue.js";
import type { IWsClient } from "../services/ws-client.js";

export interface HostVerifyRequest {
	hostId: string;
	hostname: string;
	fingerprint: string;
	algorithm: string;
	oldFingerprint: string;
	promptId: string;
	/** True on first connection (TOFU) — no previous fingerprint. */
	firstConnect?: boolean;
	/** What this machine's own OpenSSH configuration says about this key. */
	knownHosts?: { verdict: "trusted" | "other-key"; file: string; line: number };
}

/**
 * Host-verify store — receives HOST_VERIFY (mismatch variant) from the hub,
 * surfaces the HostKeyWarning dialog to the user, and sends back
 * HOST_VERIFY_RESPONSE (trust_permanent, trust_once, or reject).
 *
 * Prompts are queued by promptId so two HOST_VERIFY dialogs from different
 * host contexts routed to the same client do not overwrite each other.
 * PROMPT_CANCEL removes a specific entry by promptId.
 */
export const useHostVerifyStore = defineStore("hostVerify", () => {
	const { currentPrompt, enqueue, handlePromptCancel, resolveHead, withHeadPrompt } =
		usePromptQueue<HostVerifyRequest>({
			stalePromptWarning: "[host-verify] ignoring stale prompt action",
		});
	let _wsClient: IWsClient | null = null;

	// Legacy alias: components that bind `pendingPrompt` keep working
	const pendingPrompt = currentPrompt;

	function setWsClient(client: IWsClient): void {
		_wsClient = client;
	}

	function handleHostVerify(
		hostId: string,
		hostname: string,
		fingerprint: string,
		algorithm: string,
		oldFingerprint: string,
		promptId: string,
		firstConnect = false,
		knownHosts?: HostVerifyRequest["knownHosts"],
	): void {
		enqueue({
			hostId,
			hostname,
			fingerprint,
			algorithm,
			oldFingerprint,
			promptId,
			...(firstConnect ? { firstConnect: true } : {}),
			...(knownHosts ? { knownHosts } : {}),
		});
	}

	function respond(action: "trust_permanent" | "trust_once" | "reject", promptId?: string): void {
		withHeadPrompt(
			promptId,
			(req) => {
				_wsClient?.send({
					type: "HOST_VERIFY_RESPONSE",
					hostId: req.hostId,
					action,
					promptId: req.promptId,
				});
				resolveHead();
			},
			action,
		);
	}

	function accept(promptId?: string): void {
		respond("trust_permanent", promptId);
	}

	function trustOnce(promptId?: string): void {
		respond("trust_once", promptId);
	}

	function reject(promptId?: string): void {
		respond("reject", promptId);
	}

	function dismiss(promptId?: string): void {
		respond("reject", promptId);
	}

	return {
		pendingPrompt,
		currentPrompt,
		setWsClient,
		handleHostVerify,
		handlePromptCancel,
		respond,
		accept,
		trustOnce,
		reject,
		dismiss,
	};
});
