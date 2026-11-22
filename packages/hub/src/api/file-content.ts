import { type Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ErrorCode, isValidUlid } from "@lasterm/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DownloadTickets } from "../files/download-tickets.js";
import { FileAccessError } from "../files/host-files.js";
import {
	ChannelNotFound,
	type DownloadTarget,
	type HostFilesService,
	HostNotFound,
} from "../files/host-files-service.js";
import { baseNameOf } from "../files/host-paths.js";
import { type FileLook, type OpenedFile, sameLook } from "../files/read-backend.js";
import { FILE_STATUS, MAX_PATH_LENGTH } from "./files.js";

/**
 * A file of a terminal's host, as a download (#840): `GET
 * /api/channels/:id/files/content?path=` and its host form `GET
 * /api/hosts/:hostId/files/content?path=`, for any authenticated client, a
 * reader included, or for a browser's ordinary download through a ticket made
 * by `POST …/files/content-ticket`. One range at most (RFC 9110 § 14), an ETag
 * of the file's size and time, and a file seen to change while it is read is
 * never delivered whole: a small body is checked before any header, a larger
 * one has its last `HOLD_BACK` bytes held until a second look agrees.
 *
 * Paths and names are the user's: the query reaches no log (`redactUrl`), and
 * an unexpected failure is logged by its error name alone.
 */

/** The bytes held back until the second look; a body this small is checked whole first. */
export const HOLD_BACK = 64 * 1024;

/** 100 ns ticks between 0001-01-01 and the Unix epoch. */
const TICKS_AT_EPOCH = 621_355_968_000_000_000n;

export interface FileContentDeps {
	readonly files: Pick<HostFilesService, "openForRead" | "downloadTarget" | "hostOf">;
	readonly tickets: DownloadTickets;
	/** `[experimental] file_transfer`, read at each request. */
	enabled(): boolean;
	/** Count an open download response on a host until the returned function is called (#840 H13). */
	responseOpen(hostId: string): () => void;
}

/** The ETag of a look: `"<size>-<unit><mtime>"`. */
export function etagOf(look: FileLook): string {
	return `"${look.size}-${look.unit}${look.mtime}"`;
}

function millisOf(look: FileLook): number {
	if (look.unit === "ms") return Number(look.mtime);
	if (look.unit === "s") return Number(look.mtime) * 1000;
	return Number((BigInt(look.mtime) - TICKS_AT_EPOCH) / 10_000n);
}

/** The bytes a request asks for, or why none (RFC 9110 § 14; spec H5). */
export type RangeAnswer =
	| { readonly kind: "whole" }
	| { readonly kind: "part"; readonly start: number; readonly end: number }
	| { readonly kind: "unsatisfiable" };

