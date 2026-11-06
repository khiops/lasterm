import { ErrorCode, isValidUlid, TRANSFER_CHUNK_MAX_BYTES } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { TransferRequestError, type TransferService } from "../transfers/transfer-service.js";
import { CLIENT_ID_HEADER } from "./files.js";

export interface TransferRouteDeps {
	readonly transfers: Pick<TransferService, "receive" | "listFor" | "describe">;
	/** `[experimental] file_transfer`, read at each request. */
	enabled(): boolean;
	/** The token the socket `clientId` authenticated with; undefined for no socket of this hub. */
	clientToken(clientId: string): string | null | undefined;
}

function refuse(
	reply: FastifyReply,
	status: number,
	code: string,
	message: string,
	details: Record<string, unknown> = {},
): FastifyReply {
	return reply
		.code(status)
		.header("Cache-Control", "no-store")
		.send({ error: { code, message, ...details } });
}

/** An offset in a query: a whole number of bytes, given once. */
function readOffset(value: unknown): number | null {
	if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) return null;
	const offset = Number(value);
	return Number.isSafeInteger(offset) ? offset : null;
}

/**
 * Uploads (#833): a file's bytes, chunk by chunk, from the window that started
 * its upload, and what an upload is at, for a client that attached after it
 * started. Every route waits behind `[experimental] file_transfer`.
 *
 * The chunks come on the REST connection rather than the WebSocket, so that a
 * window's terminal output is never queued behind them, and each is answered
 * once the host acknowledged it: a client goes at the host's pace. These
 * routes take `application/octet-stream` up to `TRANSFER_CHUNK_MAX_BYTES`, in
 * their own scope: no other route reads that type, and the multipart limit
 * does not apply to them.
 *
 * The routes log nothing of their own: an id and an offset are no secret, but
 * a chunk is the user's, and its route runs once a megabyte.
 */
export function registerTransferRoutes(server: FastifyInstance, deps: TransferRouteDeps): void {
	const disabled = (reply: FastifyReply) =>
		refuse(
			reply,
			404,
			ErrorCode.FILE_TRANSFER_DISABLED,
			"File transfer is off: [experimental] file_transfer",
		);

	server.register(async (scope) => {
		scope.addContentTypeParser(
			"application/octet-stream",
			{ parseAs: "buffer", bodyLimit: TRANSFER_CHUNK_MAX_BYTES },
			(_request, body, done) => done(null, body),
		);

		scope.put<{ Params: { id: string; item: string }; Querystring: { offset?: unknown } }>(
			"/api/transfers/:id/items/:item",
			{ bodyLimit: TRANSFER_CHUNK_MAX_BYTES },
			async (request, reply) => {
				if (!deps.enabled()) return disabled(reply);
				const { id } = request.params;
				if (!isValidUlid(id)) return refuse(reply, 400, "VALIDATION_ERROR", "Invalid transfer ID");
				if (!/^\d{1,9}$/.test(request.params.item)) {
					return refuse(reply, 400, "VALIDATION_ERROR", "Invalid item ID");
				}
				const offset = readOffset(request.query.offset);
				if (offset === null) {
					return refuse(reply, 400, "VALIDATION_ERROR", "offset must be a whole number of bytes");
				}
				if (!Buffer.isBuffer(request.body)) {
					return refuse(
						reply,
						415,
						"VALIDATION_ERROR",
						"A chunk is sent as application/octet-stream",
					);
				}
				const header = request.headers[CLIENT_ID_HEADER];
				const clientId = typeof header === "string" ? header : undefined;
				const tokenId = request.authTokenRecord?.id ?? null;
				if (
					clientId === undefined ||
					!isValidUlid(clientId) ||
					deps.clientToken(clientId) !== tokenId
				) {
					return refuse(
						reply,
						403,
						"NOT_THE_SENDER",
						"Name in X-Lasterm-Client-Id the window of this credential that started the upload",
					);
				}
				try {
					const { acked } = await deps.transfers.receive(
						{ clientId, tokenId },
						id,
						Number(request.params.item),
						offset,
						request.body,
					);
					return reply.code(200).header("Cache-Control", "no-store").send({ acked });
				} catch (error) {
					if (error instanceof TransferRequestError) {
						return refuse(reply, error.status, error.code, error.message, error.details);
					}
					request.log.error(
						{ errorName: error instanceof Error ? error.name : typeof error },
						"transfers: a chunk failed unexpectedly",
					);
					return refuse(reply, 500, "TRANSFER_FAILED", "The chunk failed unexpectedly");
				}
			},
		);
	});

	server.get<{ Querystring: { channel_id?: unknown } }>(
		"/api/transfers",
		async (request, reply) => {
			if (!deps.enabled()) return disabled(reply);
			const channelId = request.query.channel_id;
			// Each says whether it is from the asking window's device, which alone may resume it (#837).
			const viewer = request.authTokenRecord?.id ?? null;
			// Without one, every upload the hub holds: a window offering to resume
			// what a restart interrupted reads them all (#860).
			if (channelId === undefined) {
				return reply
					.header("Cache-Control", "no-store")
					.send({ transfers: deps.transfers.listFor(undefined, viewer) });
			}
			if (!isValidUlid(channelId)) {
				return refuse(reply, 400, "VALIDATION_ERROR", "channel_id must be a terminal's id");
			}
			return reply
				.header("Cache-Control", "no-store")
				.send({ transfers: deps.transfers.listFor(channelId, viewer) });
		},
	);

	server.get<{ Params: { id: string } }>("/api/transfers/:id", async (request, reply) => {
		if (!deps.enabled()) return disabled(reply);
		const found = isValidUlid(request.params.id)
			? deps.transfers.describe(request.params.id, request.authTokenRecord?.id ?? null)
			: null;
		if (found === null) return refuse(reply, 404, "TRANSFER_NOT_FOUND", "No upload has that id");
		return reply.header("Cache-Control", "no-store").send(found);
	});
}
