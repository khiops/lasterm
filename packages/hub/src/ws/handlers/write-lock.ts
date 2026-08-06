import type {
	WriteClaimMessage,
	WriteDenyMessage,
	WriteForceMessage,
	WriteGrantMessage,
	WriteReleaseMessage,
} from "@lasterm/shared";
import { isValidUlid } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleWriteClaim(msg: WriteClaimMessage, ctx: WsHandlerContext): void {
	const { client, clientId, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}

	writeLockManager.claim(msg.channelId, clientId);
}

export function handleWriteRelease(msg: WriteReleaseMessage, ctx: WsHandlerContext): void {
	const { client, clientId, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}

	writeLockManager.release(msg.channelId, clientId);
}

export function handleWriteForce(msg: WriteForceMessage, ctx: WsHandlerContext): void {
	const { client, clientId, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}

	writeLockManager.force(msg.channelId, clientId);
}

export function handleWriteGrant(msg: WriteGrantMessage, ctx: WsHandlerContext): void {
	const { client, clientId, writeLockManager } = ctx;

	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}

	writeLockManager.grant(msg.channelId, clientId, msg.toClientId);
}

export function handleWriteDeny(msg: WriteDenyMessage, ctx: WsHandlerContext): void {
	const { client, clientId, writeLockManager } = ctx;

	// WriteDenyMessage shares the toClientId field shape with WriteGrantMessage
	if (!isValidUlid(msg.channelId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid channelId" });
		return;
	}

	writeLockManager.deny(msg.channelId, clientId, msg.toClientId);
}
