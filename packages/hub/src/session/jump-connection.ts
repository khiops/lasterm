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

import { createHash } from "node:crypto";
import { Client, type ClientChannel, type SyncHostVerifier } from "ssh2";
import {
	findKnownHostKeys,
	judgeAgainstKnownHosts,
	normalizeFingerprint,
	readUserKnownHosts,
} from "../ssh/known-hosts.js";

export interface JumpTarget {
	host: string;
	port: number;
	username: string;
}

export interface JumpOptions {
	/** Where the jump is, and who it is reached as. */
	jump: JumpTarget;
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

	return new Promise<JumpRoute>((resolve, reject) => {
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			client.end();
			reject(error);
		};

		client.on("error", (error: Error) => {
			fail(
				presented === "" || error.message.includes("verification")
					? error
					: new Error(`Cannot reach the jump host ${options.jump.host}: ${error.message}`),
			);
		});

		client.on("ready", () => {
			client.forwardOut(
				"127.0.0.1",
				0,
				options.destination.host,
				options.destination.port,
				(error, stream) => {
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
					settled = true;
					resolve({
						stream,
						fingerprint: presented,
						fromKnownHosts,
						close: () => client.end(),
					});
				},
			);
		});

		const hostVerifier = ((key: Buffer) => {
			presented = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
			const offered = normalizeFingerprint(presented);

			const pinned = options.pinnedFingerprint;
			if (pinned) return normalizeFingerprint(pinned) === offered;

			// Nothing pinned yet: what this machine's own SSH already trusts is the
			// only answer available without a person to ask.
			const verdict = judgeAgainstKnownHosts(
				presented,
				findKnownHostKeys(options.jump.host, options.jump.port, readUserKnownHosts()),
			);
			if (verdict.kind === "trusted" && options.trustKnownHosts) {
				fromKnownHosts = true;
				return true;
			}
			return false;
		}) as SyncHostVerifier;

		client.connect({
			...options.auth,
			host: options.jump.host,
			port: options.jump.port,
			username: options.jump.username,
			hostVerifier,
		});
	}).catch((error: unknown) => {
		if (presented !== "" && error instanceof Error && !(error instanceof JumpRefusedError)) {
			// The key was seen and not accepted: say what to do about it, since
			// nothing here can ask.
			throw new JumpRefusedError(
				options.pinnedFingerprint
					? `The jump host ${options.jump.host} presented ${presented}, which is not the key trusted for it. Nothing was connected.`
					: `The jump host ${options.jump.host} presented ${presented}, and nothing here trusts it yet. Connect to it once as a host of its own, or let Lasterm trust what your known_hosts already does.`,
			);
		}
		throw error;
	});
}
