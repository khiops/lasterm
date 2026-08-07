import type { HostVerifyResponseMessage } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleHostVerifyResponse(
	msg: HostVerifyResponseMessage,
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

	sessionManager.handleHostVerifyResponse(msg.promptId, msg.action, client.id);
}
