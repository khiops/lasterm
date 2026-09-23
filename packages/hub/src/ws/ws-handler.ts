import type {
	AgentBinaryVerifyResponseMessage,
	AuthMessage,
	AuthPromptResponseMessage,
	DetachMessage,
	HostVerifyResponseMessage,
	InputMessage,
	ProtocolMessage,
	ResizeMessage,
	TestConnectMessage,
	UiAttachMessage,
	UiSpawnMessage,
	WriteClaimMessage,
	WriteDenyMessage,
	WriteForceMessage,
	WriteGrantMessage,
	WriteReleaseMessage,
} from "@lasterm/shared";
import { decodeMessage, encodeMessage, generateId } from "@lasterm/shared";
import type { Database } from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { reportTokenStore, touchToken, validateTokenRecord } from "../auth.js";
import type { SessionManager, WsClient } from "../session/session-manager.js";
import { WriteLockManager } from "../session/write-lock.js";
import {
	handleAgentBinaryVerifyResponse,
	handleAttach,
	handleAuthPromptResponse,
	handleDetach,
	handleHostVerifyResponse,
	handleInput,
	handlePing,
	handleResize,
	handleSpawn,
	handleTestConnect,
	handleWriteClaim,
	handleWriteDeny,
	handleWriteForce,
	handleWriteGrant,
	handleWriteRelease,
	type WsHandlerContext,
} from "./handlers/index.js";

/**
 * RFC 6455 "Try Again Later": the hub could not consult its token store, so it
 * has no verdict on the credential and the client should keep it and retry.
 */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

