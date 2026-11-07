import net from "node:net";
import type { Client, ConnectConfig } from "ssh2";

/**
 * Connect `client` with Nagle's algorithm off on its socket, so that each SSH
 * packet leaves at once (#873), and in one TCP segment (#896).
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
 * With Nagle off, each of those writes could leave as a segment of its own, so
 * the socket also gathers what is written to it in one turn of the event loop
 * into one write ({@link coalesceWritesPerTick}).
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
	// ssh2 keeps the socket it made, or the stream it was given, in `_sock`. A
	// channel stream (a jump's inner connection) sends no segments of its own.
	const socket = (client as unknown as { _sock?: unknown })._sock;
	if (socket instanceof net.Socket) coalesceWritesPerTick(socket);
}

/**
 * Make `socket` send what is written to it in one turn of the event loop as
 * one write, so that an SSH packet ssh2 writes in pieces leaves in one segment
 * (#896): the first write of a turn corks the socket, and a `process.nextTick`
 * uncorks it, which Node runs before it polls for I/O again. Nothing waits past
 * the turn that wrote it.
 *
 * Nothing stays corked:
 * - a write from a later turn (a timer, an immediate, an I/O callback, a
 *   promise) corks anew, and is released at the end of its own turn;
 * - a write made while the release runs, or after it in the same tick queue,
 *   corks anew too, and its release runs in that same queue;
 * - a write that throws was corked before it threw, and is released all the same;
 * - `end()` uncorks the socket itself, before its FIN, and the release then has
 *   nothing left to do;
 * - `destroy()` is preceded by the release, so what was written before it is
 *   handed to the system first, as it was without corking.
 */
export function coalesceWritesPerTick(socket: net.Socket): void {
	let corked = false;
	const release = (): void => {
		if (!corked) return;
		corked = false;
		socket.uncork();
	};
	const write = socket.write;
	socket.write = function (this: net.Socket, ...args: unknown[]): boolean {
		if (!corked) {
			corked = true;
			socket.cork();
			process.nextTick(release);
		}
		return Reflect.apply(write, this, args);
	} as typeof socket.write;
	const destroy = socket.destroy;
	socket.destroy = function (this: net.Socket, ...args: unknown[]): net.Socket {
		release();
		return Reflect.apply(destroy, this, args);
	} as typeof socket.destroy;
}
