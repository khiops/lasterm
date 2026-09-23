import { isIP } from "node:net";
import { isValidUlid, type SshAuthMethod } from "@lasterm/shared";
import { type InvalidTokenReason, PRIMARY_TOKEN_ID } from "../auth.js";

// ─── What an event may say ────────────────────────────────────────────────────

const REST_AUTH_FAILURES = [
	"missing_header",
	"malformed_header",
	"invalid_token",
	"database_unavailable",
] as const;
const WS_AUTH_FAILURES = [
	"auth_timeout",
	"not_auth_first",
	"invalid_token",
	"database_unavailable",
	"token_no_longer_valid",
] as const;
const PAIR_AUTH_FAILURES = [
	"rate_limited",
	"invalid_format",
	"unknown_code",
	"code_used",
	"code_expired",
] as const;
const TOKEN_STATUSES = [
	"unknown",
	"revoked",
	"swept",
	"expired",
] as const satisfies readonly InvalidTokenReason[];
const SSH_AUTH_METHODS = ["agent", "key", "password"] as const satisfies readonly SshAuthMethod[];
const SSH_DISCONNECT_REASONS = ["closed_by_hub", "connection_lost"] as const;
const PERMISSIONS_CHECKS = ["passed", "not_checked_on_windows"] as const;
const TOKEN_REVOCATION_OUTCOMES = ["revoked", "not_found", "not_revocable"] as const;

export type SshDisconnectReason = (typeof SSH_DISCONNECT_REASONS)[number];
export type PermissionsCheck = (typeof PERMISSIONS_CHECKS)[number];
export type TokenRevocationOutcome = (typeof TOKEN_REVOCATION_OUTCOMES)[number];

export type AuthSuccess =
	| { via: "rest"; sourceIp: string; tokenId: string }
	| { via: "ws"; sourceIp: string; tokenId: string; clientId: string };

export type AuthFailure =
	| {
			via: "rest";
			sourceIp: string;
			reason: (typeof REST_AUTH_FAILURES)[number];
			tokenStatus?: InvalidTokenReason;
	  }
	| {
			via: "ws";
			sourceIp: string;
			clientId: string;
			reason: (typeof WS_AUTH_FAILURES)[number];
			tokenStatus?: InvalidTokenReason;
	  }
	| { via: "pair"; sourceIp: string; reason: (typeof PAIR_AUTH_FAILURES)[number] };

/** Every value a record can hold: nothing structured, so nothing nested can hide in one. */
export type SecurityFields = Readonly<Record<string, string | number>>;

/** Where records go. The hub writes them to `logs/hub.jsonl`; tests collect them. */
export type SecuritySink = (msg: string, fields: SecurityFields) => void;

/** Written in place of a value that does not have the shape its field requires. */
export const WITHHELD = "<withheld>";

// ─── SecurityLog ──────────────────────────────────────────────────────────────

/**
 * The security events of SECURITY.md § 7.1, and the only way the hub records them.
 *
 * § 7.2 names what must never reach a log: tokens, SSH passwords, terminal
 * output and pairing codes. Holding to that by care at every call site is what
 * fails first, the day someone logs a request body or an error message, so here
 * it is a property of the API:
 *
 *   - Each event is a method whose parameter names every field the event may
 *     carry, and the record is built from those names alone. A caller cannot add
 *     a field in a literal, which the compiler refuses, and a field smuggled in on
 *     an object the compiler did not see is never read.
 *   - No field is free-form text, save a host's label, which the person chose.
 *     There is no message, no error text and no request data. Identifiers must
 *     have the shape of what they name: a ULID, an IP address, an ISO 8601 time,
 *     a port. Reasons and methods are closed lists. A value of the wrong shape is
 *     written as `<withheld>`, and a 64-character token or an 8-digit pairing
 *     code has none of those shapes.
 */
export class SecurityLog {
	constructor(private readonly sink: SecuritySink) {}

	/** Recorded after the hub has published its runtime record, so it is serving. */
	hubStarted(event: {
		bindAddress: string;
		port: number;
		permissionsCheck: PermissionsCheck;
	}): void {
		this.write("hub.start", "hub start", {
			bindAddress: ip(event.bindAddress),
			port: port(event.port),
			permissionsCheck: oneOf(event.permissionsCheck, PERMISSIONS_CHECKS),
		});
	}

	authSucceeded(event: AuthSuccess): void {
		switch (event.via) {
			case "rest":
				this.write("auth.success", "auth success", {
					via: "rest",
					sourceIp: ip(event.sourceIp),
					tokenId: tokenId(event.tokenId),
				});
				return;
			case "ws":
				this.write("auth.success", "auth success", {
					via: "ws",
					sourceIp: ip(event.sourceIp),
					tokenId: tokenId(event.tokenId),
					clientId: ulid(event.clientId),
				});
				return;
		}
	}

