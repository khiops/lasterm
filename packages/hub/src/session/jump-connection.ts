/**
 * Opening the channel a jumped connection travels in.
 *
 * The bastion is an SSH connection of its own, and the target's connection is
 * carried inside a channel opened on it. That connection therefore has to
 * outlive this function: it is handed back so whoever ends the target's
 * connection ends the route with it, rather than leaving a bastion logged in
 * with nothing going through it.
 *
 * The bastion's own host key is verified here, against what is already trusted
 * for it — its pinned fingerprint, or this machine's `known_hosts`. A jump with
 * no such answer is refused rather than trusted on sight: a first connection is
 * a question for a person, and this one happens on the way to somewhere else,
 * where nobody is looking.
 */

import { Client, type ClientChannel, type SyncHostVerifier } from "ssh2";
import { fingerprintOf } from "../ssh/fingerprint.js";
import {
	findHostKeyRevocation,
	findKnownHostKeys,
	judgeAgainstKnownHosts,
	readUserKnownHosts,
} from "../ssh/known-hosts.js";
import { agentSignerFailure } from "./key-agent-signer.js";
import { passwordRefusal } from "./password-auth.js";
import { describeConnectionLoss, SSH_KEEPALIVE } from "./ssh-keepalive.js";
import { connectWithoutDelay } from "./ssh-nodelay.js";

export interface JumpTarget {
	host: string;
	port: number;
	username: string;
}

export interface JumpOptions {
	/** How long opening the route may take, from connecting to the open channel; none when absent. */
	timeoutMs?: number;
	/**
	 * How long each of the route's two waits may take apart, when the host it
	 * leads to sets a connection timeout (#1034): the jump's own connection, up
	 * to `ready` (ssh2's `readyTimeout`, 20 s when absent), and its channel to
	 * the host, from `forwardOut` to its answer (unbounded when absent).
	 */
	waitTimeoutMs?: number;
	/** Cancels the route: the jump's connection is destroyed and the route refused (#1034). */
	signal?: AbortSignal;
	/** Where the jump is, and who it is reached as. */
	jump: JumpTarget;
	/** Names used for revocation and trust lookup in `known_hosts`. */
	knownHostsNames: string[];
	/** The ssh2 configuration authenticating to the jump (agent, key, password). */
	auth: Record<string, unknown>;
	/** The fingerprint already trusted for this jump, when there is one. */
	pinnedFingerprint?: string | null;
	/** Whether a key `known_hosts` already trusts is enough on its own. */
	trustKnownHosts: boolean;
	/** Where the channel goes: the host being reached through the jump. */
	destination: { host: string; port: number };
}

export interface JumpRoute {
	/** The stream the target's SSH connection runs inside. */
	stream: ClientChannel;
	/** The fingerprint the jump presented, for pinning after a first success. */
	fingerprint: string;
	/** Whether that fingerprint was learned from `known_hosts` rather than a pin. */
	fromKnownHosts: boolean;
	/** Ends the connection to the jump. */
	close: () => void;
}

/** How a refused jump is reported, so the message reaches the person. */
export class JumpRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JumpRefusedError";
	}
}

/**
 * Connect the bastion and open the channel the target's connection travels in.
 */
