/**
 * A connection that ended for want of something only the person can give: a
 * password the server refused (#815), or a key's passphrase once the SSH agent
 * that was to sign with that key did not (#876).
 *
 * Whoever dialled closes that connection first, so that nothing of it stays
 * open while the person is asked, then calls `askAgain`, which puts the answer
 * into the ssh2 configuration it came from, and dials again. `askAgain` rejects
 * with `AuthCancelledError` when nothing is given.
 *
 * Kept apart from `ssh-agent.ts`, which many specs replace whole.
 */
export class AskAgainError extends Error {
	constructor(
		message: string,
		readonly askAgain: () => Promise<void>,
	) {
		super(message);
		this.name = "AskAgainError";
	}
}
