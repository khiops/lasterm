/**
 * `hub-daemon.log`: the hub's output, as `lasterm start --daemon` keeps it.
 *
 * The launch opens the file in the state directory and gives it to the child as
 * its standard output and error. Nothing bounded it, so a daemon left running
 * for months grew it for as long (#525). It now follows the rule the desktop's
 * `hub.log` got in #520: before each line, if that line would take the file
 * past 10 MB, what the file holds moves aside to `hub-daemon.log.old`,
 * replacing the one before it, and the file starts again. That is two files at
 * most, and a line never spans both.
 *
 * The desktop renames its file, because it is the only one writing to it.
 * Here, the hub writes through the descriptors the launch handed it, and Node
 * cannot point those at another file. After a rename they would go on writing
 * to the previous file. On Windows they would also hold it open, and no later
 * rename could replace it: a second move fails with EPERM. So the file is never
 * renamed. Its content is copied to `.old`, and the file is emptied in place.
 * Every descriptor on it was opened for appending, the hub's own, the launch's
 * and those of any start that lost the lock, so each one writes its next line
 * at the new end. That includes what Node prints to descriptor 2 on a fatal
 * error.
 *
 * Only the hub that holds the lock checks the size, so one process moves the
 * file aside: a start that loses to a running hub appends its refusal and
 * never moves that hub's log (#133). The lock also covers quick restarts,
 * since the next hub cannot hold it before this one has exited. Another
 * process that appends between the copy and the emptying loses what it
 * appended. The two calls run back to back, and the only other writers are the
 * brief runs of starts that lost the lock.
 *
 * A file deleted while the hub runs, or moved away, loses the name, and the
 * launch's descriptors went on writing to it: a file nobody could open, grown by
 * every line and never checked, since nothing at the path had a size (#540).
 * Windows is no different on NTFS, where a deletion frees the name at once and
 * the descriptors keep the file. So the same check compares the file at the
 * path with the one the lines go to. When the path is gone or names another
 * file, it opens the path again as the launch did, creating the file if need
 * be, and the lines go there from then on, within the limit as before.
 *
 * That is as far as a fix goes. Node cannot point descriptors 1 and 2 at
 * another file, so the lines of the checked streams go through the new
 * descriptor instead of theirs. What reaches descriptor 2 without them, Node's
 * report of a fatal error, still lands in the old file. That file stops growing
 * otherwise, at most at the limit it was kept under, and its space comes back
 * when the hub exits. A deleted name that Windows keeps until the last handle
 * closes (a volume without POSIX deletion) can be neither read nor opened, and
 * the lines go to that file unchecked, as they did before.
 */

import {
	type BigIntStats,
	closeSync,
	copyFileSync,
	fstatSync,
	ftruncateSync,
	openSync,
	statSync,
	writeSync,
} from "node:fs";
import { DAEMON_LOG_ENV, openDaemonLog } from "../daemon-launch.js";
import { LOG_ROTATION_MAX_BYTES } from "./hub-logger.js";

/** Where the file before it is kept, until the next one replaces it. */
export function previousDaemonLogPath(path: string): string {
	return `${path}.old`;
}

/** Which file a descriptor or a path leads to. */
interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

function identityOf(stats: BigIntStats): FileIdentity {
	return { dev: stats.dev, ino: stats.ino };
}

/** The daemon log's size limit, checked before each line written to it. */
export class DaemonLogBound {
	/** A failure is said once, until the file next moves aside or is opened again. */
	private failing = false;
	/** The file the lines go to, when it could be read. */
	private written: FileIdentity | undefined;
	private reopenedFd: number | undefined;

	/**
	 * `report` says what went wrong, once per failure. Whatever goes wrong, the
	 * line is still written: a file that cannot move aside only grows past the
	 * limit until it can. `descriptor` is the one the lines are written through
	 * until the path names another file: standard output, which the launch opened
	 * on the log, as it did standard error.
	 */
	constructor(
		readonly path: string,
		private readonly report: (message: string) => void,
		private readonly maxBytes: number = LOG_ROTATION_MAX_BYTES,
		descriptor = 1,
	) {
		try {
			this.written = identityOf(fstatSync(descriptor, { bigint: true }));
		} catch {
			// Unknown: only a path with nothing at it is then noticed.
		}
	}

	/**
	 * The descriptor this bound opened on the path once the file there was no
	 * longer the one being written, and the one every line goes through since.
	 * `undefined` while the lines still go where the launch sent them.
	 */
	get reopened(): number | undefined {
		return this.reopenedFd;
	}

	/**
	 * Call before `bytes` more are written to the file. The size is read from the
	 * file, not counted, because others append to it too. A file that holds
	 * nothing yet takes the line whatever its size: moving an empty file aside
	 * would only lose the previous one.
	 */
	beforeLine(bytes: number): void {
		let named: BigIntStats | undefined;
		try {
			named = statSync(this.path, { bigint: true });
		} catch (error) {
			// Anything but an absence says nothing about which file is there.
			if (!isAbsent(error)) return;
		}
		if (named === undefined || !this.isWritten(named)) {
			named = this.reopen();
			if (named === undefined) return;
		}
		const size = Number(named.size);
		if (size > 0 && size + bytes > this.maxBytes) this.moveAside();
	}

	/** Release the descriptor opened on the path, if one was. */
	close(): void {
		if (this.reopenedFd === undefined) return;
		closeSync(this.reopenedFd);
		this.reopenedFd = undefined;
	}

	private isWritten(named: BigIntStats): boolean {
		return (
			this.written === undefined ||
			(named.dev === this.written.dev && named.ino === this.written.ino)
		);
	}

