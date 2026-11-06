import type { ProtocolMessage } from "@lasterm/shared";
import type { FastifyBaseLogger } from "fastify";
import type { SessionManager, WsClient } from "../../session/session-manager.js";
import type { WriteLockManager } from "../../session/write-lock.js";
import type { TransferService } from "../../transfers/transfer-service.js";

/** Uploads, for the TRANSFER_* messages (#833, #860). */
export interface WsTransfers {
	readonly service: Pick<
		TransferService,
		"start" | "resolve" | "retry" | "cancel" | "resume" | "discard"
	>;
	/** `[experimental] file_transfer`, read at each message. */
	enabled(): boolean;
}

/** Shared context passed to every per-message-type WS handler. */
export interface WsHandlerContext {
	clientId: string;
	/** The token this socket authenticated with; null on a hub without auth. */
	tokenId: string | null;
	client: WsClient;
	log: FastifyBaseLogger;
	sessionManager: SessionManager;
	writeLockManager: WriteLockManager;
	transfers?: WsTransfers;
}

/** Type alias for a single message handler function. */
export type WsMessageHandler<T extends ProtocolMessage = ProtocolMessage> = (
	msg: T,
	ctx: WsHandlerContext,
) => void;
