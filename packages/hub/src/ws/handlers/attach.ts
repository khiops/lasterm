import type { UiAttachMessage } from "@lasterm/shared";
import { isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleAttach(msg: UiAttachMessage, ctx: WsHandlerContext): void {
	const { client, clientId, log, sessionManager, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}

	sessionManager
		.handleAttach(clientId, msg.channelId)
		.then((ok) => {
			if (ok) {
				writeLockManager.attach(msg.channelId, clientId);
			}
		})
		.catch((err: unknown) => {
			log.error({ err }, "ATTACH handling failed");
		});
}
