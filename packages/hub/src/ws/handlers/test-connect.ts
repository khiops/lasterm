import type { TestConnectMessage } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleTestConnect(msg: TestConnectMessage, ctx: WsHandlerContext): void {
	const { client, clientId, log, sessionManager } = ctx;

	// hostId: not necessarily a ULID (can be client-generated temp ID), must be non-empty ≤ 128 chars
	if (typeof msg.hostId !== "string" || msg.hostId.length === 0 || msg.hostId.length > 128) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid hostId" });
		return;
	}
	if (typeof msg.hostname !== "string" || msg.hostname.length === 0 || msg.hostname.length > 4096) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid hostname" });
		return;
	}
	if (typeof msg.port !== "number" || msg.port < 1 || msg.port > 65535) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid port" });
		return;
	}
	if (!["agent", "key", "password"].includes(msg.sshAuth)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid sshAuth" });
		return;
	}
	if (
		msg.sshKeyPath !== undefined &&
		(typeof msg.sshKeyPath !== "string" || msg.sshKeyPath.length > 4096)
	) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid sshKeyPath" });
		return;
	}
	if (msg.sshUser !== undefined && (typeof msg.sshUser !== "string" || msg.sshUser.length > 256)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid sshUser" });
		return;
	}

	sessionManager.handleTestConnect(clientId, msg).catch((err) => {
		log.error({ err }, "TEST_CONNECT handling failed");
	});
}