export function openJumpRoute(options: JumpOptions): Promise<JumpRoute> {
	const client = new Client();
	let presented = "";
	let fromKnownHosts = false;
	let keyRefused = false;

	return new Promise<JumpRoute>((resolve, reject) => {
		let settled = false;
		/** The route was handed out: from here on, an error is how it ends. */
		let routed = false;
		/** Whoever holds the route ended it: what goes wrong on the way out is no loss. */
		let closing = false;
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						fail(
							new Error(
								`The jump host ${options.jump.host} timed out after ${options.timeoutMs}ms`,
							),
						);
						client.destroy();
					}, options.timeoutMs);
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			client.end();
			reject(error);
		};

		// Cancelled, as a Disconnect does while the route opens: nothing else
		// would end a channel open the jump never answers (#1034).
		const onAbort = (): void => {
			fail(Object.assign(new Error("SSH connect aborted"), { name: "AbortError" }));
			client.destroy();
		};
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });

		client.on("error", (error: Error) => {
			if (routed) {
				if (closing) return;
				// The target's connection ends with the route, and is lost like any
				// other; only here is it known that the jump is what went.
				console.error(
					`[lasterm-ssh] lost the connection to the jump host ${options.jump.host}:${options.jump.port}: ${describeConnectionLoss(error)}`,
				);
				return;
			}
			fail(
				// The jump refused its password, or the agent did not sign with the
				// jump's key: whoever opens the route asks for the password or the
				// key's passphrase, and opens it again (#815, #876).
				passwordRefusal(options.auth, error) ??
					agentSignerFailure(options.auth) ??
					(presented === "" || error.message.includes("verification")
						? error
						: new Error(`Cannot reach the jump host ${options.jump.host}: ${error.message}`)),
			);
		});

		// The jump went away before it handed out the route: ssh2 says nothing
		// else when the server closes after its banner (#1034), and nothing else
		// would settle this.
		client.on("close", () => {
			fail(
				new Error(
					`The jump host ${options.jump.host} closed the connection before the route was open`,
				),
			);
		});

		client.on("ready", () => {
			const channelTimer =
				options.waitTimeoutMs === undefined
					? undefined
					: setTimeout(() => {
							fail(
								new Error(
									`The jump host ${options.jump.host} did not open a route to ${options.destination.host}:${options.destination.port} within ${options.waitTimeoutMs}ms`,
								),
							);
							client.destroy();
						}, options.waitTimeoutMs);
			client.forwardOut(
				"127.0.0.1",
				0,
				options.destination.host,
				options.destination.port,
				(error, stream) => {
					clearTimeout(channelTimer);
					if (error) {
						fail(
							new Error(
								`The jump host ${options.jump.host} refused a route to ${options.destination.host}:${options.destination.port}: ${error.message}`,
							),
						);
						return;
					}
					if (settled) {
						stream.destroy();
						client.end();
						return;
					}
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					settled = true;
					routed = true;
					resolve({
						stream,
						fingerprint: presented,
						fromKnownHosts,
						close: () => {
							closing = true;
							client.end();
						},
					});
				},
			);
		});

		const hostVerifier = ((key: Buffer) => {
			presented = fingerprintOf(key);
			const revoked = findHostKeyRevocation(presented, options.knownHostsNames, options.jump.port);
			if (revoked) {
				keyRefused = true;
				fail(
					new JumpRefusedError(
						`The jump host ${options.jump.host} presented a key marked @revoked in ${revoked.file}:${revoked.line}. Nothing was connected.`,
					),
				);
				return false;
			}

			const pinned = options.pinnedFingerprint;
			if (pinned) {
				keyRefused = pinned !== presented;
				return !keyRefused;
			}

			// Nothing pinned yet: what this machine's own SSH already trusts is the
			// only answer available without a person to ask.
			const sources = readUserKnownHosts();
			const verdict = judgeAgainstKnownHosts(
				presented,
				options.knownHostsNames.flatMap((name) =>
					findKnownHostKeys(name, options.jump.port, sources),
				),
			);
			if (verdict.kind === "trusted" && options.trustKnownHosts) {
				fromKnownHosts = true;
				return true;
			}
			keyRefused = true;
			return false;
		}) as SyncHostVerifier;

		try {
			connectWithoutDelay(client, {
				...options.auth,
				// A bastion that goes silent is noticed like the host behind it (#607).
				...SSH_KEEPALIVE,
				host: options.jump.host,
				port: options.jump.port,
				username: options.jump.username,
				hostVerifier,
				...(options.waitTimeoutMs !== undefined && { readyTimeout: options.waitTimeoutMs }),
			});
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	}).catch((error: unknown) => {
		if (keyRefused && error instanceof Error && !(error instanceof JumpRefusedError)) {
			// The key was seen and not accepted: say what to do about it, since
			// nothing here can ask.
			throw new JumpRefusedError(
				options.pinnedFingerprint
					? `The jump host ${options.jump.host} presented ${presented}, which is not the key trusted for it. Nothing was connected.`
					: `The jump host ${options.jump.host} presented ${presented}, and nothing here trusts it yet. Connect to it once as a saved host and choose that host as the jump, or let Lasterm trust what your known_hosts already does.`,
			);
		}
		throw error;
	});
}
