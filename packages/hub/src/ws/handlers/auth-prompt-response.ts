import type { AuthPromptResponseMessage } from "@lasterm/shared";
import { isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleAuthPromptResponse(
	msg: AuthPromptResponseMessage,
	ctx: WsHandlerContext,
): void {
	const { client, clientId, sessionManager } = ctx;

	if (!isValidUlid(msg.hostId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid hostId" });
		return;
	}
	if (msg.secret !== null && (typeof msg.secret !== "string" || msg.secret.length > 4096)) {
		client.send({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "secret must be a string ≤ 4096 chars or null",
		});
		return;
	}
	if (!isValidUlid(msg.promptId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid promptId" });
		return;
	}
	if (
		typeof msg.deliveryEpoch !== "number" ||
		!Number.isFinite(msg.deliveryEpoch) ||
		msg.deliveryEpoch < 0
	) {
		client.send({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "deliveryEpoch must be a finite non-negative number",
		});
		return;
	}

	sessionManager.handleAuthPromptResponse(clientId, msg);
}
