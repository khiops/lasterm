import type { Client, ConnectConfig } from "ssh2";

/**
 * Connect `client` with Nagle's algorithm off on its socket, so that each SSH
 * packet leaves at once (#873).
 *
 * The shipped hub uses ssh2's JavaScript ciphers: its bundle stubs out the
 * native binding (`scripts/build-sea-hub.ts`), and since #868 tests and a hub
 * run from source do too. Those ciphers hand each packet to the socket in
 * several writes: AES-GCM and ChaCha20-Poly1305 write the length, the body and
 * the tag apart. Node leaves Nagle on, and ssh2 does not turn it off. The first
 * write then leaves, and the rest wait for the peer to acknowledge it; a peer
 * holding part of a packet has nothing to answer with, so it acknowledges when
 * its delayed-ACK timer fires, tens of milliseconds later. Every request paid
 * that wait: each SFTP request of an upload, each keystroke sent to a terminal.
 *
 * Called for every connection the hub opens over TCP: a host's own, which its
 * agent, its remote daemon's socket (#79), its SFTP and its SSH commands all go
 * over; a jump host's, which carries the connection of the host behind it in
 * a channel (that inner connection has no socket of its own, and ssh2 skips
 * it); and a connection test's.
 */
export function connectWithoutDelay(client: Client, config: ConnectConfig): void {
	client.connect(config);
	// ssh2 makes the socket in connect(); Node keeps the flag until it is connected.
	client.setNoDelay(true);
}
