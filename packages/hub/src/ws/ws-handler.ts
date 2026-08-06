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
import { touchToken, validateTokenRecord } from "../auth.js";
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
	});

	// Provide write-lock holder lookup so ATTACH_OK includes the current holder
	sessionManager.setGetWriteLockHolder((channelId) => writeLockManager.getHolder(channelId));

	server.get("/ws", { websocket: true }, (socket, _req) => {
		const clientId = generateId();
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
					client.send({ type: "AUTH_FAIL", message: "First message must be AUTH" });
					socket.close();
					return;
				}

				const authMsg = msg as AuthMessage;
				let tokenAccepted = false;
				if (db) {
					// DB-backed validation: checks expiry and revocation status
					const record = validateTokenRecord(db, authMsg.token);
					if (record) {
						touchToken(db, record.id, ttlDays ?? 90);
						tokenAccepted = true;
					}
				} else {
					// DB is required for token validation — fail closed to prevent
					// skipping expiry/revocation checks.
					server.log.warn({ clientId }, "ws-auth: database unavailable");
					client.send({ type: "AUTH_FAIL", message: "Database unavailable" });
					socket.close();
					return;
				}
				if (!tokenAccepted) {
					server.log.warn({ clientId }, "ws-auth: invalid, expired, or revoked token");
					client.send({ type: "AUTH_FAIL", message: "Invalid token" });
					socket.close();
					return;
				}

				authenticated = true;
				clearTimeout(authTimeout ?? undefined);
				sessionManager.addClient(client);
				server.log.info({ clientId }, "ws-auth: accepted");
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