	/**
	 * Open the path as the launch did, and send the lines there from now on. The
	 * file at the path is appended to if another took the name, and created if
	 * none did. Returns what it opened, or `undefined` if it could not: the lines
	 * then go where they went, and the next line tries again.
	 */
	private reopen(): BigIntStats | undefined {
		let fd: number;
		let opened: BigIntStats;
		try {
			fd = openDaemonLog(this.path);
		} catch (error) {
			this.fail(`cannot open ${this.path} again: ${describe(error)}`);
			return undefined;
		}
		try {
			opened = fstatSync(fd, { bigint: true });
		} catch (error) {
			closeSync(fd);
			this.fail(`cannot open ${this.path} again: ${describe(error)}`);
			return undefined;
		}
		this.close();
		this.reopenedFd = fd;
		this.written = identityOf(opened);
		this.failing = false;
		return opened;
	}

	private moveAside(): void {
		const previous = previousDaemonLogPath(this.path);
		try {
			// Replaces the previous file, and keeps the owner-only mode.
			copyFileSync(this.path, previous);
		} catch (error) {
			// Held by something that does not share it, a viewer say. Nothing is
			// lost: the file is left as it is, and the next line tries again.
			this.fail(`cannot copy ${this.path} to ${previous}: ${describe(error)}`);
			return;
		}
		try {
			// Emptied through a descriptor of its own: on Windows, one opened for
			// appending cannot truncate.
			const fd = openSync(this.path, "r+");
			try {
				ftruncateSync(fd, 0);
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			// The lines are in both files now, and the next line tries again.
			this.fail(`cannot empty ${this.path}: ${describe(error)}`);
			return;
		}
		this.failing = false;
	}

	private fail(message: string): void {
		if (this.failing) return;
		this.failing = true;
		this.report(message);
	}
}

function isAbsent(error: unknown): boolean {
	const code =
		typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** What `checkBeforeEachLine` checks: `process.stdout` and `process.stderr`. */
export type OutputStream = Pick<NodeJS.WritableStream, "write">;

const checked = new WeakSet<OutputStream>();

/**
 * Check the log before each line these streams write. The line goes where it
 * always went, to the descriptor the launch opened, until the path names
 * another file: from then on it goes through the descriptor the bound opened
 * there. Fastify's log is included once the server writes to `process.stdout`,
 * since pino otherwise writes to descriptor 1 itself. A line written that way
 * still lands in the file, and the next line checked counts it.
 */
export function checkBeforeEachLine(bound: DaemonLogBound, streams: readonly OutputStream[]): void {
	for (const stream of streams) {
		if (checked.has(stream)) continue;
		checked.add(stream);
		const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
		stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
			bound.beforeLine(
				typeof chunk === "string"
					? Buffer.byteLength(
							chunk,
							typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
						)
					: (chunk as Uint8Array).byteLength,
			);
			const reopened = bound.reopened;
			if (reopened === undefined) return write(chunk, encoding, callback);
			return writeThrough(reopened, chunk, encoding, callback);
		}) as OutputStream["write"];
	}
}

/**
 * Write a line through `fd` as the daemon's streams write through theirs: at
 * once, then calling back. A failure goes to the callback as theirs would, and
 * the line is lost either way.
 */
function writeThrough(fd: number, chunk: unknown, encoding: unknown, callback: unknown): boolean {
	const done = typeof encoding === "function" ? encoding : callback;
	// A stream calls back with null when the write went through.
	let failure: unknown = null;
	try {
		if (typeof chunk === "string") {
			writeSync(
				fd,
				chunk,
				null,
				typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
			);
		} else {
			writeSync(fd, chunk as Uint8Array);
		}
	} catch (error) {
		failure = error;
	}
	if (typeof done === "function") process.nextTick(done as (error?: unknown) => void, failure);
	return true;
}

/**
 * The daemon log this process was launched with, if any, taken out of its
 * environment. The agent the hub starts inherits that environment, and so do
 * the shells the agent starts. A `lasterm start` typed in one of them must not
 * treat the daemon's log as its own.
 */
export function takeDaemonLogPath(env: NodeJS.ProcessEnv): string | undefined {
	const path = env[DAEMON_LOG_ENV];
	delete env[DAEMON_LOG_ENV];
	return path === undefined || path === "" ? undefined : path;
}

export interface DaemonLogStreams {
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly maxBytes?: number;
	/** The descriptor both streams write through: standard output, by default. */
	readonly descriptor?: number;
}

/**
 * Keep the daemon's log within its limit, if `lasterm start --daemon`
 * launched this process. Only a hub that holds the lock may call this, so that
 * one process moves the file aside. Returns the bound now checked before each
 * line, or `undefined` when there is no daemon log.
 */
export function boundDaemonLog(
	env: NodeJS.ProcessEnv = process.env,
	io: DaemonLogStreams = { stdout: process.stdout, stderr: process.stderr },
): DaemonLogBound | undefined {
	const path = takeDaemonLogPath(env);
	if (path === undefined) return undefined;
	const stderr = io.stderr.write.bind(io.stderr) as (line: string) => boolean;
	const bound: DaemonLogBound = new DaemonLogBound(
		path,
		(message) => {
			// Where the lines go by then, and unchecked: the bound does not check a
			// line of its own.
			const line = `[lasterm] ${message}\n`;
			const reopened = bound.reopened;
			if (reopened === undefined) stderr(line);
			else writeThrough(reopened, line, undefined, undefined);
		},
		io.maxBytes,
		io.descriptor,
	);
	checkBeforeEachLine(bound, [io.stdout, io.stderr]);
	return bound;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
