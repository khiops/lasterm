import { ErrorCode, type TransferNotResumedReason } from "@lasterm/shared";

/**
 * No password or passphrase was given when one was asked for: the person
 * cancelled, or nobody could be asked. Nothing failed, and a pane says no
 * reason for it (`AUTH_CANCELLED`, #812).
 *
 * `secret` says which was asked for, when the one who threw knows: an upload
 * that could not resume says so (#860).
 *
 * Kept apart from `ssh-agent.ts`, which many specs replace whole.
 */
export class AuthCancelledError extends Error {
	readonly code = ErrorCode.AUTH_CANCELLED;

	constructor(readonly secret?: "password" | "passphrase") {
		super("Authentication cancelled by user");
		this.name = "AuthCancelledError";
	}
}

/** The person did not accept the host's key when asked: nothing was connected. */
export class HostKeyRejectedError extends Error {
	constructor() {
		super("SSH host key rejected by user");
		this.name = "HostKeyRejectedError";
	}
}

/**
 * The code of the ERROR that says an SSH connection was not made: the
 * person's cancel, or `SSH_CONNECT_FAILED`.
 */
export function sshConnectErrorCode(err: unknown): string {
	return err instanceof AuthCancelledError ? err.code : "SSH_CONNECT_FAILED";
}

/**
 * Why a connection asked for an upload's resume was not made, as the upload
 * records it (#860): the question its host needed answered and that was not,
 * or that it could not be reached.
 */
export function notResumedReason(err: unknown): TransferNotResumedReason {
	if (err instanceof AuthCancelledError) {
		return err.secret === "password" ? "needs_password" : "needs_passphrase";
	}
	if (err instanceof HostKeyRejectedError) return "host_key_not_accepted";
	return "host_unreachable";
}
