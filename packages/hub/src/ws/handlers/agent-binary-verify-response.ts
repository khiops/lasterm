import type { AgentBinaryVerifyResponseMessage } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleAgentBinaryVerifyResponse(
	msg: AgentBinaryVerifyResponseMessage,
	ctx: WsHandlerContext,
): void {
	const { client, sessionManager } = ctx;

	if (!msg.promptId || typeof msg.promptId !== "string" || msg.promptId.length > 128) {
		client.send({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "Invalid promptId",
		});
		return;
	}
	if (!["trust_permanent", "trust_once", "reject"].includes(msg.action)) {
		client.send({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "Invalid action",
		});
		return;
	}

	sessionManager.handleAgentVerifyResponse(msg.promptId, msg.action, client.id);
}
