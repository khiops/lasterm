import { ErrorCode } from "@lasterm/shared";

/**
 * No password or passphrase was given when one was asked for: the person
 * cancelled, or nobody could be asked. Nothing failed, and a pane says no
 * reason for it (`AUTH_CANCELLED`, #812).
 *
 * Kept apart from `ssh-agent.ts`, which many specs replace whole.
 */
export class AuthCancelledError extends Error {
	readonly code = ErrorCode.AUTH_CANCELLED;

	constructor() {
		super("Authentication cancelled by user");
		this.name = "AuthCancelledError";
	}
}

/**
 * The code of the ERROR that says an SSH connection was not made: the
 * person's cancel, or `SSH_CONNECT_FAILED`.
 */
export function sshConnectErrorCode(err: unknown): string {
	return err instanceof AuthCancelledError ? err.code : "SSH_CONNECT_FAILED";
}
