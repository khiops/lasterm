import type { FastifyReply, FastifyRequest, FastifyServerOptions, LogLevel } from "fastify";
import { LogController } from "fastify";
import { stdSerializers } from "pino";
import { ASSET_TOKEN_QUERY_PARAM } from "../asset-token.js";

/**
 * How Fastify's own log lines are held to CLAUDE.md's Logging rules: which
 * requests leave a line at the shipped level, and what a line may say about a
 * request. Everything here reaches `hub.log`, since the desktop keeps the hub's
 * stdout there.
 */

/** Written in place of whatever a logged value would have given away. */
export const REDACTED = "[redacted]";

/** A query parameter name worth keeping: one of the hub's own, not a stray value. */
const PARAMETER_NAME_RE = /^[\w.-]{1,64}$/;

/**
 * A request URL as a log line may carry it: its path, and the names of its query
 * parameters without their values. A value can be a credential — the asset token
 * every protected asset URL carries (#511) — or something the user typed, such
 * as a log search. A name that does not look like one is withheld too, since a
 * bare `?value` is all value.
 */
export function redactUrl(url: string): string {
	const query = url.indexOf("?");
	if (query === -1) return url;
	const parameters = url
		.slice(query + 1)
		.split("&")
		.filter((pair) => pair.length > 0)
		.map((pair) => {
			const equals = pair.indexOf("=");
			const name = equals === -1 ? "" : pair.slice(0, equals);
			return PARAMETER_NAME_RE.test(name) ? `${name}=${REDACTED}` : REDACTED;
		});
	return `${url.slice(0, query)}?${parameters.join("&")}`;
}

/** The fields of a request a serializer reads; Fastify hands it its own request. */
interface LoggedRequest {
	method?: string;
	url?: string;
	ip?: string;
	host?: string;
	socket?: { remotePort?: number } | null;
}

/** Fastify's own request serializer, with the query values withheld. */
function serializeRequest(request: LoggedRequest): Record<string, unknown> {
	return {
		method: request.method,
		url: typeof request.url === "string" ? redactUrl(request.url) : undefined,
		host: request.host,
		remoteAddress: request.ip,
		remotePort: request.socket?.remotePort,
	};
}

/**
 * Pino's error serializer, which is Fastify's, without `rawPacket`. Node's HTTP
 * parser attaches the bytes it could not parse to the error, and those are the
 * request itself: its URL and its headers, the bearer token among them. Fastify
 * logs that error (at TRACE) for every malformed request.
 */
function serializeError(error: unknown): unknown {
	const serialized = stdSerializers.err(error as Error);
	// What is not an error comes back as it was given, and is the caller's own.
	if (serialized === error || serialized === null || typeof serialized !== "object") {
		return serialized;
	}
	delete (serialized as { rawPacket?: unknown }).rawPacket;
	return serialized;
}

/** An asset token as it appears in any URL, whoever composed the line. */
const ASSET_TOKEN_VALUE_RE = new RegExp(`(${ASSET_TOKEN_QUERY_PARAM}=)[^&\\s"'\\\\#]+`, "g");

/**
 * The last pass over each line before it is written. The serializers above
 * cover a URL logged as a request, but Fastify also composes messages around
 * the raw URL itself — a reply sent twice names the URL it was sent on, in the
 * message and in the error — and those are strings no serializer sees. This
 * pass is what makes the asset token absent from every line, whoever wrote it.
 */
export function withholdSecretsFromLine(line: string): string {
	return line.includes(`${ASSET_TOKEN_QUERY_PARAM}=`)
		? line.replace(ASSET_TOKEN_VALUE_RE, `$1${REDACTED}`)
		: line;
}

/** Where a server's log lines go, and from which level. */
export interface ServerLogOptions {
	/** The shipped hub writes from INFO. */
	readonly level?: LogLevel;
	/** Standard output when absent, which the desktop keeps as `hub.log`. */
	readonly destination?: { write(line: string): void };
}

/** Fastify's `logger` option for a hub server: `false` for none, `true` for the shipped one. */
export function serverLoggerOptions(
	option: boolean | ServerLogOptions,
): NonNullable<FastifyServerOptions["logger"]> {
	if (option === false) return false;
	const { level = "info", destination } = option === true ? {} : option;
	return {
		level,
		serializers: {
			req: serializeRequest as never,
			err: serializeError as never,
		},
		hooks: { streamWrite: withholdSecretsFromLine },
		...(destination ? { stream: destination } : {}),
	};
}

/**
 * Fastify's own per-request lines, at the levels CLAUDE.md allows.
 *
 * Fastify writes two INFO lines for every request, "incoming request" and
 * "request completed", and they were most of the desktop's `hub.log` (#512). A
 * routine request is a hot path, so both are DEBUG here, as are a missing route
 * and a client that hung up early. A request that fails on the hub's side is no
 * routine: a 5xx is still written, at ERROR with the error when one was thrown,
 * and at WARN when a route answered 5xx on purpose. A 4xx is the client's own
 * mistake, and a refused credential is in the security log already.
 */
export class HubLogController extends LogController {
	/** Replies whose 5xx the error handler already wrote, with the error that caused it. */
	private readonly reported = new WeakSet<FastifyReply>();

	override incomingRequest(request: FastifyRequest): void {
		request.log.debug({ req: request }, "incoming request");
	}

	override requestCompleted(
		error: Error | null | undefined,
		request: FastifyRequest,
		reply: FastifyReply,
	): void {
		const responseTime = reply.elapsedTime;
		if (error) {
			reply.log.error({ req: request, res: reply, err: error, responseTime }, "request errored");
		} else if (reply.statusCode >= 500 && !this.reported.has(reply)) {
			reply.log.warn({ req: request, res: reply, responseTime }, "request failed");
		} else {
			reply.log.debug({ res: reply, responseTime }, "request completed");
		}
	}

	override defaultErrorLog(error: Error, request: FastifyRequest, reply: FastifyReply): void {
		if (reply.statusCode >= 500) {
			this.reported.add(reply);
			reply.log.error({ req: request, res: reply, err: error }, error?.message);
		} else {
			reply.log.debug({ res: reply, err: error }, error?.message);
		}
	}

	override streamError(error: Error, _request: FastifyRequest, reply: FastifyReply): void {
		if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
			reply.log.debug({ res: reply }, "stream closed prematurely");
		} else {
			reply.log.warn({ err: error }, "response terminated with an error with headers already sent");
		}
	}

	/** Fastify's own puts the raw URL in the message, where no serializer reaches it. */
	override routeNotFound(request: FastifyRequest): void {
		request.log.debug({ req: request }, "route not found");
	}
}
