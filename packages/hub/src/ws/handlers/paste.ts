import type { ErrorMessage, PasteCancelMessage, PasteMessage } from "@lasterm/shared";
import { isValidInputData, isValidPasteNumber, isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

/**
 * A chunk of a paste (#1014). Only the terminal's write-lock holder sends
 * one: `isHolder`, stricter than INPUT's check, which lets anyone through
 * while nobody holds the lock. A pane pastes only as the holder.
 */
export function handlePaste(msg: PasteMessage, ctx: WsHandlerContext): void {
	const { client, clientId, sessionManager, writeLockManager } = ctx;
	if (
		!isValidUlid(msg.channelId) ||
		!isValidInputData(msg.data) ||
		!isValidPasteNumber(msg.pasteId) ||
		!isValidPasteNumber(msg.seq) ||
		typeof msg.last !== "boolean"
	) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid paste chunk" });
		return;
	}
	if (!writeLockManager.isHolder(msg.channelId, clientId)) {
		client.send({
			type: "ERROR",
			code: "WRITE_LOCK_DENIED",
			message: "You do not hold the write lock for this channel",
			channelId: msg.channelId,
		} satisfies ErrorMessage);
		return;
	}
	sessionManager.handlePaste(clientId, msg);
}

/** A window stops its paste (#1014): only its own is touched. */
export function handlePasteCancel(msg: PasteCancelMessage, ctx: WsHandlerContext): void {
	const { client, clientId, sessionManager } = ctx;
	if (!isValidUlid(msg.channelId) || !isValidPasteNumber(msg.pasteId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid paste cancel" });
		return;
	}
	sessionManager.handlePasteCancel(clientId, msg);
}
