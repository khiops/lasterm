import type { AuthenticationType, AuthHandlerMiddleware, ConnectConfig } from "ssh2";
import { AuthCancelledError } from "./auth-cancelled.js";

/**
 * Authenticating with a password the server may refuse (#815).
 *
 * The password is asked for before anything is dialled, so that no prompt
 * holds a connection open, and only the server can say it is wrong. Then it is
 * asked for again, saying so, and the server dialled again, as OpenSSH asks
 * again, until it takes one or the person cancels. A new connection rather
 * than another try on the same one: the person may take longer to answer than
 * the server and ssh2 wait for a connection to authenticate.
 *
 * Nothing here keeps a password: it lives in the ssh2 configuration it was
 * asked for, as before, and the next one replaces the one refused.
 *
 * Kept apart from `ssh-agent.ts`, which many specs replace whole.
 */

/** The server refused the password the connection was made with (#815). */
export class PasswordRefusedError extends Error {
	constructor(
		account: string,
		/**
		 * Ask the person again, saying the last one was wrong, for the next
		 * connection. Rejects with `AuthCancelledError` when no password is given.
		 */
		readonly askAgain: () => Promise<void>,
	) {
		super(`The server refused the password for ${account}`);
		this.name = "PasswordRefusedError";
	}
}

/** What a password's handler knows of the connection it last authenticated. */
interface PasswordAttempt {
	/** That connection's server refused the password. */
	refused: boolean;
	/** `user@host`, as the prompt names it. */
	account: string;
	askAgain: () => Promise<void>;
}

/** Each handler's attempt, found again through any copy of its configuration. */
const attempts = new WeakMap<object, PasswordAttempt>();

/**
 * Authenticate `config` with `password`, and know when its server refuses it.
 *
 * ssh2 tries `none`, then the password, as it does by default. The server's
 * answer to `none` names the methods it takes: one that takes no password is
 * sent none, and fails as before. Only a password sent and refused is a
 * refusal (`passwordRefusal`); a partial success, which wants more than a
 * password, is not.
 *
 * `askAgain` is the prompt that says the last one was wrong, and resolves null
 * when the person cancels.
 */
export function authenticateWithPassword(
	config: ConnectConfig,
	password: string,
	account: string,
	askAgain: () => Promise<string | null>,
): void {
	config.password = password;
	const attempt: PasswordAttempt = {
		refused: false,
		account,
		askAgain: async () => {
			console.error(`[lasterm-ssh] the server refused the password for ${account}: asking again`);
			const secret = await askAgain();
			// Whether there is one, never its length (#644).
			console.error(
				`[lasterm-ssh] password obtained: ${secret === null ? "no (cancelled)" : "yes"}`,
			);
			if (secret === null) throw new AuthCancelledError();
			config.password = secret;
		},
	};
	let sent = false;
	// ssh2 takes what the handler returns: a method's name, or false for none left.
	const handler = (
		methodsLeft: AuthenticationType[] | null,
		partialSuccess: boolean | null,
	): AuthenticationType | false => {
		// The first call of a connection: the configuration may be dialled again.
		if (methodsLeft === null) {
			attempt.refused = false;
			sent = false;
			return "none";
		}
		if (!sent) {
			if (!methodsLeft.includes("password")) return false;
			sent = true;
			// The method's name, not the password: ssh2 reads that from the
			// configuration it was given, and keeps it nowhere else.
			return "password";
		}
		attempt.refused = partialSuccess !== true;
		return false;
	};
	attempts.set(handler, attempt);
	config.authHandler = handler as unknown as AuthHandlerMiddleware;
}

/**
 * The refusal of the password `config` authenticated with, when that is what
 * `err` reports, or null: a network, a host key or a server that takes no
 * password is not asked for another one (#815).
 *
 * `config` may be a copy of the one `authenticateWithPassword` was given: the
 * next password goes into that one all the same.
 */
export function passwordRefusal(
	config: { authHandler?: unknown },
	err: unknown,
): PasswordRefusedError | null {
	const handler = config.authHandler;
	if (typeof handler !== "function") return null;
	const attempt = attempts.get(handler);
	if (attempt === undefined || !attempt.refused) return null;
	// The handler's verdict outlives its connection: only the failure ssh2 ends
	// authentication with is the refusal.
	if ((err as { level?: unknown } | null)?.level !== "client-authentication") return null;
	return new PasswordRefusedError(attempt.account, attempt.askAgain);
}
