import type {
	TransferCancelMessage,
	TransferDiscardMessage,
	TransferErrorMessage,
	TransferResolveMessage,
	TransferResumeMessage,
	TransferRetryMessage,
	TransferStartMessage,
} from "@lasterm/shared";
import { ErrorCode } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export type TransferMessage =
	| TransferStartMessage
	| TransferResolveMessage
	| TransferRetryMessage
	| TransferCancelMessage
	| TransferResumeMessage
	| TransferDiscardMessage;

/** The upload a refusal names: a start's request, one upload's id, or the first of several. */
function refusalTarget(msg: TransferMessage): Partial<TransferErrorMessage> {
	switch (msg.type) {
		case "TRANSFER_START":
			return { requestId: typeof msg.requestId === "string" ? msg.requestId : "" };
		case "TRANSFER_RESUME":
		case "TRANSFER_DISCARD": {
			const first = Array.isArray(msg.transferIds) ? msg.transferIds[0] : undefined;
			return { transferId: typeof first === "string" ? first : "" };
		}
		default:
			return { transferId: typeof msg.transferId === "string" ? msg.transferId : "" };
	}
}

/**
 * TRANSFER_START, _RESOLVE, _RETRY and _CANCEL (#833), _RESUME and _DISCARD
 * (#860): handed to the transfer service, which checks the write lock as
 * INPUT does and answers. Refused at once while `[experimental]
 * file_transfer` is off.
 *
 * Nothing is logged: the messages hold paths and names, which are the user's.
 */
export function handleTransfer(msg: TransferMessage, ctx: WsHandlerContext): void {
	const transfers = ctx.transfers;
	if (transfers === undefined || !transfers.enabled()) {
		ctx.client.send({
			type: "TRANSFER_ERROR",
			...refusalTarget(msg),
			code: ErrorCode.FILE_TRANSFER_DISABLED,
			message: "File transfer is off: [experimental] file_transfer",
		} satisfies TransferErrorMessage);
		return;
	}
	const requester = { clientId: ctx.clientId, tokenId: ctx.tokenId };
	const failed = (error: unknown) => {
		ctx.log.error(
			{ msgType: msg.type, errorName: error instanceof Error ? error.name : typeof error },
			"transfer: request failed unexpectedly",
		);
	};
	try {
		switch (msg.type) {
			case "TRANSFER_START":
				void transfers.service.start(requester, msg).catch(failed);
				break;
			case "TRANSFER_RESOLVE":
				transfers.service.resolve(requester, msg);
				break;
			case "TRANSFER_RETRY":
				void transfers.service.retry(requester, msg).catch(failed);
				break;
			case "TRANSFER_CANCEL":
				transfers.service.cancel(requester, msg);
				break;
			case "TRANSFER_RESUME":
				void transfers.service.resume(requester, msg).catch(failed);
				break;
			case "TRANSFER_DISCARD":
				void transfers.service.discard(requester, msg).catch(failed);
				break;
		}
	} catch (error) {
		failed(error);
	}
}
