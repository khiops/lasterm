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
 */

import { closeSync, copyFileSync, ftruncateSync, openSync, statSync } from "node:fs";
import { DAEMON_LOG_ENV } from "../daemon-launch.js";
import { LOG_ROTATION_MAX_BYTES } from "./hub-logger.js";

/** Where the file before it is kept, until the next one replaces it. */
export function previousDaemonLogPath(path: string): string {
	return `${path}.old`;
}

/** The daemon log's size limit, checked before each line written to it. */
export class DaemonLogBound {
	/** A failure is said once, until the file next moves aside. */
	private failing = false;

	/**
	 * `report` says what went wrong, once per failure. Whatever goes wrong, the
	 * line is still written: a file that cannot move aside only grows past the
	 * limit until it can.
	 */
	constructor(
		readonly path: string,
		private readonly report: (message: string) => void,
		private readonly maxBytes: number = LOG_ROTATION_MAX_BYTES,
	) {}

	/**
	 * Call before `bytes` more are written to the file. The size is read from the
	 * file, not counted, because others append to it too. A file that holds
	 * nothing yet takes the line whatever its size: moving an empty file aside
	 * would only lose the previous one.
	 */
	beforeLine(bytes: number): void {
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			// Nothing at that name to move aside.
			return;
		}
		if (size > 0 && size + bytes > this.maxBytes) this.moveAside();
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

/** What `checkBeforeEachLine` checks: `process.stdout` and `process.stderr`. */
export type OutputStream = Pick<NodeJS.WritableStream, "write">;

const checked = new WeakSet<OutputStream>();

/**
 * Check the log's size before each line these streams write. The line still
 * goes where it always went, to the descriptor the launch opened. Fastify's
 * log is included once the server writes to `process.stdout`, since pino
 * otherwise writes to descriptor 1 itself. A line written that way still lands
 * in the file, and the next line checked counts it.
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
			return write(chunk, encoding, callback);
		}) as OutputStream["write"];
	}
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
	const bound = new DaemonLogBound(
		path,
		(message) => {
			stderr(`[lasterm] ${message}\n`);
		},
		io.maxBytes,
	);
	checkBeforeEachLine(bound, [io.stdout, io.stderr]);
	return bound;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
