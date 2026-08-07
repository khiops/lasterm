import type { ProtocolMessage } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handlePing(_msg: ProtocolMessage, ctx: WsHandlerContext): void {
	ctx.client.send({ type: "PONG" });
}
