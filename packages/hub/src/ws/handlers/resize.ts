import type { ResizeMessage } from "@lasterm/shared";
import { isValidDimensions, isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

/**
 * A client asks for its terminal's size.
 *
 * A terminal has one size, its PTY's, and one client decides it: the one
 * holding the write lock (#831). Every other client's pane resizes too — a
 * reader beside the writer, a second device — and its RESIZE is dropped
 * without an answer: that is normal, not an error. With nobody holding the
 * lock nobody decides, and the size stays put until someone takes it.
 */
export function handleResize(msg: ResizeMessage, ctx: WsHandlerContext): void {
	const { client, clientId, sessionManager, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}
	if (!isValidDimensions(msg.cols, msg.rows)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid dimensions" });
		return;
	}
	if (!writeLockManager.isHolder(msg.channelId, clientId)) return;

	sessionManager.handleResize(clientId, msg.channelId, msg.cols, msg.rows);
}