	/**
	 * `tokenStatus` says which way an `invalid_token` was invalid. A revoked or
	 * swept token still being offered is a device that kept a credential it was
	 * meant to lose; an unknown one is a guess or a typo. Both are refused the
	 * same way, and only the record can tell them apart.
	 *
	 * `token_no_longer_valid` is a WebSocket the hub had accepted and has now
	 * ended, because the token it authenticated with stopped validating: on its
	 * next frame, or at once when the token was revoked. Its `tokenStatus` says
	 * why, and its `clientId` names the connection an earlier `auth.success`
	 * opened.
	 */
	authFailed(event: AuthFailure): void {
		switch (event.via) {
			case "rest":
				this.write("auth.failure", "auth failure", {
					via: "rest",
					sourceIp: ip(event.sourceIp),
					reason: oneOf(event.reason, REST_AUTH_FAILURES),
					...tokenStatus(event.reason, event.tokenStatus),
				});
				return;
			case "ws":
				this.write("auth.failure", "auth failure", {
					via: "ws",
					sourceIp: ip(event.sourceIp),
					clientId: ulid(event.clientId),
					reason: oneOf(event.reason, WS_AUTH_FAILURES),
					...tokenStatus(event.reason, event.tokenStatus),
				});
				return;
			case "pair":
				this.write("auth.failure", "auth failure", {
					via: "pair",
					sourceIp: ip(event.sourceIp),
					reason: oneOf(event.reason, PAIR_AUTH_FAILURES),
				});
				return;
		}
	}

	/** The code itself is what pairs a device, so only its record and its expiry are said. */
	pairingCodeGenerated(event: { pairingId: string; expiresAt: string; sourceIp: string }): void {
		this.write("pairing.generated", "pairing code generated", {
			pairingId: ulid(event.pairingId),
			expiresAt: isoTime(event.expiresAt),
			sourceIp: ip(event.sourceIp),
		});
	}

	pairingCodeVerified(event: { pairingId: string; tokenId: string; sourceIp: string }): void {
		this.write("pairing.verified", "pairing code verified", {
			pairingId: ulid(event.pairingId),
			tokenId: tokenId(event.tokenId),
			sourceIp: ip(event.sourceIp),
		});
	}

	sshConnected(event: { hostId: string; hostLabel: string; authMethod: SshAuthMethod }): void {
		this.write("ssh.connect", "SSH connect", {
			hostId: ulid(event.hostId),
			hostLabel: typeof event.hostLabel === "string" ? event.hostLabel : WITHHELD,
			authMethod: oneOf(event.authMethod, SSH_AUTH_METHODS),
		});
	}

	sshDisconnected(event: { hostId: string; reason: SshDisconnectReason }): void {
		this.write("ssh.disconnect", "SSH disconnect", {
			hostId: ulid(event.hostId),
			reason: oneOf(event.reason, SSH_DISCONNECT_REASONS),
		});
	}

	/** Only a lock taken from another client: forcing a free lock takes nothing from anyone. */
	writeLockForced(event: { channelId: string; byClientId: string; fromClientId: string }): void {
		this.write("write_lock.force", "write lock forced", {
			channelId: ulid(event.channelId),
			byClientId: ulid(event.byClientId),
			fromClientId: ulid(event.fromClientId),
		});
	}

	tokenRotated(event: { tokenId: string }): void {
		this.write("token.rotate", "token rotated", { tokenId: tokenId(event.tokenId) });
	}

	/**
	 * A revocation the hub undid on its own: the primary token's, recorded by a
	 * version that still allowed it (#515). `revokedAt` is when that revocation
	 * was made, to set beside whatever else the log holds from that moment.
	 */
	tokenReinstated(event: { tokenId: string; revokedAt: string }): void {
		this.write("token.reinstate", "token reinstated", {
			tokenId: tokenId(event.tokenId),
			revokedAt: isoTime(event.revokedAt),
		});
	}

	/**
	 * A request to revoke a credential, whatever became of it: `revoked`;
	 * `not_found`, no token has that id or it was already revoked; `not_revocable`,
	 * the primary token, which is retired by replacing auth.json instead (#515).
	 * `tokenId` is the id the request named, so one that is neither `primary` nor a
	 * ULID is withheld, whatever the caller put there.
	 */
	tokenRevocation(event: {
		tokenId: string;
		sourceIp: string;
		outcome: TokenRevocationOutcome;
	}): void {
		this.write("token.revoke", "token revocation", {
			tokenId: tokenId(event.tokenId),
			sourceIp: ip(event.sourceIp),
			outcome: oneOf(event.outcome, TOKEN_REVOCATION_OUTCOMES),
		});
	}

	private write(event: string, summary: string, fields: SecurityFields): void {
		try {
			this.sink(`security: ${summary}`, { event, ...fields });
		} catch {
			// The event being recorded has already happened, and a sink that fails
			// must not turn a successful authentication into a failed request.
		}
	}
}

/** A log that keeps nothing, for a session manager built outside a hub (tests). */
export function discardingSecurityLog(): SecurityLog {
	return new SecurityLog(() => undefined);
}

// ─── Field shapes ─────────────────────────────────────────────────────────────

const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function ulid(value: string): string {
	return isValidUlid(value) ? value : WITHHELD;
}

/** Credentials are named by their row: the constant primary, or the ULID a pairing gave it. */
function tokenId(value: string): string {
	return value === PRIMARY_TOKEN_ID || isValidUlid(value) ? value : WITHHELD;
}

function ip(value: string): string {
	return typeof value === "string" && isIP(value) !== 0 ? value : WITHHELD;
}

function isoTime(value: string): string {
	return typeof value === "string" && ISO_TIME_RE.test(value) ? value : WITHHELD;
}

function port(value: number): number | string {
	return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : WITHHELD;
}

/** Only a refused token has a status to give; beside any other reason it is not written. */
function tokenStatus(reason: string, status: InvalidTokenReason | undefined): SecurityFields {
	if (status === undefined) return {};
	if (reason !== "invalid_token" && reason !== "token_no_longer_valid") return {};
	return { tokenStatus: oneOf(status, TOKEN_STATUSES) };
}

function oneOf<T extends string>(value: T, allowed: readonly T[]): string {
	return allowed.includes(value) ? value : WITHHELD;
}