export function rangeOf(
	header: string | undefined,
	ifRange: string | undefined,
	size: number,
	etag: string,
): RangeAnswer {
	if (header === undefined || size === 0) return { kind: "whole" };
	if (ifRange !== undefined && ifRange !== etag) return { kind: "whole" };
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return { kind: "whole" };
	const [, first = "", last = ""] = match;
	if (first === "" && last === "") return { kind: "whole" };
	if (first === "") {
		const suffix = Number(last);
		if (suffix === 0) return { kind: "unsatisfiable" };
		return { kind: "part", start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	if (last !== "" && Number(last) < start) return { kind: "whole" };
	if (start >= size) return { kind: "unsatisfiable" };
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	return { kind: "part", start, end };
}

/**
 * `Content-Disposition` for `name`: an ASCII fallback (bytes 0x20–0x7E other
 * than `"`, `\` and `%`, each other character one `_`) and the name itself in
 * RFC 8187's UTF-8 form.
 */
export function contentDisposition(name: string): string {
	let fallback = "";
	for (const character of name) {
		const code = character.codePointAt(0) ?? 0;
		fallback +=
			code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\" && character !== "%"
				? character
				: "_";
	}
	if (fallback === "") fallback = "download";
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** The headers a download sets before it knows it can send the file. */
const DOWNLOAD_HEADERS = [
	"Accept-Ranges",
	"ETag",
	"Last-Modified",
	"Content-Disposition",
	"Content-Range",
	"Content-Length",
];

/** A JSON refusal, without the download's own headers. */
function refuse(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
	for (const name of DOWNLOAD_HEADERS) reply.removeHeader(name);
	return reply
		.code(status)
		.header("Cache-Control", "no-store")
		.header("Content-Type", "application/json; charset=utf-8")
		.send({ error: { code, message } });
}

/**
 * Passes its bytes on, holding the last `HOLD_BACK` of `length` until `check`
 * says the source did not change; otherwise it fails before them.
 */
class HoldBack extends Transform {
	private passed = 0;
	private held: Buffer[] = [];

	constructor(
		private readonly length: number,
		private readonly check: () => Promise<boolean>,
	) {
		super();
	}

	override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
		const free = Math.max(0, this.length - HOLD_BACK - this.passed);
		if (free > 0) {
			const now = chunk.subarray(0, free);
			this.passed += now.length;
			this.push(now);
			chunk = chunk.subarray(now.length);
		}
		if (chunk.length > 0) this.held.push(chunk);
		done();
	}

	override _flush(done: TransformCallback): void {
		const held = Buffer.concat(this.held);
		if (this.passed + held.length !== this.length) {
			done(new FileAccessError("FILE_CHANGED", "The file ended early"));
			return;
		}
		this.check().then(
			(same) => {
				if (!same) {
					done(new FileAccessError("FILE_CHANGED", "The file changed while it was read"));
					return;
				}
				this.push(held);
				done();
			},
			(error: unknown) => done(error instanceof Error ? error : new Error(String(error))),
		);
	}
}

/** Read a whole small body into memory. */
async function readAll(stream: Readable, limit: number): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
		total += buffer.length;
		if (total > limit) break;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

export function registerFileContentRoutes(server: FastifyInstance, deps: FileContentDeps): void {
	const failed = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
		if (error instanceof ChannelNotFound) {
			return refuse(reply, 404, ErrorCode.CHANNEL_NOT_FOUND, "Channel not found");
		}
		if (error instanceof HostNotFound) {
			return refuse(reply, 404, ErrorCode.HOST_NOT_FOUND, "Host not found");
		}
		if (error instanceof FileAccessError) {
			return refuse(reply, FILE_STATUS[error.code], error.code, error.message);
		}
		request.log.error(
			{ errorName: error instanceof Error ? error.name : typeof error },
			"files: download failed unexpectedly",
		);
		return refuse(reply, 500, "FILE_ACCESS_FAILED", "The download failed unexpectedly");
	};

	const disabled = (reply: FastifyReply): FastifyReply =>
		refuse(
			reply,
			404,
			ErrorCode.FILE_TRANSFER_DISABLED,
			"File transfer is off: [experimental] file_transfer",
		);

	const readPathQuery = (request: FastifyRequest): string | { error: string } => {
		const path = (request.query as { path?: unknown } | null)?.path;
		if (typeof path !== "string" || path === "") return { error: "path is required, once." };
		if (path.length > MAX_PATH_LENGTH) {
			return { error: `path must be at most ${MAX_PATH_LENGTH} characters.` };
		}
		return path;
	};

	const serve = async (
		request: FastifyRequest,
		reply: FastifyReply,
		target: DownloadTarget,
	): Promise<FastifyReply> => {
		if (!deps.enabled()) return disabled(reply);
		let path: string;
		const grant = request.downloadGrant ?? null;
		if (grant !== null && grant.kind === "file") {
			path = grant.payload as string;
		} else {
			const read = readPathQuery(request);
			if (typeof read !== "string") return refuse(reply, 400, "VALIDATION_ERROR", read.error);
			path = read;
		}
		let opened: {
			hostId: string;
			path: string;
			style: Parameters<typeof baseNameOf>[1];
			file: OpenedFile;
		};
		try {
			opened = await deps.files.openForRead(target, path);
		} catch (error) {
			return failed(request, reply, error);
		}
		const { file } = opened;
		const release = deps.responseOpen(opened.hostId);
		let closed = false;
		const finish = (): void => {
			if (closed) return;
			closed = true;
			release();
			void file.close();
		};
		reply.raw.once("close", finish);
		// A client that left while the file was being opened: its close came before
		// the listener, so nothing else would let go of the file and the count.
		if (request.raw.destroyed || reply.raw.destroyed) {
			finish();
			return reply;
		}
		try {
			const look = file.look;
			const etag = etagOf(look);
			const headers = request.headers;
			const range = rangeOf(
				typeof headers.range === "string" ? headers.range : undefined,
				typeof headers["if-range"] === "string" ? headers["if-range"] : undefined,
				look.size,
				etag,
			);
			reply
				.header("Cache-Control", "no-store")
				.header("X-Content-Type-Options", "nosniff")
				.header("Accept-Ranges", "bytes")
				.header("ETag", etag)
				.header("Last-Modified", new Date(millisOf(look)).toUTCString())
				.header("Content-Disposition", contentDisposition(baseNameOf(opened.path, opened.style)));
			if (range.kind === "unsatisfiable") {
				finish();
				return reply
					.code(416)
					.header("Content-Range", `bytes */${look.size}`)
					.send({
						error: { code: "RANGE_NOT_SATISFIABLE", message: "The range is outside the file" },
					});
			}
			const start = range.kind === "part" ? range.start : 0;
			const length = range.kind === "part" ? range.end - range.start + 1 : look.size;
			if (range.kind === "part") {
				reply.code(206).header("Content-Range", `bytes ${range.start}-${range.end}/${look.size}`);
			} else reply.code(200);
			reply.header("Content-Type", "application/octet-stream");
			const unchanged = async (): Promise<boolean> => sameLook(await file.recheck(), look);
			if (length <= HOLD_BACK) {
				const body =
					length === 0 ? Buffer.alloc(0) : await readAll(await file.read(start, length), length);
				if (body.length !== length || !(await unchanged())) {
					finish();
					return refuse(reply, 409, "FILE_CHANGED", "The file changed while it was read");
				}
				finish();
				return reply.header("Content-Length", length).send(body);
			}
			const source = await file.read(start, length);
			const hold = new HoldBack(length, unchanged);
			reply.header("Content-Length", length);
			// The response is the held-back stream; a failure on either side
			// destroys the socket, so the client sees fewer bytes than promised.
			pipeline(source, hold).catch(() => {
				reply.raw.destroy();
			});
			return reply.send(hold);
		} catch (error) {
			finish();
			if (reply.sent) {
				reply.raw.destroy();
				return reply;
			}
			return failed(request, reply, error);
		}
	};

	server.get<{ Params: { id: string } }>(
		"/api/channels/:id/files/content",
		async (request, reply) => {
			if (!isValidUlid(request.params.id)) {
				return refuse(reply, 400, "VALIDATION_ERROR", "Invalid channel ID");
			}
			return serve(request, reply, { channelId: request.params.id });
		},
	);

	server.get<{ Params: { hostId: string } }>(
		"/api/hosts/:hostId/files/content",
		async (request, reply) => serve(request, reply, { hostId: request.params.hostId }),
	);

	const issue = async (
		request: FastifyRequest,
		reply: FastifyReply,
		target: DownloadTarget,
	): Promise<FastifyReply> => {
		if (!deps.enabled()) return disabled(reply);
		const body = request.body as { path?: unknown } | null;
		const path = body?.path;
		if (typeof path !== "string" || path === "" || path.length > MAX_PATH_LENGTH) {
			return refuse(reply, 400, "VALIDATION_ERROR", "path is required, as text.");
		}
		const tokenId = request.authTokenId ?? "local";
		try {
			const resolved = await deps.files.downloadTarget(target, path);
			const { ticket, expiresIn } = deps.tickets.issue(tokenId, {
				kind: "file",
				hostId: resolved.hostId,
				payload: resolved.path,
			});
			return reply
				.code(200)
				.header("Cache-Control", "no-store")
				.send({ ticket, expires_in: expiresIn });
		} catch (error) {
			return failed(request, reply, error);
		}
	};

	server.post<{ Params: { id: string } }>(
		"/api/channels/:id/files/content-ticket",
		async (request, reply) => {
			if (!isValidUlid(request.params.id)) {
				return refuse(reply, 400, "VALIDATION_ERROR", "Invalid channel ID");
			}
			return issue(request, reply, { channelId: request.params.id });
		},
	);

	server.post<{ Params: { hostId: string } }>(
		"/api/hosts/:hostId/files/content-ticket",
		async (request, reply) => issue(request, reply, { hostId: request.params.hostId }),
	);
}

/** The routes a ticket opens, as the router names them (spec H6). */
export const TICKET_ROUTES: Readonly<
	Record<string, { kind: "file" | "archive"; param: "id" | "hostId" }>
> = {
	"/api/channels/:id/files/content": { kind: "file", param: "id" },
	"/api/hosts/:hostId/files/content": { kind: "file", param: "hostId" },
	"/api/hosts/:hostId/files/archive": { kind: "archive", param: "hostId" },
};
