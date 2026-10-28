import type { UiSpawnMessage } from "@lasterm/shared";
import { isValidDimensions, isValidEnv, isValidUlid, validateShell } from "@lasterm/shared";
import { HostUnreachableError } from "../../session/host-reachability.js";
import { answeringSpawn } from "../../session/session-manager.js";
import type { WsHandlerContext } from "./types.js";

export function handleSpawn(msg: UiSpawnMessage, ctx: WsHandlerContext): void {
	const { clientId, log, sessionManager, writeLockManager } = ctx;

	log.debug(
		{ hostId: msg.hostId, clientId, shell: msg.shell, cols: msg.cols, rows: msg.rows },
		"spawn-handler: received SPAWN",
	);

	// Checked first, and refused without it: an id that is not one is not echoed.
	if (msg.requestId !== undefined && !isValidUlid(msg.requestId)) {
		ctx.client.send({ type: "ERROR", code: "INVALID_INPUT", message: "Invalid requestId" });
		return;
	}
	// Everything that answers this SPAWN, here and in SessionManager.handleSpawn,
	// carries its request id (#777).
	const client = answeringSpawn(ctx.client, msg.requestId);

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
			// Its host went away while it started: said with the host and its
			// status, and the terminal it was bringing back (#605).
			if (err instanceof HostUnreachableError) {
				client.send(err.toMessage(msg.reuseChannelId));
				return;
			}
			const errorMsg = err instanceof Error ? err.message : String(err);
			const code = (err as Record<string, unknown>)?.code;
			client.send({
				type: "ERROR",
				code: typeof code === "string" ? code : "SPAWN_FAILED",
				message: errorMsg,
			});
		});
}
