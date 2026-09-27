/**
 * How the hub notices that a host it holds an SSH connection to has gone
 * silent (#607).
 *
 * A host that vanishes without closing TCP — power lost, rebooted at another
 * address, the network cut — leaves the connection looking up until a write
 * fails, which can take many minutes. Meanwhile the host shows connected, and
 * a restart sent over the dead connection times out instead of waiting for the
 * host (#605).
 *
 * ssh2 sends an SSH-level keepalive request every `keepaliveInterval`, and
 * counts those left unanswered. Past `keepaliveCountMax` of them it emits
 * "Keepalive timeout" and destroys the socket, and the connection ends like
 * any other that is lost: the host goes disconnected and is reconnected, and a
 * restart waits for it. Only an answer resets the count, so a silent host is
 * declared lost `interval × (countMax + 1)` after its last answer: 60 s, which
 * is 45 to 60 s after it went silent.
 *
 * A live link is not torn down for being busy. The server answers a request as
 * soon as it reads it, and what can be queued ahead of the request, or of its
 * answer, is bounded by the channel windows: about 2 MB each way. The first
 * unanswered request has 45 s to be answered, so any link carrying some 50 KB/s
 * in its loaded direction keeps its connection. Only a slower link, saturated
 * — an agent upload or a burst of output over a few hundred kbit/s — could lose
 * a connection that was still alive.
 *
 * A constant rather than a setting: no other SSH timing is one (the handshake,
 * HELLO and reconnect bounds are all fixed). A host's settings do show a "Keep
 * Alive (s)" value, `keepAliveSeconds`, but it has never been read by anything,
 * and every host stores 60 there: taken as the interval, a vanished host would
 * go unnoticed for three to four minutes.
 */
export const SSH_KEEPALIVE = {
	/** Milliseconds between two keepalive requests. */
	keepaliveInterval: 15_000,
	/** Requests that may go unanswered in a row before the connection is declared lost. */
	keepaliveCountMax: 3,
} as const;

/**
 * Why a connection that was up ended, for the log. ssh2 says it with an
 * error just before the close; nothing in it is anything a user typed.
 */
export function describeConnectionLoss(err: unknown): string {
	if (!(err instanceof Error)) return "an error without a message";
	if (err.message === "Keepalive timeout") return "the host stopped answering its keepalives";
	return err.message;
}
