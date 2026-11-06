import { ErrorCode, isValidUlid } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	FileAccessError,
	type FileEntry,
	type FileErrorCode,
	type FileListing,
	type FileStat,
	type FreeSpace,
} from "../files/host-files.js";
import { ChannelNotFound, type HostFilesService } from "../files/host-files-service.js";
import type { WriterCheck } from "../ws/ws-handler.js";

/** The longest path a request may name, in characters. */
export const MAX_PATH_LENGTH = 4096;

/** The header naming the window a write is made from: the id its `AUTH_OK` gave it. */
export const CLIENT_ID_HEADER = "x-lasterm-client-id";

const STATUS: Record<FileErrorCode, number> = {
	HOST_NOT_CONNECTED: 409,
	NOT_FOUND: 404,
	NOT_A_DIRECTORY: 409,
	ALREADY_EXISTS: 409,
	PERMISSION_DENIED: 403,
	UNSUPPORTED_PATH: 400,
	FILE_ACCESS_FAILED: 502,
};

/** What a listing, a stat or a free-space request asks for. */
export interface FilesQuery {
	/** Absent: the folder a panel opens at (the home). */
	readonly path?: string;
	readonly hidden: boolean;
}

function readPath(value: unknown, name: string): string | undefined | { readonly error: string } {
	if (value === undefined) return undefined;
	if (typeof value !== "string") return { error: `${name} must be given once, as text.` };
	if (value.length > MAX_PATH_LENGTH) {
		return { error: `${name} must be at most ${MAX_PATH_LENGTH} characters.` };
	}
	return value;
}

/**
 * Read the query of a files request: `path`, optional (an empty one is none),
 * and `hidden`, `1`/`true` to list hidden entries, `0`/`false` or nothing not
 * to. A parameter given twice is refused, as anything else is.
 */
export function readFilesQuery(query: unknown): FilesQuery | { readonly error: string } {
	const { path, hidden } = (query ?? {}) as { path?: unknown; hidden?: unknown };
	const read = readPath(path === "" ? undefined : path, "path");
	if (typeof read === "object") return read;
	let showHidden = false;
	if (hidden !== undefined) {
		if (hidden === "1" || hidden === "true") showHidden = true;
		else if (hidden !== "0" && hidden !== "false" && hidden !== "") {
			return { error: "hidden must be 1, true, 0 or false." };
		}
	}
	return { ...(read !== undefined ? { path: read } : {}), hidden: showHidden };
}

/** Read the body of a new folder: `{ path }`, the folder to create, non-empty. */
export function readFolderBody(
	body: unknown,
): { readonly path: string } | { readonly error: string } {
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		return { error: "The body must be a JSON object." };
	}
	const path = readPath((body as { path?: unknown }).path, "path");
	if (path === undefined || path === "") return { error: "path is required." };
	if (typeof path === "object") return path;
	return { path };
}

/** An entry as the wire carries it: snake_case, its link fields only on a link. */
function entryOnWire(entry: FileEntry): Record<string, unknown> {
	return {
		name: entry.name,
		kind: entry.kind,
		size: entry.size,
		mtime: entry.mtime,
		...(entry.linkTarget !== undefined ? { link_target: entry.linkTarget } : {}),
		...(entry.linkKind !== undefined ? { link_kind: entry.linkKind } : {}),
	};
}

function listingOnWire(listing: FileListing): Record<string, unknown> {
	return {
		path: listing.path,
		entries: listing.entries.map(entryOnWire),
		truncated: listing.truncated,
	};
}

function statOnWire(stat: FileStat): Record<string, unknown> {
	return { path: stat.path, ...entryOnWire(stat) };
}

function freeSpaceOnWire(space: FreeSpace): Record<string, unknown> {
	return { path: space.path, available: space.available, total: space.total };
}

function refuse(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
	return reply.code(status).header("Cache-Control", "no-store").send({ error: { code, message } });
}

export interface FileRouteDeps {
	readonly files: Pick<HostFilesService, "list" | "stat" | "freeSpace" | "mkdir">;
	/** Whether the window a request names may write to a terminal (`WsRoutes.writerCheck`). */
	readonly writerCheck: (
		channelId: string,
		clientId: string,
		tokenId: string | null,
	) => WriterCheck;
}

