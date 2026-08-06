import type { ResizeMessage } from "@lasterm/shared";
import { isValidDimensions, isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleResize(msg: ResizeMessage, ctx: WsHandlerContext): void {
	const { client, clientId, sessionManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}
	if (!isValidDimensions(msg.cols, msg.rows)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid dimensions" });
		return;
	}

	sessionManager.handleResize(clientId, msg.channelId, msg.cols, msg.rows);
}
