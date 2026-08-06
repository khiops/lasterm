import type { ProtocolMessage } from "@lasterm/shared";
import type { FastifyBaseLogger } from "fastify";
import type { SessionManager, WsClient } from "../../session/session-manager.js";
import type { WriteLockManager } from "../../session/write-lock.js";

/** Shared context passed to every per-message-type WS handler. */
export interface WsHandlerContext {
	clientId: string;
	client: WsClient;
	log: FastifyBaseLogger;
	sessionManager: SessionManager;
	writeLockManager: WriteLockManager;
}

/** Type alias for a single message handler function. */
export type WsMessageHandler<T extends ProtocolMessage = ProtocolMessage> = (
	msg: T,
	ctx: WsHandlerContext,
) => void;
