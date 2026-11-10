import { type ChannelStatus, ErrorCode } from "@lasterm/shared";

/** What a terminal pane knows about the terminal behind it. */
export interface PaneFacts {
	/** Its status as this client last heard it, whichever host is in view. */
	status: ChannelStatus | undefined;
	/** An attach was refused because the terminal has ended. */
	ended: boolean;
	/** The hub has no record of it. */
	gone: boolean;
	/** The last attach was answered from what the hub remembers, not from the terminal. */
	detached: boolean;
}

/**
 * What a pane lays over its terminal: the exit overlay, with Restart
 * (`exited`); the same overlay without it (`gone`); the "Not connected" banner
 * with Reconnect (`not-connected`); or nothing.
 *
 * A terminal that has ended is not waiting for a connection. The banner is
 * only for one the hub could not reach, so whatever says it ended wins over it.
 */
export type PaneCover = "exited" | "gone" | "not-connected" | null;

export function paneCover(facts: PaneFacts): PaneCover {
	if (facts.gone) return "gone";
	if (facts.ended || facts.status === "dead") return "exited";
	if (facts.detached) return "not-connected";
	return null;
}

/** What the hub's answer to one ATTACH says: everything a pane knows but the status. */
export type AttachFacts = Omit<PaneFacts, "status">;

/**
 * What a pane knows once the hub has answered its ATTACH with an ATTACH_OK:
 * from the terminal itself, or from what the hub remembers (`cached`).
 *
 * Every answer sets all three facts, so none outlives the answer that replaced
 * it. A pane whose socket came back used to keep what the attach before it had
 * said: the banner over a terminal it could reach again, or no banner over one
 * the hub could now only remember (#559).
 */
export function factsFromAttachOk(cached: boolean): AttachFacts {
	return { ended: false, gone: false, detached: cached };
}

/**
 * What a pane knows once the hub has refused its ATTACH with `code`: that the
 * terminal ended, or that the hub has no record of it.
 *
 * `null` for any other failure — a timeout, a socket gone. That is not the hub
 * saying anything about the terminal, and the pane keeps what it knew.
 */
export function factsFromRefusal(code: string | undefined): AttachFacts | null {
	if (code === "CHANNEL_DEAD") return factsFromKnownEnd();
	if (code === "CHANNEL_NOT_FOUND") return { ended: false, gone: true, detached: false };
	return null;
}

/**
 * What a pane knows when the client already says its terminal has ended and
 * its attach gets no answer: what the hub would answer, CHANNEL_DEAD. Such a
 * pane asks all the same, for what the terminal last printed (#927).
 *
 * The pane keeps it as its own. It learnt it from the list of the host in
 * view, and that list changes with the rail: a pane over an ended terminal of
 * the host just left went blank, with no overlay, no lock and nothing to
 * type into, though its terminal was as ended as before (#594).
 */
export function factsFromKnownEnd(): AttachFacts {
	return { ended: true, gone: false, detached: false };
}

/** What a host can ask for before a terminal starts on it. */
export type AskedSecret = "password" | "passphrase";

/**
 * A new terminal that never started: its host asked for a password or a key's
 * passphrase, and none was given (`AUTH_CANCELLED`). `asked` says which, when
 * the spawn saw the question.
 */
export interface SecretNotGiven {
	asked?: AskedSecret;
}

/**
 * Whether a spawn was refused because the password or passphrase its host
 * asked for was not given, and which was asked for. Null for anything else.
 *
 * That is no failure, and no end (#812): no shell started and nothing ended,
 * so the pane offers to connect again, which asks again (#875).
 */
export function secretNotGiven(err: unknown): SecretNotGiven | null {
	const refusal = err as { code?: unknown; asked?: unknown } | null;
	if (refusal?.code !== ErrorCode.AUTH_CANCELLED) return null;
	return refusal.asked === "password" || refusal.asked === "passphrase"
		? { asked: refusal.asked }
		: {};
}

/** What the pane says of it: "Not connected: the passphrase was not given". */
export function notGivenMessage(notGiven: SecretNotGiven): string {
	return `Not connected: the ${notGiven.asked ?? "password or passphrase"} was not given`;
}
