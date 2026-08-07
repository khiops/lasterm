import type { ErrorMessage, InputMessage } from "@lasterm/shared";
import { isValidInputData, isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleInput(msg: InputMessage, ctx: WsHandlerContext): void {
	const { client, clientId, sessionManager, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}
	if (!isValidInputData(msg.data)) {
		client.send({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "Invalid or oversized input data",
		});
		return;
	}
	if (!writeLockManager.isWriteLockHolder(msg.channelId, clientId)) {
		const errMsg: ErrorMessage = {
			type: "ERROR",
			code: "WRITE_LOCK_DENIED",
			message: "You do not hold the write lock for this channel",
			channelId: msg.channelId,
		};
		client.send(errMsg);
		return;
	}

	sessionManager.handleInput(clientId, msg.channelId, msg.data);
}
