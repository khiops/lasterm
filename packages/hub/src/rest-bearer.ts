import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { judgeCredential, touchTokenBestEffort } from "./auth.js";
import type { SecurityLog } from "./logging/security-log.js";
import type { Database } from "./storage/sqlite.js";

declare module "fastify" {
	interface FastifyRequest {
		/**
		 * The credential this request authenticated with, as the shared bearer check
		 * judged it: its id (`primary`, or a pairing's ULID), never the token. A
		 * route reads it to say who asked, as `token.revoke` does (#537), or to match
		 * a request with the socket of the same credential. Null wherever no bearer
		 * was judged — health, pairing verification, static files, the WebSocket
		 * upgrade — and on a server built without auth, except on the agent
		 * routes, which judge their bearer themselves.
		 */
		authTokenId: string | null;
	}
}

/** What the shared check answers a REST request; each route family sends it in its own shape. */
export type RestBearerOutcome =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly status: 401 | 503;
			readonly code: "AUTH_REQUIRED" | "AUTH_INVALID" | "AUTH_UNAVAILABLE";
			readonly message: string;
	  };

export interface RestBearerOptions {
	readonly store: Database | null;
	readonly primaryToken: string | null;
	/** The sliding expiry a use extends; a use is not recorded without it. */
	readonly ttlDays?: number | undefined;
	readonly log: FastifyBaseLogger;
	/** The security log; a bare Fastify instance in a spec has none. */
	readonly security: SecurityLog | null;
}

/**
 * The bearer check every REST route shares: the hub-wide auth hook and the
 * agent routes' own guard. One header rule, one verdict (`judgeCredential`),
 * one record of failures and first successes. Sets `request.authTokenId` on
 * success.
 */
export function createRestBearerCheck(
	options: RestBearerOptions,
): (request: FastifyRequest) => RestBearerOutcome {
	// Every REST request carries the bearer, so a record of each success would
	// bury everything else in the log. The first one from each credential and
	// address in a hub run is what says who used a token, and from where.
	const credentialsSeen = new Set<string>();
	const { log, security } = options;

	return (request) => {
		const url = new URL(request.url, "http://localhost").pathname;
		const header = request.headers.authorization;
		if (!header) {
			log.warn({ url }, "auth: missing Authorization header");
			security?.authFailed({ via: "rest", sourceIp: request.ip, reason: "missing_header" });
			return {
				ok: false,
				status: 401,
				code: "AUTH_REQUIRED",
				message: "Authorization header required",
			};
		}

		const parts = header.split(" ");
		const [scheme, token] = parts;
		if (parts.length !== 2 || scheme !== "Bearer" || !token) {
			log.warn({ url }, "auth: malformed Authorization header");
			security?.authFailed({ via: "rest", sourceIp: request.ip, reason: "malformed_header" });
			return {
				ok: false,
				status: 401,
				code: "AUTH_REQUIRED",
				message: "Authorization header must be: Bearer <token>",
			};
		}

		const verdict = judgeCredential(
			{ token },
			{
				store: options.store,
				primaryToken: options.primaryToken,
				primaryWithoutStore: "accept",
				log,
			},
		);
		if (verdict.status === "unavailable") {
			// Still a refusal, but not a verdict on the credential: a 401 here told a
			// client holding a good token to discard it. The outage is logged once by
			// judgeCredential, not on every request it refuses, and not in the
			// security log: nobody failed to authenticate.
			return {
				ok: false,
				status: 503,
				code: "AUTH_UNAVAILABLE",
				message: "The hub cannot check credentials right now",
			};
		}
		if (verdict.status === "invalid") {
			log.warn({ url, reason: verdict.reason }, "auth: invalid, expired, or revoked token");
			security?.authFailed({
				via: "rest",
				sourceIp: request.ip,
				reason: "invalid_token",
				tokenStatus: verdict.reason,
			});
			return {
				ok: false,
				status: 401,
				code: "AUTH_INVALID",
				message: "Invalid, expired, or revoked token",
			};
		}

		request.authTokenId = verdict.tokenId;
		if (verdict.record && options.store && options.ttlDays !== undefined) {
			// Sliding-window expiry refresh + last_used_at update (best effort): the
			// credential has been checked, and failing to record its use is not a
			// reason to refuse it.
			touchTokenBestEffort(options.store, verdict.record.id, options.ttlDays, log);
		}
		log.debug({ url, tokenId: verdict.tokenId }, "auth: accepted");
		const credentialAndAddress = `${verdict.tokenId} ${request.ip}`;
		if (!credentialsSeen.has(credentialAndAddress)) {
			credentialsSeen.add(credentialAndAddress);
			security?.authSucceeded({ via: "rest", sourceIp: request.ip, tokenId: verdict.tokenId });
		}
		return { ok: true };
	};
}
