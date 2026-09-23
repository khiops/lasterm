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
import {
	type InvalidTokenReason,
	reportTokenStore,
	touchTokenBestEffort,
	validateTokenHash,
	validateTokenRecord,
} from "../auth.js";
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

/**
 * RFC 6455 "Policy Violation": the token this socket authenticated with no
 * longer validates. It was revoked, it expired, or a restart swept it.
 */
export const WS_CLOSE_POLICY_VIOLATION = 1008;

/**
 * How often an open socket records that its token is in use. The REST hook
 * touches on every request; a socket is checked on every frame, and a write per
 * keystroke buys nothing a write a minute does not. What matters is that the
 * sliding expiry keeps moving while the client is active, so an active socket
 * is not closed for an expiry its own use should have pushed back.
 */
const SOCKET_TOKEN_TOUCH_INTERVAL_MS = 60_000;

/** The token a socket authenticated with, kept to check it again. */
interface HeldCredential {
	readonly id: string;
	/** The stored hash, so the plaintext token is not kept for the socket's life. */
	readonly tokenHash: string;
	/** The store that vouched for it, and that is asked again. */
	readonly store: Database;
	touchedAt: number;
}

/** What the rest of the hub can do to the sockets this route holds. */
export interface WsRoutes {
	/**
	 * Close, now rather than on their next frame, the sockets that authenticated
	 * with the token `tokenId`. Returns how many there were.
	 */
	closeSocketsForToken(tokenId: string): number;
}

export async function registerWsRoutes(
	server: FastifyInstance,
	sessionManager: SessionManager,
	authToken?: string,
	db?: Database | null,
	ttlDays?: number,
): Promise<WsRoutes> {
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

	// Sockets that authenticated with a token, by client id, so that revoking the
	// token can end them at once.
	const tokenSockets = new Map<
		string,
		{ readonly tokenId: string; readonly refuse: (status: InvalidTokenReason) => void }
	>();

	server.get("/ws", { websocket: true }, (socket, req) => {
		const clientId = generateId();
		const sourceIp = req.ip;
		let authenticated = !authToken; // skip auth gate when no token configured
		let credential: HeldCredential | null = null;
		// Set once the hub has decided to end this socket: it acts on nothing the
		// client sends while the close handshake completes.
		let ending = false;
		let released = false;

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

		// Detach the client from everything it holds. Several paths end a socket,
		// and the error event is followed by close, so this runs once.
		const release = () => {
			if (released) return;
			released = true;
			clearTimeout(authTimeout ?? undefined);
			clientSendRegistry.delete(clientId);
			tokenSockets.delete(clientId);
			if (authenticated) {
				writeLockManager.onClientDisconnect(clientId);
				sessionManager.removeClient(clientId);
			}
		};

		// End the session now. What it holds, a write lock above all, is released
		// before the close handshake, which a client that ignores it can drag out
		// for as long as the WebSocket library waits.
		const end = (code: number, reason: string) => {
			if (ending) return;
			ending = true;
			release();
			socket.close(code, reason);
		};

		// The token this socket authenticated with no longer validates. The hub
		// ends a session it had accepted, which the security log records as the
		// refusal it is, beside the auth.success that opened it.
		const refuse = (tokenId: string, status: InvalidTokenReason) => {
			if (ending) return;
			server.log.warn(
				{ clientId, tokenId, reason: status },
				"ws-auth: token no longer valid; closing socket",
			);
			server.security.authFailed({
				via: "ws",
				sourceIp,
				clientId,
				reason: "token_no_longer_valid",
				tokenStatus: status,
			});
			end(WS_CLOSE_POLICY_VIOLATION, "AUTH_REVOKED");
		};

		// Ask the store again about the token this socket authenticated with. A
		// token that no longer validates ends the socket with a policy close; a
		// store that cannot answer ends it with Try Again Later, as it would have
		// refused the AUTH, and the client reconnects when it can. An outage is
		// not a refusal of this client, so it is not in the security log.
		const stillValid = (held: HeldCredential): boolean => {
			const validation = validateTokenHash(held.store, held.tokenHash);
			reportTokenStore(held.store, validation, server.log);
			if (validation.status === "valid") {
				const now = Date.now();
				if (now - held.touchedAt >= SOCKET_TOKEN_TOUCH_INTERVAL_MS) {
					held.touchedAt = now;
					touchTokenBestEffort(held.store, held.id, ttlDays ?? 90, server.log);
				}
				return true;
			}
			if (validation.status === "unavailable") {
				end(WS_CLOSE_TRY_AGAIN_LATER, "AUTH_UNAVAILABLE");
				return false;
			}
			refuse(held.id, validation.reason);
			return false;
		};

		socket.on("message", (raw: Buffer) => {
			if (ending) return;

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

			// DEBUG, never INFO: every keystroke is a frame, so a line per frame at the
			// default level records when, and how fast, the user types.
			server.log.debug({ msgType: msg.type }, "ws: received message");

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
				touchTokenBestEffort(db, validation.record.id, ttlDays ?? 90, server.log);

				authenticated = true;
				credential = {
					id: validation.record.id,
					tokenHash: validation.record.tokenHash,
					store: db,
					touchedAt: Date.now(),
				};
				const tokenId = validation.record.id;
				tokenSockets.set(clientId, {
					tokenId,
					refuse: (status) => refuse(tokenId, status),
				});
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

			// Every frame after AUTH is checked, not only those that change state.
			// The check is one indexed read, INPUT dominates the traffic either way,
			// and the frames that merely answer a prompt can still trust a host key
			// or an agent binary. A frame type added later is covered without anyone
			// having to remember it.
			if (credential !== null && !stillValid(credential)) return;

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

		socket.on("close", release);

		socket.on("error", (err: Error) => {
			server.log.error({ err }, "WebSocket error");
			release();
		});
	});

	return {
		closeSocketsForToken(tokenId) {
			let closed = 0;
			for (const entry of tokenSockets.values()) {
				if (entry.tokenId !== tokenId) continue;
				entry.refuse("revoked");
				closed++;
			}
			if (closed > 0) {
				server.log.info({ tokenId, closed }, "ws-auth: closed the sockets of a revoked token");
			}
			return closed;
		},
	};
}
