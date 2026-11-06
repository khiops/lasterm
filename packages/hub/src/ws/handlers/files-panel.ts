import type { ErrorMessage, FilesPanelMessage } from "@lasterm/shared";
import { isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

/**
 * The writer's window says whether its files panel is open on a terminal (#838).
 *
 * The panel is a window-level change to the terminal, as its size is (#831): only the client
 * holding the write lock may say it, and anyone else is refused as a reader's INPUT is
 * (`WRITE_LOCK_DENIED`). While nobody holds the lock, nobody may, and the last state stands.
 *
 * A window has one panel, attached to one terminal: opening it on one terminal closes it on
 * every other terminal the same client writes, so a panel that moves from A to B closes on A
 * and opens on B even when the window says only the second.
 */
export function handleFilesPanel(msg: FilesPanelMessage, ctx: WsHandlerContext): void {
	const { client, clientId, sessionManager, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}
	if (typeof msg.open !== "boolean") {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid open" });
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

	if (msg.open) {
		for (const other of writeLockManager.heldBy(clientId)) {
			if (other !== msg.channelId) sessionManager.setFilesPanel(other, false);
		}
	}
	sessionManager.setFilesPanel(msg.channelId, msg.open);
}