export async function registerWsRoutes(
	server: FastifyInstance,
	sessionManager: SessionManager,
	authToken?: string,
	db?: Database | null,
	ttlDays?: number,
): Promise<void> {
	// Registry: clientId → send function.
	// WriteLockManager needs to send to arbitrary clients (not just those on a given
	// channel) for WRITE_REQUEST / WRITE_DENY / WRITE_REVOKED. The registry is
	// populated on connect and cleaned up on disconnect.
	const clientSendRegistry = new Map<string, (msg: ProtocolMessage) => void>();

	const writeLockManager = new WriteLockManager({
		sendToClient: (clientId, msg) => {
			clientSendRegistry.get(clientId)?.(msg as ProtocolMessage);
		},
		broadcastToChannel: (channelId, msg) => {
			for (const client of sessionManager.getClientsForChannel(channelId)) {
				client.send(msg as ProtocolMessage);
			}
		},
		onForce: (force) => server.security.writeLockForced(force),
	});

	// Provide write-lock holder lookup so ATTACH_OK includes the current holder
	sessionManager.setGetWriteLockHolder((channelId) => writeLockManager.getHolder(channelId));

	server.get("/ws", { websocket: true }, (socket, req) => {
		const clientId = generateId();
		const sourceIp = req.ip;
		let authenticated = !authToken; // skip auth gate when no token configured

		const client: WsClient = {
			id: clientId,
			send: (msg: ProtocolMessage) => {
				if (socket.readyState === socket.OPEN) {
					socket.send(encodeMessage(msg));
				}
			},
			attachedChannels: new Set(),
		};

		// Register send function for write-lock targeted messages
		clientSendRegistry.set(clientId, client.send);

		// Close unauthenticated connections after 10 seconds
		const authTimeout = authToken
			? setTimeout(() => {
					if (!authenticated) {
						server.log.warn({ clientId }, "WS connection closed: AUTH timeout");
						server.security.authFailed({ via: "ws", sourceIp, clientId, reason: "auth_timeout" });
						socket.close(4001, "AUTH_TIMEOUT");
					}
				}, 10_000)
			: null;

		// Only register the client after successful AUTH (or when auth is disabled)
		if (!authToken) {
			sessionManager.addClient(client);
		}

		socket.on("message", (raw: Buffer) => {
			let msg: ProtocolMessage;
			try {
				msg = decodeMessage(new Uint8Array(raw));
			} catch {
				server.log.warn(
					{ clientId, byteLength: raw.byteLength },
					"ws: malformed MessagePack message",
				);
				client.send({
					type: "ERROR",
					code: "MALFORMED_MESSAGE",
					message: "Failed to decode MessagePack message",
				});
				return;
			}

			server.log.info({ msgType: msg.type }, "ws: received message");

			// AUTH handshake — must be the first message when auth is enabled
			if (!authenticated) {
				if (msg.type !== "AUTH") {
					server.log.warn({ clientId }, "ws-auth: first message must be AUTH");
					server.security.authFailed({ via: "ws", sourceIp, clientId, reason: "not_auth_first" });
					client.send({ type: "AUTH_FAIL", message: "First message must be AUTH" });
					socket.close();
					return;
				}

				const authMsg = msg as AuthMessage;
				if (!db) {
					// DB is required for token validation — fail closed to prevent
					// skipping expiry/revocation checks.
					server.log.warn({ clientId }, "ws-auth: database unavailable");
					server.security.authFailed({
						via: "ws",
						sourceIp,
						clientId,
						reason: "database_unavailable",
					});
					client.send({ type: "AUTH_FAIL", message: "Database unavailable" });
					socket.close();
					return;
				}
				// DB-backed validation: checks expiry and revocation status
				const validation = validateTokenRecord(db, authMsg.token);
				reportTokenStore(db, validation, server.log);
				if (validation.status === "unavailable") {
					// No AUTH_FAIL: a client treats that as a verdict on its token and
					// asks to pair again. Closing with Try Again Later lets it keep the
					// token and reconnect, which succeeds once the store answers. Nor
					// is it an authentication failure in the security log: the token
					// was not judged, and reportTokenStore records the outage once.
					socket.close(WS_CLOSE_TRY_AGAIN_LATER, "AUTH_UNAVAILABLE");
					return;
				}
				if (validation.status === "invalid") {
					server.log.warn(
						{ clientId, reason: validation.reason },
						"ws-auth: invalid, expired, or revoked token",
					);
					server.security.authFailed({
						via: "ws",
						sourceIp,
						clientId,
						reason: "invalid_token",
						tokenStatus: validation.reason,
					});
					client.send({ type: "AUTH_FAIL", message: "Invalid token" });
					socket.close();
					return;
				}
				// Best effort, as on the REST path: the credential has been checked,
				// and a store that cannot record its use must not throw out of the
				// socket's message handler.
				try {
					touchToken(db, validation.record.id, ttlDays ?? 90);
				} catch (err) {
					server.log.warn({ err, clientId }, "ws-auth: touchToken failed");
				}

				authenticated = true;
				clearTimeout(authTimeout ?? undefined);
				sessionManager.addClient(client);
				server.log.info({ clientId }, "ws-auth: accepted");
				server.security.authSucceeded({
					via: "ws",
					sourceIp,
					clientId,
					tokenId: validation.record.id,
				});
				client.send({ type: "AUTH_OK", clientId });
				client.send(sessionManager.getStateSnapshot());
				return;
			}

			const ctx: WsHandlerContext = {
				clientId,
				client,
				log: server.log,
				sessionManager,
				writeLockManager,
			};

			switch (msg.type) {
				case "SPAWN":
					handleSpawn(msg as UiSpawnMessage, ctx);
					break;
				case "ATTACH":
					handleAttach(msg as UiAttachMessage, ctx);
					break;
				case "DETACH":
					handleDetach(msg as DetachMessage, ctx);
					break;
				case "INPUT":
					handleInput(msg as InputMessage, ctx);
					break;
				case "RESIZE":
					handleResize(msg as ResizeMessage, ctx);
					break;
				case "WRITE_CLAIM":
					handleWriteClaim(msg as WriteClaimMessage, ctx);
					break;
				case "WRITE_RELEASE":
					handleWriteRelease(msg as WriteReleaseMessage, ctx);
					break;
				case "WRITE_FORCE":
					handleWriteForce(msg as WriteForceMessage, ctx);
					break;
				case "WRITE_GRANT":
					handleWriteGrant(msg as WriteGrantMessage, ctx);
					break;
				case "WRITE_DENY":
					handleWriteDeny(msg as WriteDenyMessage, ctx);
					break;
				case "PING":
					handlePing(msg, ctx);
					break;
				case "AUTH_PROMPT_RESPONSE":
					handleAuthPromptResponse(msg as AuthPromptResponseMessage, ctx);
					break;
				case "HOST_VERIFY_RESPONSE":
					handleHostVerifyResponse(msg as HostVerifyResponseMessage, ctx);
					break;
				case "AGENT_BINARY_VERIFY_RESPONSE":
					handleAgentBinaryVerifyResponse(msg as AgentBinaryVerifyResponseMessage, ctx);
					break;
				case "TEST_CONNECT":
					handleTestConnect(msg as TestConnectMessage, ctx);
					break;
				default:
					server.log.warn(
						{ msgType: msg.type, keys: Object.keys(msg) },
						"ws: unhandled message type",
					);
					break;
			}
		});

		socket.on("close", () => {
			clearTimeout(authTimeout ?? undefined);
			clientSendRegistry.delete(clientId);
			if (authenticated) {
				writeLockManager.onClientDisconnect(clientId);
				sessionManager.removeClient(clientId);
			}
		});

		socket.on("error", (err: Error) => {
			server.log.error({ err }, "WebSocket error");
			clientSendRegistry.delete(clientId);
			if (authenticated) {
				writeLockManager.onClientDisconnect(clientId);
				sessionManager.removeClient(clientId);
			}
		});
	});
}
