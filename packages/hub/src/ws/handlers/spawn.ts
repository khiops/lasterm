import type { UiSpawnMessage } from "@lasterm/shared";
import { isValidDimensions, isValidEnv, isValidUlid, validateShell } from "@lasterm/shared";
import type { WsHandlerContext } from "./types.js";

export function handleSpawn(msg: UiSpawnMessage, ctx: WsHandlerContext): void {
	const { client, clientId, log, sessionManager, writeLockManager } = ctx;

	log.debug(
		{ hostId: msg.hostId, clientId, shell: msg.shell, cols: msg.cols, rows: msg.rows },
		"spawn-handler: received SPAWN",
	);

	if (!isValidUlid(msg.hostId)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid hostId" });
		return;
	}
	if (msg.cols !== undefined || msg.rows !== undefined) {
		if (!isValidDimensions(msg.cols, msg.rows)) {
			client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid dimensions" });
			return;
		}
	}
	const shellError = validateShell(msg.shell);
	if (shellError !== null) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: shellError });
		return;
	}
	if (msg.cwd !== undefined && (typeof msg.cwd !== "string" || msg.cwd.length > 4096)) {
		client.send({
			type: "ERROR",
			code: "INVALID_INPUT",
			message: "cwd must be a string ≤ 4096 chars",
		});
		return;
	}
	if (!isValidEnv(msg.env)) {
		client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid env" });
		return;
	}

	log.debug({ clientId }, "spawn-handler: validation passed, calling sessionManager.handleSpawn");
	sessionManager
		.handleSpawn(clientId, msg)
		.then((channelId) => {
			log.debug({ channelId }, "spawn-handler: handleSpawn returned");
			if (channelId) {
				writeLockManager.attach(channelId, clientId);
			}
		})
		.catch((err: unknown) => {
			log.error({ err }, "spawn-handler: handleSpawn threw");
			const errorMsg = err instanceof Error ? err.message : String(err);
			const code = (err as Record<string, unknown>)?.code;
			client.send({
				type: "ERROR",
				code: typeof code === "string" ? code : "SPAWN_FAILED",
				message: errorMsg,
			});
		});
}