/**
 * The files of the host a terminal runs on (#832): list, stat and free space
 * for any authenticated client, a reader included; a new folder only from the
 * window that holds the terminal's write lock.
 *
 * Paths are the user's: the query string reaches no log (`redactUrl`), and
 * neither do the body nor the answers, at any level. A failure the hub did not
 * expect is logged by its name alone, since its message may hold a path.
 */
export function registerFileRoutes(server: FastifyInstance, deps: FileRouteDeps): void {
	const answer = async (
		request: FastifyRequest<{ Params: { id: string } }>,
		reply: FastifyReply,
		run: (channelId: string) => Promise<Record<string, unknown>>,
		status = 200,
	): Promise<FastifyReply> => {
		const channelId = request.params.id;
		if (!isValidUlid(channelId)) {
			return refuse(reply, 400, "VALIDATION_ERROR", "Invalid channel ID");
		}
		try {
			const body = await run(channelId);
			return reply.code(status).header("Cache-Control", "no-store").send(body);
		} catch (error) {
			if (error instanceof ChannelNotFound) {
				return refuse(reply, 404, ErrorCode.CHANNEL_NOT_FOUND, "Channel not found");
			}
			if (error instanceof FileAccessError) {
				return refuse(reply, STATUS[error.code], error.code, error.message);
			}
			request.log.error(
				{ errorName: error instanceof Error ? error.name : typeof error },
				"files: request failed unexpectedly",
			);
			return refuse(reply, 500, "FILE_ACCESS_FAILED", "The request failed unexpectedly");
		}
	};

	server.get<{ Params: { id: string } }>("/api/channels/:id/files", async (request, reply) => {
		const query = readFilesQuery(request.query);
		if ("error" in query) return refuse(reply, 400, "VALIDATION_ERROR", query.error);
		return answer(request, reply, async (channelId) =>
			listingOnWire(await deps.files.list(channelId, query.path, query.hidden)),
		);
	});

	server.get<{ Params: { id: string } }>("/api/channels/:id/files/stat", async (request, reply) => {
		const query = readFilesQuery(request.query);
		if ("error" in query) return refuse(reply, 400, "VALIDATION_ERROR", query.error);
		const { path } = query;
		if (path === undefined) return refuse(reply, 400, "VALIDATION_ERROR", "path is required.");
		return answer(request, reply, async (channelId) =>
			statOnWire(await deps.files.stat(channelId, path)),
		);
	});

	server.get<{ Params: { id: string } }>(
		"/api/channels/:id/files/free-space",
		async (request, reply) => {
			const query = readFilesQuery(request.query);
			if ("error" in query) return refuse(reply, 400, "VALIDATION_ERROR", query.error);
			return answer(request, reply, async (channelId) =>
				freeSpaceOnWire(await deps.files.freeSpace(channelId, query.path)),
			);
		},
	);

	server.post<{ Params: { id: string } }>("/api/channels/:id/folders", async (request, reply) => {
		const channelId = request.params.id;
		if (!isValidUlid(channelId)) {
			return refuse(reply, 400, "VALIDATION_ERROR", "Invalid channel ID");
		}
		const body = readFolderBody(request.body);
		if ("error" in body) return refuse(reply, 400, "VALIDATION_ERROR", body.error);
		const header = request.headers[CLIENT_ID_HEADER];
		const clientId = typeof header === "string" ? header : undefined;
		if (clientId === undefined || !isValidUlid(clientId)) {
			return refuse(
				reply,
				403,
				"WRITE_LOCK_DENIED",
				"Name the window that holds this terminal's write lock in X-Lasterm-Client-Id",
			);
		}
		const check = deps.writerCheck(channelId, clientId, request.authTokenRecord?.id ?? null);
		if (check !== "holder") {
			return refuse(
				reply,
				403,
				"WRITE_LOCK_DENIED",
				check === "unknown-client"
					? "X-Lasterm-Client-Id names no window of this credential connected to the hub"
					: "This window does not hold the write lock for this terminal",
			);
		}
		return answer(
			request,
			reply,
			async (id) => ({ path: (await deps.files.mkdir(id, body.path)).path }),
			201,
		);
	});
}
